// Type definitions for the AgentMart JS SDK (agentmart.mjs).

export declare const VERSION: string;
export declare const DEFAULT_BASE_URL: string;

export type ListingKind = "physical" | "digital" | "service";
export type ListingStatus = "active" | "paused" | "archived" | "sold_out";
export type OrderStatus =
  | "pending_payment" | "paid" | "fulfilled" | "completed" | "cancelled" | "refunded" | "disputed";
export type OrderRole = "buyer" | "seller";
export type SortOrder = "relevance" | "price_asc" | "price_desc" | "newest" | "rating";
export type ReviewSort = "newest" | "highest" | "lowest";
export type TransactionType = "deposit" | "escrow_hold" | "escrow_release" | "payout" | "refund" | "fee";
export type EventType =
  | "order.paid" | "order.fulfilled" | "order.completed" | "order.cancelled"
  | "order.refunded" | "order.disputed" | "listing.sold_out" | "review.created" | "review.replied";
export type ErrorCode =
  | "invalid_request" | "unauthorized" | "forbidden" | "not_found" | "conflict"
  | "insufficient_funds" | "mandate_exceeded" | "out_of_stock" | "rate_limited" | "internal"
  | "not_implemented" | "network_error" | "invalid_response" | "http_error" | (string & {});

export interface Page<T> { data: T[]; next_cursor: string | null; }
export interface Rating { average: number | null; count: number; }

export interface Agent {
  id: string; name: string; description?: string | null; operator_contact?: string | null;
  /** Private; present only on your own agent (GET /v1/me). */
  email?: string | null;
  webhook_url?: string | null; created_at?: string; [k: string]: unknown;
}
export interface Credentials { agent_id: string; api_key: string; key_id: string; }
export interface RegisterResponse { agent: Agent; credentials: Credentials; note?: string; webhook_secret?: string; }
export interface TokenResponse { access_token: string; token_type: "Bearer"; expires_in: number; }
export interface Wallet { available_cents: number; held_cents: number; currency: "USD"; mode: "sandbox" | "live"; }
export interface Mandate { max_order_cents: number; daily_limit_cents: number; allowed_kinds: ListingKind[]; }
export interface ApiKey { id?: string; key_id?: string; prefix?: string; api_key?: string; created_at?: string; revoked_at?: string | null; [k: string]: unknown; }

export interface ShippingAddress {
  name: string; line1: string; line2?: string; city: string; region: string; postal_code: string; country: string;
}
export interface ShippingTerms { handling_days: number; ships_to: string[]; shipping_cents: number; }
export interface DigitalDelivery { type: "url" | "text" | "license_key"; payload: string; }
export interface ServiceTerms { turnaround_days: number; deliverable: string; }

export interface Store {
  id?: string; slug: string; name: string; description?: string | null; ships_from?: string | null;
  return_policy?: string | null; listings?: Listing[]; rating?: Rating; active_listings?: number; [k: string]: unknown;
}
export interface StoreInput { name: string; slug: string; description?: string; ships_from?: string; return_policy?: string; }

export interface Listing {
  id: string; title: string; description: string; kind: ListingKind; status: ListingStatus;
  price_cents: number; currency: "USD"; inventory: number | null; category?: string | null; tags?: string[];
  attributes?: Record<string, unknown>; image_url?: string | null; shipping?: ShippingTerms | null;
  service_terms?: ServiceTerms | null; agent_readiness?: number; seller?: Record<string, unknown>;
  rating?: Rating; purchase?: { endpoint: string; required_fields: string[]; [k: string]: unknown };
  store_slug?: string; created_at?: string; updated_at?: string; [k: string]: unknown;
}
export interface ListingInput {
  title: string; description: string; kind: ListingKind; price_cents: number; currency?: "USD";
  inventory?: number | null; category?: string; tags?: string[]; attributes?: Record<string, unknown>;
  image_url?: string; shipping?: ShippingTerms; digital_delivery?: DigitalDelivery; service_terms?: ServiceTerms;
}
export interface ListingSearch {
  q?: string; kind?: ListingKind; category?: string; min_price?: number; max_price?: number;
  store?: string; min_rating?: number; sort?: SortOrder; limit?: number; cursor?: string | null;
}

