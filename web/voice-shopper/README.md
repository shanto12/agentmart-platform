# AgentMart Voice Shopper — a simulated Alexa+ experience

A conversational web app that simulates an Alexa+ shopping conversation on
top of AgentMart's **live** marketplace. Built for the Amazon Developer
Hackathon 2026, Alexa+ track, using the track's expressly permitted
**simulated Alexa+ experience** route.

> This is a simulation. It is not Alexa, not an Amazon product, and not a
> certified Alexa+ add-on. The page says so, in the banner, the title and
> the footer.

## What it does

1. The shopper states a goal, a budget, a product type and a minimum rating
   (via the structured controls or free-text utterances like
   “Find me a highly rated digital product under $25 for building AI agents”).
2. A deterministic planner maps the request to AgentMart tool calls. There
   is no LLM and there are **no canned results** — every listing, detail and
   review on the page comes from a live API call made in the browser.
3. Results render as numbered cards so the conversation can refer to them
   (“compare 1 and 2”, “reviews 1”, “shortlist 2”).
4. Session state (goal, budget, kind, category, rating, shortlist) persists
   across turns, so follow-ups refine the same search instead of restarting.
5. Comparisons fetch live `get_listing` + `get_reviews` data and apply a
   fixed, disclosed rule: highest rating → most reviews → lowest price.
6. A tool-call trace logs every API call (tool name, endpoint, status,
   result count, latency), so a judge can verify the data is real.

If a search returns nothing, the shopper retries with disclosed relaxations
(drop the rating filter, broaden the search text, search by filters only) —
each retry is a real call in the trace and each relaxation is announced in
the conversation. If nothing matches, it says so.

## Tools / endpoints used

All calls go to the production API base in `web/assets/config.js`
(`https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api`), CORS-open and
auth-free for reads:

| Voice Shopper call | REST endpoint | MCP tool equivalent |
| --- | --- | --- |
| `list_categories` | `GET /v1/categories` | `list_categories` |
| `search_listings` | `GET /v1/listings?q=&kind=&category=&max_price=&min_rating=&sort=&limit=` | `search_listings` |
| `get_listing` | `GET /v1/listings/{id}` | `get_listing` |
| `get_reviews` | `GET /v1/listings/{id}/reviews?limit=&sort=` | `get_reviews` |

Prices are integer cents in the API (`max_price` is in cents); ratings use
`min_rating` (1–5). The same operations are exposed on AgentMart's MCP
server (`POST /mcp`, Streamable HTTP). Note: the MCP endpoint currently
negotiates MCP 2025-06-18 / 2025-03-26 / 2024-11-05 — this entry uses the
simulation route and makes **no** claim of MCP 2025-11-25 compliance or
Alexa+ certification.

## Run it

- **Live:** https://agentmart.us/voice-shopper/
- **Local:** serve the repository's `web/` folder with any static server,
  e.g. `cd web && python3 -m http.server 8080`, then open
  `http://localhost:8080/voice-shopper/`. No build step, no keys, no
  environment variables. Read calls are unauthenticated; the page honours
  the site-wide CSP in `web/netlify.toml` (scripts are external files;
  `connect-src` allows the Supabase API origin).

## Judge test script (2 minutes)

1. Open the live URL. Confirm the banner labels it a simulation.
2. Click the chip “Find me a highly rated digital product under $25 for
   building AI agents”. Watch the trace: `list_categories`, then
   `search_listings` calls with visible relaxations, then real cards.
3. Type “reviews 1” — live reviews for the first card appear.
4. Type “compare 1 and 2” — the shopper fetches details + reviews for both
   and renders a comparison table with a verdict and its fixed rule.
5. Type “cheaper” or “clear” to see state handling across turns.

## Honesty notes

- AgentMart is in public beta; the catalogue is small (dozens of listings)
  and v1 settles in **sandbox credits** — no real money moves, and demo/test
  listings in the live data are labelled with a “demo listing” badge when
  the API marks them `is_demo`.
- No AWS services are used by this entry (the marketplace runs on
  Supabase + Netlify), so the AWS Builder mini challenge is **not** claimed.
- Licence: the files in this `web/voice-shopper/` directory are MIT-licensed
  (see `LICENSE` in this directory). The rest of the AgentMart platform
  repository carries no licence file at the time of submission; that is a
  separate founder decision and nothing here relicenses it.
