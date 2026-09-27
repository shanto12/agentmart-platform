#!/usr/bin/env python3
"""AgentMart production smoke test (stdlib only).

Exercises the full buyer/seller lifecycle against a live deployment with two
freshly registered agents (plus an outsider), and asserts wallet balances,
platform fees, the ledger, events, idempotency, mandates and access control.

    python3 tools/smoke_test.py                       # production
    API_BASE=http://127.0.0.1:54321/functions/v1/api python3 tools/smoke_test.py
    python3 tools/smoke_test.py --verbose --skip-mcp

Exit code 0 = all checks passed, 1 = at least one FAIL, 2 = aborted early.
Everything runs in sandbox mode; the test agents are left in place (named
"smoke-*") so failures can be inspected.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

DEFAULT_BASE = "https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api"

# Prices chosen so that 5% fees never land on .5 (no rounding-mode ambiguity).
DIGITAL_PRICE = 1999        # fee 99.95 -> 100
PHYSICAL_PRICE = 2500       # fee 125
PHYSICAL_SHIPPING = 500     # not subject to fee
SERVICE_PRICE = 4000        # fee 200
DEPOSIT = 100_000

TEST_ADDRESS = {
    "name": "Smoke Test Receiver", "line1": "1 Sandbox Way", "city": "Austin",
    "region": "TX", "postal_code": "78701", "country": "US",
}


def fee_of(subtotal: int) -> int:
    """5% rounded half-up (matches Math.round for positive numbers)."""
    return (subtotal * 5 + 50) // 100


# --------------------------------------------------------------------------- output

USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if USE_COLOR else s


class Results:
    def __init__(self, verbose: bool) -> None:
        self.verbose = verbose
        self.passed: List[str] = []
        self.failed: List[Tuple[str, str]] = []
        self.warnings: List[str] = []
        self.section = ""

    def start(self, name: str) -> None:
        self.section = name
        print(f"\n{_c('1', '== ' + name)}")

    def check(self, name: str, cond: bool, detail: Any = "") -> bool:
        label = f"{self.section}: {name}"
        if cond:
            self.passed.append(label)
            print(f"  {_c('32', 'PASS')} {name}")
        else:
            d = detail if isinstance(detail, str) else json.dumps(detail, default=str)[:600]
            self.failed.append((label, d))
            print(f"  {_c('31', 'FAIL')} {name}" + (f"\n       -> {d}" if d else ""))
        return cond

    def eq(self, name: str, actual: Any, expected: Any) -> bool:
        return self.check(f"{name} (= {expected!r})", actual == expected, f"expected {expected!r}, got {actual!r}")

    def warn(self, msg: str) -> None:
        self.warnings.append(f"{self.section}: {msg}")
        print(f"  {_c('33', 'WARN')} {msg}")

    def info(self, msg: str) -> None:
        if self.verbose:
            print(f"       {msg}")


# --------------------------------------------------------------------------- HTTP

class Resp:
    def __init__(self, status: int, headers: Dict[str, str], text: str) -> None:
        self.status = status
        self.headers = headers
        self.text = text
        try:
            self.json: Any = json.loads(text) if text.strip() else None
        except ValueError:
            self.json = None

    @property
    def error_code(self) -> Optional[str]:
        e = (self.json or {}).get("error") if isinstance(self.json, dict) else None
        return e.get("code") if isinstance(e, dict) else None

    def __repr__(self) -> str:
        return f"<{self.status} {self.text[:300]}>"


class Http:
    def __init__(self, base: str, verbose: bool, timeout: float = 30.0) -> None:
        self.base = base.rstrip("/")
        self.verbose = verbose
        self.timeout = timeout
        self.count = 0

    def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        key: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        idem: Optional[str] = None,
    ) -> Resp:
        url = self.base + path
        if params:
            url += "?" + urlparse.urlencode({k: v for k, v in params.items() if v is not None})
        h = {"Accept": "application/json", "User-Agent": "agentmart-smoke-test/1.0"}
        data = None
        if body is not None or method in ("POST", "PUT", "PATCH"):
            data = json.dumps(body if body is not None else {}).encode()
            h["Content-Type"] = "application/json"
        if key:
            h["Authorization"] = f"Bearer {key}"
        if idem:
            h["Idempotency-Key"] = idem
        h.update(headers or {})

        for attempt in range(6):
            self.count += 1
            req = urlrequest.Request(url, data=data, headers=h, method=method)
            try:
                with urlrequest.urlopen(req, timeout=self.timeout) as r:
                    resp = Resp(r.status, {k.lower(): v for k, v in r.headers.items()}, r.read().decode("utf-8", "replace"))
            except urlerror.HTTPError as e:
                resp = Resp(e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, e.read().decode("utf-8", "replace"))
            except (urlerror.URLError, TimeoutError, ConnectionError) as e:
                if attempt < 2 and method == "GET":
                    time.sleep(1 + attempt)
                    continue
                raise RuntimeError(f"network error on {method} {path}: {e}") from e
            if self.verbose:
                print(f"       {method} {path} -> {resp.status} {resp.text[:160]!r}")
            # Rate limited: the request was not processed, so retrying is always safe.
            if resp.status == 429 and attempt < 5:
                wait = float(resp.headers.get("retry-after") or (2 ** attempt))
                print(f"       (429 rate limited, sleeping {wait:.0f}s)")
                time.sleep(min(wait, 60))
                continue
            return resp
        return resp


def unwrap(obj: Any, key: str) -> Any:
    if isinstance(obj, dict) and isinstance(obj.get(key), dict) and "id" not in obj:
        return obj[key]
    return obj


def items(obj: Any) -> List[Any]:
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for k in ("data", "items", "results", "listings", "events", "keys"):
            if isinstance(obj.get(k), list):
                return obj[k]
    return []


class Abort(Exception):
    pass


def _parse_ts(value: str) -> float:
    """ISO-8601 (with Z or offset, optional fraction) -> epoch seconds."""
    from datetime import datetime, timezone

    v = value.strip().replace("Z", "+00:00")
    m = re.match(r"^(.*T\d{2}:\d{2}:\d{2})(\.\d+)?(.*)$", v)
    if m:  # normalise fractional seconds to 6 digits for fromisoformat on older Pythons
        frac = (m.group(2) or ".0")[1:7].ljust(6, "0")
        v = f"{m.group(1)}.{frac}{m.group(3)}"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


# --------------------------------------------------------------------------- smoke test

class Smoke:
    def __init__(self, base: str, verbose: bool, skip_mcp: bool) -> None:
        self.http = Http(base, verbose)
        self.r = Results(verbose)
        self.skip_mcp = skip_mcp
        self.run_id = uuid.uuid4().hex[:8]
        self.buyer: Dict[str, Any] = {}
        self.seller: Dict[str, Any] = {}
        self.outsider: Dict[str, Any] = {}
        self.store_slug = f"smoke-{self.run_id}"
        self.buyer_email = f"smoke-buyer-{self.run_id}@example.com"
        self.category = f"smoke-cat-{self.run_id}"
        self.reviews: Dict[str, Dict[str, Any]] = {}
        self.secret_payload = f"SMOKE-SECRET-{uuid.uuid4().hex}"
        self.tag = f"smoketag{self.run_id}"
        self.listings: Dict[str, Dict[str, Any]] = {}
        self.orders: Dict[str, Dict[str, Any]] = {}
        self.expected_fees = 0

    # -- helpers -----------------------------------------------------------

    def must(self, resp: Resp, status: Any, what: str) -> Any:
        ok_statuses = status if isinstance(status, (list, tuple, set)) else [status]
        if resp.status not in ok_statuses:
            self.r.check(f"{what} -> HTTP {ok_statuses}", False, f"got {resp.status}: {resp.text[:500]}")
            raise Abort(f"{what} failed with HTTP {resp.status}")
        return resp.json

    def expect_error(self, resp: Resp, statuses: Any, codes: Any, what: str) -> None:
        statuses = statuses if isinstance(statuses, (list, tuple)) else [statuses]
        codes = codes if isinstance(codes, (list, tuple)) else [codes]
        self.r.check(
            f"{what} -> {'/'.join(map(str, statuses))} {'/'.join(c for c in codes if c) or ''}".rstrip(),
            resp.status in statuses and (not any(codes) or resp.error_code in codes),
            f"got {resp.status} code={resp.error_code} body={resp.text[:300]}",
        )

    def wallet(self, agent: Dict[str, Any]) -> Dict[str, Any]:
        return self.must(self.http.call("GET", "/v1/wallet", key=agent["key"]), 200, "GET /v1/wallet")

    def order(self, agent: Dict[str, Any], oid: str) -> Dict[str, Any]:
        return unwrap(self.must(self.http.call("GET", f"/v1/orders/{oid}", key=agent["key"]), 200, f"GET order {oid}"), "order")

    def post_order(self, body: Dict[str, Any], idem: Optional[str] = None, agent: Optional[Dict[str, Any]] = None) -> Resp:
        return self.http.call("POST", "/v1/orders", body, key=(agent or self.buyer)["key"], idem=idem or f"smoke-{uuid.uuid4().hex}")

    def action(self, agent: Dict[str, Any], oid: str, act: str, body: Optional[Dict[str, Any]] = None) -> Resp:
        return self.http.call("POST", f"/v1/orders/{oid}/{act}", body or {}, key=agent["key"])

    def check_wallet(self, agent: Dict[str, Any], label: str, available: int, held: int) -> None:
        w = self.wallet(agent)
        self.r.eq(f"{label} available_cents", w.get("available_cents"), available)
        self.r.eq(f"{label} held_cents", w.get("held_cents"), held)

    # -- steps -------------------------------------------------------------

    def step_discovery(self) -> None:
        self.r.start("Discovery & public endpoints")
        for path in ("/v1", "/", "/.well-known/agentmart.json", "/v1/openapi.json"):
            resp = self.http.call("GET", path)
            self.r.check(f"GET {path} -> 200 JSON", resp.status == 200 and isinstance(resp.json, dict), resp)
        resp = self.http.call("GET", "/v1/openapi.json")
        if isinstance(resp.json, dict):
            self.r.check("openapi version 3.1.x", str(resp.json.get("openapi", "")).startswith("3.1"), resp.json.get("openapi"))
            self.r.check("openapi documents /v1/orders", any("/v1/orders" in p for p in (resp.json.get("paths") or {})), list(resp.json.get("paths") or {})[:20])
        resp = self.http.call("GET", "/llms.txt", headers={"Accept": "text/plain"})
        self.r.check("GET /llms.txt -> 200 non-empty text", resp.status == 200 and len(resp.text) > 50, resp)
        resp = self.http.call("GET", "/v1/stats")
        ok = resp.status == 200 and isinstance(resp.json, dict)
        self.r.check("GET /v1/stats -> 200", ok, resp)
        if ok:
            for k in ("agents", "stores", "active_listings", "orders_completed", "gmv_cents"):
                self.r.check(f"stats.{k} is int", isinstance(resp.json.get(k), int), resp.json)
            self.stats_before = resp.json
        self.r.check("X-Request-Id header present", bool(resp.headers.get("x-request-id")), resp.headers)

        pre = self.http.call("OPTIONS", "/v1/listings", headers={
            "Origin": "https://example.com", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
        })
        self.r.check("CORS preflight 2xx", 200 <= pre.status < 300, pre)
        self.r.check("CORS allow-origin *", pre.headers.get("access-control-allow-origin") == "*", pre.headers)
        allow_h = (pre.headers.get("access-control-allow-headers") or "").lower()
        self.r.check("CORS allows idempotency-key", "idempotency-key" in allow_h or allow_h == "*", allow_h)

        resp = self.http.call("GET", "/v1/me")
        self.expect_error(resp, 401, "unauthorized", "GET /v1/me without auth")
        err = (resp.json or {}).get("error") if isinstance(resp.json, dict) else None
        self.r.check("error envelope has code/message/request_id",
                     isinstance(err, dict) and all(err.get(k) for k in ("code", "message", "request_id")), resp.json)
        resp = self.http.call("GET", "/v1/me", key="am_live_" + "0" * 48)
        self.expect_error(resp, 401, "unauthorized", "GET /v1/me with bogus key")
        resp = self.http.call("GET", "/v1/listings/lst_doesnotexist000000000")
        self.expect_error(resp, 404, "not_found", "GET unknown listing")

    def _register(self, role: str, email: Optional[str] = None) -> Dict[str, Any]:
        body = {"name": f"smoke-{role}-{self.run_id}", "description": f"Smoke test {role} agent (automated, safe to ignore)"}
        if email:
            body["email"] = email
        res = self.must(self.http.call("POST", "/v1/agents/register", body), 201, f"register {role}")
        creds = (res or {}).get("credentials") or {}
        agent = (res or {}).get("agent") or {}
        key = creds.get("api_key", "")
        self.r.check(f"{role}: api_key format am_live_<48 hex>", bool(re.fullmatch(r"am_live_[0-9a-f]{48}", key)), key[:14] + "...")
        self.r.check(f"{role}: agent_id prefixed agt_", str(creds.get("agent_id", "")).startswith("agt_"), creds.get("agent_id"))
        self.r.check(f"{role}: key_id prefixed key_", str(creds.get("key_id", "")).startswith("key_"), creds.get("key_id"))
        self.r.check(f"{role}: agent object returned", isinstance(agent, dict) and agent.get("id") == creds.get("agent_id"), agent)
        return {"id": creds.get("agent_id"), "key": key, "key_id": creds.get("key_id"), "role": role}

    def step_register(self) -> None:
        self.r.start("Register agents & auth")
        resp = self.http.call("POST", "/v1/agents/register", {"description": "no name"})
        self.expect_error(resp, 400, "invalid_request", "register without name")
        self.seller = self._register("seller")
        self.buyer = self._register("buyer", email=self.buyer_email.replace("smoke", "SMOKE", 1))  # mixed case on purpose
        self.outsider = self._register("outsider")

        dup = self.http.call("POST", "/v1/agents/register", {"name": f"smoke-dup-{self.run_id}", "email": self.buyer_email})
        self.expect_error(dup, 409, "conflict", "register with an email already in use (case-insensitive)")
        bad_email = self.http.call("POST", "/v1/agents/register", {"name": f"smoke-bad-{self.run_id}", "email": "not-an-email"})
        self.expect_error(bad_email, 400, "invalid_request", "register with invalid email")

        tok = self.http.call("POST", "/v1/auth/token", {"agent_id": self.buyer["id"], "api_key": self.buyer["key"]})
        tj = self.must(tok, 200, "POST /v1/auth/token")
        self.r.check("token_type Bearer, expires_in 3600",
                     tj.get("token_type") == "Bearer" and tj.get("expires_in") == 3600, tj)
        jwt = tj.get("access_token", "")
        self.r.check("access_token looks like a JWT", jwt.count(".") == 2, jwt[:20])
        me = self.must(self.http.call("GET", "/v1/me", key=jwt), 200, "GET /v1/me with JWT")
        self.r.check("GET /v1/me (JWT) returns buyer", self.buyer["id"] in json.dumps(me), me)
        bad = self.http.call("POST", "/v1/auth/token", {"agent_id": self.buyer["id"], "api_key": self.seller["key"]})
        self.expect_error(bad, 401, "unauthorized", "token with another agent's key")

        me = self.http.call("GET", "/v1/me", key=self.buyer["key"])
        self.must(me, 200, "GET /v1/me with api key")
        self.r.check("X-RateLimit-Limit header on authed response", bool(me.headers.get("x-ratelimit-limit")), me.headers)
        self.r.check("X-RateLimit-Remaining header on authed response", me.headers.get("x-ratelimit-remaining") is not None, me.headers)
        mj = me.json or {}
        self.r.check("GET /v1/me shape {agent, wallet, mandate, store}", all(k in mj for k in ("agent", "wallet", "mandate", "store")), list(mj))
        self.r.check("GET /v1/me wallet/mandate populated",
                     "available_cents" in (mj.get("wallet") or {}) and "max_order_cents" in (mj.get("mandate") or {}), mj)
        self.r.eq("GET /v1/me store is null before creating one", mj.get("store", "missing"), None)
        self.r.eq("GET /v1/me agent.email (lower-cased)", (mj.get("agent") or {}).get("email"), self.buyer_email)
        other = self.must(self.http.call("GET", "/v1/me", key=self.seller["key"]), 200, "seller GET /v1/me")
        self.r.eq("agent without email has email null", ((other or {}).get("agent") or {}).get("email", "missing"), None)

        upd = self.http.call("PATCH", "/v1/me", {"description": f"updated-{self.run_id}"}, key=self.buyer["key"])
        self.must(upd, 200, "PATCH /v1/me")
        me2 = self.http.call("GET", "/v1/me", key=self.buyer["key"])
        self.r.check("PATCH /v1/me persisted", f"updated-{self.run_id}" in me2.text, me2.text[:300])
        new_email = f"smoke-seller-{self.run_id}@example.com"
        pe = self.http.call("PATCH", "/v1/me", {"email": new_email}, key=self.seller["key"])
        self.r.eq("PATCH /v1/me sets email", (unwrap(self.must(pe, 200, "PATCH email"), "agent") or {}).get("email"), new_email)
        pe = self.http.call("PATCH", "/v1/me", {"email": self.buyer_email}, key=self.seller["key"])
        self.expect_error(pe, 409, "conflict", "PATCH /v1/me email taken by another agent")
        pe = self.http.call("PATCH", "/v1/me", {"email": None}, key=self.seller["key"])
        self.r.eq("PATCH /v1/me email=null clears it", (unwrap(self.must(pe, 200, "clear email"), "agent") or {}).get("email", "missing"), None)
        pe = self.http.call("PATCH", "/v1/me", {"email": new_email}, key=self.seller["key"])
        self.must(pe, 200, "re-set seller email")
        bad_hook = self.http.call("PATCH", "/v1/me", {"webhook_url": "http://insecure.example.com/hook"}, key=self.buyer["key"])
        self.expect_error(bad_hook, 400, "invalid_request", "PATCH /v1/me non-https webhook_url")

        mandate = self.must(self.http.call("GET", "/v1/me/mandate", key=self.buyer["key"]), 200, "GET mandate")
        mandate = unwrap(mandate, "mandate")
        self.r.eq("default mandate max_order_cents", mandate.get("max_order_cents"), 50_000)
        self.r.eq("default mandate daily_limit_cents", mandate.get("daily_limit_cents"), 200_000)
        self.r.eq("default mandate allowed_kinds", sorted(mandate.get("allowed_kinds") or []), ["digital", "physical", "service"])

    def step_keys(self) -> None:
        self.r.start("API key management")
        raw = self.must(self.http.call("POST", "/v1/me/keys", {"label": "smoke"}, key=self.buyer["key"]), [200, 201], "create extra key") or {}
        created = unwrap(raw, "key")
        secret = raw.get("api_key") or created.get("api_key") or raw.get("secret") or (raw.get("credentials") or {}).get("api_key")
        kid = created.get("key_id") or created.get("id") or raw.get("key_id")
        self.r.check("new key secret returned once (am_live_)", bool(secret and str(secret).startswith("am_live_")), created)
        self.r.check("new key id prefixed key_", str(kid or "").startswith("key_"), created)
        lst = self.must(self.http.call("GET", "/v1/me/keys", key=self.buyer["key"]), 200, "list keys")
        self.r.check("key list contains >= 2 keys", len(items(lst)) >= 2, lst)
        self.r.check("key list never exposes secrets", secret not in json.dumps(lst) and self.buyer["key"] not in json.dumps(lst), "secret leaked")
        ok = self.http.call("GET", "/v1/me", key=secret)
        self.r.check("new key authenticates", ok.status == 200, ok)
        rv = self.http.call("DELETE", f"/v1/me/keys/{kid}", key=self.buyer["key"])
        self.r.check("revoke extra key -> 2xx", 200 <= rv.status < 300, rv)
        after = self.http.call("GET", "/v1/me", key=secret)
        self.expect_error(after, 401, "unauthorized", "revoked key rejected")
        last = self.http.call("DELETE", f"/v1/me/keys/{self.seller['key_id']}", key=self.seller["key"])
        self.expect_error(last, [400, 409], ["conflict", "invalid_request"], "revoking last active key is refused")
        still = self.http.call("GET", "/v1/me", key=self.seller["key"])
        self.r.check("seller key still works after refused revoke", still.status == 200, still)

    def step_wallet(self) -> None:
        self.r.start("Sandbox wallet & idempotent deposit")
        self.check_wallet(self.buyer, "new buyer", 0, 0)
        w = self.wallet(self.buyer)
        if w.get("mode") == "live":
            self.r.check("API is in sandbox mode (smoke test needs the faucet)", False, w)
            raise Abort("wallet mode is 'live' (STRIPE_SECRET_KEY set); run the smoke test against a sandbox deployment")
        self.r.eq("wallet mode", w.get("mode"), "sandbox")
        self.r.eq("wallet currency", w.get("currency"), "USD")

        too_big = self.http.call("POST", "/v1/wallet/deposit", {"amount_cents": 100_001}, key=self.buyer["key"], idem=f"smoke-{uuid.uuid4().hex}")
        self.expect_error(too_big, 400, "invalid_request", "deposit over per-call max")
        neg = self.http.call("POST", "/v1/wallet/deposit", {"amount_cents": -5}, key=self.buyer["key"], idem=f"smoke-{uuid.uuid4().hex}")
        self.expect_error(neg, 400, "invalid_request", "negative deposit")

        idem = f"smoke-dep-{uuid.uuid4().hex}"
        d1 = self.http.call("POST", "/v1/wallet/deposit", {"amount_cents": DEPOSIT}, key=self.buyer["key"], idem=idem)
        self.must(d1, [200, 201], "deposit")
        d2 = self.http.call("POST", "/v1/wallet/deposit", {"amount_cents": DEPOSIT}, key=self.buyer["key"], idem=idem)
        self.r.check("deposit replay with same Idempotency-Key -> same status", d2.status == d1.status, (d1.status, d2.status))
        self.r.check("deposit replay returns identical body", d2.json == d1.json, {"first": d1.json, "replay": d2.json})
        dj = d1.json or {}
        self.r.eq("deposit response has wallet available_cents", dj.get("available_cents"), DEPOSIT)
        self.r.eq("deposit response deposit.amount_cents", (dj.get("deposit") or {}).get("amount_cents"), DEPOSIT)
        self.r.check("deposit response deposit.transfer_id", bool((dj.get("deposit") or {}).get("transfer_id")), dj)
        d3 = self.http.call("POST", "/v1/wallet/deposit", {"amount_cents": 777}, key=self.buyer["key"], idem=idem)
        self.expect_error(d3, 409, "conflict", "same Idempotency-Key with a different body")
        self.check_wallet(self.buyer, "buyer after deposit (+replay)", DEPOSIT, 0)
        self.check_wallet(self.seller, "seller initial", 0, 0)

    def step_store_and_listings(self) -> None:
        self.r.start("Store & listings")
        s = self.http.call("POST", "/v1/stores", {"name": f"Smoke Store {self.run_id}", "slug": self.store_slug,
                                                  "description": "Automated smoke test store", "ships_from": "US",
                                                  "return_policy": "Sandbox"}, key=self.seller["key"])
        store = unwrap(self.must(s, 201, "create store"), "store")
        self.r.eq("store slug", store.get("slug"), self.store_slug)
        dup = self.http.call("POST", "/v1/stores", {"name": "Second", "slug": f"{self.store_slug}-2"}, key=self.seller["key"])
        self.expect_error(dup, 409, "conflict", "second store for same agent")
        taken = self.http.call("POST", "/v1/stores", {"name": "Squat", "slug": self.store_slug}, key=self.buyer["key"])
        self.expect_error(taken, 409, "conflict", "slug already taken")
        badslug = self.http.call("POST", "/v1/stores", {"name": "Bad", "slug": "Bad Slug!"}, key=self.outsider["key"])
        self.expect_error(badslug, 400, "invalid_request", "invalid slug")
        nostore = self.http.call("POST", "/v1/listings", {"title": "x", "description": "x", "kind": "digital",
                                                          "price_cents": 100, "currency": "USD", "inventory": None},
                                 key=self.buyer["key"])
        self.expect_error(nostore, [400, 403, 404, 409], None, "create listing without a store")

        pu = self.http.call("PATCH", "/v1/stores/me", {"description": f"patched-{self.run_id}"}, key=self.seller["key"])
        self.must(pu, 200, "PATCH /v1/stores/me")

        common = {"currency": "USD", "tags": [self.tag, "smoke"], "category": self.category}
        specs = {
            "digital": {**common, "title": f"Smoke Digital {self.run_id}", "description": "Digital good for smoke test",
                        "kind": "digital", "price_cents": DIGITAL_PRICE, "inventory": None,
                        "digital_delivery": {"type": "text", "payload": self.secret_payload}},
            "physical": {**common, "title": f"Smoke Physical {self.run_id}", "description": "Physical good for smoke test",
                         "kind": "physical", "price_cents": PHYSICAL_PRICE, "inventory": 2,
                         "shipping": {"handling_days": 1, "ships_to": ["US"], "shipping_cents": PHYSICAL_SHIPPING}},
            "service": {**common, "title": f"Smoke Service {self.run_id}", "description": "Service for smoke test",
                        "kind": "service", "price_cents": SERVICE_PRICE, "inventory": None,
                        "service_terms": {"turnaround_days": 1, "deliverable": "A smoke report"}},
            "pricey": {**common, "title": f"Smoke Pricey {self.run_id}", "description": "Too expensive for the buyer",
                       "kind": "service", "price_cents": 200_000, "inventory": None,
                       "service_terms": {"turnaround_days": 1, "deliverable": "Nothing"}},
        }
        for name, spec in specs.items():
            lst = unwrap(self.must(self.http.call("POST", "/v1/listings", spec, key=self.seller["key"]), 201, f"create {name} listing"), "listing")
            self.listings[name] = lst
            self.r.check(f"{name} listing id lst_ + status active",
                         str(lst.get("id", "")).startswith("lst_") and lst.get("status") == "active", lst)

        # validation
        bad_cases = [
            ("price below 50", {**specs["service"], "price_cents": 10}),
            ("physical without inventory", {**specs["physical"], "inventory": None}),
            ("unknown kind", {**specs["service"], "kind": "weapon"}),
            ("title > 140 chars", {**specs["service"], "title": "x" * 141}),
            ("non-USD currency", {**specs["service"], "currency": "EUR"}),
            ("> 10 tags", {**specs["service"], "tags": [f"t{i}" for i in range(11)]}),
            ("http image_url", {**specs["service"], "image_url": "http://example.com/a.png"}),
        ]
        for label, body in bad_cases:
            resp = self.http.call("POST", "/v1/listings", body, key=self.seller["key"])
            self.expect_error(resp, 400, "invalid_request", f"reject listing: {label}")

        # public views never leak the digital payload
        dig = self.http.call("GET", f"/v1/listings/{self.listings['digital']['id']}")
        dj = unwrap(self.must(dig, 200, "GET digital listing (public)"), "listing")
        self.r.check("public listing hides digital payload", self.secret_payload not in dig.text, "payload leaked!")
        rd = dj.get("agent_readiness")
        self.r.check("listing has agent_readiness 0..100", isinstance(rd, (int, float)) and 0 <= rd <= 100, rd)
        self.r.check("listing has seller summary", isinstance(dj.get("seller"), dict) or "seller" in json.dumps(dj), list(dj))
        self.r.check("listing seller summary never exposes email", f"smoke-seller-{self.run_id}@" not in dig.text, "email leaked")
        self.r.eq("new listing rating {average: null, count: 0}", dj.get("rating"), {"average": None, "count": 0})
        purchase = dj.get("purchase") or {}
        self.r.eq("listing purchase.endpoint hint", purchase.get("endpoint"), "POST /v1/orders")
        self.r.check("listing purchase.required_fields lists listing_id",
                     "listing_id" in json.dumps(purchase.get("required_fields")), purchase)
        phys = unwrap(self.http.call("GET", f"/v1/listings/{self.listings['physical']['id']}").json, "listing") or {}
        self.r.check("physical purchase hint requires shipping_address",
                     "shipping_address" in json.dumps((phys.get("purchase") or {}).get("required_fields")), phys.get("purchase"))

        found = self.http.call("GET", "/v1/listings", params={"q": self.tag, "limit": 50})
        fj = self.must(found, 200, "search by unique tag")
        ids = {x.get("id") for x in items(fj)}
        self.r.check("full-text search finds all 4 listings", {l["id"] for l in self.listings.values()} <= ids, sorted(ids))
        self.r.check("search results hide digital payload", self.secret_payload not in found.text, "payload leaked!")
        self.r.check("search response has next_cursor key", isinstance(fj, dict) and "next_cursor" in fj, list(fj) if isinstance(fj, dict) else fj)
        byk = self.http.call("GET", "/v1/listings", params={"store": self.store_slug, "kind": "physical"})
        kids = [x.get("id") for x in items(byk.json)]
        self.r.check("filter store+kind=physical", kids == [self.listings["physical"]["id"]], kids)
        asc = self.http.call("GET", "/v1/listings", params={"store": self.store_slug, "sort": "price_asc", "limit": 10})
        prices = [x.get("price_cents") for x in items(asc.json)]
        self.r.check("sort=price_asc ordered", prices == sorted(prices) and len(prices) == 4, prices)
        rng = self.http.call("GET", "/v1/listings", params={"store": self.store_slug, "min_price": 2000, "max_price": 3000})
        self.r.check("min_price/max_price filter", [x.get("id") for x in items(rng.json)] == [self.listings["physical"]["id"]],
                     [x.get("price_cents") for x in items(rng.json)])
        page1 = self.http.call("GET", "/v1/listings", params={"store": self.store_slug, "limit": 2, "sort": "price_asc"})
        p1 = page1.json or {}
        if p1.get("next_cursor"):
            page2 = self.http.call("GET", "/v1/listings", params={"store": self.store_slug, "limit": 2, "sort": "price_asc", "cursor": p1["next_cursor"]})
            both = [x.get("id") for x in items(p1)] + [x.get("id") for x in items(page2.json)]
            self.r.check("cursor pagination returns disjoint pages covering all", len(set(both)) == 4, both)
        else:
            self.r.check("limit=2 yields next_cursor", False, p1)

        st = self.http.call("GET", f"/v1/stores/{self.store_slug}")
        self.must(st, 200, "GET store (public)")
        self.r.check("public store lists its listings", all(l["id"] in st.text for l in self.listings.values()), st.text[:300])
        self.r.check("public store hides digital payload", self.secret_payload not in st.text, "payload leaked!")

        me = self.must(self.http.call("GET", "/v1/me", key=self.seller["key"]), 200, "seller GET /v1/me")
        self.r.eq("GET /v1/me store populated after creation", ((me or {}).get("store") or {}).get("slug"), self.store_slug)
        mine = unwrap(self.must(self.http.call("GET", "/v1/stores/me", key=self.seller["key"]), 200, "GET /v1/stores/me"), "store") or {}
        self.r.eq("GET /v1/stores/me slug", mine.get("slug"), self.store_slug)
        self.r.check("GET /v1/stores/me lists own listings", all(l["id"] in json.dumps(mine) for l in self.listings.values()), list(mine))
        ns = self.http.call("GET", "/v1/stores/me", key=self.buyer["key"])
        self.expect_error(ns, 404, "not_found", "GET /v1/stores/me without a store")
        sl = self.must(self.http.call("GET", "/v1/stores", params={"limit": 100}), 200, "GET /v1/stores (public)")
        self.r.check("store directory is paginated {data, next_cursor}", isinstance(sl, dict) and "next_cursor" in sl, list(sl or {}))
        self.r.check("store directory includes new store (newest first)", self.store_slug in json.dumps(items(sl)), [x.get("slug") for x in items(sl)][:5])
        self.step_discovery_v11()

        foreign = self.http.call("PATCH", f"/v1/listings/{self.listings['service']['id']}", {"price_cents": 51}, key=self.buyer["key"])
        self.expect_error(foreign, [403, 404], ["forbidden", "not_found"], "non-owner cannot PATCH listing")

    def step_discovery_v11(self) -> None:
        """Categories + catalog feed (called at the end of the store step, while all 4 listings are active)."""
        self.r.start("Categories & catalog feed")
        cats = self.must(self.http.call("GET", "/v1/categories"), 200, "GET /v1/categories")
        rows = items(cats)
        self.r.check("categories are {slug, name, listing_count}",
                     bool(rows) and all({"slug", "name", "listing_count"} <= set(c) for c in rows), rows[:3])
        mine = [c for c in rows if c.get("slug") == self.category]
        self.r.check("category slug derived from listings", len(mine) == 1, [c.get("slug") for c in rows][:20])
        if mine:
            self.r.eq("category listing_count", mine[0].get("listing_count"), 4)

        stamps = [l.get("updated_at") or l.get("created_at") for l in self.listings.values()]
        if all(stamps):
            # Start just before our oldest listing (server clock), so the feed is small.
            t0 = min(stamps)
            since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(_parse_ts(t0) - 2)) + "Z"
        else:
            self.r.warn("listing objects carry no updated_at/created_at; syncing the last 10 minutes by client clock")
            since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 600))
        feed, token, pages = [], None, 0
        cursor = None
        while pages < 50:
            q: Dict[str, Any] = {"updated_since": since, "limit": 200}
            if cursor:
                q["cursor"] = cursor
            page = self.must(self.http.call("GET", "/v1/catalog", params=q), 200, "GET /v1/catalog")
            feed.extend(items(page))
            token = page.get("sync_token") or token
            cursor = page.get("next_cursor")
            pages += 1
            if not cursor:
                break
        ours = {x.get("id"): x for x in feed if x.get("store_slug") == self.store_slug}
        self.r.check("catalog feed (updated_since) contains all 4 new listings", set(ours) == {l["id"] for l in self.listings.values()}, sorted(ours))
        sample = ours.get(self.listings["physical"]["id"]) or {}
        need = {"id", "title", "kind", "price_cents", "currency", "shipping_cents", "inventory", "rating", "category", "store_slug", "url", "updated_at"}
        self.r.check("catalog items are compact objects with all fields", need <= set(sample), sorted(need - set(sample)))
        self.r.eq("catalog shipping_cents (physical)", sample.get("shipping_cents"), PHYSICAL_SHIPPING)
        self.r.check("catalog item url points at listing", str(sample.get("url", "")).endswith(f"/v1/listings/{self.listings['physical']['id']}"), sample.get("url"))
        self.r.check("catalog never includes digital payload", self.secret_payload not in json.dumps(feed), "payload leaked")
        upd = [x.get("updated_at") or "" for x in feed]
        self.r.check("catalog ordered by updated_at ascending", upd == sorted(upd), upd[:5])
        self.r.check("catalog returns sync_token", bool(token), token)
        big = self.http.call("GET", "/v1/catalog", params={"limit": 201})
        self.expect_error(big, 400, "invalid_request", "catalog limit > 200")
        badts = self.http.call("GET", "/v1/catalog", params={"updated_since": "yesterday-ish"})
        self.expect_error(badts, 400, "invalid_request", "catalog invalid updated_since")
        if token:
            time.sleep(1.1)  # make sure the next update gets a strictly later timestamp
            p = self.http.call("PATCH", f"/v1/listings/{self.listings['service']['id']}",
                               {"description": f"Service for smoke test (updated {self.run_id})"}, key=self.seller["key"])
            self.must(p, 200, "PATCH listing description")
            inc = self.must(self.http.call("GET", "/v1/catalog", params={"updated_since": token, "limit": 200}), 200, "incremental catalog")
            ids = [x.get("id") for x in items(inc)]
            self.r.check("incremental sync returns the updated listing", self.listings["service"]["id"] in ids, ids[:10])
            self.r.check("incremental sync omits unchanged listings", self.listings["digital"]["id"] not in ids, ids[:10])

    def step_reviews(self) -> None:
        self.r.start("Reviews & ratings")
        phys, svc_a, svc_c = self.orders["physical"], self.orders["service_a"], self.orders["service_c"]
        post = lambda agent, oid, body: self.http.call("POST", f"/v1/orders/{oid}/review", body, key=agent["key"])

        self.expect_error(post(self.buyer, phys["id"], {"rating": 6}), 400, "invalid_request", "rating out of range")
        self.expect_error(post(self.buyer, phys["id"], {"rating": 4.5}), 400, "invalid_request", "non-integer rating")
        self.expect_error(post(self.buyer, phys["id"], {"rating": 5, "title": "x" * 121}), 400, "invalid_request", "title > 120 chars")
        self.expect_error(post(self.seller, phys["id"], {"rating": 5}), 403, "forbidden", "seller cannot review own sale")
        self.expect_error(post(self.outsider, phys["id"], {"rating": 1}), [403, 404], ["forbidden", "not_found"], "outsider cannot review")
        self.expect_error(post(self.buyer, svc_a["id"], {"rating": 3}), 409, "conflict", "cannot review a cancelled order")

        r1 = post(self.buyer, phys["id"], {"rating": 5, "title": "Great mug", "body": f"Arrived fine ({self.run_id})"})
        rv = unwrap(self.must(r1, 201, "review completed physical order"), "review")
        self.reviews["physical"] = rv
        self.r.check("review fields", rv.get("rating") == 5 and rv.get("order_id") == phys["id"]
                     and rv.get("listing_id") == self.listings["physical"]["id"] and rv.get("store_slug") == self.store_slug, rv)
        self.r.eq("verified_purchase", rv.get("verified_purchase"), True)
        self.r.eq("reviewer.agent_id", (rv.get("reviewer") or {}).get("agent_id"), self.buyer["id"])
        self.r.eq("seller_reply initially null", rv.get("seller_reply", "missing"), None)
        self.expect_error(post(self.buyer, phys["id"], {"rating": 4}), 409, "conflict", "second review for same order")

        r2 = post(self.buyer, svc_c["id"], {"rating": 2, "title": "Incomplete", "body": "Opened a dispute"})
        self.reviews["service"] = unwrap(self.must(r2, 201, "review disputed service order"), "review")

        lr = self.must(self.http.call("GET", f"/v1/listings/{self.listings['physical']['id']}/reviews"), 200, "GET listing reviews")
        self.r.check("listing reviews list contains the review", rv["id"] in [x.get("id") for x in items(lr)], lr)
        self.r.eq("listing reviews rating summary", (lr or {}).get("rating"), {"average": 5.0, "count": 1})
        pl = unwrap(self.http.call("GET", f"/v1/listings/{self.listings['physical']['id']}").json, "listing") or {}
        self.r.eq("listing.rating after review", pl.get("rating"), {"average": 5.0, "count": 1})

        pr = self.http.call("PATCH", f"/v1/reviews/{rv['id']}", {"rating": 4, "body": "Still good; handle a bit small"}, key=self.buyer["key"])
        self.r.eq("author edits review rating", unwrap(self.must(pr, 200, "PATCH review"), "review").get("rating"), 4)
        self.expect_error(self.http.call("PATCH", f"/v1/reviews/{rv['id']}", {"rating": 1}, key=self.seller["key"]),
                          403, "forbidden", "non-author cannot edit review")
        self.expect_error(self.http.call("PATCH", f"/v1/reviews/{rv['id']}", {}, key=self.buyer["key"]),
                          400, "invalid_request", "empty review update")
        pl = unwrap(self.http.call("GET", f"/v1/listings/{self.listings['physical']['id']}").json, "listing") or {}
        self.r.eq("listing.rating recomputed after edit", pl.get("rating"), {"average": 4.0, "count": 1})

        rp = self.http.call("POST", f"/v1/reviews/{rv['id']}/reply", {"body": "Thanks! Bigger mug coming soon."}, key=self.seller["key"])
        rj = unwrap(self.must(rp, [200, 201], "seller replies"), "review")
        self.r.check("reply stored as seller_reply {body, created_at}",
                     (rj.get("seller_reply") or {}).get("body", "").startswith("Thanks!") and bool((rj.get("seller_reply") or {}).get("created_at")), rj.get("seller_reply"))
        self.expect_error(self.http.call("POST", f"/v1/reviews/{rv['id']}/reply", {"body": "again"}, key=self.seller["key"]),
                          409, "conflict", "second seller reply")
        self.expect_error(self.http.call("POST", f"/v1/reviews/{rv['id']}/reply", {"body": "me too"}, key=self.buyer["key"]),
                          403, "forbidden", "non-seller cannot reply")

        sr = self.must(self.http.call("GET", f"/v1/stores/{self.store_slug}/reviews", params={"sort": "lowest"}), 200, "GET store reviews")
        ratings = [x.get("rating") for x in items(sr)]
        self.r.eq("store reviews sort=lowest", ratings, [2, 4])
        self.r.eq("store rating summary", (sr or {}).get("rating"), {"average": 3.0, "count": 2})
        hi = self.http.call("GET", f"/v1/stores/{self.store_slug}/reviews", params={"sort": "highest"})
        self.r.eq("store reviews sort=highest", [x.get("rating") for x in items(hi.json)], [4, 2])
        st = unwrap(self.http.call("GET", f"/v1/stores/{self.store_slug}").json, "store") or {}
        self.r.eq("store.rating", st.get("rating"), {"average": 3.0, "count": 2})

        mr = self.http.call("GET", "/v1/listings", params={"store": self.store_slug, "min_rating": 3})
        self.r.eq("search min_rating=3 filter", [x.get("id") for x in items(mr.json)], [self.listings["physical"]["id"]])
        sr2 = self.http.call("GET", "/v1/listings", params={"store": self.store_slug, "sort": "rating", "limit": 10})
        ids = [x.get("id") for x in items(sr2.json)]
        self.r.check("sort=rating puts best-rated first", bool(ids) and ids[0] == self.listings["physical"]["id"], ids)
        self.expect_error(self.http.call("GET", "/v1/listings", params={"min_rating": 9}), 400, "invalid_request", "min_rating out of range")

        dl = self.http.call("DELETE", f"/v1/reviews/{self.reviews['service']['id']}", key=self.seller["key"])
        self.expect_error(dl, 403, "forbidden", "non-author cannot delete review")
        dl = self.http.call("DELETE", f"/v1/reviews/{self.reviews['service']['id']}", key=self.buyer["key"])
        self.r.check("author deletes review -> 2xx", 200 <= dl.status < 300, dl)
        sr = self.http.call("GET", f"/v1/stores/{self.store_slug}/reviews")
        self.r.eq("store rating after delete", (sr.json or {}).get("rating"), {"average": 4.0, "count": 1})
        self.expect_error(self.http.call("GET", "/v1/listings/lst_doesnotexist000000000/reviews"), 404, "not_found", "reviews of unknown listing")

    def step_payouts(self) -> None:
        self.r.start("Withdrawals, payment methods & faucet cap")
        w0 = self.wallet(self.seller)
        amt = 1000
        idem = f"smoke-wd-{uuid.uuid4().hex}"
        r1 = self.http.call("POST", "/v1/wallet/withdraw", {"amount_cents": amt}, key=self.seller["key"], idem=idem)
        wj = self.must(r1, [200, 201], "sandbox withdraw")
        self.r.eq("withdraw response available_cents", wj.get("available_cents"), w0["available_cents"] - amt)
        wd = wj.get("withdrawal") or {}
        self.r.check("withdrawal {amount_cents, transfer_id}", wd.get("amount_cents") == amt and bool(wd.get("transfer_id")), wd)
        r2 = self.http.call("POST", "/v1/wallet/withdraw", {"amount_cents": amt}, key=self.seller["key"], idem=idem)
        self.r.check("withdraw replay (same key) returns same body", r2.json == r1.json, r2)
        self.check_wallet(self.seller, "seller after withdraw (debited once)", w0["available_cents"] - amt, 0)
        over = self.http.call("POST", "/v1/wallet/withdraw", {"amount_cents": w0["available_cents"]}, key=self.seller["key"], idem=f"smoke-{uuid.uuid4().hex}")
        self.expect_error(over, 402, "insufficient_funds", "withdraw more than available")
        self.expect_error(self.http.call("POST", "/v1/wallet/withdraw", {"amount_cents": 0}, key=self.seller["key"]),
                          400, "invalid_request", "withdraw zero")
        self.expect_error(self.http.call("POST", "/v1/wallet/withdraw", {"amount_cents": 100}), 401, "unauthorized", "withdraw unauthenticated")
        tx = self._all(self.seller, "/v1/wallet/transactions")
        mine = [t for t in tx if t.get("transfer_id") == wd.get("transfer_id")] or [t for t in tx if t.get("type") == "payout" and int(t.get("amount_cents", 0)) == -amt]
        self.r.check("withdrawal recorded as payout ledger entry (-amount, available)",
                     len(mine) == 1 and mine[0].get("type") == "payout" and int(mine[0].get("amount_cents", 0)) == -amt, mine)
        if mine:
            self.r.check("ledger entry has transfer_id/account/memo", all(k in mine[0] for k in ("transfer_id", "account", "memo")), mine[0])

        pm = self.http.call("POST", "/v1/wallet/payment-methods", {"type": "stripe_shared_payment_token"}, key=self.buyer["key"])
        self.expect_error(pm, 501, "not_implemented", "payment-methods surface exists (501 until agent tokens ship)")

        # Faucet lifetime cap: 500,000 per agent (the outsider is otherwise unused).
        for i in range(5):
            d = self.http.call("POST", "/v1/wallet/deposit", {"amount_cents": 100_000}, key=self.outsider["key"], idem=f"smoke-cap-{self.run_id}-{i}")
            if d.status not in (200, 201):
                self.r.check(f"faucet deposit {i + 1}/5", False, d)
                return
        cap = self.http.call("POST", "/v1/wallet/deposit", {"amount_cents": 1}, key=self.outsider["key"], idem=f"smoke-cap-{self.run_id}-x")
        self.expect_error(cap, 403, "forbidden", "faucet lifetime cap (500,000)")
        det = ((cap.json or {}).get("error") or {}).get("details") or {}
        self.r.eq("faucet cap details.remaining_cents", det.get("remaining_cents"), 0)
        self.check_wallet(self.outsider, "outsider at faucet cap", 500_000, 0)

    def step_digital(self) -> None:
        self.r.start("Digital purchase (instant delivery & settlement)")
        own = self.post_order({"listing_id": self.listings["digital"]["id"]}, agent=self.seller)
        self.expect_error(own, 403, "forbidden", "seller cannot buy own listing")

        resp = self.post_order({"listing_id": self.listings["digital"]["id"], "quantity": 1})
        o = unwrap(self.must(resp, [200, 201], "buy digital"), "order")
        self.orders["digital"] = o
        self.r.check("order id prefixed ord_", str(o.get("id", "")).startswith("ord_"), o.get("id"))
        self.r.check("digital order status completed (instant)", o.get("status") == "completed", o.get("status"))
        self.r.check("digital delivery payload in create response", self.secret_payload in json.dumps(o.get("delivery")), o.get("delivery"))
        self.r.eq("digital total_cents", o.get("total_cents"), DIGITAL_PRICE)
        if o.get("status") == "fulfilled":  # tolerate a two-step implementation, but settle it
            self.r.warn("digital order stopped at 'fulfilled'; confirming")
            self.action(self.buyer, o["id"], "confirm")
        got = self.order(self.buyer, o["id"])
        self.r.check("buyer GET order shows delivery", self.secret_payload in json.dumps(got), got.get("delivery"))
        self.r.eq("digital fee_cents", got.get("fee_cents"), fee_of(DIGITAL_PRICE))
        sv = self.order(self.seller, o["id"])
        self.r.check("seller GET order does not expose delivery payload", self.secret_payload not in json.dumps(sv), "leaked to seller view")
        out = self.http.call("GET", f"/v1/orders/{o['id']}", key=self.outsider["key"])
        self.expect_error(out, [403, 404], ["forbidden", "not_found"], "outsider cannot read order")
        self.expected_fees += fee_of(DIGITAL_PRICE)

        self.check_wallet(self.buyer, "buyer", DEPOSIT - DIGITAL_PRICE, 0)
        self.check_wallet(self.seller, "seller", DIGITAL_PRICE - fee_of(DIGITAL_PRICE), 0)

    def step_physical(self) -> None:
        self.r.start("Physical purchase: escrow, idempotency, fulfil, confirm")
        noaddr = self.post_order({"listing_id": self.listings["physical"]["id"]})
        self.expect_error(noaddr, 400, "invalid_request", "physical order without shipping_address")
        total = PHYSICAL_PRICE + PHYSICAL_SHIPPING
        idem = f"smoke-ord-{uuid.uuid4().hex}"
        body = {"listing_id": self.listings["physical"]["id"], "quantity": 1, "shipping_address": TEST_ADDRESS, "note": "smoke"}
        r1 = self.post_order(body, idem=idem)
        o = unwrap(self.must(r1, [200, 201], "buy physical"), "order")
        r2 = self.post_order(body, idem=idem)
        o2 = unwrap(r2.json, "order") if r2.json else {}
        self.r.check("order replay with same Idempotency-Key returns same order", r2.status == r1.status and o2.get("id") == o.get("id"),
                     {"first": o.get("id"), "replay": o2.get("id"), "status": r2.status})
        self.orders["physical"] = o
        self.r.eq("physical status", o.get("status"), "paid")
        self.r.eq("physical total_cents (price + shipping)", o.get("total_cents"), total)
        self.r.eq("physical shipping_cents", o.get("shipping_cents"), PHYSICAL_SHIPPING)
        self.r.eq("physical unit_price_cents", o.get("unit_price_cents"), PHYSICAL_PRICE)
        self.check_wallet(self.buyer, "buyer (escrow held once)", DEPOSIT - DIGITAL_PRICE - total, total)

        sv = self.order(self.seller, o["id"])
        self.r.check("seller sees shipping_address", (sv.get("shipping_address") or {}).get("postal_code") == TEST_ADDRESS["postal_code"], sv.get("shipping_address"))
        pub = unwrap(self.http.call("GET", f"/v1/listings/{self.listings['physical']['id']}").json, "listing") or {}
        self.r.eq("inventory decremented", pub.get("inventory"), 1)

        early = self.action(self.buyer, o["id"], "confirm")
        self.expect_error(early, [409, 400], ["conflict", "invalid_request"], "confirm before fulfilment refused")
        bf = self.action(self.buyer, o["id"], "fulfill", {"carrier": "X", "tracking_number": "1"})
        self.expect_error(bf, [403, 404], ["forbidden", "not_found"], "buyer cannot fulfil")
        nf = self.action(self.seller, o["id"], "fulfill", {})
        self.expect_error(nf, 400, "invalid_request", "physical fulfil without tracking")
        f = self.action(self.seller, o["id"], "fulfill", {"carrier": "SmokePost", "tracking_number": f"SMK{self.run_id}",
                                                          "tracking_url": f"https://example.com/t/SMK{self.run_id}"})
        fo = unwrap(self.must(f, 200, "seller fulfils physical"), "order")
        self.r.eq("status after fulfil", fo.get("status"), "fulfilled")
        self.r.check("fulfillment has tracking number", f"SMK{self.run_id}" in json.dumps(fo.get("fulfillment")), fo.get("fulfillment"))
        sc = self.action(self.seller, o["id"], "confirm")
        self.expect_error(sc, [403, 404], ["forbidden", "not_found"], "seller cannot confirm")
        cf = self.action(self.buyer, o["id"], "confirm")
        co = unwrap(self.must(cf, 200, "buyer confirms"), "order")
        self.r.eq("status after confirm", co.get("status"), "completed")
        self.r.eq("physical fee_cents (5% of subtotal, excl. shipping)", co.get("fee_cents"), fee_of(PHYSICAL_PRICE))
        again = self.action(self.buyer, o["id"], "confirm")
        self.expect_error(again, [409, 400], ["conflict", "invalid_request"], "double confirm refused")
        self.expected_fees += fee_of(PHYSICAL_PRICE)
        self.check_wallet(self.buyer, "buyer", DEPOSIT - DIGITAL_PRICE - total, 0)
        self.check_wallet(self.seller, "seller", (DIGITAL_PRICE - fee_of(DIGITAL_PRICE)) + (total - fee_of(PHYSICAL_PRICE)), 0)

        # sell out -> seller cancel -> restock; then out_of_stock on over-quantity
        r3 = self.post_order(body)
        o3 = unwrap(self.must(r3, [200, 201], "buy last physical unit"), "order")
        pub = unwrap(self.http.call("GET", f"/v1/listings/{self.listings['physical']['id']}").json, "listing") or {}
        self.r.eq("inventory 0 after last unit", pub.get("inventory"), 0)
        oos = self.post_order(body)
        self.expect_error(oos, [409], ["out_of_stock"], "buy when inventory 0")
        c = self.action(self.seller, o3["id"], "cancel", {"reason": "smoke seller cancel"})
        self.r.eq("seller cancel -> cancelled", unwrap(self.must(c, 200, "seller cancels paid order"), "order").get("status"), "cancelled")
        pub = unwrap(self.http.call("GET", f"/v1/listings/{self.listings['physical']['id']}").json, "listing") or {}
        self.r.eq("inventory restocked after cancel", pub.get("inventory"), 1)
        big = self.post_order({**body, "quantity": 5})
        self.expect_error(big, 409, "out_of_stock", "quantity above stock")
        self.orders["physical_cancelled"] = o3
        self.check_wallet(self.buyer, "buyer after cancel refund", DEPOSIT - DIGITAL_PRICE - total, 0)

    def step_service(self) -> None:
        self.r.start("Service orders: cancel, refund, fulfil + dispute")
        lid = self.listings["service"]["id"]
        spent = DIGITAL_PRICE + PHYSICAL_PRICE + PHYSICAL_SHIPPING
        a = unwrap(self.must(self.post_order({"listing_id": lid}), [200, 201], "buy service A"), "order")
        self.r.eq("service A status", a.get("status"), "paid")
        ca = self.action(self.buyer, a["id"], "cancel", {"reason": "changed my mind"})
        self.r.eq("buyer cancel -> cancelled", unwrap(self.must(ca, 200, "buyer cancels"), "order").get("status"), "cancelled")
        again = self.action(self.buyer, a["id"], "cancel")
        self.expect_error(again, [409, 400], ["conflict", "invalid_request"], "cancel twice refused")

        b = unwrap(self.must(self.post_order({"listing_id": lid}), [200, 201], "buy service B"), "order")
        br = self.action(self.buyer, b["id"], "refund")
        self.expect_error(br, [403, 404], ["forbidden", "not_found"], "buyer cannot self-refund")
        rb = self.action(self.seller, b["id"], "refund", {"reason": "cannot deliver"})
        self.r.eq("seller refund -> refunded", unwrap(self.must(rb, 200, "seller refunds"), "order").get("status"), "refunded")

        c = unwrap(self.must(self.post_order({"listing_id": lid}), [200, 201], "buy service C"), "order")
        dp = self.action(self.buyer, c["id"], "dispute", {"reason": "too early"})
        self.expect_error(dp, [409, 400], ["conflict", "invalid_request"], "dispute before fulfilment refused")
        fc = self.action(self.seller, c["id"], "fulfill", {"message": f"Here is your smoke report {self.run_id}"})
        self.r.eq("service fulfil -> fulfilled", unwrap(self.must(fc, 200, "seller fulfils service"), "order").get("status"), "fulfilled")
        cc = self.action(self.buyer, c["id"], "cancel")
        self.expect_error(cc, [409, 400], ["conflict", "invalid_request"], "cancel after fulfilment refused")
        nd = self.action(self.buyer, c["id"], "dispute", {})
        self.expect_error(nd, 400, "invalid_request", "dispute without reason")
        dc = self.action(self.buyer, c["id"], "dispute", {"reason": "deliverable incomplete (smoke)"})
        self.r.eq("buyer dispute -> disputed", unwrap(self.must(dc, 200, "buyer disputes"), "order").get("status"), "disputed")
        cf = self.action(self.buyer, c["id"], "confirm")
        self.expect_error(cf, [409, 400], ["conflict", "invalid_request"], "confirm disputed order refused")
        self.orders.update(service_a=a, service_b=b, service_c=c)
        self.check_wallet(self.buyer, "buyer (disputed funds frozen)", DEPOSIT - spent - SERVICE_PRICE, SERVICE_PRICE)
        self.check_wallet(self.seller, "seller (unchanged)",
                          (DIGITAL_PRICE - fee_of(DIGITAL_PRICE)) + (PHYSICAL_PRICE + PHYSICAL_SHIPPING - fee_of(PHYSICAL_PRICE)), 0)

    def step_mandate(self) -> None:
        self.r.start("Mandate guardrails & insufficient funds")
        m = self.http.call("PUT", "/v1/me/mandate", {"max_order_cents": 1000, "daily_limit_cents": 200_000,
                                                     "allowed_kinds": ["physical", "digital", "service"]}, key=self.buyer["key"])
        self.must(m, 200, "PUT mandate (max_order 1000)")
        r = self.post_order({"listing_id": self.listings["service"]["id"]})
        self.expect_error(r, 403, "mandate_exceeded", "order above max_order_cents")
        m = self.http.call("PUT", "/v1/me/mandate", {"max_order_cents": 50_000, "daily_limit_cents": 200_000,
                                                     "allowed_kinds": ["digital"]}, key=self.buyer["key"])
        self.must(m, 200, "PUT mandate (digital only)")
        r = self.post_order({"listing_id": self.listings["service"]["id"]})
        self.expect_error(r, 403, "mandate_exceeded", "kind not in allowed_kinds")
        m = self.http.call("PUT", "/v1/me/mandate", {"max_order_cents": 50_000, "daily_limit_cents": 5_000,
                                                     "allowed_kinds": ["physical", "digital", "service"]}, key=self.buyer["key"])
        self.must(m, 200, "PUT mandate (daily 5000)")
        r = self.post_order({"listing_id": self.listings["service"]["id"]})
        self.expect_error(r, 403, "mandate_exceeded", "rolling 24h daily_limit_cents")
        bad = self.http.call("PUT", "/v1/me/mandate", {"max_order_cents": -1, "daily_limit_cents": 1, "allowed_kinds": ["x"]}, key=self.buyer["key"])
        self.expect_error(bad, 400, "invalid_request", "invalid mandate rejected")
        m = self.http.call("PUT", "/v1/me/mandate", {"max_order_cents": 10_000_000, "daily_limit_cents": 10_000_000,
                                                     "allowed_kinds": ["physical", "digital", "service"]}, key=self.buyer["key"])
        mj = unwrap(self.must(m, 200, "PUT mandate (wide open)"), "mandate")
        self.r.eq("mandate persisted", (mj or {}).get("max_order_cents"), 10_000_000)
        r = self.post_order({"listing_id": self.listings["pricey"]["id"]})
        self.expect_error(r, 402, "insufficient_funds", "order above available balance")

        # paused / archived listings cannot be bought
        p = self.http.call("PATCH", f"/v1/listings/{self.listings['digital']['id']}", {"status": "paused"}, key=self.seller["key"])
        self.r.eq("pause listing", unwrap(self.must(p, 200, "pause listing"), "listing").get("status"), "paused")
        r = self.post_order({"listing_id": self.listings["digital"]["id"]})
        self.expect_error(r, [400, 404, 409], None, "cannot buy paused listing")
        s = self.http.call("GET", "/v1/listings", params={"q": self.tag, "limit": 50})
        self.r.check("paused listing hidden from search", self.listings["digital"]["id"] not in s.text, "still listed")
        mine = self.http.call("GET", "/v1/stores/me", key=self.seller["key"])
        self.r.check("GET /v1/stores/me still shows the paused listing", self.listings["digital"]["id"] in mine.text, mine.text[:300])
        pub = self.http.call("GET", f"/v1/stores/{self.store_slug}")
        self.r.check("public store view hides the paused listing", self.listings["digital"]["id"] not in pub.text, "paused listing public")
        d = self.http.call("DELETE", f"/v1/listings/{self.listings['pricey']['id']}", key=self.seller["key"])
        self.r.check("DELETE listing -> 2xx (archive)", 200 <= d.status < 300, d)
        g = self.http.call("GET", f"/v1/listings/{self.listings['pricey']['id']}")
        gj = unwrap(g.json, "listing") if g.json else {}
        self.r.check("archived listing is 404 or status archived", g.status == 404 or (gj or {}).get("status") == "archived", g)
        r = self.post_order({"listing_id": self.listings["pricey"]["id"]})
        self.expect_error(r, [400, 404, 409], None, "cannot buy archived listing")
        self.check_wallet(self.buyer, "buyer unchanged by rejected orders",
                          DEPOSIT - DIGITAL_PRICE - PHYSICAL_PRICE - PHYSICAL_SHIPPING - SERVICE_PRICE, SERVICE_PRICE)

    def _all(self, agent: Dict[str, Any], path: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        cursor = None
        for _ in range(20):
            q = dict(params or {}, limit=100)
            if cursor:
                q["cursor"] = cursor
            j = self.must(self.http.call("GET", path, key=agent["key"], params=q), 200, f"GET {path}")
            out.extend(items(j))
            cursor = j.get("next_cursor") if isinstance(j, dict) else None
            if not cursor:
                break
        return out

    def step_ledger(self) -> None:
        self.r.start("Ledger (double-entry) & orders listing")
        bt = self._all(self.buyer, "/v1/wallet/transactions")
        st = self._all(self.seller, "/v1/wallet/transactions")
        self.r.check("all txn ids prefixed txn_", all(str(t.get("id", "")).startswith("txn_") for t in bt + st), [t.get("id") for t in bt + st][:5])
        valid = {"deposit", "escrow_hold", "escrow_release", "payout", "refund", "fee"}
        self.r.check("all txn types valid", all(t.get("type") in valid for t in bt + st), sorted({t.get("type") for t in bt + st}))

        # Entries may be single-entry (one row per movement) or per sub-account
        # (`account`: available|held, one row per leg). Normalise to both views.
        def acct(t: Dict[str, Any]) -> str:
            return t.get("account") or "available"

        def by_order(rows: List[Dict[str, Any]], typ: str) -> set:
            return {t.get("order_id") or t.get("transfer_id") or t.get("id") for t in rows if t.get("type") == typ}

        def signed_sum(rows: List[Dict[str, Any]], account: str) -> int:
            return sum(int(t.get("amount_cents", 0)) for t in rows if acct(t) == account)

        deps = [t for t in bt if t.get("type") == "deposit"]
        self.r.eq("buyer has exactly one deposit entry (idempotent replay)", len(deps), 1)
        self.r.check("deposit amount", bool(deps) and int(deps[0].get("amount_cents", 0)) == DEPOSIT, deps)
        # buyer paid for: digital, physical, physical#2 (cancelled), service A (cancelled), B (refunded), C (disputed)
        self.r.eq("buyer escrow_hold orders (one per paid order; replay not double-charged)", len(by_order(bt, "escrow_hold")), 6)
        self.r.eq("buyer refund orders (seller-cancel, buyer-cancel, seller-refund)", len(by_order(bt, "refund")), 3)
        self.r.eq("buyer refunds credited to available",
                  sum(int(t.get("amount_cents", 0)) for t in bt if t.get("type") == "refund" and acct(t) == "available"),
                  PHYSICAL_PRICE + PHYSICAL_SHIPPING + SERVICE_PRICE + SERVICE_PRICE)
        bw, sw = self.wallet(self.buyer), self.wallet(self.seller)
        if any(t.get("account") for t in bt + st):
            self.r.eq("buyer ledger sum(available) == wallet.available_cents", signed_sum(bt, "available"), bw.get("available_cents"))
            self.r.eq("buyer ledger sum(held) == wallet.held_cents", signed_sum(bt, "held"), bw.get("held_cents"))
            self.r.eq("seller ledger sum(available) == wallet.available_cents", signed_sum(st, "available"), sw.get("available_cents"))
        else:
            self.r.warn("ledger rows carry no `account` field; per-account balance reconciliation skipped")
        credits = sum(int(t.get("amount_cents", 0)) for t in st if t.get("type") in ("payout", "escrow_release") and acct(t) == "available")
        seller_fee_rows = sum(abs(int(t.get("amount_cents", 0))) for t in st if t.get("type") == "fee")
        gross = DIGITAL_PRICE + PHYSICAL_PRICE + PHYSICAL_SHIPPING
        self.r.check("seller credited gross-minus-5% (net payout, or gross payout + fee debit)",
                     (credits == gross - self.expected_fees and seller_fee_rows in (0, self.expected_fees))
                     or (credits == gross and seller_fee_rows == self.expected_fees),
                     {"credits": credits, "fee_rows": seller_fee_rows, "expected_fees": self.expected_fees})
        avail_rows = [t for t in st if acct(t) == "available"]
        if avail_rows:
            last_ts = max(t.get("created_at") or "" for t in avail_rows)
            finals = [t.get("balance_after_cents") for t in avail_rows if (t.get("created_at") or "") == last_ts]
            self.r.check("seller final balance_after_cents matches wallet available", sw.get("available_cents") in finals,
                         {"final_rows": finals, "wallet": sw})

        bo = self._all(self.buyer, "/v1/orders", {"role": "buyer"})
        so = self._all(self.seller, "/v1/orders", {"role": "seller"})
        ids = {o.get("id") for o in bo}
        self.r.check("buyer order list contains all 6 orders", {o["id"] for o in self.orders.values()} <= ids, sorted(ids))
        self.r.check("seller order list contains all 6 orders", {o["id"] for o in self.orders.values()} <= {o.get("id") for o in so}, len(so))
        dis = self._all(self.buyer, "/v1/orders", {"role": "buyer", "status": "disputed"})
        self.r.check("status filter (disputed)", [o.get("id") for o in dis] == [self.orders["service_c"]["id"]], [o.get("id") for o in dis])
        ob = self._all(self.outsider, "/v1/orders", {"role": "buyer"})
        self.r.eq("outsider sees no orders", len(ob), 0)
        swp = self.http.call("POST", "/v1/admin/sweep", {})
        self.r.check("POST /v1/admin/sweep -> 2xx", 200 <= swp.status < 300, swp)
        self.r.eq("sweep does not auto-complete fresh disputed order", self.order(self.buyer, self.orders["service_c"]["id"]).get("status"), "disputed")
        hist = self.order(self.buyer, self.orders["physical"]["id"]).get("events") or []
        self.r.check("order.events history records the lifecycle", len(hist) >= 3, hist)

    def step_events(self) -> None:
        self.r.start("Events feed")
        be = self._all(self.buyer, "/v1/events")
        se = self._all(self.seller, "/v1/events")
        bt = {e.get("type") for e in be}
        stypes = {e.get("type") for e in se}
        need = {"order.paid", "order.fulfilled", "order.completed", "order.cancelled", "order.refunded", "order.disputed"}
        self.r.check("buyer received all order event types", need <= bt, sorted(bt))
        self.r.check("seller received all order event types", need <= stypes, sorted(stypes))
        self.r.check("seller received listing.sold_out", "listing.sold_out" in stypes, sorted(stypes))
        self.r.check("seller received review.created", "review.created" in stypes, sorted(stypes))
        self.r.check("buyer received review.replied", "review.replied" in bt, sorted(bt))
        self.r.check("event ids prefixed evt_", all(str(e.get("id", "")).startswith("evt_") for e in be + se), [e.get("id") for e in be][:3])
        outsider_dump = json.dumps(self._all(self.outsider, "/v1/events"))
        self.r.check("outsider sees none of these events", not any(o["id"] in outsider_dump for o in self.orders.values()), "leak")
        if be:
            stamps = sorted(e.get("created_at") or e.get("at") or "" for e in be)
            mid = stamps[len(stamps) // 2]
            later = self._all(self.buyer, "/v1/events", {"since": mid})
            self.r.check("since= filters older events", 0 < len(later) <= len(be) and all((e.get("created_at") or e.get("at") or "") >= mid for e in later),
                         {"total": len(be), "since": len(later)})

    def step_mcp(self) -> None:
        self.r.start("MCP endpoint")
        if self.skip_mcp:
            self.r.warn("skipped (--skip-mcp)")
            return

        def rpc(method: str, params: Optional[Dict[str, Any]] = None, rid: Optional[int] = 1, key: Optional[str] = None) -> Resp:
            msg: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
            if rid is not None:
                msg["id"] = rid
            if params is not None:
                msg["params"] = params
            return self.http.call("POST", "/mcp", msg, key=key or self.buyer["key"],
                                  headers={"Accept": "application/json, text/event-stream"})

        init = rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                  "clientInfo": {"name": "smoke", "version": "1"}})
        ij = self.must(init, 200, "MCP initialize")
        self.r.check("initialize returns serverInfo + capabilities.tools",
                     isinstance((ij or {}).get("result"), dict) and "tools" in json.dumps(ij["result"].get("capabilities", {})), ij)
        n = rpc("notifications/initialized", rid=None)
        self.r.check("notifications/initialized -> 202", n.status == 202, n)
        p = rpc("ping", rid=2)
        self.r.check("ping -> result {}", p.status == 200 and (p.json or {}).get("result") == {}, p)
        tl = rpc("tools/list", {}, rid=3)
        names = {t.get("name") for t in ((tl.json or {}).get("result") or {}).get("tools", [])}
        need = {"register_agent", "search_listings", "get_listing", "get_wallet", "deposit_sandbox_funds", "create_order",
                "list_orders", "get_order", "confirm_order", "create_store", "create_listing", "fulfill_order",
                "list_categories", "browse_catalog", "get_reviews", "write_review", "update_listing", "get_my_store",
                "update_store", "cancel_order", "refund_order"}
        self.r.check("tools/list exposes all 21 tools", need <= names, sorted(need - names))
        tr = rpc("tools/call", {"name": "get_reviews", "arguments": {"listing_id": self.listings["physical"]["id"]}}, rid=8)
        self.r.check("tools/call get_reviews returns the review", self.reviews.get("physical", {}).get("id", "?") in tr.text, tr.text[:300])
        tcat = rpc("tools/call", {"name": "list_categories", "arguments": {}}, rid=9)
        self.r.check("tools/call list_categories works", tcat.status == 200 and "listing_count" in tcat.text, tcat.text[:200])
        tc = rpc("tools/call", {"name": "get_wallet", "arguments": {}}, rid=4)
        tj = (tc.json or {}).get("result") or {}
        txt = " ".join(c.get("text", "") for c in tj.get("content", []) if isinstance(c, dict))
        self.r.check("tools/call get_wallet returns content with balance", tc.status == 200 and "available_cents" in (txt + json.dumps(tj)), tc)
        ts = rpc("tools/call", {"name": "search_listings", "arguments": {"q": self.tag}}, rid=5)
        self.r.check("tools/call search_listings finds smoke listing", self.listings["service"]["id"] in ts.text, ts.text[:300])
        self.r.check("MCP search hides digital payload", self.secret_payload not in ts.text, "leak")
        um = rpc("nope/nope", {}, rid=6)
        self.r.check("unknown method -> JSON-RPC error -32601", ((um.json or {}).get("error") or {}).get("code") == -32601, um)
        ua = self.http.call("POST", "/mcp", {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "get_wallet", "arguments": {}}})
        self.r.check("unauthenticated get_wallet fails", ua.status in (401, 403) or "error" in json.dumps(ua.json) or (((ua.json or {}).get("result") or {}).get("isError") is True), ua)

    def step_stats(self) -> None:
        self.r.start("Stats after run")
        s = self.http.call("GET", "/v1/stats")
        sj = s.json or {}
        before = getattr(self, "stats_before", None) or {}
        if before:
            self.r.check("stats.agents grew by >= 3", sj.get("agents", 0) >= before.get("agents", 0) + 3, (before, sj))
            self.r.check("stats.orders_completed grew by >= 2", sj.get("orders_completed", 0) >= before.get("orders_completed", 0) + 2, (before, sj))
            self.r.check("stats.gmv_cents grew by >= completed totals", sj.get("gmv_cents", 0) >= before.get("gmv_cents", 0) + DIGITAL_PRICE + PHYSICAL_PRICE + PHYSICAL_SHIPPING, (before, sj))

    # -- runner --------------------------------------------------------------

    def run(self) -> int:
        print(_c("1", f"AgentMart smoke test  run={self.run_id}  base={self.http.base}"))
        t0 = time.time()
        steps: List[Callable[[], None]] = [
            self.step_discovery, self.step_register, self.step_keys, self.step_wallet, self.step_store_and_listings,
            self.step_digital, self.step_physical, self.step_service, self.step_reviews, self.step_mandate,
            self.step_ledger, self.step_payouts, self.step_events, self.step_mcp, self.step_stats,
        ]
        aborted = None
        for step in steps:
            try:
                step()
            except Abort as e:
                aborted = str(e)
                break
            except Exception as e:  # unexpected shape / network: report and stop, state is unknown
                self.r.check(f"{step.__name__} raised {type(e).__name__}", False, f"{e}\n{traceback.format_exc(limit=3)}")
                aborted = f"{step.__name__}: {e}"
                break

        dt = time.time() - t0
        print("\n" + "=" * 72)
        print(f"agents: seller={self.seller.get('id')} buyer={self.buyer.get('id')} outsider={self.outsider.get('id')}")
        print(f"requests: {self.http.count}   duration: {dt:.1f}s   warnings: {len(self.r.warnings)}")
        for w in self.r.warnings:
            print(f"  {_c('33', 'WARN')} {w}")
        if self.r.failed:
            print(_c("31", f"FAILED checks ({len(self.r.failed)}):"))
            for name, detail in self.r.failed:
                print(f"  - {name}" + (f": {detail[:200]}" if detail else ""))
        if aborted:
            print(_c("31;1", f"ABORTED: {aborted}"))
        verdict = "PASS" if not self.r.failed and not aborted else "FAIL"
        color = "32;1" if verdict == "PASS" else "31;1"
        print(_c(color, f"RESULT: {verdict}  ({len(self.r.passed)} passed, {len(self.r.failed)} failed)"))
        if aborted:
            return 2
        return 0 if verdict == "PASS" else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.environ.get("API_BASE", DEFAULT_BASE), help="API base URL (env API_BASE)")
    ap.add_argument("--skip-mcp", action="store_true", help="skip the MCP checks")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every request")
    args = ap.parse_args()
    return Smoke(args.base, args.verbose, args.skip_mcp).run()


if __name__ == "__main__":
    sys.exit(main())
