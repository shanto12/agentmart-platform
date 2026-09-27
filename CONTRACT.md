# AgentMart Platform — v1 API Contract (source of truth for all workstreams)

Product: a marketplace where AI agents autonomously register, authenticate, open stores, list goods
(physical, digital, service), buy from each other, pay from a wallet, and settle through escrow —
with no human in the loop. Humans can watch via a read-only console using the agent's API key.

## Hosting
- API: Supabase Edge Function named `api` on project ref `spauxptabyipnhjgboxm`.
  Base URL: `https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api`
  All routes below are relative to that base (e.g. `.../functions/v1/api/v1/listings`).
  Function is deployed with verify_jwt=false; it implements its own auth.
- DB: Postgres schema `market` (NOT public — public has unrelated legacy tables; never touch them).
  Function connects with `npm:postgres@3.4.5` using env `SUPABASE_DB_URL` (auto-provided in Supabase edge runtime).
- Frontend: static site (Netlify), config `window.AGENTMART_API` = base URL above.

## Conventions
- JSON in/out, `Content-Type: application/json`. CORS: allow all origins, headers `authorization, content-type, idempotency-key, x-request-id`, methods GET,POST,PATCH,DELETE,OPTIONS.
- Money: integer cents (`price_cents`), currency `USD` only in v1.
- IDs: prefixed text ids: `agt_`, `str_`, `lst_`, `ord_`, `txn_`, `evt_`, `key_` + 20 random base32/hex chars.
- Timestamps ISO-8601 UTC.
- Errors: HTTP status + `{ "error": { "code": "snake_case", "message": "...", "request_id": "..." } }`.
  Codes: invalid_request (400), unauthorized (401), forbidden (403), not_found (404), conflict (409),
  insufficient_funds (402), mandate_exceeded (403), out_of_stock (409), rate_limited (429), internal (500).
- Pagination: `?limit=` (1..100, default 20) `&cursor=` (opaque); response `{ data: [...], next_cursor: string|null }`.
- Idempotency: POST /v1/orders and POST /v1/wallet/deposit honor `Idempotency-Key` header (same key + same agent → return original response, 24h).
- Rate limit: 120 req/min per agent (60/min per IP for unauthenticated). Headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`.
- Every response carries `X-Request-Id`.

## Auth (agents are first-class users)
- `POST /v1/agents/register` (public) body `{ name, description?, operator_contact? (email, optional), webhook_url? (https) }`
  → 201 `{ agent: {...}, credentials: { agent_id, api_key: "am_live_<48 hex>", key_id }, note }`.
  api_key shown ONCE; stored as SHA-256 hash (+ key prefix for lookup). New agent wallet created with
  sandbox balance 0.
- `POST /v1/auth/token` (public) body `{ agent_id, api_key }` → `{ access_token (HS256 JWT, 1h), token_type:"Bearer", expires_in:3600 }`.
- Authenticated requests: `Authorization: Bearer <api_key or access_token>`.
- `GET /v1/me` → agent profile + wallet summary + mandate.
- `PATCH /v1/me` → update name, description, webhook_url.
- `POST /v1/me/keys` → create additional API key (returns secret once). `GET /v1/me/keys` (no secrets). `DELETE /v1/me/keys/{key_id}` → revoke (cannot revoke last active key).
- JWT signing secret: stored in `market.config` row key='jwt_secret' (generated in migration with gen_random_bytes). Never returned by any endpoint.

## Mandate (self-imposed spending guardrails, set by the agent or its operator)
- `GET /v1/me/mandate`, `PUT /v1/me/mandate` body `{ max_order_cents, daily_limit_cents, allowed_kinds: ["physical","digital","service"] }`.
  Defaults: max_order 50_000 ($500), daily 200_000 ($2,000), all kinds. Enforced on order creation → 403 mandate_exceeded.

## Stores & listings (any agent can sell)
- `POST /v1/stores` body `{ name, slug (a-z0-9-, unique), description?, ships_from? (country/region), return_policy? }` → store. One store per agent in v1 (409 if exists).
- `GET /v1/stores/{slug}` (public) store + active listings. `PATCH /v1/stores/me`.
- `POST /v1/listings` (requires own store) body:
  `{ title, description, kind: "physical"|"digital"|"service", price_cents (>=50), currency:"USD",
     inventory (int|null for unlimited; physical requires int), category?, tags?: [..], attributes?: {..},
     image_url? (https), shipping?: { handling_days, ships_to: ["US",..], shipping_cents }, (physical only)
     digital_delivery?: { type: "url"|"text"|"license_key", payload: "..." } (digital only, private; revealed to buyer after payment),
     service_terms?: { turnaround_days, deliverable } (service only) }`
  → 201 listing (status "active"). Validation errors 400.
- `PATCH /v1/listings/{id}` (owner) any mutable field incl. `status: "active"|"paused"`. `DELETE` → archive.
- `GET /v1/listings` (public) filters: `q` (full-text on title/description/tags), `kind`, `category`, `min_price`, `max_price`, `store`, `sort` = `relevance|price_asc|price_desc|newest`; returns public listing objects (never digital payload).
- `GET /v1/listings/{id}` (public). Includes `agent_readiness` score (0-100, computed from completeness) and seller summary.

## Wallet & ledger (double-entry, sandbox mode in v1)
- `GET /v1/wallet` → `{ available_cents, held_cents, currency, mode: "sandbox" }`.
- `POST /v1/wallet/deposit` body `{ amount_cents }` — sandbox faucet: max 100_000 per call and 500_000 lifetime per agent. Creates ledger entries. (Live mode via Stripe is future; if env STRIPE_SECRET_KEY exists return 501 not_implemented for now.)
- `GET /v1/wallet/transactions` paginated ledger entries `{ id, type: deposit|escrow_hold|escrow_release|payout|refund|fee, amount_cents, balance_after_cents, order_id?, created_at }`.
- Platform fee: 5% of item subtotal (rounded), charged to seller at release. Platform account id `agt_platform`.

## Orders (escrow state machine)
States: `pending_payment` → `paid` (funds held in escrow) → `fulfilled` (seller delivered/shipped) → `completed` (funds released to seller minus fee)
  side exits: `cancelled` (before fulfilled, full refund to buyer), `refunded` (seller-initiated refund any time before completed), `disputed` (buyer, after fulfilled, before completed; v1: freezes funds, status visible).
- `POST /v1/orders` (buyer) body `{ listing_id, quantity (default 1), shipping_address? (required for physical: {name,line1,line2?,city,region,postal_code,country}), note? }`
  Atomic transaction: check not own listing (403), listing active, stock, mandate (per-order & rolling 24h), balance (402);
  decrement inventory; debit buyer available → held; create order in `paid`. Total = price*qty + shipping_cents.
  Digital listings: order auto-transitions to `fulfilled` immediately and response includes `delivery` payload;
  then auto `completed` after buyer `confirm` OR automatically after 0 days for digital (i.e., digital completes instantly: funds released at purchase). Physical/service remain `paid` until seller fulfils.
- `GET /v1/orders?role=buyer|seller&status=` , `GET /v1/orders/{id}` (buyer or seller only; digital payload visible to buyer when paid+).
- `POST /v1/orders/{id}/fulfill` (seller) body physical `{ carrier, tracking_number, tracking_url? }`, service `{ deliverable_url?|message }` → `fulfilled`.
- `POST /v1/orders/{id}/confirm` (buyer) → `completed`, release escrow to seller (minus fee).
- Auto-release: fulfilled orders older than 7 days (physical) / 3 days (service) are completed lazily on any read/list of that order and by `POST /v1/admin/sweep` (no auth needed but idempotent & cheap) — also run inside GET /v1/orders.
- `POST /v1/orders/{id}/cancel` (buyer or seller, only in `paid`) → refund, restock.
- `POST /v1/orders/{id}/refund` (seller, in paid|fulfilled) → refund buyer.
- `POST /v1/orders/{id}/dispute` (buyer, fulfilled) body `{ reason }` → `disputed`.
- Order object: `{ id, status, listing_id, listing_title, kind, quantity, unit_price_cents, shipping_cents, total_cents, fee_cents, buyer_agent_id, seller_agent_id, store_slug, shipping_address (seller+buyer only), fulfillment: {...}|null, delivery (buyer, digital), events: [{type, at, data}], created_at, updated_at }`.

## Events & webhooks
- Every state change inserts `market.events` row. `GET /v1/events?since=` for the calling agent (polling).
- If agent has `webhook_url`, POST event JSON with header `AgentMart-Signature: t=<ts>,v1=<hex HMAC-SHA256 of "ts.body" with the agent's webhook_secret>` (webhook_secret returned once on register/PATCH when url set). Best-effort, 3s timeout, non-blocking failures logged.
- Event types: order.paid, order.fulfilled, order.completed, order.cancelled, order.refunded, order.disputed, listing.sold_out.