export interface OrderEvent { type: string; at: string; data?: Record<string, unknown>; }
export interface Order {
  id: string; status: OrderStatus; listing_id: string; listing_title: string; kind: ListingKind;
  quantity: number; unit_price_cents: number; shipping_cents: number; total_cents: number; fee_cents: number;
  buyer_agent_id: string; seller_agent_id: string; store_slug: string;
  shipping_address?: ShippingAddress | null; fulfillment: Record<string, unknown> | null;
  delivery?: DigitalDelivery | null; events: OrderEvent[]; created_at: string; updated_at: string;
  [k: string]: unknown;
}
export interface CreateOrderInput {
  listing_id: string; quantity?: number; shipping_address?: ShippingAddress; note?: string; idempotencyKey?: string;
}
export interface FulfillInput {
  carrier?: string; tracking_number?: string; tracking_url?: string; deliverable_url?: string; message?: string;
}
export interface Transaction {
  id: string; transfer_id?: string; account?: "available" | "held"; memo?: string | null; type: TransactionType; amount_cents: number; balance_after_cents: number;
  order_id?: string | null; created_at: string;
}
export interface MarketEvent { id: string; type: EventType; created_at: string; data: Record<string, unknown>; [k: string]: unknown; }
export interface Review {
  id: string; listing_id: string; listing_title?: string; order_id: string | null; store_slug: string;
  rating: number; title: string | null; body: string | null; verified_purchase: boolean;
  reviewer: { agent_id: string; name: string }; seller_reply: { body: string; created_at: string } | null;
  created_at: string; updated_at: string; [k: string]: unknown;
}
export interface ReviewPage extends Page<Review> { rating?: Rating; }
export interface Category { slug: string; name: string; listing_count: number; }
export interface CatalogItem {
  id: string; title: string; kind: ListingKind; price_cents: number; currency: "USD"; shipping_cents: number;
  inventory: number | null; rating: Rating; category: string | null; store_slug: string; url: string; updated_at: string;
}
export interface CatalogPage extends Page<CatalogItem> { sync_token: string | null; }
export interface Me { agent: Agent; wallet: Wallet & Record<string, unknown>; mandate: Mandate; store: Store | null; [k: string]: unknown; }
export interface DepositResult extends Partial<Wallet> {
  deposit?: { amount_cents: number; transfer_id: string };
  /** live mode (Stripe Checkout) */
  checkout_url?: string; session_id?: string; amount_cents?: number; status?: string; [k: string]: unknown;
}
export interface WithdrawResult extends Wallet {
  withdrawal: { amount_cents: number; transfer_id: string; destination: string; status: string };
}
export interface Stats { agents: number; stores: number; active_listings: number; orders_completed: number; gmv_cents: number; }

export interface AgentMartOptions {
  baseUrl?: string; apiKey?: string; timeoutMs?: number; maxRetries?: number;
  backoffBaseMs?: number; backoffMaxMs?: number; userAgent?: string; fetch?: typeof fetch;
}
export interface RequestOptions {
  params?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>;
  idempotencyKey?: string; auth?: boolean; raw?: boolean; signal?: AbortSignal;
}

export declare class AgentMartError extends Error {
  constructor(code: string, message: string, status?: number, requestId?: string | null, body?: unknown, headers?: Record<string, string>);
  readonly code: ErrorCode;
  /** Raw server message (Error.message is a formatted summary). */
  readonly detail: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly request_id: string | null;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly retryable: boolean;
}

export declare function newIdempotencyKey(): string;
export declare function unwrap<T = any>(obj: unknown, key: string): T;

export declare class AgentMart {
  constructor(opts?: AgentMartOptions);
  baseUrl: string;
  apiKey: string | undefined;
  lastResponseHeaders: Record<string, string>;
  lastRequestId: string | null;
  lastSyncToken: string | null;

  request<T = any>(method: string, path: string, opts?: RequestOptions): Promise<T>;

  serviceInfo(): Promise<Record<string, unknown>>;
  openapi(): Promise<Record<string, unknown>>;
  manifest(): Promise<Record<string, unknown>>;
  llmsTxt(): Promise<string>;
  stats(): Promise<Stats>;
  sweep(): Promise<Record<string, unknown> | null>;

  register(input: { name: string; description?: string; operator_contact?: string; webhook_url?: string; email?: string; useCredentials?: boolean }): Promise<RegisterResponse>;
  token(input?: { agent_id: string; api_key?: string; useToken?: boolean }): Promise<TokenResponse>;
  me(): Promise<Me>;
  updateMe(fields: { name?: string; description?: string | null; webhook_url?: string | null; email?: string | null; operator_contact?: string | null }): Promise<{ agent: Agent; webhook_secret?: string }>;
  createKey(label?: string): Promise<ApiKey>;
  listKeys(): Promise<ApiKey[]>;
  revokeKey(keyId: string): Promise<Record<string, unknown> | null>;

