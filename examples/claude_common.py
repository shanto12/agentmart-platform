#!/usr/bin/env python3
"""Shared plumbing for the Claude-driven AgentMart example agents.

This module holds everything the Claude buyer/seller examples share:

* :func:`resolve_model` — turns a short tier name (``sonnet``/``haiku``/``opus``)
  or a full model id into the model id passed to the Anthropic API.
* :func:`get_anthropic_client` — builds an ``anthropic.Anthropic`` client from
  ``$ANTHROPIC_API_KEY`` only. The key is never logged, printed, or persisted.
* Tool schemas (:data:`BUYER_TOOLS`, :data:`SELLER_TOOLS`) — the AgentMart API
  surface exposed to Claude as tool-use tools.
* :class:`BuyerExecutor` / :class:`SellerExecutor` — run the tools against a
  live :class:`agentmart.AgentMart` client, with server-mandate + code-side
  budget guardrails for the buyer.
* :func:`run_tool_loop` — the agentic loop: send messages to Claude, execute
  any ``tool_use`` blocks, feed results back, repeat until Claude answers.

Nothing in this module touches the network on import.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk" / "python"))

import anthropic  # noqa: E402

from agentmart import AgentMart, AgentMartError, unwrap  # noqa: E402

log = logging.getLogger("claude_common")

# Model ids verified present in the installed anthropic SDK (v1.11.0) source.
# Plain version aliases (no date suffix) so they keep resolving as Anthropic
# ships newer snapshots. Override with $CLAUDE_MODEL for anything newer.
MODEL_ALIASES = {
    "sonnet": "claude-sonnet-5-5",
    "haiku": "claude-haiku-4-5",
    "opus": "claude-opus-5-5",
}

DEFAULT_MAX_TOKENS = 2048


def resolve_model(name: Optional[str]) -> str:
    """Resolve a tier nickname or model id to a concrete Anthropic model id."""
    key = (name or "sonnet").strip().lower()
    return MODEL_ALIASES.get(key, name.strip() if name else MODEL_ALIASES["sonnet"])


def get_anthropic_client() -> "anthropic.Anthropic":
    """Build the Anthropic client. The API key comes ONLY from $ANTHROPIC_API_KEY."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise SystemExit(
            "ANTHROPIC_API_KEY is not set. Export it first:\n"
            "    export ANTHROPIC_API_KEY=sk-ant-...\n"
            "Get a key at https://console.anthropic.com (never paste it into chat or code)."
        )
    return anthropic.Anthropic(api_key=key)


class BudgetExceeded(Exception):
    """Raised when a tool call would breach the run's spending budget."""


# --------------------------------------------------------------------------- tool schemas

BUYER_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "search_listings",
        "description": (
            "Search the marketplace for listings. Returns up to `limit` listings with id, title, "
            "price_cents, kind, rating, agent_readiness and shipping info. Try several query phrasings."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Full-text query, e.g. 'ceramic mug'"},
                "kind": {"type": "string", "enum": ["physical", "digital", "service"]},
                "max_price_cents": {"type": "integer", "description": "Hard ceiling on item price in cents"},
                "min_rating": {"type": "number", "description": "Minimum average star rating 1-5"},
                "limit": {"type": "integer", "description": "Max results (default 20, max 50)"},
            },
            "required": ["q"],
        },
    },
    {
        "name": "get_listing",
        "description": "Full detail for one listing: description, agent_readiness score, seller summary, shipping terms.",
        "input_schema": {
            "type": "object",
            "properties": {"listing_id": {"type": "string"}},
            "required": ["listing_id"],
        },
    },
    {
        "name": "get_wallet",
        "description": "Your wallet balances: available_cents, held_cents, mode (sandbox/live).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "deposit_funds",
        "description": (
            "Top up the wallet from the sandbox faucet (max 100000 cents per call). "
            "Use before buying when available_cents is below the landed cost."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"amount_cents": {"type": "integer", "minimum": 1}},
            "required": ["amount_cents"],
        },
    },
    {
        "name": "place_order",
        "description": (
            "Buy a listing: funds move to escrow atomically. The run budget is enforced in code "
            "BEFORE the API is hit, and the server mandate is a second guardrail. For physical "
            "goods you MUST pass shipping_address. Idempotent per listing within a run."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "listing_id": {"type": "string"},
                "quantity": {"type": "integer", "minimum": 1, "default": 1},
                "shipping_address": {
                    "type": "object",
                    "description": "REQUIRED for physical listings.",
                    "properties": {
                        "name": {"type": "string"}, "line1": {"type": "string"},
                        "line2": {"type": "string"}, "city": {"type": "string"},
                        "region": {"type": "string"}, "postal_code": {"type": "string"},
                        "country": {"type": "string"},
                    },
                    "required": ["name", "line1", "city", "region", "postal_code", "country"],
                },
                "note": {"type": "string"},
            },
            "required": ["listing_id"],
        },
    },
    {
        "name": "get_order",
        "description": "Current status of an order: paid, fulfilled, completed, cancelled, refunded, disputed.",
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string"}},
            "required": ["order_id"],
        },
    },
    {
        "name": "confirm_order",
        "description": "Buyer confirms receipt of a fulfilled order; escrow releases to the seller (minus 5% fee).",
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string"}},
            "required": ["order_id"],
        },
    },
    {
        "name": "leave_review",
        "description": "Rate a fulfilled/completed/disputed order once, 1-5 stars.",
        "input_schema": {
            "type": "object",
            "properties": {
                "order_id": {"type": "string"},
                "rating": {"type": "integer", "minimum": 1, "maximum": 5},
                "title": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["order_id", "rating"],
        },
    },
]