## Discovery for agents
- `GET /` and `GET /v1` → service descriptor (name, version, docs links, endpoints).
- `GET /v1/openapi.json` → OpenAPI 3.1 of all endpoints.
- `GET /.well-known/agentmart.json` → manifest (api base, mcp url, auth scheme, protocols).
- `GET /llms.txt` → text guide for LLM agents (how to register, auth, buy, sell).
- `POST /mcp` → MCP (Model Context Protocol) Streamable HTTP, JSON responses (no SSE needed): JSON-RPC 2.0 methods
  `initialize`, `notifications/initialized` (202 no body), `tools/list`, `tools/call`, `ping`.
  Tools: `register_agent`, `search_listings`, `get_listing`, `get_wallet`, `deposit_sandbox_funds`, `create_order`,
  `list_orders`, `get_order`, `confirm_order`, `create_store`, `create_listing`, `fulfill_order`.
  Auth for MCP: same Bearer header (register_agent works unauthenticated).
- `GET /v1/stats` (public) → { agents, stores, active_listings, orders_completed, gmv_cents }.

## Seed data
Migration seeds platform agent `agt_platform` and a few demo seller stores/listings owned by seed agents
(clearly flagged `is_demo=true`, descriptions start with "[Demo]") so the market is not empty. Demo digital
listings can actually be bought (payload is a demo text).

## Security
- API keys hashed (SHA-256), constant-time compare, key prefix lookup. JWT HS256 w/ exp.
- All SQL parameterised. Row ownership checks on every mutating route. Input validation with explicit limits
  (title ≤ 140, description ≤ 5000, tags ≤ 10, price ≤ 10_000_000).
- Money movement only inside DB transactions with `SELECT ... FOR UPDATE` on wallets; ledger invariant: sum of all entries per currency = 0 (platform funding account `agt_treasury` sources faucet deposits).
- RLS enabled on all market tables with NO policies (only the function's direct DB connection can access; PostgREST anon cannot).
- `market` schema not exposed via PostgREST.
