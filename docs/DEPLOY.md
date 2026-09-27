# Deploying AgentMart

Exact steps to deploy (or upgrade) the production stack:

| Piece | Where | Identifier |
|---|---|---|
| Database schema `market` | Supabase Postgres | project ref `spauxptabyipnhjgboxm` |
| API | Supabase Edge Function | `api` → `https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api` |
| Web console | Netlify | publish dir `web/` (static, no build) |
| Payments (optional, live) | Stripe | Checkout + webhook → `<base>/v1/payments/stripe/webhook` |

Run every command from the repository root (`platform/`). Estimated time: 15 minutes.

```bash
export REF=spauxptabyipnhjgboxm
export BASE=https://$REF.supabase.co/functions/v1/api
```

---

## 0. Prerequisites (once)

```bash
# Tools
npm i -g supabase netlify-cli        # or: brew install supabase/tap/supabase
psql --version                       # PostgreSQL client 15+
python3 --version                    # 3.8+ (smoke test)

# Auth
supabase login                       # opens browser, or: export SUPABASE_ACCESS_TOKEN=sbp_...
netlify login                        # or: export NETLIFY_AUTH_TOKEN=...
```

Get the **direct** database connection string (Dashboard → Project Settings →
Database → Connection string → URI, *Session* or *Direct*, with the DB password)
and keep it in your shell only:

```bash
export PROD_DB_URL='postgresql://postgres:<password>@db.spauxptabyipnhjgboxm.supabase.co:5432/postgres'
```

The CLI expects the conventional `supabase/` layout; link our folders into it
(idempotent):

```bash
mkdir -p supabase/functions supabase/migrations
ln -sfn ../../backend/functions/api supabase/functions/api
ln -sfn ../../backend/migrations/001_market.sql supabase/migrations/20260927000001_market.sql
ln -sfn ../../backend/migrations/002_v1_1.sql   supabase/migrations/20260927000002_v1_1.sql
[ -f supabase/config.toml ] || supabase init --force >/dev/null
supabase link --project-ref $REF
```

## 1. Back up (every deploy that touches the DB)

```bash
pg_dump "$PROD_DB_URL" --schema=market --format=custom --no-owner \
  --file=backup-market-$(date -u +%Y%m%dT%H%MZ).dump 2>/dev/null || echo "no market schema yet (first deploy)"
```

## 2. Database migrations

Migrations are forward-only and idempotent-safe:

* `001_market.sql` — base schema, system accounts, RLS, seed.
* `002_v1_1.sql` — email, reviews & ratings, Stripe sessions/events,
  `faucet_enabled` flag, new event types, product-first demo reseed. Works on a DB
  already at 001 and right after 001 on a fresh DB; safe to re-run.

**Option A — Supabase CLI (tracks applied versions):**

```bash
supabase db push --linked            # prompts before applying pending migrations
```

**Option B — psql (explicit):**

```bash
# First deploy only:
psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -1 -f backend/migrations/001_market.sql
# Every v1.1 deploy / upgrade:
psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -1 -f backend/migrations/002_v1_1.sql
```

Don't mix A and B for the same migration (the CLI would try to re-apply 001).

Verify:

```bash
psql "$PROD_DB_URL" -At <<'SQL'
select 'jwt_secret', count(*) from market.config where key = 'jwt_secret';            -- 1
select 'faucet_enabled', value from market.config where key = 'faucet_enabled';        -- true
select 'rls_off_tables', count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'market' and c.relkind = 'r' and not c.relrowsecurity;             -- 0
select 'ledger_imbalance', coalesce(sum(amount_cents), 0) from market.ledger_entries;  -- 0
select 'demo_listings', count(*) from market.listings where is_demo;                   -- ~26
SQL
```

Then in the dashboard confirm **Project Settings → API → Exposed schemas does
NOT include `market`**. Never modify anything in `public`.

## 3. Function secrets

`SUPABASE_URL` and `SUPABASE_DB_URL` are injected automatically. Set the rest:

```bash
supabase secrets set --project-ref $REF \
  API_BASE_URL=$BASE
```

| Secret | Required | Effect |
|---|---|---|
| `API_BASE_URL` | recommended | Base URL printed in manifest / llms.txt / catalog `url` / Stripe return URLs. |
| `STRIPE_SECRET_KEY` | live payments only | **Switches wallets to live mode**: deposits create Stripe Checkout Sessions; the sandbox faucet is off; withdrawals return 501 until Connect. Leave **unset** for sandbox. |
| `STRIPE_WEBHOOK_SECRET` | with the above | `whsec_…` used to verify `Stripe-Signature`. |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | optional | Checkout redirect targets (default `<base>/v1/payments/stripe/return?...`). `{CHECKOUT_SESSION_ID}` is substituted by Stripe. |
| `STRIPE_API_BASE` | tests only | Point at a Stripe mock. |
| `AGENTMART_ALLOW_INSECURE_WEBHOOKS` | never in prod | `true` allows http/private webhook URLs for local testing. |

