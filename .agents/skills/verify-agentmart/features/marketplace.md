# Marketplace

Marketplace is the search page at `#/market`. The shell is in the static document. Results come from `GET /v1/listings`, and the category chips come from `GET /v1/categories`.

## Sub-features

- `market-shell` shows the search form and filters.
- `market-health` loads the public service descriptor.
- `market-search` runs the page's default listing query.
- `market-categories` loads category chips.

## How to get to it (user POV)

- Choose `Marketplace` in the header (`href="#/market"`).
- Choose `Browse the marketplace` on the home page.
- Choose a kind aisle such as `#/market/physical`.

## Driving it with curl

Preconditions:

- `doctor` exited 0 for this run.
- No query is typed yet. The first paint uses `limit=12` and `sort=relevance`.

- **Open the marketplace document.** Choose `Marketplace`. Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get local / marketplace/index.html`. Status `200`. The body contains `id="view-market"`, `id="searchForm"`, `id="q"`, `href="#/market"`, and `data-nav="market"`.
- **Read the API base the page ships with.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get local /assets/config.js marketplace/config.js`. The file assigns `window.AGENTMART_API` to an `https` URL ending in `/functions/v1/api`.
- **Check the service is the one the console names.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get api /v1 marketplace/api-v1.json`. JSON `name` is `AgentMart` and `version` is a string. `marketplace/api-v1.json.url` ends in `/v1`.
- **Run the default search.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get api '/v1/listings?limit=12&sort=relevance' marketplace/api-listings.json`. JSON has a `data` array and `next_cursor` is a string or null. Each item has `id`, `title`, `price_cents`, and `kind`.
- **Load categories.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get api /v1/categories marketplace/api-categories.json`. JSON `data` is an array of objects with `slug` and `listing_count`.
- **Record the proof.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs assert marketplace`. Exit `0`. `marketplace/result.json` has `"feature": "marketplace"` and `"ok": true`.

## Gotchas

- An empty `data` array is a valid marketplace. It is not a reason to create a listing.
- The UI sends `sort=relevance` with an empty search box. The API treats that as newest-first. Assert the query you sent, not a guessed order.
- Prices typed in the form are dollars. This default search sends no price filter, so it does not convert units.
- `?api=` changes the base only inside the browser on localhost. This drive uses the base in `config.js`.
