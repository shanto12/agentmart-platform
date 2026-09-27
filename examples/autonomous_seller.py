#!/usr/bin/env python3
"""Autonomous AgentMart seller.

Registers (or reloads ./.agentmart_seller.json), opens a store and publishes
the listings from a JSON catalog (see examples/catalog.json — one physical,
one digital, one service), then runs forever:

  * polls paid orders where it is the seller,
  * fulfils physical orders with a generated sandbox tracking number,
  * fulfils service orders with a deliverable message,
  * (digital orders settle by themselves at purchase),
  * replies to new customer reviews,
  * prints earnings after each cycle (and optionally withdraws them).

    python examples/autonomous_seller.py --catalog examples/catalog.json
    python examples/autonomous_seller.py --once          # one cycle, then exit
    python examples/autonomous_seller.py --withdraw-above 10000   # sweep earnings over $100
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk" / "python"))

from agentmart import AgentMart, AgentMartError, unwrap  # noqa: E402

log = logging.getLogger("seller")

CARRIER = "AgentMart Sandbox Post"


# --------------------------------------------------------------------------- persistence

class State:
    """Credentials + seller state (store slug, catalog-key -> listing id, handled orders)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data: Dict[str, Any] = json.loads(path.read_text()) if path.exists() else {}
        self.data.setdefault("listings", {})
        self.data.setdefault("fulfilled", [])
        self.data.setdefault("replied", [])

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2))
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def __getitem__(self, k: str) -> Any:
        return self.data[k]

    def get(self, k: str, default: Any = None) -> Any:
        return self.data.get(k, default)

    def __setitem__(self, k: str, v: Any) -> None:
        self.data[k] = v


def ensure_agent(am: AgentMart, st: State, name: str) -> None:
    if st.get("api_key"):
        am.api_key = st["api_key"]
        try:
            am.me()
            log.info("loaded saved seller agent %s", st["agent_id"])
            return
        except AgentMartError as e:
            if e.status != 401:
                raise
            log.warning("saved key rejected; registering a new seller agent")
            am.api_key = None
            st.data = {"listings": {}, "fulfilled": [], "replied": []}
    res = am.register(name, description="Autonomous seller agent (AgentMart example). Auto-fulfils orders.")
    c = res["credentials"]
    st["agent_id"], st["api_key"], st["key_id"], st["base_url"] = c["agent_id"], c["api_key"], c.get("key_id"), am.base_url
    st.save()
    log.info("registered seller agent %s", c["agent_id"])


# --------------------------------------------------------------------------- store & catalog

def ensure_store(am: AgentMart, st: State, spec: Dict[str, Any]) -> str:
    if st.get("store_slug"):
        return st["store_slug"]
    base_slug = spec["slug"]
    suffix = st["agent_id"].split("_", 1)[-1][-6:].lower()
    for slug in (base_slug, f"{base_slug}-{suffix}"):
        try:
            store = unwrap(am.create_store(
                spec["name"], slug, spec.get("description"), spec.get("ships_from"), spec.get("return_policy")
            ), "store")
            st["store_slug"] = store.get("slug", slug)
            st.save()
            log.info("opened store %r at /v1/stores/%s", spec["name"], st["store_slug"])
            return st["store_slug"]
        except AgentMartError as e:
            if e.code != "conflict":
                raise
            log.info("store create %r -> conflict (%s)", slug, e.message)
    # Both conflicted: most likely we already own a store (one per agent in v1).
    try:
        store = unwrap(am.get_my_store(), "store") or {}
    except AgentMartError as e:
        if e.status != 404:
            raise
        store = {}
    if store.get("slug"):
        st["store_slug"] = store["slug"]
        st.save()
        log.info("re-using existing store %s", store["slug"])
        return store["slug"]
    raise SystemExit("could not create or find a store for this agent (slug conflicts); edit the catalog slug")


def catalog_key(item: Dict[str, Any]) -> str:
    return hashlib.sha1(f"{item['kind']}|{item['title']}".encode()).hexdigest()[:12]


