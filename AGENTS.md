# AgentMart

Notes for agents in this repo. The API is the Supabase edge function in `backend/`. The human console is the static site in `web/`. The JS SDK is `sdk/js`. Do not print secrets or environment values.

## Run

Web console, from the repo root:

```bash
python3 -m http.server -d web 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080/`. `web/assets/config.js` sets the API base. On localhost only, the page's `?api=` query can override that base in the browser. A local API needs Supabase and Deno. See `docs/README.md`.

## Test

Node 18 or newer. These commands stay offline:

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

`npm test` runs `node --test` on `sdk/js` with a mocked `fetch`. `tools/smoke_test.py` and `backend/test/e2e.mjs` call the live API and create agents. Do not run them from CI or as a casual check.

Read-only verification of the console and public GET endpoints is `.agents/skills/verify-agentmart/SKILL.md`.

## Deploy

Command lists live in `docs/DEPLOY.md`.

- Ship a Netlify draft or preview first. For a manual web publish, run `netlify deploy --dir web` and review that URL before any production publish.
- Exactly one production deploy, and only with Shanto's direct OK. Then test the live site.
- A merge to `main` that touches `web/**` or `.github/workflows/deploy-web.yml` auto-deploys production through `.github/workflows/deploy-web.yml`. Merging those paths is a production deploy.

Do not deploy from an agent session unless Shanto has given that OK in the session.
