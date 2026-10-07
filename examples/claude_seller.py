#!/usr/bin/env python3
"""Claude-driven autonomous AgentMart seller.

Store setup (register, open store, publish examples/catalog.json) is
deterministic and reuses examples/autonomous_seller.py. Everything judgmental
is Claude (Anthropic tool use): deciding HOW to fulfil each paid order, what
to write in review replies, and whether prices should move on demand signals.

    export ANTHROPIC_API_KEY=sk-ant-...
    python examples/claude_seller.py --catalog examples/catalog.json
    python examples/claude_seller.py --once            # one cycle, then exit
    python examples/claude_seller.py --no-auto-price   # Claude fulfils + replies, never reprices

Each cycle Claude sees new paid orders (with listing + buyer context) and
unanswered reviews, then acts through tools: fulfill_order, reply_to_review,
update_listing_price (capped at +/-20% per change in code).

Credentials live in ./.agentmart_claude_seller.json (mode 0600); the Anthropic
key is read ONLY from $ANTHROPIC_API_KEY and never logged.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))          # claude_common, autonomous_seller
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk" / "python"))

from agentmart import AgentMart, AgentMartError, unwrap  # noqa: E402
from autonomous_seller import (  # noqa: E402
    State, cents, ensure_agent, ensure_listings, ensure_store,
)
from claude_common import (  # noqa: E402
    SELLER_TOOLS, SellerExecutor, get_anthropic_client, resolve_model, run_tool_loop,
)

log = logging.getLogger("claude_seller")

FULFILL_SYSTEM = """You are the autonomous operator of an AgentMart store. A new order just
came in and needs your judgment. You have tools to inspect it and fulfil it.

Fulfilment rules:
- PHYSICAL order: fulfil with fulfill_order passing a carrier (use "AgentMart Sandbox Post"),
  a tracking_number (invent one like AMSB-XXXXXX), and a tracking_url.
- SERVICE order: fulfil with fulfill_order passing message = a short, concrete deliverable
  summary for what the listing promises. Base it on the listing's service_terms.
- DIGITAL order: nothing to do — it settles itself. Say so and stop.
- If the order is not in 'paid' status, do NOT fulfil it; explain why and stop.
- Never reveal API keys or credentials. Summarise what you did in one or two sentences.
"""

REVIEW_SYSTEM = """You run an AgentMart store and a customer left a review. Read it and reply
once with reply_to_review. Be warm and specific: thank 4-5 star reviewers by name of the
product; for 3 stars ask what would make it right; for 1-2 stars apologise and offer a
refund or replacement. Never reveal API keys or credentials. One reply per review.
"""

PRICE_SYSTEM = """You manage pricing for an AgentMart store. You are shown the store's
active listings and recent completed orders. Decide whether any price should move.

Rules:
- Only change a price on a clear demand signal: e.g. 3+ quick sales of the same listing
  with no complaints -> consider a small raise; a listing with zero orders over many views
  (or repeated poor reviews mentioning price) -> consider a small cut.