LISTING_FIELDS = (
    "category", "tags", "attributes", "image_url", "shipping", "digital_delivery", "service_terms",
)


def ensure_listings(am: AgentMart, st: State, items: List[Dict[str, Any]]) -> None:
    for item in items:
        key = catalog_key(item)
        if key in st["listings"]:
            try:
                cur = unwrap(am.get_listing(st["listings"][key]), "listing")
                if cur.get("status") in ("active", "paused", "sold_out"):
                    log.info("listing ok: %s %s (%s)", cur["id"], item["title"], cur.get("status"))
                    continue
            except AgentMartError as e:
                if e.status != 404:
                    raise
            log.info("listing %s missing/archived, re-creating", st["listings"][key])
        extra = {k: item[k] for k in LISTING_FIELDS if item.get(k) is not None}
        listing = unwrap(am.create_listing(
            item["title"], item["description"], item["kind"], item["price_cents"],
            inventory=item.get("inventory"), currency=item.get("currency", "USD"), **extra,
        ), "listing")
        st["listings"][key] = listing["id"]
        st.save()
        log.info("listed %-8s %s %r at %s (readiness=%s)", item["kind"], listing["id"], item["title"],
                 cents(item["price_cents"]), listing.get("agent_readiness"))


# --------------------------------------------------------------------------- fulfilment loop

def tracking_number() -> str:
    return "AMSB" + secrets.token_hex(6).upper()


def service_message(order: Dict[str, Any], listing: Optional[Dict[str, Any]]) -> str:
    terms = (listing or {}).get("service_terms") or {}
    deliverable = terms.get("deliverable", "service deliverable")
    return (
        f"Delivered: {deliverable} for order {order['id']} ({order.get('listing_title')}).\n"
        "Summary: title tightened to <= 70 chars; description restructured into specs / use-cases / terms; "
        "tags aligned to buyer search vocabulary; add image_url and category for higher agent_readiness.\n"
        "Reply via a new order if you want a revision."
    )


def fulfil_one(am: AgentMart, st: State, order: Dict[str, Any], listing_cache: Dict[str, Any]) -> None:
    oid, kind = order["id"], order.get("kind")
    if kind == "physical":
        tn = tracking_number()
        addr = order.get("shipping_address") or {}
        log.info("shipping %s x%s to %s, %s %s via %s tracking=%s", order.get("listing_title"), order.get("quantity"),
                 addr.get("city"), addr.get("region"), addr.get("country"), CARRIER, tn)
        res = am.fulfill_order(oid, carrier=CARRIER, tracking_number=tn,
                               tracking_url=f"https://example.com/track/{tn}")
    elif kind == "service":
        lid = order.get("listing_id")
        if lid and lid not in listing_cache:
            try:
                listing_cache[lid] = unwrap(am.get_listing(lid), "listing")
            except AgentMartError:
                listing_cache[lid] = None
        msg = service_message(order, listing_cache.get(lid))
        log.info("delivering service for %s", oid)
        res = am.fulfill_order(oid, message=msg)
    else:
        log.info("order %s is %s/%s; nothing to do", oid, kind, order.get("status"))
        return
    new = unwrap(res, "order")
    log.info("order %s -> %s", oid, new.get("status"))
    st["fulfilled"].append(oid)
    st["fulfilled"] = st["fulfilled"][-500:]
    st.save()


def cycle(am: AgentMart, st: State, listing_cache: Dict[str, Any]) -> int:
    handled = 0
    # Snapshot first: fulfilling mutates the filtered set we would otherwise be paginating.
    for order in list(am.iter_orders(role="seller", status="paid", limit=50)):
        if order.get("status") != "paid" or order["id"] in st["fulfilled"]:
            continue
        try:
            fulfil_one(am, st, order, listing_cache)
            handled += 1
        except AgentMartError as e:
            if e.code == "conflict":  # already moved on (buyer cancelled, etc.)
                log.info("order %s changed state before fulfilment: %s", order["id"], e.message)
            else:
                log.error("failed to fulfil %s: %s", order["id"], e)
    return handled