SELLER_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "get_me",
        "description": "Your agent profile, wallet, mandate and store (if any).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_orders",
        "description": "Orders where you are the seller. Filter by status, e.g. 'paid' for orders needing fulfilment.",
        "input_schema": {
            "type": "object",
            "properties": {"status": {"type": "string", "description": "paid|fulfilled|completed|cancelled|refunded|disputed"}},
        },
    },
    {
        "name": "get_order",
        "description": "Full detail for one order, including shipping address and fulfilment info.",
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string"}},
            "required": ["order_id"],
        },
    },
    {
        "name": "fulfill_order",
        "description": (
            "Mark a paid order fulfilled. Physical: pass carrier + tracking_number (+tracking_url). "
            "Service: pass message (the deliverable summary). Digital orders need no fulfilment."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "order_id": {"type": "string"},
                "carrier": {"type": "string"},
                "tracking_number": {"type": "string"},
                "tracking_url": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["order_id"],
        },
    },
    {
        "name": "list_reviews",
        "description": "Recent reviews on your store's listings, including whether you already replied.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "reply_to_review",
        "description": "Reply once to a customer review. Be helpful; offer a refund/replacement for low ratings.",
        "input_schema": {
            "type": "object",
            "properties": {"review_id": {"type": "string"}, "body": {"type": "string"}},
            "required": ["review_id", "body"],
        },
    },
    {
        "name": "update_listing_price",
        "description": (
            "Change a listing's price_cents. Use sparingly and only on clear demand signal "
            "(e.g. repeated quick sales -> small raise; no views/orders -> small cut). "
            "Keep every change within 20% of the current price."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"listing_id": {"type": "string"}, "price_cents": {"type": "integer", "minimum": 50}},
            "required": ["listing_id", "price_cents"],
        },
    },
    {
        "name": "get_wallet",
        "description": "Your wallet balances: available_cents, held_cents, mode (sandbox/live).",
        "input_schema": {"type": "object", "properties": {}},
    },
]

# Tool names must be unique WITHIN each role's tool list (the same name may
# appear in both roles, e.g. get_wallet — each list is sent to the API alone).
for _tools in (BUYER_TOOLS, SELLER_TOOLS):
    _names = [t["name"] for t in _tools]
    assert len(set(_names)) == len(_names), "duplicate tool name within a role"


# --------------------------------------------------------------------------- executors

def _api_error(e: AgentMartError) -> Dict[str, Any]:
    return {"ok": False, "error": f"{e.code}: {e.message}", "status": e.status}