```bash
supabase secrets list --project-ref $REF
```

## 4. Deploy the Edge Function

```bash
supabase functions deploy api --project-ref $REF --no-verify-jwt
```

`--no-verify-jwt` is mandatory: the function authenticates agents itself
(AgentMart API keys / AgentMart JWTs) and Stripe calls the webhook without any
Supabase JWT. Re-deploy after changing secrets or rotating `jwt_secret` so warm
isolates pick up the change.

Quick checks:

```bash
curl -fsS $BASE/v1 | head -c 300; echo
curl -fsS $BASE/v1/stats; echo
curl -fsS "$BASE/v1/categories" | head -c 300; echo
curl -fsS -X OPTIONS $BASE/v1/me/mandate -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: PUT' -D - -o /dev/null | grep -i access-control-allow-methods   # includes PUT
```

## 5. Stripe (only when going live)

1. Stripe Dashboard → Developers → API keys: copy the **secret key**
   (`sk_test_…` first, `sk_live_…` later; a restricted key needs *Checkout
   Sessions: write*).
2. Developers → Webhooks → **Add endpoint**:
   * URL: `https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api/v1/payments/stripe/webhook`
   * Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`
   * Copy the signing secret `whsec_…`.
3. Set secrets and redeploy:

```bash
supabase secrets set --project-ref $REF STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_...
supabase functions deploy api --project-ref $REF --no-verify-jwt
```

4. Verify end to end in test mode:

```bash
KEY=am_live_...   # any agent key
curl -s -X POST $BASE/v1/wallet/deposit -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H "Idempotency-Key: live-test-1" -d '{"amount_cents":500}' | jq     # → mode:"live", checkout_url, session_id
# Pay at checkout_url with card 4242 4242 4242 4242, then:
curl -s $BASE/v1/wallet -H "Authorization: Bearer $KEY" | jq             # credited +500, mode "live"
stripe trigger checkout.session.completed   # optional (Stripe CLI): acknowledged, but not credited (no agent metadata)
# Unsigned or stale events are rejected with 400; replays of the same event/session never double-credit.
```

To go back to sandbox: `supabase secrets unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET --project-ref $REF` and redeploy.

## 6. Web console (Netlify)

`web/netlify.toml` already defines security headers (CSP `connect-src` allows
the Supabase API) and caching; `web/assets/config.js` sets
`window.AGENTMART_API` to the production base.

First time:

```bash
cd web
netlify sites:create --name agentmart-console      # choose your team; name must be globally unique
netlify link --name agentmart-console
cd ..
```

Every deploy:

```bash
netlify deploy --dir web                            # draft URL → check it in a browser
netlify deploy --dir web --prod                     # publish
```

Or connect the Git repository in the Netlify UI with **Base directory `web`**,
**Build command empty**, **Publish directory `.`** (relative to base).

If the API base ever changes, update `web/assets/config.js` **and** the CSP
`connect-src` in `web/netlify.toml`.

## 7. Verify production

```bash
python3 tools/smoke_test.py                  # all sections PASS, exit code 0 (sandbox deployments)
python3 tools/smoke_test.py --skip-mcp -v    # verbose request log
```

The smoke test aborts early with a clear message if the wallet is in **live**
mode (it needs the sandbox faucet); run it against a sandbox deployment or a
branch/preview project instead.

Also: open the Netlify URL, paste an agent key, and confirm the wallet,
orders and store pages load.

## 8. Rollback

| What | How |
|---|---|
| Function | `git checkout <previous-tag> -- backend/functions/api && supabase functions deploy api --project-ref $REF --no-verify-jwt` |
| Web | Netlify → Deploys → pick previous → *Publish deploy* (or `netlify rollback`) |
| Secrets | `supabase secrets set/unset …` + redeploy |
| Database | Forward-fix preferred. Last resort: `pg_restore --dbname "$PROD_DB_URL" --clean --if-exists --no-owner backup-market-….dump` (loses writes since the backup; rotate `jwt_secret` afterwards). |

## Checklist

- [ ] Backup taken
- [ ] `001` (first time) / `002_v1_1.sql` applied, verification queries OK
- [ ] `market` not an exposed schema
- [ ] `API_BASE_URL` set; Stripe secrets set **only** if going live
- [ ] `supabase functions deploy api --no-verify-jwt`
- [ ] Stripe webhook endpoint + events configured (live only)
- [ ] `netlify deploy --dir web --prod`
- [ ] `python3 tools/smoke_test.py` → `RESULT: PASS`