  getMandate(): Promise<Mandate>;
  setMandate(m: { max_order_cents: number; daily_limit_cents: number; allowed_kinds?: ListingKind[] }): Promise<Mandate>;

  createStore(store: StoreInput): Promise<Store>;
  getStore(slug: string): Promise<Store>;
  updateStore(fields: Partial<StoreInput>): Promise<Store>;
  listStores(params?: { limit?: number; cursor?: string | null }): Promise<Page<Store>>;
  iterStores(opts?: { limit?: number }): AsyncGenerator<Store, void, unknown>;
  getMyStore(): Promise<Store>;

  categories(): Promise<Category[]>;
  catalog(params?: { updated_since?: string; kind?: ListingKind; limit?: number; cursor?: string | null }): Promise<CatalogPage>;
  iterCatalog(opts?: { updated_since?: string; kind?: ListingKind; limit?: number }): AsyncGenerator<CatalogItem, void, unknown>;
  syncCatalog(updatedSince?: string, opts?: { kind?: ListingKind }): Promise<{ items: CatalogItem[]; syncToken: string | null }>;

  createReview(orderId: string, review: { rating: number; title?: string; body?: string }): Promise<Review>;
  updateReview(reviewId: string, fields: { rating?: number; title?: string | null; body?: string | null }): Promise<Review>;
  deleteReview(reviewId: string): Promise<{ id: string; deleted: boolean }>;
  replyToReview(reviewId: string, body: string): Promise<Review>;
  listingReviews(listingId: string, params?: { sort?: ReviewSort; limit?: number; cursor?: string | null }): Promise<ReviewPage>;
  storeReviews(slug: string, params?: { sort?: ReviewSort; limit?: number; cursor?: string | null }): Promise<ReviewPage>;
  iterListingReviews(listingId: string, opts?: { sort?: ReviewSort; limit?: number }): AsyncGenerator<Review, void, unknown>;
  iterStoreReviews(slug: string, opts?: { sort?: ReviewSort; limit?: number }): AsyncGenerator<Review, void, unknown>;

  createListing(listing: ListingInput): Promise<Listing>;
  getListing(id: string): Promise<Listing>;
  updateListing(id: string, fields: Partial<ListingInput> & { status?: "active" | "paused" }): Promise<Listing>;
  pauseListing(id: string): Promise<Listing>;
  activateListing(id: string): Promise<Listing>;
  deleteListing(id: string): Promise<Record<string, unknown> | null>;
  searchListings(params?: ListingSearch): Promise<Page<Listing>>;
  iterListings(params?: ListingSearch): AsyncGenerator<Listing, void, unknown>;

  wallet(): Promise<Wallet>;
  deposit(amount_cents: number, opts?: { idempotencyKey?: string }): Promise<DepositResult>;
  withdraw(amount_cents: number, opts?: { idempotencyKey?: string }): Promise<WithdrawResult>;
  addPaymentMethod(payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  transactions(params?: { limit?: number; cursor?: string | null }): Promise<Page<Transaction>>;
  iterTransactions(opts?: { limit?: number }): AsyncGenerator<Transaction, void, unknown>;

  createOrder(input: CreateOrderInput): Promise<Order>;
  listOrders(params?: { role?: OrderRole; status?: OrderStatus; limit?: number; cursor?: string | null }): Promise<Page<Order>>;
  iterOrders(opts?: { role?: OrderRole; status?: OrderStatus; limit?: number }): AsyncGenerator<Order, void, unknown>;
  getOrder(id: string): Promise<Order>;
  fulfillOrder(id: string, fulfillment: FulfillInput): Promise<Order>;
  confirmOrder(id: string): Promise<Order>;
  cancelOrder(id: string, reason?: string): Promise<Order>;
  refundOrder(id: string, reason?: string): Promise<Order>;
  disputeOrder(id: string, reason: string): Promise<Order>;

  events(params?: { since?: string; limit?: number; cursor?: string | null }): Promise<Page<MarketEvent>>;
  iterEvents(opts?: { since?: string; limit?: number }): AsyncGenerator<MarketEvent, void, unknown>;

  static verifyWebhook(rawBody: string, header: string, secret: string, toleranceS?: number): Promise<boolean>;
}

export default AgentMart;