class BuyerExecutor:
    """Executes buyer tools against the AgentMart API with a code-side budget guard.

    The server-side mandate (set_mandate) is the hard guardrail; this class adds
    a per-run budget check BEFORE place_order hits the API, so Claude can never
    overspend even if it misreads the mandate.
    """

    def __init__(self, am: AgentMart, budget_cents: int, dry_run: bool = False) -> None:
        self.am = am
        self.budget_cents = int(budget_cents)
        self.spent_cents = 0
        self.dry_run = dry_run
        self._idempotency: Dict[str, str] = {}

    @property
    def remaining_cents(self) -> int:
        return self.budget_cents - self.spent_cents

    def _landed_cost(self, listing: Dict[str, Any], qty: int) -> int:
        ship = 0
        if listing.get("kind") == "physical":
            ship = int((listing.get("shipping") or {}).get("shipping_cents") or 0)
        return int(listing["price_cents"]) * int(qty) + ship

    def execute(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return self._dispatch(name, args or {})
        except BudgetExceeded as e:
            return {"ok": False, "error": f"budget_exceeded: {e}"}
        except AgentMartError as e:
            return _api_error(e)
        except Exception as e:  # never crash the agent loop on a tool bug
            log.exception("tool %s failed", name)
            return {"ok": False, "error": f"tool_error: {type(e).__name__}: {e}"}

    def _dispatch(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        am = self.am
        if name == "search_listings":
            page = am.search_listings(
                args.get("q"),
                kind=args.get("kind"),
                max_price=args.get("max_price_cents"),
                min_rating=args.get("min_rating"),
                sort="relevance",
                limit=min(int(args.get("limit") or 20), 50),
            )
            return {"ok": True, "listings": (page or {}).get("data", [])}
        if name == "get_listing":
            return {"ok": True, "listing": unwrap(am.get_listing(args["listing_id"]), "listing")}
        if name == "get_wallet":
            w = am.wallet()
            return {"ok": True, "wallet": w, "run_budget_cents": self.budget_cents,
                    "run_spent_cents": self.spent_cents, "run_remaining_cents": self.remaining_cents}
        if name == "deposit_funds":
            res = am.deposit(int(args["amount_cents"]))
            return {"ok": True, "result": res}
        if name == "place_order":
            listing_id = args["listing_id"]
            qty = int(args.get("quantity") or 1)
            listing = unwrap(am.get_listing(listing_id), "listing")
            landed = self._landed_cost(listing, qty)
            if landed > self.remaining_cents:
                raise BudgetExceeded(
                    f"landed cost {landed}c exceeds remaining run budget {self.remaining_cents}c")
            if self.dry_run:
                return {"ok": True, "dry_run": True, "listing_id": listing_id,
                        "landed_cents": landed, "note": "dry run: no order was placed"}
            key = self._idempotency.setdefault(listing_id, AgentMart.new_idempotency_key())
            kwargs: Dict[str, Any] = {"idempotency_key": key, "note": args.get("note") or "Purchased by the Claude-driven AgentMart buyer."}
            if listing.get("kind") == "physical":
                if not args.get("shipping_address"):
                    return {"ok": False, "error": "physical listings require shipping_address"}
                kwargs["shipping_address"] = args["shipping_address"]
            order = unwrap(am.create_order(listing_id, qty, **kwargs), "order")
            self.spent_cents += landed
            return {"ok": True, "order": order, "landed_cents": landed,
                    "run_remaining_cents": self.remaining_cents}
        if name == "get_order":
            return {"ok": True, "order": unwrap(am.get_order(args["order_id"]), "order")}
        if name == "confirm_order":
            return {"ok": True, "order": unwrap(am.confirm_order(args["order_id"]), "order")}
        if name == "leave_review":
            review = unwrap(am.create_review(
                args["order_id"], int(args["rating"]),
                title=args.get("title"), body=args.get("body")), "review")
            return {"ok": True, "review": review}
        return {"ok": False, "error": f"unknown_tool: {name}"}


class SellerExecutor:
    """Executes seller tools. `on_fulfilled(order_id)` is called after each fulfilment
    so the caller can persist progress (crash-safe state)."""

    def __init__(self, am: AgentMart, on_fulfilled: Optional[Callable[[str], None]] = None) -> None:
        self.am = am
        self.on_fulfilled = on_fulfilled

    def execute(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return self._dispatch(name, args or {})
        except AgentMartError as e:
            return _api_error(e)
        except Exception as e:
            log.exception("tool %s failed", name)
            return {"ok": False, "error": f"tool_error: {type(e).__name__}: {e}"}

    def _my_store_slug(self) -> Optional[str]:
        try:
            store = unwrap(self.am.get_my_store(), "store") or {}
        except AgentMartError as e:
            if e.status == 404:
                return None
            raise
        return store.get("slug")

    def _dispatch(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        am = self.am
        if name == "get_me":
            return {"ok": True, "me": am.me()}
        if name == "list_orders":
            orders = list(am.iter_orders(role="seller", status=args.get("status") or "paid", limit=50))
            return {"ok": True, "orders": orders}
        if name == "get_order":
            return {"ok": True, "order": unwrap(am.get_order(args["order_id"]), "order")}
        if name == "fulfill_order":
            order = unwrap(am.fulfill_order(
                args["order_id"],
                carrier=args.get("carrier"),
                tracking_number=args.get("tracking_number"),
                tracking_url=args.get("tracking_url"),
                message=args.get("message")), "order")
            if self.on_fulfilled:
                self.on_fulfilled(args["order_id"])
            return {"ok": True, "order": order}
        if name == "list_reviews":
            slug = self._my_store_slug()
            if not slug:
                return {"ok": False, "error": "no store yet"}
            reviews = list(am.iter_store_reviews(slug, sort="newest", limit=20))
            return {"ok": True, "reviews": reviews}
        if name == "reply_to_review":
            review = unwrap(am.reply_to_review(args["review_id"], args["body"]), "review")
            return {"ok": True, "review": review}
        if name == "update_listing_price":
            listing = unwrap(am.get_listing(args["listing_id"]), "listing")
            old = int(listing["price_cents"])
            new = int(args["price_cents"])
            if abs(new - old) / old > 0.20:
                return {"ok": False, "error": f"price change {old}c -> {new}c exceeds the 20% per-change limit"}
            updated = unwrap(am.update_listing(args["listing_id"], price_cents=new), "listing")
            return {"ok": True, "listing": updated, "old_price_cents": old}
        if name == "get_wallet":
            return {"ok": True, "wallet": am.wallet()}
        return {"ok": False, "error": f"unknown_tool: {name}"}


# --------------------------------------------------------------------------- agent loop

def _text_of(content: List[Any]) -> str:
    return "\n".join(getattr(b, "text", "") for b in content if getattr(b, "type", None) == "text").strip()


def run_tool_loop(
    client: "anthropic.Anthropic",
    model: str,
    system: str,
    messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]],
    executor: Any,
    max_iterations: int = 12,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> str:
    """Run the Claude tool-use loop until Claude answers or iterations run out.

    Returns Claude's final text answer. Tool results are JSON-encoded so Claude
    always sees structured data. API-level failures surface as clean log lines,
    not tracebacks, via the executor's error dicts.
    """
    for i in range(max_iterations):
        log.debug("claude turn %d/%d", i + 1, max_iterations)
        try:
            resp = client.messages.create(
                model=model, max_tokens=max_tokens, system=system, messages=messages, tools=tools)
        except anthropic.AuthenticationError:
            raise SystemExit("ANTHROPIC_API_KEY was rejected (authentication_error). Check the key and retry.")
        except anthropic.APIConnectionError as e:
            raise SystemExit(f"Could not reach the Anthropic API: {e}. Check network/proxy and retry.")
        except anthropic.APIError as e:
            raise SystemExit(f"Anthropic API error: {e}")

        content = list(resp.content or [])
        messages.append({"role": "assistant", "content": content})
        tool_uses = [b for b in content if getattr(b, "type", None) == "tool_use"]
        if resp.stop_reason == "end_turn" or not tool_uses:
            return _text_of(content)

        results = []
        for tu in tool_uses:
            tid = getattr(tu, "id", "?")
            tname = getattr(tu, "name", "?")
            tinput = getattr(tu, "input", {}) or {}
            log.info("tool call: %s(%s)", tname, json.dumps(tinput, default=str)[:300])
            result = executor.execute(tname, dict(tinput))
            results.append({
                "type": "tool_result",
                "tool_use_id": tid,
                "content": json.dumps(result, default=str),
            })
        messages.append({"role": "user", "content": results})

    return "(stopped after max iterations without a final answer)"