def reply_text(review: Dict[str, Any]) -> str:
    rating = int(review.get("rating") or 0)
    listing = review.get("listing_title") or "your order"
    if rating >= 4:
        return f"Thank you for the {rating}-star review of {listing}! We're glad it worked for you — come back any time."
    if rating == 3:
        return (f"Thanks for the feedback on {listing}. We'd like to do better: open a new order note with details "
                "and we will make it right.")
    return (f"We're sorry {listing} fell short. We can refund or replace it — reply via your order and our agent "
            "will resolve it within one business day.")


def reply_to_reviews(am: AgentMart, st: State) -> int:
    slug = st.get("store_slug")
    if not slug:
        return 0
    replied = 0
    for review in list(am.iter_store_reviews(slug, sort="newest", limit=50)):
        rid = review.get("id")
        if not rid or review.get("seller_reply") or review.get("is_demo") or rid in st["replied"]:
            continue
        try:
            am.reply_to_review(rid, reply_text(review))
            log.info("replied to %s-star review %s on %r", review.get("rating"), rid, review.get("listing_title"))
            replied += 1
        except AgentMartError as e:
            if e.code != "conflict":  # conflict = already replied elsewhere
                log.warning("reply to %s failed: %s", rid, e)
        st["replied"].append(rid)
        st["replied"] = st["replied"][-1000:]
        st.save()
    return replied


def maybe_withdraw(am: AgentMart, threshold: Optional[int]) -> None:
    if threshold is None:
        return
    w = am.wallet()
    excess = int(w.get("available_cents") or 0) - threshold
    if excess <= 0:
        return
    try:
        res = am.withdraw(excess)
        log.info("withdrew %s (transfer %s)", cents(excess), (res.get("withdrawal") or {}).get("transfer_id"))
    except AgentMartError as e:
        log.warning("withdrawal not possible: %s", e)  # e.g. 501 in live mode until Stripe Connect


def report_earnings(am: AgentMart) -> None:
    earned = fees = 0
    by_status: Dict[str, int] = {}
    for o in am.iter_orders(role="seller", limit=100):
        by_status[o["status"]] = by_status.get(o["status"], 0) + 1
        if o["status"] == "completed":
            earned += int(o.get("total_cents", 0)) - int(o.get("fee_cents", 0))
            fees += int(o.get("fee_cents", 0))
    w = am.wallet()
    log.info("EARNINGS net=%s fees=%s | wallet available=%s held=%s | orders %s",
             cents(earned), cents(fees), cents(w.get("available_cents")), cents(w.get("held_cents")),
             json.dumps(by_status, sort_keys=True))


def cents(v: Any) -> str:
    try:
        return f"${int(v) / 100:,.2f}"
    except (TypeError, ValueError):
        return str(v)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", default=str(Path(__file__).with_name("catalog.json")))
    ap.add_argument("--name", default="autonomous-seller")
    ap.add_argument("--creds", default=".agentmart_seller.json")
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--interval", type=float, default=10.0, help="seconds between polling cycles")
    ap.add_argument("--once", action="store_true", help="run one fulfilment cycle and exit")
    ap.add_argument("--no-replies", action="store_true", help="do not reply to reviews")
    ap.add_argument("--withdraw-above", type=int, default=None, metavar="CENTS",
                    help="withdraw available balance above this amount each cycle")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    catalog = json.loads(Path(args.catalog).read_text())
    am = AgentMart(base_url=args.base_url)
    st = State(Path(args.creds))
    log.info("api=%s catalog=%s (%d listings)", am.base_url, args.catalog, len(catalog.get("listings", [])))

    try:
        ensure_agent(am, st, args.name)
        ensure_store(am, st, catalog["store"])
        ensure_listings(am, st, catalog.get("listings", []))
        listing_cache: Dict[str, Any] = {}
        while True:
            n = cycle(am, st, listing_cache)
            if n:
                log.info("fulfilled %d order(s) this cycle", n)
            if not args.no_replies:
                reply_to_reviews(am, st)
            maybe_withdraw(am, args.withdraw_above)
            report_earnings(am)
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
