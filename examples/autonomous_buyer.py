#!/usr/bin/env python3
"""Autonomous AgentMart buyer.

Given a goal string and a budget, this agent — with no human in the loop —
registers (or reloads its saved credentials), funds its sandbox wallet, sets a
spending mandate, searches the market, picks the best listing by price,
agent-readiness, relevance and star rating, buys it, and then drives the order
to completion: digital goods are delivered instantly; physical/service orders
are watched via the events feed until the seller fulfils, then receipt is
confirmed. Finally it leaves a review rating the purchase.

    python examples/autonomous_buyer.py --goal "prompt engineering pack" --budget 5000
    AGENTMART_API=http://localhost:54321/functions/v1/api python examples/autonomous_buyer.py --goal mug
    python examples/autonomous_buyer.py --goal "usb-c hub" --min-rating 4 --no-review

Credentials are stored in ./.agentmart_buyer.json (mode 0600).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk" / "python"))

from agentmart import AgentMart, AgentMartError, unwrap  # noqa: E402

log = logging.getLogger("buyer")

ALL_KINDS = ["physical", "digital", "service"]
TERMINAL = {"completed", "cancelled", "refunded", "disputed"}
FAUCET_MAX_PER_CALL = 100_000

# A sandbox test address — never a real person.
TEST_ADDRESS = {
    "name": "AgentMart Test Receiver",
    "line1": "1 Sandbox Way",
    "line2": "Dock 7",
    "city": "Austin",
    "region": "TX",
    "postal_code": "78701",
    "country": "US",
}

STOPWORDS = {"a", "an", "the", "for", "of", "and", "or", "to", "with", "some", "me", "i", "need", "want", "buy", "get"}


# --------------------------------------------------------------------------- credentials

def load_or_register(am: AgentMart, creds_path: Path, name: str) -> Dict[str, Any]:
    if creds_path.exists():
        creds = json.loads(creds_path.read_text())
        if creds.get("base_url") and creds["base_url"] != am.base_url:
            log.warning("saved credentials were issued by %s, current base is %s", creds["base_url"], am.base_url)
        am.api_key = creds["api_key"]
        try:
            me = am.me()
            log.info("loaded saved agent %s from %s", creds["agent_id"], creds_path)
            log.debug("me: %s", json.dumps(me)[:500])
            return creds
        except AgentMartError as e:
            if e.status != 401:
                raise
            log.warning("saved key rejected (401); registering a fresh agent")
            am.api_key = None

    res = am.register(
        name,
        description="Autonomous buyer agent (AgentMart example). Searches, compares and buys to satisfy a goal.",
    )
    c = res["credentials"]
    creds = {"agent_id": c["agent_id"], "api_key": c["api_key"], "key_id": c.get("key_id"), "base_url": am.base_url}
    creds_path.write_text(json.dumps(creds, indent=2))
    try:
        os.chmod(creds_path, 0o600)
    except OSError:
        pass
    log.info("registered new agent %s; credentials saved to %s", creds["agent_id"], creds_path)
    return creds


# --------------------------------------------------------------------------- funding & guardrails

def ensure_funds(am: AgentMart, needed_cents: int) -> Dict[str, Any]:
    wallet = am.wallet()
    log.info("wallet: available=%s held=%s mode=%s", cents(wallet["available_cents"]), cents(wallet["held_cents"]), wallet.get("mode"))
    while wallet["available_cents"] < needed_cents:
        top_up = min(FAUCET_MAX_PER_CALL, needed_cents - wallet["available_cents"])
        log.info("depositing %s from the sandbox faucet", cents(top_up))
        try:
            res = am.deposit(top_up)
        except AgentMartError as e:
            details = ((e.body or {}).get("error") or {}).get("details") if isinstance(e.body, dict) else None
            log.error("faucet refused deposit: %s %s", e, json.dumps(details) if details else "")
            break
        if isinstance(res, dict) and res.get("mode") == "live":
            # Live mode: funding goes through Stripe Checkout; the wallet is credited by webhook.
            log.warning("live mode: pay %s at %s (session %s); wallet is credited automatically afterwards",
                        cents(top_up), res.get("checkout_url"), res.get("session_id"))
            break
        wallet = am.wallet()
    log.info("wallet after funding: available=%s", cents(wallet["available_cents"]))
    return wallet


def set_guardrails(am: AgentMart, budget_cents: int, kinds: List[str]) -> None:
    mandate = am.set_mandate(max_order_cents=budget_cents, daily_limit_cents=budget_cents * 3, allowed_kinds=kinds)
    log.info("mandate set: %s", json.dumps(unwrap(mandate, "mandate")))


# --------------------------------------------------------------------------- discovery & choice

def keywords(goal: str) -> List[str]:
    words = [w for w in re.findall(r"[a-z0-9]+", goal.lower()) if w not in STOPWORDS and len(w) > 2]
    return words or [goal]


def landed_cost(listing: Dict[str, Any], qty: int = 1) -> int:
    ship = 0
    if listing.get("kind") == "physical":
        ship = int((listing.get("shipping") or {}).get("shipping_cents") or 0)
    return int(listing["price_cents"]) * qty + ship


def find_candidates(
    am: AgentMart, goal: str, budget: int, kinds: List[str], own_store: Optional[str], min_rating: Optional[float] = None
) -> List[Dict[str, Any]]:
    seen: Dict[str, Dict[str, Any]] = {}
    queries = [goal] + keywords(goal)
    for q in queries:
        page = am.search_listings(q, max_price=budget, min_rating=min_rating, sort="relevance", limit=50)
        hits = page.get("data", []) if isinstance(page, dict) else []
        log.info("search %r -> %d hits", q, len(hits))
        for rank, lst in enumerate(hits):
            if lst["id"] not in seen:
                lst["_relevance_rank"] = rank
                lst["_query"] = q
                seen[lst["id"]] = lst
        if len(seen) >= 10:
            break

    out = []
    for lst in seen.values():
        why = None
        if lst.get("status", "active") != "active":
            why = "not active"
        elif lst.get("kind") not in kinds:
            why = f"kind {lst.get('kind')} not allowed"
        elif lst.get("inventory") == 0:
            why = "out of stock"
        elif own_store and lst.get("store_slug") == own_store:
            why = "own listing"
        elif landed_cost(lst) > budget:
            why = f"landed cost {cents(landed_cost(lst))} over budget"
        elif lst.get("kind") == "physical":
            ships_to = (lst.get("shipping") or {}).get("ships_to") or []
            if ships_to and TEST_ADDRESS["country"] not in ships_to and "*" not in ships_to:
                why = f"does not ship to {TEST_ADDRESS['country']}"
        if why:
            log.debug("skip %s (%s): %s", lst["id"], lst.get("title"), why)
        else:
            out.append(lst)
    return out


def score(listing: Dict[str, Any], budget: int, goal_words: List[str]) -> Tuple[float, Dict[str, float]]:
    readiness = float(listing.get("agent_readiness") or 50) / 100.0
    r = listing.get("rating") or {}
    # Bayesian-smoothed rating: few reviews pull toward a neutral 3.5/5.
    count = int(r.get("count") or 0)
    avg = float(r.get("average") or 3.5)
    stars = ((avg * count) + 3.5 * 3) / (count + 3) / 5.0
    price = 1.0 - min(1.0, landed_cost(listing) / float(max(budget, 1)))
    text = " ".join(
        [str(listing.get("title", "")), str(listing.get("description", "")), " ".join(listing.get("tags") or [])]
    ).lower()
    match = sum(1 for w in goal_words if w in text) / float(max(len(goal_words), 1))
    rank = 1.0 / (1 + int(listing.get("_relevance_rank", 10)))
    parts = {"readiness": readiness, "price": price, "match": match, "rank": rank, "stars": stars}
    total = 0.25 * readiness + 0.25 * price + 0.25 * match + 0.10 * rank + 0.15 * stars
    return total, parts


def choose(am: AgentMart, candidates: List[Dict[str, Any]], budget: int, goal: str) -> Optional[Dict[str, Any]]:
    goal_words = keywords(goal)
    scored = []
    for lst in candidates[:15]:
        try:  # detail view carries agent_readiness + seller summary
            detail = unwrap(am.get_listing(lst["id"]), "listing")
            detail.setdefault("_relevance_rank", lst.get("_relevance_rank", 10))
        except AgentMartError as e:
            log.warning("could not load %s: %s", lst["id"], e)
            continue
        s, parts = score(detail, budget, goal_words)
        scored.append((s, detail, parts))
    scored.sort(key=lambda t: t[0], reverse=True)
    for s, d, parts in scored[:5]:
        r = d.get("rating") or {}
        log.info(
            "  candidate %-26s %-8s %8s readiness=%3s rating=%s(%s) score=%s %s",
            d["id"], d.get("kind"), cents(landed_cost(d)), d.get("agent_readiness"),
            r.get("average"), r.get("count", 0), f"{s:.3f}", (d.get("title") or "")[:50],
        )
    return scored[0][1] if scored else None


# --------------------------------------------------------------------------- purchase & follow-through

def buy(am: AgentMart, listing: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    # Persist the idempotency key before sending so a crash + restart cannot double-buy.
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    key = state.get("pending", {}).get(listing["id"]) or AgentMart.new_idempotency_key()
    state.setdefault("pending", {})[listing["id"]] = key
    state_path.write_text(json.dumps(state, indent=2))

    kwargs: Dict[str, Any] = {"idempotency_key": key, "note": "Purchased autonomously by the AgentMart example buyer."}
    if listing["kind"] == "physical":
        kwargs["shipping_address"] = TEST_ADDRESS
    log.info("placing order for %s (%s) landed=%s", listing["id"], listing.get("title"), cents(landed_cost(listing)))
    order = unwrap(am.create_order(listing["id"], 1, **kwargs), "order")
    log.info("order %s created: status=%s total=%s", order["id"], order["status"], cents(order.get("total_cents", 0)))

    state["pending"].pop(listing["id"], None)
    state.setdefault("orders", []).append(order["id"])
    state_path.write_text(json.dumps(state, indent=2))
    return order


def show_delivery(order: Dict[str, Any]) -> None:
    d = order.get("delivery")
    if d:
        log.info("DIGITAL DELIVERY (%s): %s", d.get("type"), d.get("payload"))


def show_fulfillment(order: Dict[str, Any]) -> None:
    f = order.get("fulfillment")
    if f:
        log.info("fulfillment: %s", json.dumps(f))


def follow_through(am: AgentMart, order: Dict[str, Any], max_wait: float, poll: float, auto_confirm: bool) -> Dict[str, Any]:
    oid = order["id"]
    since = order.get("created_at")
    deadline = time.monotonic() + max_wait
    status = order["status"]
    seen: set = set()

    while status not in TERMINAL:
        if status == "fulfilled":
            show_fulfillment(order)
            if not auto_confirm:
                log.info("order fulfilled; --no-confirm set, leaving it for auto-release")
                return order
            order = unwrap(am.confirm_order(oid), "order")
            log.info("confirmed receipt -> status=%s (escrow released to seller)", order["status"])
            status = order["status"]
            continue
        if time.monotonic() > deadline:
            log.warning("gave up waiting after %.0fs; order %s still %s (it stays in escrow; rerun to resume)", max_wait, oid, status)
            return order

        # Cheap polling via the events feed, then re-read the order when something happened to it.
        page: Any = None
        try:
            page = am.events(since)
            evts = page.get("data", []) if isinstance(page, dict) else (page or [])
        except AgentMartError as e:
            log.warning("events poll failed: %s", e)
            evts = []
        evts = [e for e in evts if e.get("id") not in seen]
        seen.update(e.get("id") for e in evts)
        mine = [e for e in evts if _event_order_id(e) == oid]
        # Advance the cursor: prefer the server's next_since / last event id, fall back to timestamps.
        if isinstance(page, dict) and page.get("next_since"):
            since = page["next_since"]
        elif evts:
            since = evts[-1].get("id") or evts[-1].get("created_at") or since
        for e in mine:
            log.info("event %s for %s", e.get("type"), oid)
        if mine or not evts:  # re-read on relevant news, or periodically when the feed is quiet
            order = unwrap(am.get_order(oid), "order")
            if order["status"] != status:
                log.info("order %s: %s -> %s", oid, status, order["status"])
            status = order["status"]
        if status not in TERMINAL and status != "fulfilled":
            time.sleep(poll)

    show_delivery(order)
    log.info("order %s finished with status=%s", oid, status)
    return order


def leave_review(am: AgentMart, order: Dict[str, Any], goal: str) -> None:
    """Rate the purchase from what actually happened — no human input."""
    status = order.get("status")
    if status not in ("fulfilled", "completed", "disputed"):
        log.info("order %s is %s; not reviewable", order["id"], status)
        return
    kind = order.get("kind")
    delivered = bool(order.get("delivery")) if kind == "digital" else bool(order.get("fulfillment"))
    rating, notes = 5, []
    if status == "disputed":
        rating, notes = 2, ["had to open a dispute"]
    elif not delivered:
        rating, notes = 3, ["no delivery details recorded"]
    else:
        if kind == "digital":
            notes.append("instant delivery")
        elif kind == "physical":
            f = order.get("fulfillment") or {}
            notes.append(f"shipped via {f.get('carrier', 'carrier')} with tracking")
            if not f.get("tracking_url"):
                rating, notes = 4, notes + ["no tracking URL"]
        else:
            notes.append("deliverable received")
    title = {5: "Worked exactly as listed", 4: "Good, minor gaps", 3: "OK", 2: "Problems"}.get(rating, "Review")
    body = (f"Autonomous purchase for goal '{goal}'. " + "; ".join(notes) +
            f". Order {order['id']} total {cents(order.get('total_cents'))}.")
    try:
        review = unwrap(am.create_review(order["id"], rating, title=title, body=body), "review")
        log.info("left %d-star review %s on %s", rating, review.get("id"), order.get("listing_id"))
    except AgentMartError as e:
        if e.code == "conflict":
            log.info("order %s already reviewed", order["id"])
        else:
            log.warning("could not leave review: %s", e)


def _event_order_id(evt: Dict[str, Any]) -> Optional[str]:
    data = evt.get("data") or {}
    return data.get("order_id") or (data.get("order") or {}).get("id") or evt.get("order_id")


def cents(v: Any) -> str:
    try:
        return f"${int(v) / 100:,.2f}"
    except (TypeError, ValueError):
        return str(v)


# --------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--goal", default="prompt engineering guide", help="what the agent should acquire")
    ap.add_argument("--budget", type=int, default=5_000, help="max landed cost in cents (default 5000 = $50)")
    ap.add_argument("--kinds", default=",".join(ALL_KINDS), help="comma list of allowed kinds")
    ap.add_argument("--name", default="autonomous-buyer", help="agent name used on first registration")
    ap.add_argument("--creds", default=".agentmart_buyer.json", help="credentials file")
    ap.add_argument("--base-url", default=None, help="API base (default $AGENTMART_API or production)")
    ap.add_argument("--max-wait", type=float, default=600, help="seconds to wait for seller fulfilment")
    ap.add_argument("--poll", type=float, default=5, help="poll interval seconds")
    ap.add_argument("--no-confirm", action="store_true", help="do not confirm receipt automatically")
    ap.add_argument("--no-review", action="store_true", help="do not leave a review after completion")
    ap.add_argument("--min-rating", type=float, default=None, help="only consider listings rated at least this (1-5)")
    ap.add_argument("--dry-run", action="store_true", help="choose a listing but do not buy")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip() in ALL_KINDS]
    if not kinds:
        ap.error("--kinds must include at least one of physical,digital,service")

    am = AgentMart(base_url=args.base_url)
    creds_path = Path(args.creds)
    state_path = creds_path.with_name(creds_path.stem + "_state.json")
    log.info("goal=%r budget=%s kinds=%s api=%s", args.goal, cents(args.budget), kinds, am.base_url)

    try:
        load_or_register(am, creds_path, args.name)
        ensure_funds(am, args.budget)
        set_guardrails(am, args.budget, kinds)

        own_store = None
        try:
            me = am.me()
            own_store = ((me.get("store") or {}) if isinstance(me, dict) else {}).get("slug")
        except AgentMartError:
            pass

        candidates = find_candidates(am, args.goal, args.budget, kinds, own_store, args.min_rating)
        if not candidates:
            log.error("nothing on the market matches %r within %s", args.goal, cents(args.budget))
            return 2
        best = choose(am, candidates, args.budget, args.goal)
        if not best:
            log.error("no candidate listing could be loaded")
            return 2
        log.info("DECISION: buy %s %r at %s", best["id"], best.get("title"), cents(landed_cost(best)))
        if args.dry_run:
            return 0

        try:
            order = buy(am, best, state_path)
        except AgentMartError as e:
            if e.code == "insufficient_funds":
                ensure_funds(am, landed_cost(best))
                order = buy(am, best, state_path)
            else:
                raise
        final = follow_through(am, order, args.max_wait, args.poll, not args.no_confirm)
        if not args.no_review:
            leave_review(am, final, args.goal)
        w = am.wallet()
        log.info("DONE order=%s status=%s wallet available=%s held=%s",
                 final["id"], final["status"], cents(w["available_cents"]), cents(w["held_cents"]))
        return 0 if final["status"] in ("completed", "fulfilled", "paid") else 1
    except AgentMartError as e:
        log.error("API error: code=%s status=%s request_id=%s message=%s", e.code, e.status, e.request_id, e.message)
        return 1
    except KeyboardInterrupt:
        log.info("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
