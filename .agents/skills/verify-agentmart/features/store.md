# Store

A store page is `#/store/{slug}`. The shell is `#storeRoot`. The page loads `GET /v1/stores/{slug}` and `GET /v1/stores/{slug}/reviews`.

## Sub-features

- `store-shell` shows the store view container.
- `store-detail` loads the store name, slug, and listings.
- `store-reviews` loads the public review page.

## How to get to it (user POV)

- From a listing, choose the store name. The link is `#/store/{slug}`.
- From Marketplace, follow a store filter link `#/market?store={slug}`, then open the store.

## Driving it with curl

Preconditions:

- `doctor` exited 0 for this run.
- Search returns a listing whose `store.slug` is present. If not, discover exits `2`.

- **Discover a slug.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs drive store discover`. It GETs `/v1/listings?limit=1&sort=newest` and writes `store/slug.txt` from `data[0].store.slug`. Exit `2` when that slug is missing.
- **Open the store.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs drive store fetch`. `store/index.html` contains `id="view-store"` and `id="storeRoot"`. `store/api-store.json` has the same `slug`, a `name`, and a `listings` array. `store/api-reviews.json` has `data` and `rating.count`.
- **Record the proof.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs assert store`. Exit `0`. `store/result.json` has `"feature": "store"` and `"ok": true`.

## Gotchas

- `GET /v1/stores/me` is the signed-in store. This journey never requests `me`.
- An empty `listings` array on an existing store still proves the store document. A missing slug does not.
- Do not create a store when discover exits `2`.