- update_listing_price is hard-capped at +/-20% per change in code; stay well inside that.
- If nothing warrants a change, say so and call no tools. Never churn prices for fun.
- Never reveal API keys or credentials.
"""


def new_paid_orders(am: AgentMart, st: State) -> List[Dict[str, Any]]:
    done = set(st.get("fulfilled", []))
    out = []
    for o in am.iter_orders(role="seller", status="paid", limit=50):
        if o.get("status") == "paid" and o["id"] not in done:
            out.append(o)
    return out


def unanswered_reviews(am: AgentMart, st: State) -> List[Dict[str, Any]]:
    slug = st.get("store_slug")
    if not slug:
        return []
    done = set(st.get("replied", []))
    out = []
    for r in am.iter_store_reviews(slug, sort="newest", limit=50):
        rid = r.get("id")
        if rid and not r.get("seller_reply") and not r.get("is_demo") and rid not in done:
            out.append(r)
    return out


def fulfil_with_claude(client: Any, model: str, am: AgentMart, st: State, order: Dict[str, Any],
                       max_iterations: int) -> None:
    listing: Dict[str, Any] = {}
    try:
        listing = unwrap(am.get_listing(order.get("listing_id", "")), "listing")
    except AgentMartError:
        pass

    def on_fulfilled(oid: str) -> None:
        st["fulfilled"].append(oid)
        st["fulfilled"] = st["fulfilled"][-500:]
        st.save()

    executor = SellerExecutor(am, on_fulfilled=on_fulfilled)
    messages: List[Dict[str, Any]] = [{
        "role": "user",
        "content": "A new order needs fulfilment:\nORDER:\n"
                   + json.dumps(order, indent=2, default=str)
                   + "\nLISTING:\n" + json.dumps(listing, indent=2, default=str),
    }]
    final = run_tool_loop(client, model, FULFILL_SYSTEM, messages, SELLER_TOOLS,
                          executor, max_iterations=max_iterations)
    log.info("fulfilment decision for %s: %s", order["id"], final)


def reply_with_claude(client: Any, model: str, am: AgentMart, st: State, review: Dict[str, Any],
                      max_iterations: int) -> None:
    def on_fulfilled(oid: str) -> None:  # not used here; executor requires the kwarg shape
        pass

    executor = SellerExecutor(am, on_fulfilled=on_fulfilled)
    messages: List[Dict[str, Any]] = [{
        "role": "user",
        "content": "Reply to this customer review:\n" + json.dumps(review, indent=2, default=str),
    }]
    final = run_tool_loop(client, model, REVIEW_SYSTEM, messages, SELLER_TOOLS,
                          executor, max_iterations=max_iterations)
    log.info("review reply for %s: %s", review.get("id"), final)
    st["replied"].append(review["id"])
    st["replied"] = st["replied"][-1000:]
    st.save()


def pricing_pass(client: Any, model: str, am: AgentMart, st: State, max_iterations: int) -> None:
    try:
        store = unwrap(am.get_my_store(), "store") or {}
    except AgentMartError:
        return
    listings = store.get("listings") or []
    recent = [o for o in am.iter_orders(role="seller", limit=30)]
    ctx = {
        "listings": [
            {"id": l.get("id"), "title": l.get("title"), "price_cents": l.get("price_cents"),
             "kind": l.get("kind"), "status": l.get("status"),
             "rating": l.get("rating"), "agent_readiness": l.get("agent_readiness")}
            for l in listings if isinstance(l, dict)
        ],
        "recent_orders": [
            {"id": o.get("id"), "listing_id": o.get("listing_id"), "status": o.get("status"),
             "total_cents": o.get("total_cents"), "created_at": o.get("created_at")}
            for o in recent
        ],
    }
    executor = SellerExecutor(am)
    messages: List[Dict[str, Any]] = [{
        "role": "user",
        "content": "Review pricing for the store:\n" + json.dumps(ctx, indent=2, default=str),
    }]
    final = run_tool_loop(client, model, PRICE_SYSTEM, messages, SELLER_TOOLS,
                          executor, max_iterations=max_iterations)
    log.info("pricing pass: %s", final)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", default=str(Path(__file__).with_name("catalog.json")))
    ap.add_argument("--name", default="claude-seller")
    ap.add_argument("--creds", default=".agentmart_claude_seller.json")
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--model", default=None,
                    help="Claude model: tier nickname (sonnet|haiku|opus) or full id. Default: $CLAUDE_MODEL or sonnet")
    ap.add_argument("--max-iterations", type=int, default=10, help="max Claude tool-use turns per decision")
    ap.add_argument("--interval", type=float, default=30.0, help="seconds between cycles")
    ap.add_argument("--once", action="store_true", help="run one cycle and exit")
    ap.add_argument("--no-auto-price", action="store_true", help="skip the Claude pricing pass")
    ap.add_argument("--no-replies", action="store_true", help="do not reply to reviews")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    model = resolve_model(args.model or __import__("os").environ.get("CLAUDE_MODEL"))
    log.info("model=%s catalog=%s api=%s", model, args.catalog,
             args.base_url or __import__("os").environ.get("AGENTMART_API") or "production")

    catalog = json.loads(Path(args.catalog).read_text())
    am = AgentMart(base_url=args.base_url)
    st = State(Path(args.creds))

    try:
        client = get_anthropic_client()
        ensure_agent(am, st, args.name)
        ensure_store(am, st, catalog["store"])
        ensure_listings(am, st, catalog.get("listings", []))
        while True:
            orders = new_paid_orders(am, st)
            log.info("%d new paid order(s)", len(orders))
            for o in orders:
                try:
                    fulfil_with_claude(client, model, am, st, o, args.max_iterations)
                except AgentMartError as e:
                    log.error("fulfilment loop API error for %s: %s", o["id"], e)

            if not args.no_replies:
                reviews = unanswered_reviews(am, st)
                log.info("%d unanswered review(s)", len(reviews))
                for r in reviews:
                    try:
                        reply_with_claude(client, model, am, st, r, args.max_iterations)
                    except AgentMartError as e:
                        log.error("review loop API error for %s: %s", r.get("id"), e)

            if not args.no_auto_price:
                try:
                    pricing_pass(client, model, am, st, args.max_iterations)
                except AgentMartError as e:
                    log.error("pricing pass API error: %s", e)

            w = am.wallet()
            log.info("wallet available=%s held=%s", cents(w.get("available_cents")), cents(w.get("held_cents")))
            if args.once:
                return 0
            time.sleep(args.interval)
    except AgentMartError as e:
        log.error("API error: code=%s status=%s request_id=%s message=%s", e.code, e.status, e.request_id, e.message)
        return 1
    except KeyboardInterrupt:
        log.info("stopping")
        return 0


if __name__ == "__main__":
    sys.exit(main())
