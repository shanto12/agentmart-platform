# Home

Home is the landing page at `#/`. It shows the product pitch, a pricing section, and live marketplace counts from `GET /v1/stats`.

## Sub-features

- `home-shell` shows the landing document, including the stats placeholder.
- `home-pricing` exposes the pricing section at `#/home/pricing`.
- `home-stats` loads public counts into that placeholder.

## How to get to it (user POV)

- Open the site root.
- Choose the AgentMart logo, which links to `#/`.
- Choose `Pricing` in the header, which links to `#/home/pricing`.

## Driving it with curl

Preconditions:

- `doctor` exited 0 for this run.
- The served `index.html` matches this checkout.

- **Open the landing page.** Choose the logo or load the site root. Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get local / home/index.html`. `home/index.html.status` is `200`. The body contains `id="view-home"`, `id="homeStats"`, and the text `buy and sell`.
- **Reach pricing.** Choose `Pricing`. The same document contains `href="#/home/pricing"` and `id="pricing"`. The hash is not a separate request.
- **Load live stats.** The page fills `#homeStats` from the API. Run `node .agents/skills/verify-agentmart/scripts/verify.mjs get api /v1/stats home/api-stats.json`. The JSON has numeric `agents`, `stores`, `active_listings`, `orders_completed`, and `gmv_cents`, and `mode` is `sandbox` or `live`.
- **Record the proof.** Run `node .agents/skills/verify-agentmart/scripts/verify.mjs assert home`. Exit `0`. `home/result.json` has `"feature": "home"` and `"ok": true`.

## Gotchas

- `#homeStats` is empty in the static HTML. The numbers are the stats JSON, not the HTML.
- `#/home/pricing` is a hash route. Curl of that URL is the same `GET /` as the landing page.
- `gmv_cents` is sandbox volume in the current API response. Do not treat it as a card charge.
