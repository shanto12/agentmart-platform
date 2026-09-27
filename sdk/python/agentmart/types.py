"""TypedDict shapes for AgentMart v1 API objects.

These mirror CONTRACT.md. They are ``total=False`` because the server may add
fields over time and some fields are only present for certain roles/kinds.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional

if sys.version_info >= (3, 8):
    from typing import Literal, TypedDict
else:  # pragma: no cover
    from typing_extensions import Literal, TypedDict  # type: ignore

ListingKind = Literal["physical", "digital", "service"]
ListingStatus = Literal["active", "paused", "archived", "sold_out"]
OrderStatus = Literal[
    "pending_payment", "paid", "fulfilled", "completed", "cancelled", "refunded", "disputed"
]
OrderRole = Literal["buyer", "seller"]
SortOrder = Literal["relevance", "price_asc", "price_desc", "newest", "rating"]
ReviewSort = Literal["newest", "highest", "lowest"]
TransactionType = Literal["deposit", "escrow_hold", "escrow_release", "payout", "refund", "fee"]
EventType = Literal[
    "order.paid",
    "order.fulfilled",
    "order.completed",
    "order.cancelled",
    "order.refunded",
    "order.disputed",
    "listing.sold_out",
    "review.created",
    "review.replied",
]


class Credentials(TypedDict, total=False):
    agent_id: str
    api_key: str
    key_id: str


class Rating(TypedDict, total=False):
    average: Optional[float]
    count: int


class Agent(TypedDict, total=False):
    id: str
    name: str
    email: Optional[str]  # private: only in your own /v1/me
    description: Optional[str]
    operator_contact: Optional[str]
    webhook_url: Optional[str]
    created_at: str


class RegisterResponse(TypedDict, total=False):
    agent: Agent
    credentials: Credentials
    note: str
    webhook_secret: str


class TokenResponse(TypedDict, total=False):
    access_token: str
    token_type: str
    expires_in: int


class Wallet(TypedDict, total=False):
    available_cents: int
    held_cents: int
    currency: str
    mode: str


class Mandate(TypedDict, total=False):
    max_order_cents: int
    daily_limit_cents: int
    allowed_kinds: List[ListingKind]


class ApiKey(TypedDict, total=False):
    id: str
    key_id: str
    prefix: str
    api_key: str  # only present on creation
    created_at: str
    revoked_at: Optional[str]


class ShippingAddress(TypedDict, total=False):
    name: str
    line1: str
    line2: Optional[str]
    city: str
    region: str
    postal_code: str
    country: str


class ShippingTerms(TypedDict, total=False):
    handling_days: int
    ships_to: List[str]
    shipping_cents: int


class DigitalDelivery(TypedDict, total=False):
    type: Literal["url", "text", "license_key"]
    payload: str


class ServiceTerms(TypedDict, total=False):
    turnaround_days: int
    deliverable: str


class Store(TypedDict, total=False):
    id: str
    slug: str
    name: str
    description: Optional[str]
    ships_from: Optional[str]
    return_policy: Optional[str]
    agent_id: str
    listings: List["Listing"]
    rating: Rating
    active_listings: int
    created_at: str


class Listing(TypedDict, total=False):
    id: str
    title: str
    description: str
    kind: ListingKind
    status: ListingStatus
    price_cents: int
    currency: str
    inventory: Optional[int]
    category: Optional[str]
    tags: List[str]
    attributes: Dict[str, Any]
    image_url: Optional[str]
    shipping: Optional[ShippingTerms]
    service_terms: Optional[ServiceTerms]
    agent_readiness: int
    rating: Rating
    purchase: Dict[str, Any]
    seller: Dict[str, Any]
    store_slug: str
    created_at: str
    updated_at: str


class OrderEvent(TypedDict, total=False):
    type: str
    at: str
    data: Dict[str, Any]


class Order(TypedDict, total=False):
    id: str
    status: OrderStatus
    listing_id: str
    listing_title: str
    kind: ListingKind
    quantity: int
    unit_price_cents: int
    shipping_cents: int
    total_cents: int
    fee_cents: int
    buyer_agent_id: str
    seller_agent_id: str
    store_slug: str
    shipping_address: Optional[ShippingAddress]
    fulfillment: Optional[Dict[str, Any]]
    delivery: Optional[DigitalDelivery]
    events: List[OrderEvent]
    created_at: str
    updated_at: str


class Transaction(TypedDict, total=False):
    id: str
    transfer_id: str
    account: Literal["available", "held"]
    memo: Optional[str]
    type: TransactionType
    amount_cents: int
    balance_after_cents: int
    order_id: Optional[str]
    created_at: str


class Event(TypedDict, total=False):
    id: str
    type: EventType
    created_at: str
    data: Dict[str, Any]


class SellerReply(TypedDict, total=False):
    body: str
    created_at: str


class Review(TypedDict, total=False):
    id: str
    listing_id: str
    listing_title: str
    order_id: Optional[str]
    store_slug: str
    rating: int
    title: Optional[str]
    body: Optional[str]
    verified_purchase: bool
    reviewer: Dict[str, Any]
    seller_reply: Optional[SellerReply]
    created_at: str
    updated_at: str


class Category(TypedDict, total=False):
    slug: str
    name: str
    listing_count: int


class CatalogItem(TypedDict, total=False):
    id: str
    title: str
    kind: ListingKind
    price_cents: int
    currency: str
    shipping_cents: int
    inventory: Optional[int]
    rating: Rating
    category: Optional[str]
    store_slug: str
    url: str
    updated_at: str


class Stats(TypedDict, total=False):
    agents: int
    stores: int
    active_listings: int
    orders_completed: int
    gmv_cents: int


class Page(TypedDict, total=False):
    data: List[Any]
    next_cursor: Optional[str]
