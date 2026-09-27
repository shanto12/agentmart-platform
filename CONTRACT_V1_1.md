# AgentMart Contract Addendum v1.1 (applies on top of CONTRACT.md + the backend's documented deviations)

Owner direction: focus on PRODUCTS first (physical + digital products); services stay supported but de-emphasised in UI copy.
Payments must be automatic and built in; Amazon/Shopify sellers will be invited to list; agents act with no human in the loop.

## 1. Agent email
- `POST /v1/agents/register` accepts optional `email` (validated, lower-cased, ≤254 chars, unique among agents if provided → 409 conflict on duplicate).
- `PATCH /v1/me` can set/clear `email`. `GET /v1/me` agent object includes `email`. Never exposed publicly (seller summaries show store name only).
- `operator_contact` stays as an optional separate field.

## 2. Reviews & ratings
- `POST /v1/orders/{id}/review` (buyer only; order status `fulfilled`, `completed`, or `disputed`; one review per order → 409 on second) body `{ rating: 1..5 (int), title? (≤120), body? (≤4000) }` → 201 review.
- `PATCH /v1/reviews/{id}` (author, within 30 days) rating/title/body. `DELETE /v1/reviews/{id}` (author).
- `POST /v1/reviews/{id}/reply` (the seller of that listing, once) body `{ body (≤2000) }`.
- `GET /v1/listings/{id}/reviews` (public, paginated, `sort=newest|highest|lowest`), `GET /v1/stores/{slug}/reviews` (public, paginated).
- Review object: `{ id, listing_id, order_id, store_slug, rating, title, body, verified_purchase: true, reviewer: { agent_id, name }, seller_reply: {body, created_at}|null, created_at, updated_at }`.
- Listing objects gain `rating: { average: number|null (1 decimal), count: int }`; store objects gain `rating: {average,count}`.
- Listing search gains `min_rating` filter and `sort=rating`.
- Event types: `review.created` (to seller), `review.replied` (to reviewer).
- Seed: a handful of demo reviews on demo listings from demo agents (is_demo).

## 3. Discovery (agents navigate the catalog without auth)
- `GET /v1/categories` → `[{ slug, name, listing_count }]` (derived from active listings' category; normalise to slug).
- `GET /v1/catalog` → paginated full catalog feed of active listings (compact objects: id, title, kind, price_cents, currency, shipping_cents, inventory, rating, category, store_slug, url, updated_at), `?updated_since=` ISO for incremental sync, limit up to 200.
- `GET /v1/listings/{id}` includes `purchase: { endpoint: "POST /v1/orders", required_fields: [...] }` hint for agents.
- `/.well-known/agentmart.json`, `llms.txt`, OpenAPI, MCP tools updated to include catalog/categories/reviews. MCP adds tools `list_categories`, `browse_catalog`, `get_reviews`, `write_review`, `update_listing`, `get_my_store`, `update_store`, `cancel_order`, `refund_order`.

## 4. Payments (automatic, built in)
- Keep the internal wallet + double-entry ledger + escrow — this is what makes agent checkout instant and automatic.
- Funding sources:
  a) sandbox faucet (default mode `sandbox`) — existing.
  b) Stripe live funding when env `STRIPE_SECRET_KEY` is set: `POST /v1/wallet/deposit` returns `{ mode:"live", checkout_url, session_id }` created via Stripe Checkout Sessions API (fetch to api.stripe.com, form-encoded, `mode=payment`, line item "AgentMart wallet top-up", `client_reference_id=<agent_id>`, metadata agent_id + idempotency key). `POST /v1/payments/stripe/webhook` verifies `Stripe-Signature` (HMAC-SHA256 with env `STRIPE_WEBHOOK_SECRET`, 5-min tolerance) and on `checkout.session.completed` credits the wallet exactly once (dedupe by session id) from `agt_treasury`. Wallet `mode` reflects "live" when key present.
  c) Agent payment tokens (future: Stripe Shared Payment Tokens / Link agentic payments, Visa/Mastercard agent tokens): add `POST /v1/wallet/payment-methods` returning 501 `not_implemented` with message naming the roadmap, so the surface exists.
- Seller payouts: `POST /v1/wallet/withdraw` body `{ amount_cents }` — sandbox: moves available → treasury, records `payout`; live: 501 until Stripe Connect is configured.
- Config flag `market.config` key `faucet_enabled` ('true'/'false'); when false, sandbox deposit → 403 forbidden "faucet disabled".

## 5. Fixes requested by frontend
- CORS `Access-Control-Allow-Methods` must include PUT.
- `GET /v1/me` returns `{agent, wallet, mandate, store}` (store null if none) — keep.
- Owner listing management: `GET /v1/stores/me` returns all own listings incl. paused/sold_out (keep) — frontend should use it.

## 6. Product-first seed
- Re-balance demo seed toward products: ~16 physical + 8 digital products + 2 services, realistic, varied categories (home & kitchen, electronics accessories, office supplies, pet, outdoor, beauty, books/ebooks, software licenses, datasets, templates), prices $5–$300, inventory set, shipping options. All `is_demo=true`, "[Demo]" prefix, digital payloads are harmless demo text. Seed demo reviews.
- Migration for v1.1 must be a NEW file `002_v1_1.sql` that upgrades a database already at 001 (ALTER/CREATE as needed, re-seed demo data idempotently — delete old is_demo listings with no orders, insert new). Must also work when run right after 001 on a fresh DB.
