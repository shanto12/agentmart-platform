"""Dependency-free (urllib-only) client for the AgentMart v1 API."""

from __future__ import annotations

import json
import os
import random
import socket
import time
import uuid
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, cast
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from . import __version__
from .errors import AgentMartError
from .types import (
    ApiKey,
    CatalogItem,
    Category,
    Review,
    DigitalDelivery,
    Event,
    Listing,
    ListingKind,
    Mandate,
    Order,
    OrderRole,
    Page,
    RegisterResponse,
    ReviewSort,
    ServiceTerms,
    ShippingAddress,
    ShippingTerms,
    SortOrder,
    Stats,
    Store,
    TokenResponse,
    Transaction,
    Wallet,
)

__all__ = ["AgentMart", "DEFAULT_BASE_URL", "unwrap"]

DEFAULT_BASE_URL = "https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api"

_UNSET: Any = object()


def _clean(d: Mapping[str, Any]) -> Dict[str, Any]:
    """Drop keys whose value is None (callers use None for 'not provided')."""
    return {k: v for k, v in d.items() if v is not None}


def _q(segment: str) -> str:
    return urlparse.quote(str(segment), safe="")


class AgentMart:
    """Client for the AgentMart agent-to-agent marketplace.

    >>> am = AgentMart(api_key="am_live_...")
    >>> am.wallet()["available_cents"]

    Args:
        base_url: API base, e.g. ``https://<ref>.supabase.co/functions/v1/api``.
                  Defaults to ``$AGENTMART_API`` or the production URL.
        api_key: agent API key (``am_live_...``) or a JWT access token.
                 Defaults to ``$AGENTMART_API_KEY``.
        timeout: per-request socket timeout in seconds.
        max_retries: retries for 429 / 5xx / network errors (see ``_should_retry``).
        backoff_base: first backoff delay in seconds; doubles each attempt, with jitter.
        backoff_max: cap on a single backoff delay.
        user_agent: override the User-Agent header.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        *,
        timeout: float = 30.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
        backoff_max: float = 20.0,
        user_agent: Optional[str] = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("AGENTMART_API") or DEFAULT_BASE_URL).rstrip("/")
        self.api_key: Optional[str] = api_key if api_key is not None else os.environ.get("AGENTMART_API_KEY")
        self.timeout = timeout
        self.max_retries = max(0, int(max_retries))
        self.backoff_base = backoff_base
        self.backoff_max = backoff_max
        self.user_agent = user_agent or f"agentmart-python/{__version__}"
        #: Headers of the most recent response (e.g. X-RateLimit-Remaining).
        self.last_response_headers: Dict[str, str] = {}
        #: X-Request-Id of the most recent response.
        self.last_request_id: Optional[str] = None
        #: sync_token from the last catalog page fetched via iter_catalog / sync_catalog.
        self.last_sync_token: Optional[str] = None
        self._sleep: Callable[[float], None] = time.sleep

    def __repr__(self) -> str:
        return f"AgentMart(base_url={self.base_url!r}, authenticated={bool(self.api_key)})"

    # ------------------------------------------------------------------ transport

    @staticmethod
    def new_idempotency_key() -> str:
        return f"idem_{uuid.uuid4().hex}"

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        json_body: Any = _UNSET,
        headers: Optional[Mapping[str, str]] = None,
        idempotency_key: Optional[str] = None,
        auth: bool = True,
        raw: bool = False,
    ) -> Any:
        """Perform an HTTP request and return the decoded JSON body.

        ``path`` is relative to ``base_url`` (e.g. ``/v1/wallet``). ``raw=True``
        returns the response text instead of decoding JSON.
        """
        method = method.upper()
        url = self.base_url + (path if path.startswith("/") else "/" + path)
        if params:
            query = {k: ("true" if v is True else "false" if v is False else v) for k, v in params.items() if v is not None}
            if query:
                url += ("&" if "?" in url else "?") + urlparse.urlencode(query, doseq=True)

        hdrs: Dict[str, str] = {"Accept": "application/json", "User-Agent": self.user_agent}
        data: Optional[bytes] = None
        if json_body is not _UNSET:
            data = json.dumps(json_body if json_body is not None else {}, separators=(",", ":")).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        elif method in ("POST", "PUT", "PATCH"):
            data = b"{}"
            hdrs["Content-Type"] = "application/json"
        if auth and self.api_key:
            hdrs["Authorization"] = f"Bearer {self.api_key}"
        if idempotency_key:
            hdrs["Idempotency-Key"] = idempotency_key
        if headers:
            hdrs.update(headers)

        attempt = 0
        while True:
            try:
                return self._send_once(method, url, data, hdrs, raw)
            except AgentMartError as exc:
                if attempt >= self.max_retries or not self._should_retry(method, exc, idempotency_key is not None):
                    raise
                delay = self._backoff_delay(attempt, exc)
                attempt += 1
                self._sleep(delay)

    def _send_once(self, method: str, url: str, data: Optional[bytes], hdrs: Dict[str, str], raw: bool) -> Any:
        req = urlrequest.Request(url, data=data, headers=hdrs, method=method)
        status = 0
        resp_headers: Dict[str, str] = {}
        try:
            with urlrequest.urlopen(req, timeout=self.timeout) as resp:
                status = resp.status
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                body = resp.read()
        except urlerror.HTTPError as http_err:
            status = http_err.code
            resp_headers = {k.lower(): v for k, v in (http_err.headers or {}).items()}
            try:
                body = http_err.read()
            except Exception:  # pragma: no cover - defensive
                body = b""
        except (urlerror.URLError, socket.timeout, ConnectionError, TimeoutError) as net_err:
            reason = getattr(net_err, "reason", net_err)
            raise AgentMartError("network_error", f"{method} {url} failed: {reason}", 0) from net_err

        self.last_response_headers = resp_headers
        self.last_request_id = resp_headers.get("x-request-id")
        text = body.decode("utf-8", errors="replace") if body else ""

        if 200 <= status < 300:
            if raw:
                return text
            if not text.strip():
                return None
            try:
                return json.loads(text)
            except ValueError:
                raise AgentMartError(
                    "invalid_response", f"Expected JSON from {method} {url}", status, self.last_request_id, text, resp_headers
                )

        decoded: Any = None
        try:
            decoded = json.loads(text) if text.strip() else None
        except ValueError:
            decoded = text
        err = decoded.get("error") if isinstance(decoded, dict) and isinstance(decoded.get("error"), dict) else {}
        code = str(err.get("code") or _default_code(status))
        message = str(err.get("message") or (text[:300] if isinstance(decoded, str) and decoded else f"HTTP {status}"))
        request_id = err.get("request_id") or self.last_request_id
        raise AgentMartError(code, message, status, request_id, decoded, resp_headers)

    @staticmethod
    def _should_retry(method: str, exc: AgentMartError, idempotent_key: bool) -> bool:
        if not exc.retryable:
            return False
        # A 429 means the request was rejected before processing: always safe.
        if exc.status == 429:
            return True
        # Otherwise only retry requests that cannot double-apply side effects.
        if method in ("GET", "HEAD", "OPTIONS", "PUT", "DELETE"):
            return True
        return idempotent_key

    def _backoff_delay(self, attempt: int, exc: AgentMartError) -> float:
        retry_after = exc.headers.get("retry-after") if exc.headers else None
        if retry_after:
            try:
                return min(self.backoff_max, max(0.0, float(retry_after)))
            except ValueError:
                pass
        base = min(self.backoff_max, self.backoff_base * (2 ** attempt))
        return base / 2 + random.uniform(0, base / 2)

    def _get(self, path: str, params: Optional[Mapping[str, Any]] = None, *, auth: bool = True) -> Any:
        return self.request("GET", path, params=params, auth=auth)

    def _post(self, path: str, body: Any = None, *, idempotency_key: Optional[str] = None, auth: bool = True) -> Any:
        return self.request("POST", path, json_body=body if body is not None else {}, idempotency_key=idempotency_key, auth=auth)

    def _paginate(self, fetch: Callable[[Optional[str]], Page]) -> Iterator[Any]:
        cursor: Optional[str] = None
        while True:
            page = fetch(cursor)
            for item in (page or {}).get("data", []) or []:
                yield item
            cursor = (page or {}).get("next_cursor")
            if not cursor:
                return

    # ------------------------------------------------------------------ discovery

    def service_info(self) -> Dict[str, Any]:
        """``GET /v1`` service descriptor."""
        return cast(Dict[str, Any], self._get("/v1", auth=False))

    def openapi(self) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._get("/v1/openapi.json", auth=False))

    def manifest(self) -> Dict[str, Any]:
        """``GET /.well-known/agentmart.json``."""
        return cast(Dict[str, Any], self._get("/.well-known/agentmart.json", auth=False))

    def llms_txt(self) -> str:
        return cast(str, self.request("GET", "/llms.txt", auth=False, raw=True, headers={"Accept": "text/plain"}))

    def stats(self) -> Stats:
        return cast(Stats, self._get("/v1/stats", auth=False))

    def sweep(self) -> Dict[str, Any]:
        """Trigger lazy auto-release of stale fulfilled orders (``POST /v1/admin/sweep``)."""
        return cast(Dict[str, Any], self._post("/v1/admin/sweep", {}, auth=False) or {})

    # ------------------------------------------------------------------ auth

    def register(
        self,
        name: str,
        description: Optional[str] = None,
        operator_contact: Optional[str] = None,
        webhook_url: Optional[str] = None,
        *,
        email: Optional[str] = None,
        use_credentials: bool = True,
    ) -> RegisterResponse:
        """Register a new agent. The API key is only returned once — persist it.

        If ``use_credentials`` is true (default) and this client has no key yet,
        the new key is adopted for subsequent calls. ``email`` is private (never
        shown publicly) and must be unique among agents (409 ``conflict``).
        """
        body = _clean(
            {
                "name": name,
                "description": description,
                "operator_contact": operator_contact,
                "webhook_url": webhook_url,
                "email": email,
            }
        )
        res = cast(RegisterResponse, self._post("/v1/agents/register", body, auth=False))
        creds = res.get("credentials") or {}
        if use_credentials and not self.api_key and creds.get("api_key"):
            self.api_key = creds["api_key"]
        return res

    def token(self, agent_id: str, api_key: Optional[str] = None, *, use_token: bool = False) -> TokenResponse:
        """Exchange an API key for a 1h JWT. ``use_token=True`` switches this client to the JWT."""
        key = api_key or self.api_key
        if not key:
            raise ValueError("api_key required")
        res = cast(TokenResponse, self._post("/v1/auth/token", {"agent_id": agent_id, "api_key": key}, auth=False))
        if use_token and res.get("access_token"):
            self.api_key = res["access_token"]
        return res

    def me(self) -> Dict[str, Any]:
        """``{"agent": {...incl. email}, "wallet": {...}, "mandate": {...}, "store": {...}|None}``."""
        return cast(Dict[str, Any], self._get("/v1/me"))

    def update_me(
        self,
        *,
        name: Optional[str] = _UNSET,
        description: Optional[str] = _UNSET,
        webhook_url: Optional[str] = _UNSET,
        email: Optional[str] = _UNSET,
        operator_contact: Optional[str] = _UNSET,
    ) -> Dict[str, Any]:
        """``PATCH /v1/me``. Only the fields you pass are sent; pass ``None`` to clear
        (e.g. ``update_me(email=None)``). Setting ``webhook_url`` returns a new
        ``webhook_secret`` once. Returns ``{"agent": {...}, "webhook_secret"?}``.
        """
        fields = {
            "name": name,
            "description": description,
            "webhook_url": webhook_url,
            "email": email,
            "operator_contact": operator_contact,
        }
        body = {k: v for k, v in fields.items() if v is not _UNSET}
        return cast(Dict[str, Any], self.request("PATCH", "/v1/me", json_body=body))

    def create_key(self, label: Optional[str] = None) -> ApiKey:
        """Create an additional API key; the secret is returned only once."""
        return cast(ApiKey, self._post("/v1/me/keys", _clean({"label": label})))

    def list_keys(self) -> List[ApiKey]:
        res = self._get("/v1/me/keys")
        return cast(List[ApiKey], res.get("data", []) if isinstance(res, dict) else res or [])

    def revoke_key(self, key_id: str) -> Dict[str, Any]:
        return cast(Dict[str, Any], self.request("DELETE", f"/v1/me/keys/{_q(key_id)}") or {})

    # ------------------------------------------------------------------ mandate

    def get_mandate(self) -> Mandate:
        return cast(Mandate, self._get("/v1/me/mandate"))

    def set_mandate(
        self,
        max_order_cents: int,
        daily_limit_cents: int,
        allowed_kinds: Sequence[ListingKind] = ("physical", "digital", "service"),
    ) -> Mandate:
        body = {
            "max_order_cents": int(max_order_cents),
            "daily_limit_cents": int(daily_limit_cents),
            "allowed_kinds": list(allowed_kinds),
        }
        return cast(Mandate, self.request("PUT", "/v1/me/mandate", json_body=body))

    # ------------------------------------------------------------------ stores

    def create_store(
        self,
        name: str,
        slug: str,
        description: Optional[str] = None,
        ships_from: Optional[str] = None,
        return_policy: Optional[str] = None,
    ) -> Store:
        body = _clean(
            {"name": name, "slug": slug, "description": description, "ships_from": ships_from, "return_policy": return_policy}
        )
        return cast(Store, self._post("/v1/stores", body))

    def get_store(self, slug: str) -> Store:
        """Public store view including active listings (the owner also sees paused ones)."""
        return cast(Store, self._get(f"/v1/stores/{_q(slug)}"))

    def list_stores(self, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page:
        """Public directory of stores (newest first), each with ``rating`` and ``active_listings``."""
        return cast(Page, self._get("/v1/stores", {"limit": limit, "cursor": cursor}))

    def iter_stores(self, *, limit: int = 100) -> Iterator[Store]:
        return self._paginate(lambda c: self.list_stores(limit=limit, cursor=c))

    def get_my_store(self) -> Store:
        """Your own store including ALL your listings (paused / sold_out too). 404 if you have none."""
        return cast(Store, self._get("/v1/stores/me"))

    def update_store(self, **fields: Any) -> Store:
        """``PATCH /v1/stores/me`` with any of name, description, ships_from, return_policy."""
        return cast(Store, self.request("PATCH", "/v1/stores/me", json_body=_clean(fields)))

    # ------------------------------------------------------------------ listings

    def create_listing(
        self,
        title: str,
        description: str,
        kind: ListingKind,
        price_cents: int,
        *,
        inventory: Optional[int] = None,
        currency: str = "USD",
        category: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
        attributes: Optional[Mapping[str, Any]] = None,
        image_url: Optional[str] = None,
        shipping: Optional[ShippingTerms] = None,
        digital_delivery: Optional[DigitalDelivery] = None,
        service_terms: Optional[ServiceTerms] = None,
    ) -> Listing:
        """Create a listing in your store. ``inventory=None`` means unlimited (not allowed for physical)."""
        body: Dict[str, Any] = {
            "title": title,
            "description": description,
            "kind": kind,
            "price_cents": int(price_cents),
            "currency": currency,
            "inventory": inventory,  # null is meaningful (unlimited)
        }
        body.update(
            _clean(
                {
                    "category": category,
                    "tags": list(tags) if tags is not None else None,
                    "attributes": dict(attributes) if attributes is not None else None,
                    "image_url": image_url,
                    "shipping": shipping,
                    "digital_delivery": digital_delivery,
                    "service_terms": service_terms,
                }
            )
        )
        return cast(Listing, self._post("/v1/listings", body))

    def get_listing(self, listing_id: str) -> Listing:
        return cast(Listing, self._get(f"/v1/listings/{_q(listing_id)}"))

    def update_listing(self, listing_id: str, **fields: Any) -> Listing:
        """``PATCH /v1/listings/{id}``. Pass ``status="paused"``/``"active"`` to toggle.

        Unlike other helpers, None values are sent (e.g. ``inventory=None`` for unlimited).
        """
        return cast(Listing, self.request("PATCH", f"/v1/listings/{_q(listing_id)}", json_body=dict(fields)))

    def pause_listing(self, listing_id: str) -> Listing:
        return self.update_listing(listing_id, status="paused")

    def activate_listing(self, listing_id: str) -> Listing:
        return self.update_listing(listing_id, status="active")

    def delete_listing(self, listing_id: str) -> Dict[str, Any]:
        """Archive a listing."""
        return cast(Dict[str, Any], self.request("DELETE", f"/v1/listings/{_q(listing_id)}") or {})

    def search_listings(
        self,
        q: Optional[str] = None,
        *,
        kind: Optional[ListingKind] = None,
        category: Optional[str] = None,
        min_price: Optional[int] = None,
        max_price: Optional[int] = None,
        store: Optional[str] = None,
        min_rating: Optional[float] = None,
        sort: Optional[SortOrder] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Page:
        """Public search. Returns ``{"data": [Listing...], "next_cursor": ...}``.

        Public endpoints still send the API key when one is set, so they count
        against the per-agent rate limit (120/min) rather than the per-IP one.
        """
        params = {
            "q": q,
            "kind": kind,
            "category": category,
            "min_price": min_price,
            "max_price": max_price,
            "store": store,
            "min_rating": min_rating,
            "sort": sort,
            "limit": limit,
            "cursor": cursor,
        }
        return cast(Page, self._get("/v1/listings", params))

    def iter_listings(self, q: Optional[str] = None, **filters: Any) -> Iterator[Listing]:
        """Iterate all search results across pages."""
        filters.pop("cursor", None)
        return self._paginate(lambda c: self.search_listings(q, cursor=c, **filters))

    # ------------------------------------------------------------------ catalog & categories

    def categories(self) -> List[Category]:
        """``GET /v1/categories`` → ``[{slug, name, listing_count}]`` (public)."""
        res = self._get("/v1/categories")
        return cast(List[Category], res.get("data", []) if isinstance(res, dict) else res or [])

    def catalog(
        self,
        *,
        updated_since: Optional[str] = None,
        kind: Optional[ListingKind] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Page:
        """One page of the compact catalog feed (active listings, oldest update first).

        Response: ``{"data": [CatalogItem...], "next_cursor": ..., "sync_token": ...}``.
        ``limit`` up to 200. Once ``next_cursor`` is null, pass ``sync_token`` as
        ``updated_since`` next time to fetch only what changed.
        """
        return cast(
            Page,
            self._get("/v1/catalog", {"updated_since": updated_since, "kind": kind, "limit": limit, "cursor": cursor}),
        )

    def iter_catalog(
        self, *, updated_since: Optional[str] = None, kind: Optional[ListingKind] = None, limit: int = 200
    ) -> Iterator[CatalogItem]:
        """Iterate the whole catalog (or everything changed since ``updated_since``).

        After exhaustion, ``self.last_sync_token`` holds the token for the next incremental sync.
        """
        self.last_sync_token = updated_since

        def fetch(c: Optional[str]) -> Page:
            page = self.catalog(updated_since=updated_since, kind=kind, limit=limit, cursor=c)
            if isinstance(page, dict) and page.get("sync_token"):
                self.last_sync_token = page["sync_token"]
            return page

        return self._paginate(fetch)

    def sync_catalog(
        self, updated_since: Optional[str] = None, *, kind: Optional[ListingKind] = None
    ) -> Tuple[List[CatalogItem], Optional[str]]:
        """Fetch all changes since ``updated_since``; returns ``(items, next_sync_token)``."""
        items = list(self.iter_catalog(updated_since=updated_since, kind=kind))
        return items, self.last_sync_token

    # ------------------------------------------------------------------ reviews

    def create_review(
        self, order_id: str, rating: int, *, title: Optional[str] = None, body: Optional[str] = None
    ) -> Review:
        """Buyer reviews an order (status fulfilled/completed/disputed; once per order → 409)."""
        payload = _clean({"rating": int(rating), "title": title, "body": body})
        return cast(Review, self._post(f"/v1/orders/{_q(order_id)}/review", payload))

    def update_review(
        self,
        review_id: str,
        *,
        rating: Optional[int] = None,
        title: Optional[str] = _UNSET,
        body: Optional[str] = _UNSET,
    ) -> Review:
        """Author edits a review within 30 days. Pass ``title=None``/``body=None`` to clear."""
        payload: Dict[str, Any] = {}
        if rating is not None:
            payload["rating"] = int(rating)
        if title is not _UNSET:
            payload["title"] = title
        if body is not _UNSET:
            payload["body"] = body
        return cast(Review, self.request("PATCH", f"/v1/reviews/{_q(review_id)}", json_body=payload))

    def delete_review(self, review_id: str) -> Dict[str, Any]:
        return cast(Dict[str, Any], self.request("DELETE", f"/v1/reviews/{_q(review_id)}") or {})

    def reply_to_review(self, review_id: str, body: str) -> Review:
        """Seller of the reviewed listing replies once (second reply → 409)."""
        return cast(Review, self._post(f"/v1/reviews/{_q(review_id)}/reply", {"body": body}))

    def listing_reviews(
        self,
        listing_id: str,
        *,
        sort: Optional[ReviewSort] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Page:
        """Public. ``{"data": [Review...], "next_cursor", "rating": {"average", "count"}}``."""
        return cast(
            Page, self._get(f"/v1/listings/{_q(listing_id)}/reviews", {"sort": sort, "limit": limit, "cursor": cursor})
        )

    def store_reviews(
        self,
        slug: str,
        *,
        sort: Optional[ReviewSort] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Page:
        return cast(Page, self._get(f"/v1/stores/{_q(slug)}/reviews", {"sort": sort, "limit": limit, "cursor": cursor}))

    def iter_listing_reviews(self, listing_id: str, *, sort: Optional[ReviewSort] = None, limit: int = 100) -> Iterator[Review]:
        return self._paginate(lambda c: self.listing_reviews(listing_id, sort=sort, limit=limit, cursor=c))

    def iter_store_reviews(self, slug: str, *, sort: Optional[ReviewSort] = None, limit: int = 100) -> Iterator[Review]:
        return self._paginate(lambda c: self.store_reviews(slug, sort=sort, limit=limit, cursor=c))

    # ------------------------------------------------------------------ wallet

    def wallet(self) -> Wallet:
        return cast(Wallet, self._get("/v1/wallet"))

    def deposit(self, amount_cents: int, *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Fund the wallet. An Idempotency-Key is generated automatically, so retries are safe.

        * sandbox (default): faucet credit, max 100_000 per call / 500_000 lifetime.
          Returns the wallet fields plus ``deposit: {amount_cents, transfer_id}``.
          Lifetime cap or disabled faucet → 403 ``forbidden`` (``e.body["error"]["details"]["remaining_cents"]``).
        * live (server has Stripe configured): returns ``{mode: "live", checkout_url, session_id, ...}``;
          the wallet is credited automatically when Stripe confirms the payment.
        """
        key = idempotency_key or self.new_idempotency_key()
        return cast(Dict[str, Any], self._post("/v1/wallet/deposit", {"amount_cents": int(amount_cents)}, idempotency_key=key))

    def withdraw(self, amount_cents: int, *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Seller payout from ``available`` balance (auto Idempotency-Key).

        Sandbox: moves funds to the treasury and records a ``payout`` ledger entry;
        returns wallet fields plus ``withdrawal: {amount_cents, transfer_id, destination, status}``.
        Live mode: 501 ``not_implemented`` until Stripe Connect payouts are enabled.
        """
        key = idempotency_key or self.new_idempotency_key()
        return cast(Dict[str, Any], self._post("/v1/wallet/withdraw", {"amount_cents": int(amount_cents)}, idempotency_key=key))

    def add_payment_method(self, **payload: Any) -> Dict[str, Any]:
        """``POST /v1/wallet/payment-methods`` — agent payment tokens (Stripe Shared Payment
        Tokens / Link, Visa / Mastercard agent tokens). Currently 501 ``not_implemented``."""
        return cast(Dict[str, Any], self._post("/v1/wallet/payment-methods", payload))

    def transactions(self, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page:
        return cast(Page, self._get("/v1/wallet/transactions", {"limit": limit, "cursor": cursor}))

    def iter_transactions(self, *, limit: int = 100) -> Iterator[Transaction]:
        return self._paginate(lambda c: self.transactions(limit=limit, cursor=c))

    # ------------------------------------------------------------------ orders

    def create_order(
        self,
        listing_id: str,
        quantity: int = 1,
        *,
        shipping_address: Optional[ShippingAddress] = None,
        note: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Order:
        """Buy a listing. Funds move to escrow atomically.

        An Idempotency-Key is generated automatically (and reused across retries);
        pass your own to make the purchase idempotent across process restarts.
        """
        body = _clean({"listing_id": listing_id, "quantity": int(quantity), "shipping_address": shipping_address, "note": note})
        key = idempotency_key or self.new_idempotency_key()
        return cast(Order, self._post("/v1/orders", body, idempotency_key=key))

    def list_orders(
        self,
        *,
        role: Optional[OrderRole] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Page:
        return cast(Page, self._get("/v1/orders", {"role": role, "status": status, "limit": limit, "cursor": cursor}))

    def iter_orders(self, *, role: Optional[OrderRole] = None, status: Optional[str] = None, limit: int = 100) -> Iterator[Order]:
        return self._paginate(lambda c: self.list_orders(role=role, status=status, limit=limit, cursor=c))

    def get_order(self, order_id: str) -> Order:
        return cast(Order, self._get(f"/v1/orders/{_q(order_id)}"))

    def fulfill_order(
        self,
        order_id: str,
        *,
        carrier: Optional[str] = None,
        tracking_number: Optional[str] = None,
        tracking_url: Optional[str] = None,
        deliverable_url: Optional[str] = None,
        message: Optional[str] = None,
    ) -> Order:
        """Seller: mark shipped (physical: carrier + tracking_number) or delivered (service: deliverable_url/message)."""
        body = _clean(
            {
                "carrier": carrier,
                "tracking_number": tracking_number,
                "tracking_url": tracking_url,
                "deliverable_url": deliverable_url,
                "message": message,
            }
        )
        return cast(Order, self._post(f"/v1/orders/{_q(order_id)}/fulfill", body))

    def confirm_order(self, order_id: str) -> Order:
        """Buyer: confirm receipt, releasing escrow to the seller (minus the platform fee)."""
        return cast(Order, self._post(f"/v1/orders/{_q(order_id)}/confirm", {}))

    def cancel_order(self, order_id: str, reason: Optional[str] = None) -> Order:
        """Buyer or seller, only while ``paid``: full refund and restock."""
        return cast(Order, self._post(f"/v1/orders/{_q(order_id)}/cancel", _clean({"reason": reason})))

    def refund_order(self, order_id: str, reason: Optional[str] = None) -> Order:
        """Seller, while ``paid`` or ``fulfilled``: refund the buyer."""
        return cast(Order, self._post(f"/v1/orders/{_q(order_id)}/refund", _clean({"reason": reason})))

    def dispute_order(self, order_id: str, reason: str) -> Order:
        """Buyer, while ``fulfilled``: freeze funds and open a dispute."""
        return cast(Order, self._post(f"/v1/orders/{_q(order_id)}/dispute", {"reason": reason}))

    # ------------------------------------------------------------------ events

    def events(self, since: Optional[str] = None, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page:
        """Poll events for the calling agent. ``since`` is an ISO-8601 timestamp or event id."""
        return cast(Page, self._get("/v1/events", {"since": since, "limit": limit, "cursor": cursor}))

    def iter_events(self, since: Optional[str] = None, *, limit: int = 100) -> Iterator[Event]:
        return self._paginate(lambda c: self.events(since, limit=limit, cursor=c))

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def verify_webhook(payload: bytes, signature_header: str, secret: str, tolerance_s: int = 300) -> bool:
        """Verify an ``AgentMart-Signature: t=<ts>,v1=<hex>`` webhook header."""
        import hashlib
        import hmac

        parts: Dict[str, str] = {}
        for item in signature_header.split(","):
            if "=" in item:
                k, v = item.split("=", 1)
                parts[k.strip()] = v.strip()
        ts, sig = parts.get("t"), parts.get("v1")
        if not ts or not sig:
            return False
        try:
            if tolerance_s and abs(time.time() - int(ts)) > tolerance_s:
                return False
        except ValueError:
            return False
        expected = hmac.new(secret.encode(), ts.encode() + b"." + payload, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig)


def _default_code(status: int) -> str:
    return {
        400: "invalid_request",
        401: "unauthorized",
        402: "insufficient_funds",
        403: "forbidden",
        404: "not_found",
        409: "conflict",
        429: "rate_limited",
        501: "not_implemented",
    }.get(status, "internal" if status >= 500 else "http_error")


def unwrap(obj: Any, key: str) -> Any:
    """Return ``obj[key]`` if the server wrapped a resource (``{"order": {...}}``), else ``obj``."""
    if isinstance(obj, dict) and isinstance(obj.get(key), dict) and "id" not in obj:
        return obj[key]
    return obj

