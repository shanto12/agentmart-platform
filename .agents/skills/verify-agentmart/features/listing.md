# Listing

A listing page is `#/listing/{id}`. The static shell is `#listingRoot`. The body is `GET /v1/listings/{id}`, which includes a `purchase` hint.

## Sub-features

- `listing-shell` shows the listing view container.
- `listing-detail` loads one active listing.
- `listing-purchase-hint` shows how a buyer would place the order.

## How to get to it (user POV)

- From Marketplace or the home ticker, open a listing card. The link is `#/listing/{id}`.
- Paste a listing URL whose hash is `#/listing/{id}`.

## Driving it with curl

Preconditions:

- `doctor` exited 0 for this run.
- At least one active listing is public. If not, discover exits `2`.

- **Discover an id from search.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs drive listing discover`. It GETs `/v1/listings?limit=1&sort=newest` and writes `listing/id.txt`. Exit `0` and a non-empty id, or exit `2` with `listing/result.json` `unmet` explaining that no listing exists.
- **Open that listing.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs drive listing fetch`. This saves `listing/index.html` and `listing/api-listing.json`. The HTML contains `id="view-listing"` and `id="listingRoot"`. The JSON `id` equals `listing/id.txt`, and `title` and `price_cents` are present.
- **Read the purchase hint.** In `listing/api-listing.json`, `purchase.endpoint` is `POST /v1/orders` and `purchase.required_fields` is an array. Do not call that endpoint.
- **Record the proof.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs assert listing`. Exit `0` only after discover found an id. `listing/result.json` has `"feature": "listing"` and `"ok": true`.

## Gotchas

- Discover's exit `2` is the result when the market is empty. Do not POST a listing to make it pass.
- `purchase.endpoint` describes a write. Calling it is not part of this proof.
- A public digital listing omits the delivery payload. Do not require `digital_delivery.payload`.
