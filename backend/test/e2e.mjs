#!/usr/bin/env node
// AgentMart end-to-end test.
//   API_BASE=http://localhost:8787 node test/e2e.mjs
//   API_BASE=https://<ref>.supabase.co/functions/v1/api node test/e2e.mjs
// Optional: SKIP_RATE_LIMIT_TEST=1 to skip the 429 burst test.
// Exits non-zero if any check fails.
import http from "node:http";
import crypto from "node:crypto";

const BASE = (process.env.API_BASE ?? "http://localhost:8787").replace(/\/$/, "");
const RUN = crypto.randomBytes(4).toString("hex"); // unique token for this run
const results = [];
let currentSection = "";

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

function section(name) {
  currentSection = name;
  console.log(`\n== ${name}`);
}

function check(name, cond, info) {
  results.push({ section: currentSection, name, ok: !!cond });
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${!cond && info !== undefined ? `\n        -> ${typeof info === "string" ? info : JSON.stringify(info).slice(0, 600)}` : ""}`);
  return !!cond;
}

async function api(method, path, { body, token, headers = {}, raw = false, base = BASE } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* non-JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

const errCode = (r) => r.json?.error?.code;
const isErr = (r, status, code) => r.status === status && errCode(r) === code && typeof r.json?.error?.request_id === "string";

async function mcp(payload, token) {
  return await api("POST", "/mcp", { body: payload, token, headers: { accept: "application/json, text/event-stream" } });
}
const toolCall = (name, args, token, id = 1) => mcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, token);

async function allTransactions(token) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const r = await api("GET", `/v1/wallet/transactions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token });
    if (r.status !== 200) throw new Error(`transactions ${r.status} ${r.text}`);
    out.push(...r.json.data);
    cursor = r.json.next_cursor;
    if (!cursor) break;
  }
  return out;
}

const DEMO_STORES = ["northwind-supply", "trailhead-outfitters", "promptforge", "taskrunner-services"];
async function demoListings(token) {
  const out = [];
  for (const slug of DEMO_STORES) {
    const r = await api("GET", `/v1/stores/${slug}`, { token });
    if (r.status === 200) out.push(...r.json.listings.filter((l) => l.is_demo));
  }
  return out;
}

const ADDRESS = { name: "Ada Agent", line1: "1 Market St", city: "Aubrey", region: "TX", postal_code: "76227", country: "US" };

// ---------------------------------------------------------------------------
// Optional local webhook receiver (only works when the API can reach us and allows http webhooks)
// ---------------------------------------------------------------------------

const hooks = [];
const hookServer = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    hooks.push({ headers: req.headers, body: data });
    res.writeHead(200).end("ok");
  });
});
await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
const HOOK_URL = `http://127.0.0.1:${hookServer.address().port}/hook`;

// ---------------------------------------------------------------------------
// Optional live-mode (Stripe) run: a second API instance started with
//   STRIPE_SECRET_KEY=sk_test_fake_local STRIPE_WEBHOOK_SECRET=<STRIPE_WEBHOOK_SECRET>
//   STRIPE_API_BASE=http://127.0.0.1:<FAKE_STRIPE_PORT>
// A tiny fake Stripe API below answers POST /v1/checkout/sessions.
// ---------------------------------------------------------------------------
const LIVE_BASE = process.env.API_BASE_LIVE?.replace(/\/$/, "") ?? null;
const STRIPE_WHSEC = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_local";
const fakeStripe = { requests: [], byIdemKey: new Map(), server: null };
if (LIVE_BASE) {
  fakeStripe.server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/checkout/sessions") {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const idem = req.headers["idempotency-key"];
      if (idem && fakeStripe.byIdemKey.has(idem)) {
        res.writeHead(200, { "content-type": "application/json" }).end(fakeStripe.byIdemKey.get(idem));
        return;
      }
      fakeStripe.requests.push({ form: new URLSearchParams(data), auth: req.headers.authorization, idem });
      const id = `cs_test_${crypto.randomBytes(8).toString("hex")}`;
      const out = JSON.stringify({ id, object: "checkout.session", url: `https://checkout.stripe.test/c/pay/${id}`, status: "open" });
      if (idem) fakeStripe.byIdemKey.set(idem, out);
      res.writeHead(200, { "content-type": "application/json" }).end(out);
    });
  });
  await new Promise((r) => fakeStripe.server.listen(Number(process.env.FAKE_STRIPE_PORT ?? 12111), "127.0.0.1", r));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log(`AgentMart e2e against ${BASE} (run ${RUN})`);

  section("Discovery");
  {
    const root = await api("GET", "/");
    check("GET / returns service descriptor", root.status === 200 && root.json?.name === "AgentMart", root.json);
    check("X-Request-Id header present", !!root.headers.get("x-request-id"));
    const v1 = await api("GET", "/v1");
    check("GET /v1 returns descriptor", v1.status === 200 && Array.isArray(v1.json?.endpoints));
    const oa = await api("GET", "/v1/openapi.json");
    check("OpenAPI 3.1 document", oa.status === 200 && oa.json?.openapi === "3.1.0" && !!oa.json?.paths?.["/v1/orders"]?.post, oa.json?.openapi);
    check("OpenAPI covers >= 30 operations", Object.values(oa.json?.paths ?? {}).reduce((n, p) => n + Object.keys(p).length, 0) >= 30);
    const llms = await api("GET", "/llms.txt");
    check("llms.txt is text", llms.status === 200 && llms.text.includes("AgentMart") && (llms.headers.get("content-type") ?? "").startsWith("text/plain"));
    const wk = await api("GET", "/.well-known/agentmart.json");
    check("well-known manifest", wk.status === 200 && wk.json?.mcp?.url?.endsWith("/mcp") && wk.json?.auth?.type === "bearer", wk.json);
    const pre = await fetch(BASE + "/v1/orders", {
      method: "OPTIONS",
      headers: { origin: "https://example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization, idempotency-key" },
    });
    check("CORS allows PUT", (pre.headers.get("access-control-allow-methods") ?? "").split(",").map((x) => x.trim()).includes("PUT"));
    check("CORS preflight", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*" &&
      (pre.headers.get("access-control-allow-headers") ?? "").includes("idempotency-key"));
    const rid = await api("GET", "/v1/stats", { headers: { "x-request-id": `test-${RUN}` } });
    check("inbound X-Request-Id echoed", rid.headers.get("x-request-id") === `test-${RUN}`);
    check("GET /v1/stats", rid.status === 200 && typeof rid.json?.gmv_cents === "number" && typeof rid.json?.agents === "number", rid.json);
    const nf = await api("GET", "/v1/nope");
    check("unknown route -> 404 not_found error format", isErr(nf, 404, "not_found"), nf.json);
    if (!/\/api$/.test(BASE)) {
      const pref = await api("GET", "/functions/v1/api/v1/listings?limit=1");
      check("prefix stripping: /functions/v1/api/v1/listings", pref.status === 200 && Array.isArray(pref.json?.data), pref.status);
      const pref2 = await api("GET", "/functions/v1/api/.well-known/agentmart.json");
      check("prefix stripping: /functions/v1/api/.well-known/agentmart.json", pref2.status === 200 && pref2.json?.name === "AgentMart");
    }
    const demo = await demoListings();
    check("seed demo listings present", demo.filter((l) => l.is_demo && l.description.startsWith("[Demo]")).length >= 12, demo.length);
  }

  section("Registration & auth");
  const regBad = await api("POST", "/v1/agents/register", { body: { description: "no name" } });
  check("register without name -> 400 invalid_request", isErr(regBad, 400, "invalid_request"), regBad.json);
  const regBadHook = await api("POST", "/v1/agents/register", { body: { name: "x", webhook_url: "ftp://nope" } });
  check("register with non-https webhook -> 400", isErr(regBadHook, 400, "invalid_request"), regBadHook.json);
  const badJson = await api("POST", "/v1/agents/register", { body: "{not json", raw: true });
  check("malformed JSON -> 400", isErr(badJson, 400, "invalid_request"), badJson.json);

  const regA = await api("POST", "/v1/agents/register", { body: { name: `Seller ${RUN}`, description: "e2e seller", operator_contact: "ops@example.com" } });
  const regB = await api("POST", "/v1/agents/register", { body: { name: `Buyer ${RUN}`, description: "e2e buyer" } });
  check("register seller A -> 201", regA.status === 201 && /^am_live_[0-9a-f]{48}$/.test(regA.json?.credentials?.api_key ?? ""), regA.json);
  check("register buyer B -> 201", regB.status === 201 && regB.json?.agent?.id?.startsWith("agt_"), regB.json);
  if (regA.status !== 201 || regB.status !== 201) throw new Error("cannot continue without agents");
  const A = { id: regA.json.credentials.agent_id, key: regA.json.credentials.api_key, keyId: regA.json.credentials.key_id };
  const B = { id: regB.json.credentials.agent_id, key: regB.json.credentials.api_key };
  // A read-only "browser" agent: public reads made with its key count against its own
  // per-agent bucket instead of the shared 60/min per-IP bucket.
  const regC = await api("POST", "/v1/agents/register", { body: { name: `Browser ${RUN}` } });
  const C = { key: regC.json?.credentials?.api_key };

  const tok = await api("POST", "/v1/auth/token", { body: { agent_id: A.id, api_key: A.key } });
  check("token exchange", tok.status === 200 && tok.json?.token_type === "Bearer" && tok.json?.expires_in === 3600 && tok.json.access_token.split(".").length === 3, tok.json);
  A.jwt = tok.json?.access_token;
  const meJwt = await api("GET", "/v1/me", { token: A.jwt });
  check("GET /v1/me with JWT", meJwt.status === 200 && meJwt.json?.agent?.id === A.id && meJwt.json?.wallet?.available_cents === 0, meJwt.json);
  check("GET /v1/me includes default mandate", meJwt.json?.mandate?.max_order_cents === 50000 && meJwt.json?.mandate?.daily_limit_cents === 200000 &&
    meJwt.json?.mandate?.allowed_kinds?.length === 3, meJwt.json?.mandate);
  const meKey = await api("GET", "/v1/me", { token: B.key });
  check("GET /v1/me with API key", meKey.status === 200 && meKey.json?.agent?.id === B.id);

  const noAuth = await api("GET", "/v1/me");
  check("no auth -> 401 unauthorized", isErr(noAuth, 401, "unauthorized"), noAuth.json);
  const badKey = await api("GET", "/v1/me", { token: "am_live_" + "0".repeat(48) });
  check("unknown api key -> 401", isErr(badKey, 401, "unauthorized"));
  const tampered = A.jwt.slice(0, -3) + (A.jwt.endsWith("AAA") ? "BBB" : "AAA");
  const badJwt = await api("GET", "/v1/me", { token: tampered });
  check("tampered JWT -> 401", isErr(badJwt, 401, "unauthorized"));
  const wrongTok = await api("POST", "/v1/auth/token", { body: { agent_id: B.id, api_key: A.key } });
  check("token exchange with mismatched agent_id -> 401", isErr(wrongTok, 401, "unauthorized"));
  const wrongTok2 = await api("POST", "/v1/auth/token", { body: { agent_id: A.id, api_key: "am_live_" + "f".repeat(48) } });
  check("token exchange with wrong key -> 401", isErr(wrongTok2, 401, "unauthorized"));

  section("Profile, keys & rate-limit headers");
  {
    const p = await api("PATCH", "/v1/me", { token: A.key, body: { description: "updated seller" } });
    check("PATCH /v1/me", p.status === 200 && p.json?.agent?.description === "updated seller", p.json);
    const rl1 = await api("GET", "/v1/wallet", { token: A.key });
    const rl2 = await api("GET", "/v1/wallet", { token: A.key });
    check("X-RateLimit-Limit 120 for agents", rl1.headers.get("x-ratelimit-limit") === "120", rl1.headers.get("x-ratelimit-limit"));
    const r1 = Number(rl1.headers.get("x-ratelimit-remaining")), r2 = Number(rl2.headers.get("x-ratelimit-remaining"));
    check("X-RateLimit-Remaining decrements", Number.isFinite(r1) && (r2 === r1 - 1 || r2 > r1 /* window rolled */), { r1, r2 });
    const pub = await api("GET", "/v1/listings?limit=1");
    check("X-RateLimit-Limit 60 for unauthenticated", pub.headers.get("x-ratelimit-limit") === "60");

    const k2 = await api("POST", "/v1/me/keys", { token: A.key, body: { label: "second" } });
    check("create extra key", k2.status === 201 && /^am_live_/.test(k2.json?.api_key ?? "") && k2.json?.key?.status === "active", k2.json);
    const list = await api("GET", "/v1/me/keys", { token: A.key });
    check("list keys (no secrets)", list.status === 200 && list.json.data.length === 2 && !JSON.stringify(list.json).includes(k2.json.api_key), list.json);
    const tok2 = await api("POST", "/v1/auth/token", { body: { agent_id: A.id, api_key: k2.json.api_key } });
    const rev = await api("DELETE", `/v1/me/keys/${k2.json.key.id}`, { token: A.key });
    check("revoke key", rev.status === 200 && rev.json?.key?.status === "revoked", rev.json);
    const useRevoked = await api("GET", "/v1/me", { token: k2.json.api_key });
    check("revoked key -> 401", isErr(useRevoked, 401, "unauthorized"));
    const useRevokedJwt = await api("GET", "/v1/me", { token: tok2.json?.access_token });
    check("JWT minted from revoked key -> 401", isErr(useRevokedJwt, 401, "unauthorized"));
    const revLast = await api("DELETE", `/v1/me/keys/${A.keyId}`, { token: A.key });
    check("cannot revoke last active key -> 409", isErr(revLast, 409, "conflict"), revLast.json);
  }

  section("Mandate");
  {
    const g = await api("GET", "/v1/me/mandate", { token: B.key });
    check("GET mandate defaults", g.status === 200 && g.json.max_order_cents === 50000, g.json);
    const bad = await api("PUT", "/v1/me/mandate", { token: B.key, body: { max_order_cents: 100, daily_limit_cents: 100, allowed_kinds: ["weapons"] } });
    check("PUT mandate with bad kind -> 400", isErr(bad, 400, "invalid_request"));
    const put = await api("PUT", "/v1/me/mandate", { token: B.key, body: { max_order_cents: 60000, daily_limit_cents: 300000, allowed_kinds: ["physical", "digital", "service"] } });
    check("PUT mandate", put.status === 200 && put.json.max_order_cents === 60000 && put.json.daily_limit_cents === 300000, put.json);
  }

  section("Stores & listings");
  const slug = `e2e-${RUN}`;
  const noStoreListing = await api("POST", "/v1/listings", { token: B.key, body: { title: "x", description: "y", kind: "service", price_cents: 100 } });
  check("create listing without store -> 403", isErr(noStoreListing, 403, "forbidden"), noStoreListing.json);
  const st = await api("POST", "/v1/stores", { token: A.key, body: { name: `E2E Store ${RUN}`, slug, description: "Test store", ships_from: "US-TX", return_policy: "30 days" } });
  check("create store", st.status === 201 && st.json?.slug === slug && st.json?.id?.startsWith("str_"), st.json);
  const st2 = await api("POST", "/v1/stores", { token: A.key, body: { name: "Again", slug: `${slug}-2` } });
  check("second store for same agent -> 409", isErr(st2, 409, "conflict"), st2.json);
  const stB = await api("POST", "/v1/stores", { token: B.key, body: { name: "Dup", slug } });
  check("duplicate slug -> 409", isErr(stB, 409, "conflict"), stB.json);
  const stBad = await api("POST", "/v1/stores", { token: B.key, body: { name: "Bad", slug: "Bad Slug!" } });
  check("invalid slug -> 400", isErr(stBad, 400, "invalid_request"));
  const stPatch = await api("PATCH", "/v1/stores/me", { token: A.key, body: { description: "Updated store" } });
  check("PATCH /v1/stores/me", stPatch.status === 200 && stPatch.json?.description === "Updated store", stPatch.json);

  const token = `zq${RUN}`;
  const physBody = {
    title: `Widget ${token}`, description: "A sturdy physical widget for automated testing of the checkout flow.",
    kind: "physical", price_cents: 2000, inventory: 2, category: "Testing", tags: ["widget", token, "e2e"],
    attributes: { color: "blue" }, image_url: "https://example.com/widget.png",
    shipping: { handling_days: 1, ships_to: ["US"], shipping_cents: 500 },
  };
  const phys = await api("POST", "/v1/listings", { token: A.key, body: physBody });
  check("create physical listing", phys.status === 201 && phys.json?.kind === "physical" && phys.json?.status === "active" && phys.json?.inventory === 2, phys.json);
  const dig = await api("POST", "/v1/listings", {
    token: A.key,
    body: { title: `Dataset ${token}`, description: "Digital dataset delivered instantly.", kind: "digital", price_cents: 1500, category: "datasets", tags: [token],
      digital_delivery: { type: "text", payload: `SECRET-${RUN}` } },
  });
  check("create digital listing (owner sees payload)", dig.status === 201 && dig.json?.digital_delivery?.payload === `SECRET-${RUN}`, dig.json);
  const svc = await api("POST", "/v1/listings", {
    token: A.key,
    body: { title: `Consulting ${token}`, description: "One hour of agent consulting.", kind: "service", price_cents: 5000, tags: [token],
      service_terms: { turnaround_days: 2, deliverable: "Written summary" } },
  });
  check("create service listing", svc.status === 201 && svc.json?.kind === "service" && svc.json?.inventory === null, svc.json);
  const P = phys.json, D = dig.json, S = svc.json;

  for (const [name, body] of [
    ["physical without inventory -> 400", { ...physBody, inventory: undefined }],
    ["title > 140 chars -> 400", { ...physBody, title: "x".repeat(141) }],
    ["price < 50 -> 400", { ...physBody, price_cents: 10 }],
    ["price > 10M -> 400", { ...physBody, price_cents: 10_000_001 }],
    ["> 10 tags -> 400", { ...physBody, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    ["digital without digital_delivery -> 400", { title: "d", description: "d", kind: "digital", price_cents: 100 }],
    ["shipping on service -> 400", { title: "s", description: "s", kind: "service", price_cents: 100, shipping: { shipping_cents: 1 } }],
    ["bad kind -> 400", { ...physBody, kind: "crypto" }],
  ]) {
    const r = await api("POST", "/v1/listings", { token: A.key, body });
    check(name, isErr(r, 400, "invalid_request"), r.json);
  }

  {
    const s1 = await api("GET", `/v1/listings?q=${token}`, { token: C.key });
    const ids = (s1.json?.data ?? []).map((l) => l.id);
    check("full-text search finds all 3 kinds", [P.id, D.id, S.id].every((id) => ids.includes(id)), ids);
    check("public listings never expose digital payload", !s1.text.includes(`SECRET-${RUN}`));
    const s2 = await api("GET", `/v1/listings?q=${token}&kind=digital`, { token: C.key });
    check("kind filter", s2.json?.data?.length === 1 && s2.json.data[0].id === D.id, s2.json?.data?.map((l) => l.id));
    const s3 = await api("GET", `/v1/listings?q=${token}&sort=price_desc`, { token: C.key });
    check("sort price_desc", s3.json?.data?.[0]?.id === S.id, s3.json?.data?.map((l) => l.price_cents));
    const s4 = await api("GET", `/v1/listings?store=${slug}&min_price=1600&max_price=4000`, { token: C.key });
    check("store + price range filters", s4.json?.data?.length === 1 && s4.json.data[0].id === P.id, s4.json?.data?.map((l) => l.id));
    const s5 = await api("GET", `/v1/listings?category=testing`, { token: C.key });
    check("category filter", (s5.json?.data ?? []).some((l) => l.id === P.id));
    const s6 = await api("GET", `/v1/listings?q=sturdy%20widget`, { token: C.key });
    check("search matches description words", (s6.json?.data ?? []).some((l) => l.id === P.id));
    const pg1 = await api("GET", "/v1/listings?limit=2&sort=price_asc");
    const pg2 = await api("GET", `/v1/listings?limit=2&sort=price_asc&cursor=${encodeURIComponent(pg1.json?.next_cursor ?? "")}`, { token: C.key });
    check("pagination with next_cursor", pg1.json?.data?.length === 2 && !!pg1.json?.next_cursor && pg2.json?.data?.length === 2 &&
      pg2.json.data[0].id !== pg1.json.data[0].id, { a: pg1.json?.data?.map((l) => l.id), b: pg2.json?.data?.map((l) => l.id) });
    const badLimit = await api("GET", "/v1/listings?limit=500");
    check("limit > 100 -> 400", isErr(badLimit, 400, "invalid_request"));
    const det = await api("GET", `/v1/listings/${D.id}`, { token: C.key });
    check("listing detail: readiness + seller, no payload", det.status === 200 && typeof det.json?.agent_readiness === "number" &&
      det.json.agent_readiness >= 0 && det.json.agent_readiness <= 100 && det.json?.seller?.agent_id === A.id &&
      det.json?.digital_delivery?.type === "text" && det.json?.digital_delivery?.payload === undefined, det.json);
    const storeGet = await api("GET", `/v1/stores/${slug}`, { token: C.key });
    check("GET /v1/stores/{slug} with listings", storeGet.status === 200 && storeGet.json?.listings?.length === 3, storeGet.json?.listings?.length);
    const notMine = await api("PATCH", `/v1/listings/${P.id}`, { token: B.key, body: { price_cents: 60 } });
    check("non-owner PATCH listing -> 403", isErr(notMine, 403, "forbidden"));
    const upd = await api("PATCH", `/v1/listings/${S.id}`, { token: A.key, body: { tags: [token, "consulting"], category: "services" } });
    check("owner PATCH listing", upd.status === 200 && upd.json?.tags?.includes("consulting") && upd.json?.category === "services", upd.json);
  }

  section("Wallet & deposits");
  {
    const d1 = await api("POST", "/v1/wallet/deposit", { token: B.key, body: { amount_cents: 100000 } });
    check("deposit 100000", d1.status === 201 && d1.json?.available_cents === 100000 && d1.json?.mode === "sandbox", d1.json);
    const tooMuch = await api("POST", "/v1/wallet/deposit", { token: B.key, body: { amount_cents: 100001 } });
    check("deposit > 100000 per call -> 400", isErr(tooMuch, 400, "invalid_request"));
    const neg = await api("POST", "/v1/wallet/deposit", { token: B.key, body: { amount_cents: -5 } });
    check("negative deposit -> 400", isErr(neg, 400, "invalid_request"));
    const key = `dep-${RUN}`;
    const i1 = await api("POST", "/v1/wallet/deposit", { token: B.key, body: { amount_cents: 20000 }, headers: { "idempotency-key": key } });
    const i2 = await api("POST", "/v1/wallet/deposit", { token: B.key, body: { amount_cents: 20000 }, headers: { "idempotency-key": key } });
    check("idempotent deposit replay returns original", i1.status === 201 && i2.status === 201 && i2.json?.deposit?.transfer_id === i1.json?.deposit?.transfer_id &&
      i2.headers.get("idempotent-replayed") === "true", { i1: i1.json, i2: i2.json });
    const w = await api("GET", "/v1/wallet", { token: B.key });
    check("replay did not double-credit", w.json?.available_cents === 120000 && w.json?.held_cents === 0 && w.json?.currency === "USD", w.json);
    const i3 = await api("POST", "/v1/wallet/deposit", { token: B.key, body: { amount_cents: 1 }, headers: { "idempotency-key": key } });
    check("same key, different body -> 409", isErr(i3, 409, "conflict"), i3.json);
    // Lifetime cap: 120000 so far; 3 x 100000 more = 420000; next 100000 would make 520000 > 500000.
    for (let i = 0; i < 3; i++) await api("POST", "/v1/wallet/deposit", { token: B.key, body: { amount_cents: 100000 } });
    const cap = await api("POST", "/v1/wallet/deposit", { token: B.key, body: { amount_cents: 100000 } });
    check("lifetime faucet cap enforced", cap.status === 403 && cap.json?.error?.details?.remaining_cents === 80000, cap.json);
  }
  let bExpected = 420000;

  section("Buy digital (instant delivery & settlement)");
  let digitalOrderId;
  {
    const o = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: D.id, quantity: 2 } });
    digitalOrderId = o.json?.id;
    check("digital order -> completed instantly", o.status === 201 && o.json?.status === "completed" && o.json?.id?.startsWith("ord_"), o.json);
    check("digital delivery payload returned to buyer", o.json?.delivery?.payload === `SECRET-${RUN}` && o.json?.delivery?.type === "text", o.json?.delivery);
    check("order totals & fee", o.json?.total_cents === 3000 && o.json?.fee_cents === 150 && o.json?.subtotal_cents === 3000, o.json);
    const types = (o.json?.events ?? []).map((e) => e.type);
    check("order events paid->fulfilled->completed", JSON.stringify(types) === JSON.stringify(["order.paid", "order.fulfilled", "order.completed"]), types);
    bExpected -= 3000;
    const wa = await api("GET", "/v1/wallet", { token: A.key });
    check("seller credited total minus 5% fee (2850)", wa.json?.available_cents === 2850, wa.json);
    const wb = await api("GET", "/v1/wallet", { token: B.key });
    check("buyer debited", wb.json?.available_cents === bExpected && wb.json?.held_cents === 0, wb.json);
    const sellerView = await api("GET", `/v1/orders/${digitalOrderId}`, { token: A.key });
    check("seller cannot see digital delivery payload", sellerView.status === 200 && sellerView.json?.delivery === undefined && sellerView.json?.role === "seller");
    const stranger = await api("POST", "/v1/agents/register", { body: { name: `Stranger ${RUN}` } });
    const sv = await api("GET", `/v1/orders/${digitalOrderId}`, { token: stranger.json?.credentials?.api_key });
    check("non-party cannot read order -> 404", isErr(sv, 404, "not_found"));
  }

  section("Buy physical (escrow) -> fulfil -> confirm -> release");
  let physOrderId;
  {
    const noAddr = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: P.id } });
    check("physical without shipping_address -> 400", isErr(noAddr, 400, "invalid_request"), noAddr.json);
    const wrongCountry = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: P.id, shipping_address: { ...ADDRESS, country: "CA" } } });
    check("ships_to enforced -> 400", isErr(wrongCountry, 400, "invalid_request"), wrongCountry.json);
    const tooMany = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: P.id, quantity: 3, shipping_address: ADDRESS } });
    check("quantity > inventory -> 409 out_of_stock", isErr(tooMany, 409, "out_of_stock"), tooMany.json);

    const o = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: P.id, quantity: 1, shipping_address: ADDRESS, note: "leave at door" } });
    physOrderId = o.json?.id;
    check("physical order -> paid (held)", o.status === 201 && o.json?.status === "paid" && o.json?.total_cents === 2500 && o.json?.shipping_cents === 500, o.json);
    check("shipping_address on order", o.json?.shipping_address?.postal_code === "76227");
    bExpected -= 2500;
    const wb = await api("GET", "/v1/wallet", { token: B.key });
    check("buyer funds moved to held", wb.json?.available_cents === bExpected && wb.json?.held_cents === 2500, wb.json);
    const lst = await api("GET", `/v1/listings/${P.id}`);
    check("inventory decremented", lst.json?.inventory === 1, lst.json?.inventory);

    const confirmEarly = await api("POST", `/v1/orders/${physOrderId}/confirm`, { token: B.key });
    check("confirm before fulfil -> 409", isErr(confirmEarly, 409, "conflict"));
    const buyerFulfil = await api("POST", `/v1/orders/${physOrderId}/fulfill`, { token: B.key, body: { carrier: "UPS", tracking_number: "1Z" } });
    check("buyer cannot fulfil -> 403", isErr(buyerFulfil, 403, "forbidden"));
    const noTracking = await api("POST", `/v1/orders/${physOrderId}/fulfill`, { token: A.key, body: { carrier: "UPS" } });
    check("fulfil without tracking_number -> 400", isErr(noTracking, 400, "invalid_request"));
    const f = await api("POST", `/v1/orders/${physOrderId}/fulfill`, {
      token: A.key, body: { carrier: "UPS", tracking_number: "1Z999AA10123456784", tracking_url: "https://ups.com/track?n=1Z999" },
    });
    check("seller fulfils -> fulfilled", f.status === 200 && f.json?.status === "fulfilled" && f.json?.fulfillment?.carrier === "UPS" && !!f.json?.auto_release_at, f.json);
    const autoDays = (new Date(f.json?.auto_release_at) - Date.now()) / 86400000;
    check("physical auto-release ~7 days", autoDays > 6.9 && autoDays < 7.1, autoDays);
    const sellerConfirm = await api("POST", `/v1/orders/${physOrderId}/confirm`, { token: A.key });
    check("seller cannot confirm -> 403", isErr(sellerConfirm, 403, "forbidden"));
    const c = await api("POST", `/v1/orders/${physOrderId}/confirm`, { token: B.key });
    check("buyer confirms -> completed", c.status === 200 && c.json?.status === "completed", c.json);
    const wa = await api("GET", "/v1/wallet", { token: A.key });
    check("seller received 2500 - 100 fee", wa.json?.available_cents === 2850 + 2400, wa.json);
    const wb2 = await api("GET", "/v1/wallet", { token: B.key });
    check("buyer held released", wb2.json?.held_cents === 0 && wb2.json?.available_cents === bExpected, wb2.json);
    const again = await api("POST", `/v1/orders/${physOrderId}/confirm`, { token: B.key });
    check("double confirm -> 409", isErr(again, 409, "conflict"));
  }

  section("Sold out, cancel, refund & restock");
  {
    const o = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: P.id, shipping_address: ADDRESS } });
    check("buy last unit", o.status === 201 && o.json?.status === "paid", o.json);
    bExpected -= 2500;
    const lst = await api("GET", `/v1/listings/${P.id}`);
    check("listing sold_out at 0 inventory", lst.json?.status === "sold_out" && lst.json?.in_stock === false && lst.json?.inventory === 0, lst.json);
    const oos = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: P.id, shipping_address: ADDRESS } });
    check("buy sold-out listing -> 409 out_of_stock", isErr(oos, 409, "out_of_stock"), oos.json);
    const cancel = await api("POST", `/v1/orders/${o.json.id}/cancel`, { token: B.key, body: { reason: "changed mind" } });
    check("buyer cancels paid order", cancel.status === 200 && cancel.json?.status === "cancelled", cancel.json);
    bExpected += 2500;
    const wb = await api("GET", "/v1/wallet", { token: B.key });
    check("cancel refunds buyer in full", wb.json?.available_cents === bExpected && wb.json?.held_cents === 0, wb.json);
    const lst2 = await api("GET", `/v1/listings/${P.id}`);
    check("cancel restocks & reactivates listing", lst2.json?.inventory === 1 && lst2.json?.status === "active", lst2.json);
    const cancel2 = await api("POST", `/v1/orders/${o.json.id}/cancel`, { token: B.key });
    check("cancel twice -> 409", isErr(cancel2, 409, "conflict"));

    // Seller-initiated refund of a paid order
    const o2 = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: S.id, note: "please help" } });
    check("service order -> paid", o2.status === 201 && o2.json?.status === "paid" && o2.json?.total_cents === 5000, o2.json);
    const buyerRefund = await api("POST", `/v1/orders/${o2.json.id}/refund`, { token: B.key });
    check("buyer cannot refund -> 403", isErr(buyerRefund, 403, "forbidden"));
    const rf = await api("POST", `/v1/orders/${o2.json.id}/refund`, { token: A.key, body: { reason: "cannot deliver" } });
    check("seller refunds paid order", rf.status === 200 && rf.json?.status === "refunded", rf.json);

    // Service: fulfil -> dispute -> refund
    const o3 = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: S.id } });
    const noMsg = await api("POST", `/v1/orders/${o3.json.id}/fulfill`, { token: A.key, body: {} });
    check("service fulfil needs deliverable -> 400", isErr(noMsg, 400, "invalid_request"));
    const f3 = await api("POST", `/v1/orders/${o3.json.id}/fulfill`, { token: A.key, body: { message: "Done — see summary", deliverable_url: "https://example.com/out.pdf" } });
    const autoDays = (new Date(f3.json?.auto_release_at) - Date.now()) / 86400000;
    check("service fulfilled, auto-release ~3 days", f3.json?.status === "fulfilled" && autoDays > 2.9 && autoDays < 3.1, f3.json);
    const dNoReason = await api("POST", `/v1/orders/${o3.json.id}/dispute`, { token: B.key, body: {} });
    check("dispute requires reason -> 400", isErr(dNoReason, 400, "invalid_request"));
    const d3 = await api("POST", `/v1/orders/${o3.json.id}/dispute`, { token: B.key, body: { reason: "incomplete" } });
    check("buyer disputes -> disputed", d3.status === 200 && d3.json?.status === "disputed" && d3.json?.dispute?.reason === "incomplete", d3.json);
    const wbD = await api("GET", "/v1/wallet", { token: B.key });
    check("disputed funds stay frozen in held", wbD.json?.held_cents === 5000, wbD.json);
    const cd = await api("POST", `/v1/orders/${o3.json.id}/confirm`, { token: B.key });
    check("cannot confirm disputed order -> 409", isErr(cd, 409, "conflict"));
    const r3 = await api("POST", `/v1/orders/${o3.json.id}/refund`, { token: A.key });
    check("seller refunds disputed order", r3.status === 200 && r3.json?.status === "refunded", r3.json);
    const wb3 = await api("GET", "/v1/wallet", { token: B.key });
    check("buyer whole after refunds", wb3.json?.available_cents === bExpected && wb3.json?.held_cents === 0, wb3.json);
  }

  section("Guardrails: own listing, paused, 402, mandate");
  {
    const own = await api("POST", "/v1/orders", { token: A.key, body: { listing_id: D.id } });
    check("buying own listing -> 403 forbidden", isErr(own, 403, "forbidden"), own.json);
    const pause = await api("PATCH", `/v1/listings/${D.id}`, { token: A.key, body: { status: "paused" } });
    check("pause listing", pause.status === 200 && pause.json?.status === "paused");
    const pausedBuy = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: D.id } });
    check("buy paused listing -> 409", isErr(pausedBuy, 409, "conflict"), pausedBuy.json);
    const search = await api("GET", `/v1/listings?q=${token}`, { token: C.key });
    check("paused listing hidden from search", !(search.json?.data ?? []).some((l) => l.id === D.id));
    await api("PATCH", `/v1/listings/${D.id}`, { token: A.key, body: { status: "active" } });
    const missing = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: "lst_00000000000000000000" } });
    check("unknown listing -> 404", isErr(missing, 404, "not_found"));

    const pricey = await api("POST", "/v1/listings", { token: A.key, body: { title: `Pricey ${token}`, description: "Expensive service", kind: "service", price_cents: 5_000_000 } });
    await api("PUT", "/v1/me/mandate", { token: B.key, body: { max_order_cents: 10_000_000, daily_limit_cents: 10_000_000, allowed_kinds: ["physical", "digital", "service"] } });
    const nsf = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: pricey.json.id } });
    check("insufficient funds -> 402", isErr(nsf, 402, "insufficient_funds"), nsf.json);

    await api("PUT", "/v1/me/mandate", { token: B.key, body: { max_order_cents: 1000, daily_limit_cents: 200000, allowed_kinds: ["physical", "digital", "service"] } });
    const overMax = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: S.id } });
    check("order over max_order_cents -> 403 mandate_exceeded", isErr(overMax, 403, "mandate_exceeded") && overMax.json?.error?.details?.rule === "max_order_cents", overMax.json);
    await api("PUT", "/v1/me/mandate", { token: B.key, body: { max_order_cents: 50000, daily_limit_cents: 200000, allowed_kinds: ["digital"] } });
    const kind = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: S.id } });
    check("disallowed kind -> 403 mandate_exceeded", isErr(kind, 403, "mandate_exceeded") && kind.json?.error?.details?.rule === "allowed_kinds", kind.json);
    // Spent in last 24h (non-cancelled/refunded): 3000 + 2500 = 5500
    await api("PUT", "/v1/me/mandate", { token: B.key, body: { max_order_cents: 50000, daily_limit_cents: 6000, allowed_kinds: ["physical", "digital", "service"] } });
    const daily = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: D.id } });
    check("rolling 24h daily limit -> 403 mandate_exceeded", isErr(daily, 403, "mandate_exceeded") && daily.json?.error?.details?.rule === "daily_limit_cents" &&
      daily.json?.error?.details?.spent_cents === 5500, daily.json);
    await api("PUT", "/v1/me/mandate", { token: B.key, body: { max_order_cents: 50000, daily_limit_cents: 200000, allowed_kinds: ["physical", "digital", "service"] } });
    const wb = await api("GET", "/v1/wallet", { token: B.key });
    check("rejected orders moved no money", wb.json?.available_cents === bExpected && wb.json?.held_cents === 0, wb.json);
  }

  section("Idempotent order creation");
  {
    const key = `ord-${RUN}`;
    const body = { listing_id: D.id, quantity: 1 };
    const o1 = await api("POST", "/v1/orders", { token: B.key, body, headers: { "idempotency-key": key } });
    const o2 = await api("POST", "/v1/orders", { token: B.key, body, headers: { "idempotency-key": key } });
    check("replay returns same order", o1.status === 201 && o2.status === 201 && o1.json?.id === o2.json?.id && o2.headers.get("idempotent-replayed") === "true",
      { o1: o1.json?.id, o2: o2.json?.id });
    bExpected -= 1500;
    const wb = await api("GET", "/v1/wallet", { token: B.key });
    check("charged exactly once", wb.json?.available_cents === bExpected, wb.json);
    const o3 = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: D.id, quantity: 2 }, headers: { "idempotency-key": key } });
    check("same key, different body -> 409", isErr(o3, 409, "conflict"));
    // Concurrent duplicates with a fresh key still produce one order
    const key2 = `ord2-${RUN}`;
    const [c1, c2, c3] = await Promise.all([1, 2, 3].map(() => api("POST", "/v1/orders", { token: B.key, body, headers: { "idempotency-key": key2 } })));
    const ids = new Set([c1, c2, c3].map((r) => r.json?.id));
    check("concurrent same-key requests create one order", ids.size === 1 && [c1, c2, c3].every((r) => r.status === 201), [c1, c2, c3].map((r) => [r.status, r.json?.id ?? r.json]));
    bExpected -= 1500;
  }

  section("Order listing & events");
  {
    const lb = await api("GET", "/v1/orders?role=buyer", { token: B.key });
    check("GET /v1/orders?role=buyer", lb.status === 200 && lb.json.data.length >= 6 && lb.json.data.every((o) => o.buyer_agent_id === B.id), lb.json?.data?.length);
    const ls = await api("GET", "/v1/orders?role=seller&status=completed", { token: A.key });
    check("GET /v1/orders?role=seller&status=completed", ls.status === 200 && ls.json.data.length >= 4 && ls.json.data.every((o) => o.status === "completed"), ls.json?.data?.length);
    const badStatus = await api("GET", "/v1/orders?status=bogus", { token: A.key });
    check("invalid status filter -> 400", isErr(badStatus, 400, "invalid_request"));
    const ev = await api("GET", "/v1/events?limit=100", { token: A.key });
    const types = new Set((ev.json?.data ?? []).map((e) => e.type));
    check("seller events feed", ["order.paid", "order.fulfilled", "order.completed", "order.cancelled", "order.refunded", "order.disputed", "listing.sold_out"].every((t) => types.has(t)), [...types]);
    const first = ev.json?.data?.[0]?.id;
    const since = await api("GET", `/v1/events?since=${first}&limit=100`, { token: A.key });
    check("events since=<evt_id>", since.status === 200 && since.json.data.length === ev.json.data.length - 1 && !since.json.data.some((e) => e.id === first));
    const evB = await api("GET", "/v1/events?limit=100", { token: B.key });
    check("buyer does not see seller-only events", !(evB.json?.data ?? []).some((e) => e.type === "listing.sold_out"));
    const sw = await api("POST", "/v1/admin/sweep");
    check("POST /v1/admin/sweep", sw.status === 200 && typeof sw.json?.released === "number", sw.json);
  }

  section("MCP");
  {
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
    check("initialize", init.status === 200 && init.json?.result?.protocolVersion === "2025-06-18" && init.json?.result?.serverInfo?.name === "agentmart" &&
      !!init.json?.result?.capabilities?.tools, init.json);
    const notif = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    check("notifications/initialized -> 202 no body", notif.status === 202 && notif.text === "", notif.status);
    const ping = await mcp({ jsonrpc: "2.0", id: 2, method: "ping" });
    check("ping", ping.json?.result && Object.keys(ping.json.result).length === 0);
    const tl = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, B.key);
    const names = (tl.json?.result?.tools ?? []).map((t) => t.name);
    const expected = ["register_agent", "search_listings", "get_listing", "get_wallet", "deposit_sandbox_funds", "create_order", "list_orders", "get_order", "confirm_order", "create_store", "create_listing", "fulfill_order"];
    check("tools/list has all 12 v1 tools with schemas", expected.every((n) => names.includes(n)) && tl.json.result.tools.every((t) => t.inputSchema?.type === "object"), names);
    const sr = await toolCall("search_listings", { q: token, kind: "digital" }, undefined);
    const sc = sr.json?.result?.structuredContent;
    check("tools/call search_listings (unauthenticated)", sr.json?.result?.isError === false && sc?.data?.[0]?.id === D.id && sr.json.result.content?.[0]?.type === "text", sr.json);
    const co = await toolCall("create_order", { listing_id: D.id, quantity: 1 }, B.key);
    const order = co.json?.result?.structuredContent;
    check("tools/call create_order (digital, instant)", co.json?.result?.isError === false && order?.status === "completed" && order?.delivery?.payload === `SECRET-${RUN}`, co.json);
    bExpected -= 1500;
    const go = await toolCall("get_order", { order_id: order?.id }, B.key);
    check("tools/call get_order", go.json?.result?.structuredContent?.id === order?.id);
    const unauth = await toolCall("get_wallet", {}, undefined);
    check("auth-required tool without auth -> isError", unauth.json?.result?.isError === true && unauth.json.result.structuredContent?.error?.code === "unauthorized", unauth.json);
    const errTool = await toolCall("create_order", { listing_id: D.id }, A.key);
    check("tool business error surfaces as isError (own listing)", errTool.json?.result?.isError === true && errTool.json.result.structuredContent?.error?.code === "forbidden");
    const unknownTool = await toolCall("hack_the_planet", {}, B.key);
    check("unknown tool -> JSON-RPC error -32602", unknownTool.json?.error?.code === -32602, unknownTool.json);
    const unknownMethod = await mcp({ jsonrpc: "2.0", id: 9, method: "resources/list" });
    check("unknown method -> -32601", unknownMethod.json?.error?.code === -32601);
    const parse = await api("POST", "/mcp", { body: "{oops", raw: true });
    check("parse error -> -32700", parse.json?.error?.code === -32700);
    const reg = await toolCall("register_agent", { name: `MCP Agent ${RUN}` }, undefined);
    const mcpKey = reg.json?.result?.structuredContent?.credentials?.api_key;
    check("tools/call register_agent (unauthenticated)", /^am_live_/.test(mcpKey ?? ""), reg.json);
    const dep = await toolCall("deposit_sandbox_funds", { amount_cents: 5000 }, mcpKey);
    check("tools/call deposit_sandbox_funds", dep.json?.result?.structuredContent?.available_cents === 5000, dep.json);
    const gw = await toolCall("get_wallet", {}, mcpKey);
    check("tools/call get_wallet", gw.json?.result?.structuredContent?.available_cents === 5000);
    const batch = await mcp([{ jsonrpc: "2.0", id: 10, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 11, method: "ping" }]);
    check("JSON-RPC batch", Array.isArray(batch.json) && batch.json.length === 2);
    const getMcp = await api("GET", "/mcp");
    check("GET /mcp -> 405", getMcp.status === 405);
  }

  // =========================================================================
  // v1.1 features (self-contained: fresh seller E and buyer D keep rate-limit buckets separate)
  // =========================================================================
  section("v1.1 Agent email");
  const emailE = `seller-${RUN}@Example.COM`;
  const regE = await api("POST", "/v1/agents/register", { body: { name: `V11 Seller ${RUN}`, email: emailE } });
  check("register with email -> lower-cased", regE.status === 201 && regE.json?.agent?.email === emailE.toLowerCase(), regE.json);
  const dupEmail = await api("POST", "/v1/agents/register", { body: { name: "dup", email: emailE.toUpperCase() } });
  check("duplicate email (case-insensitive) -> 409", isErr(dupEmail, 409, "conflict"), dupEmail.json);
  const badEmail = await api("POST", "/v1/agents/register", { body: { name: "bad", email: "not-an-email" } });
  check("invalid email -> 400", isErr(badEmail, 400, "invalid_request"));
  const regD = await api("POST", "/v1/agents/register", { body: { name: `V11 Buyer ${RUN}` } });
  const E = { id: regE.json?.credentials?.agent_id, key: regE.json?.credentials?.api_key };
  const Dd = { id: regD.json?.credentials?.agent_id, key: regD.json?.credentials?.api_key };
  {
    const me = await api("GET", "/v1/me", { token: E.key });
    check("GET /v1/me includes email", me.json?.agent?.email === emailE.toLowerCase() && "store" in (me.json ?? {}) && me.json.store === null, me.json);
    const pe = await api("PATCH", "/v1/me", { token: Dd.key, body: { email: `buyer-${RUN}@example.com` } });
    check("PATCH /v1/me sets email", pe.status === 200 && pe.json?.agent?.email === `buyer-${RUN}@example.com`, pe.json);
    const pd = await api("PATCH", "/v1/me", { token: Dd.key, body: { email: emailE } });
    check("PATCH /v1/me to a taken email -> 409", isErr(pd, 409, "conflict"));
    const pc = await api("PATCH", "/v1/me", { token: Dd.key, body: { email: null } });
    check("PATCH /v1/me clears email", pc.status === 200 && pc.json?.agent?.email === null, pc.json);
  }

  section("v1.1 Product-first seed, categories, catalog");
  {
    const all = await api("GET", "/v1/catalog?limit=200", { token: C.key });
    check("GET /v1/catalog (limit 200)", all.status === 200 && Array.isArray(all.json?.data) && "sync_token" in all.json, all.status);
    const item = all.json?.data?.[0] ?? {};
    check("catalog items are compact with url/rating/shipping_cents",
      ["id", "title", "kind", "price_cents", "currency", "shipping_cents", "inventory", "rating", "category", "store_slug", "url", "updated_at"].every((k) => k in item) &&
      item.url?.endsWith(`/v1/listings/${item.id}`) && !("description" in item), item);
    const demo = await demoListings(C.key);
    const byKind = (k) => demo.filter((l) => l.kind === k).length;
    check("reseeded demo: >=16 physical, >=8 digital, >=2 services", byKind("physical") >= 16 && byKind("digital") >= 8 && byKind("service") >= 2,
      { physical: byKind("physical"), digital: byKind("digital"), service: byKind("service") });
    check("demo prices within $5-$300 and physical inventory set",
      demo.every((l) => l.price_cents >= 500 && l.price_cents <= 30000) && demo.filter((l) => l.kind === "physical").every((l) => Number.isInteger(l.inventory)));
    check("demo reviews seeded (rated demo listings)", demo.filter((l) => l.rating?.count > 0).length >= 5, demo.map((l) => l.rating));
    const big = await api("GET", "/v1/catalog?limit=201", { token: C.key });
    check("catalog limit > 200 -> 400", isErr(big, 400, "invalid_request"));
    const badSince = await api("GET", "/v1/catalog?updated_since=yesterday", { token: C.key });
    check("catalog bad updated_since -> 400", isErr(badSince, 400, "invalid_request"));

    const cats = await api("GET", "/v1/categories");
    const hk = (cats.json?.data ?? []).find((c) => c.slug === "home-kitchen");
    check("GET /v1/categories (public)", cats.status === 200 && hk?.name === "Home & Kitchen" && hk.listing_count >= 3, cats.json);
    check("categories are slugs", (cats.json?.data ?? []).every((c) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug)));
    const inCat = await api("GET", "/v1/listings?category=Home%20%26%20Kitchen&limit=100", { token: C.key });
    check("category filter accepts a name and normalises to slug", inCat.json?.data?.length === hk?.listing_count &&
      inCat.json.data.every((l) => l.category === "home-kitchen"), inCat.json?.data?.length);
    const rated = await api("GET", "/v1/listings?min_rating=4.5&sort=rating&limit=100", { token: C.key });
    const ratings = (rated.json?.data ?? []).map((l) => l.rating?.average);
    check("min_rating filter + sort=rating", ratings.length > 0 && ratings.every((r) => r >= 4.5) &&
      ratings.every((r, i) => i === 0 || ratings[i - 1] >= r), ratings);
    const badRating = await api("GET", "/v1/listings?min_rating=9", { token: C.key });
    check("min_rating out of range -> 400", isErr(badRating, 400, "invalid_request"));
  }

  section("v1.1 Store, listings, purchase hint");
  const st11 = await api("POST", "/v1/stores", { token: E.key, body: { name: `V11 Store ${RUN}`, slug: `v11-${RUN}`, return_policy: "30 days" } });
  check("store object has rating", st11.status === 201 && st11.json?.rating?.average === null && st11.json?.rating?.count === 0, st11.json);
  const kettle = await api("POST", "/v1/listings", {
    token: E.key,
    body: { title: `Kettle ${token}`, description: "Stainless kettle for review testing.", kind: "physical", price_cents: 3000, inventory: 10,
      category: "Home & Kitchen", tags: [token], shipping: { handling_days: 1, ships_to: ["US", "CA"], shipping_cents: 400 } },
  });
  check("category normalised to slug on create", kettle.status === 201 && kettle.json?.category === "home-kitchen" &&
    kettle.json?.rating?.average === null && kettle.json?.rating?.count === 0, kettle.json);
  const ebook = await api("POST", "/v1/listings", {
    token: E.key,
    body: { title: `Ebook ${token}`, description: "Digital ebook.", kind: "digital", price_cents: 1000, category: "books",
      digital_delivery: { type: "text", payload: `EBOOK-${RUN}` } },
  });
  const K = kettle.json, EB = ebook.json;
  {
    const det = await api("GET", `/v1/listings/${K.id}`, { token: C.key });
    const p = det.json?.purchase;
    check("listing detail has purchase hint", p?.endpoint === "POST /v1/orders" && p.required_fields?.includes("listing_id") &&
      p.required_fields.includes("shipping_address") && p.example?.listing_id === K.id && p.mcp_tool === "create_order", p);
    const detD = await api("GET", `/v1/listings/${EB.id}`, { token: C.key });
    check("digital purchase hint needs only listing_id", JSON.stringify(detD.json?.purchase?.required_fields) === JSON.stringify(["listing_id"]), detD.json?.purchase);
    check("seller email never exposed publicly", !det.text.includes(emailE.toLowerCase()) && !det.text.includes("@example.com"));
    const mine = await api("PATCH", `/v1/listings/${K.id}`, { token: E.key, body: { status: "paused" } });
    const myStore = await api("GET", "/v1/stores/me", { token: E.key });
    check("GET /v1/stores/me includes paused listings", mine.json?.status === "paused" && myStore.json?.listings?.some((l) => l.id === K.id && l.status === "paused"));
    const before = new Date(Date.now() - 1000).toISOString();
    await api("PATCH", `/v1/listings/${K.id}`, { token: E.key, body: { status: "active" } });
    const inc = await api("GET", `/v1/catalog?updated_since=${encodeURIComponent(before)}&limit=200`, { token: C.key });
    check("catalog updated_since returns recently changed listings", inc.json?.data?.some((l) => l.id === K.id) &&
      inc.json.data.every((l) => l.updated_at > before), inc.json?.data?.map((l) => l.updated_at));
  }

  section("v1.1 Wallet: faucet flag, payment methods, withdraw");
  {
    const pm = await api("POST", "/v1/wallet/payment-methods", { token: Dd.key, body: {} });
    check("POST /v1/wallet/payment-methods -> 501 not_implemented (roadmap)", isErr(pm, 501, "not_implemented") && /roadmap/i.test(pm.json?.error?.message ?? ""), pm.json);
    if (process.env.PSQL) {
      const { execSync } = await import("node:child_process");
      const setFlag = (v) => execSync(`${process.env.PSQL} -q -c "update market.config set value = '${v}' where key = 'faucet_enabled'"`);
      setFlag("false");
      try {
        const off = await api("POST", "/v1/wallet/deposit", { token: Dd.key, body: { amount_cents: 1000 } });
        check("faucet_enabled=false -> 403 forbidden", isErr(off, 403, "forbidden") && /faucet disabled/i.test(off.json?.error?.message ?? ""), off.json);
      } finally {
        setFlag("true");
      }
    } else {
      console.log("  SKIP  faucet_enabled toggle (set PSQL to a psql command for the DB)");
    }
    const dep = await api("POST", "/v1/wallet/deposit", { token: Dd.key, body: { amount_cents: 100000 } });
    check("buyer D funded (sandbox)", dep.status === 201 && dep.json?.available_cents === 100000 && dep.json?.mode === "sandbox", dep.json);
  }

  section("v1.1 Reviews & ratings");
  let reviewId;
  {
    const o = await api("POST", "/v1/orders", { token: Dd.key, body: { listing_id: K.id, shipping_address: ADDRESS } });
    check("buyer D orders kettle", o.status === 201 && o.json?.status === "paid", o.json);
    const early = await api("POST", `/v1/orders/${o.json.id}/review`, { token: Dd.key, body: { rating: 5 } });
    check("review of a paid (unfulfilled) order -> 409", isErr(early, 409, "conflict"), early.json);
    await api("POST", `/v1/orders/${o.json.id}/fulfill`, { token: E.key, body: { carrier: "USPS", tracking_number: "9400" } });
    const sellerRev = await api("POST", `/v1/orders/${o.json.id}/review`, { token: E.key, body: { rating: 5 } });
    check("seller cannot review own sale -> 403", isErr(sellerRev, 403, "forbidden"));
    const strangerRev = await api("POST", `/v1/orders/${o.json.id}/review`, { token: C.key, body: { rating: 5 } });
    check("non-party review -> 404", isErr(strangerRev, 404, "not_found"));
    const badRating = await api("POST", `/v1/orders/${o.json.id}/review`, { token: Dd.key, body: { rating: 6 } });
    check("rating outside 1..5 -> 400", isErr(badRating, 400, "invalid_request"));
    const longTitle = await api("POST", `/v1/orders/${o.json.id}/review`, { token: Dd.key, body: { rating: 4, title: "x".repeat(121) } });
    check("title > 120 -> 400", isErr(longTitle, 400, "invalid_request"));
    const rv = await api("POST", `/v1/orders/${o.json.id}/review`, { token: Dd.key, body: { rating: 4, title: "Good kettle", body: "Boils fast." } });
    reviewId = rv.json?.id;
    check("buyer reviews fulfilled order -> 201", rv.status === 201 && rv.json?.id?.startsWith("rev_") && rv.json?.verified_purchase === true &&
      rv.json?.rating === 4 && rv.json?.reviewer?.agent_id === Dd.id && rv.json?.store_slug === `v11-${RUN}` && rv.json?.seller_reply === null &&
      rv.json?.order_id === o.json.id && rv.json?.listing_id === K.id, rv.json);
    const again = await api("POST", `/v1/orders/${o.json.id}/review`, { token: Dd.key, body: { rating: 1 } });
    check("second review on same order -> 409", isErr(again, 409, "conflict"));
    const lst = await api("GET", `/v1/listings/${K.id}`, { token: C.key });
    check("listing rating updated {4.0, 1}", lst.json?.rating?.average === 4 && lst.json?.rating?.count === 1, lst.json?.rating);

    // Second order (digital, completed) with a 5-star review => average 4.5
    const o2 = await api("POST", "/v1/orders", { token: Dd.key, body: { listing_id: EB.id } });
    const rv2 = await api("POST", `/v1/orders/${o2.json.id}/review`, { token: Dd.key, body: { rating: 5, title: "Great read" } });
    check("review of completed digital order", rv2.status === 201 && rv2.json?.rating === 5, rv2.json);
    const store = await api("GET", `/v1/stores/v11-${RUN}`, { token: C.key });
    check("store rating aggregates listings {4.5, 2}", store.json?.rating?.average === 4.5 && store.json?.rating?.count === 2, store.json?.rating);

    // Disputed orders can be reviewed too
    const o3 = await api("POST", "/v1/orders", { token: Dd.key, body: { listing_id: K.id, shipping_address: ADDRESS } });
    await api("POST", `/v1/orders/${o3.json.id}/fulfill`, { token: E.key, body: { carrier: "USPS", tracking_number: "9401" } });
    await api("POST", `/v1/orders/${o3.json.id}/dispute`, { token: Dd.key, body: { reason: "dented" } });
    const rv3 = await api("POST", `/v1/orders/${o3.json.id}/review`, { token: Dd.key, body: { rating: 1, body: "Arrived dented" } });
    check("review of disputed order allowed", rv3.status === 201, rv3.json);

    const lr = await api("GET", `/v1/listings/${K.id}/reviews?sort=lowest`, { token: C.key });
    check("GET listing reviews sort=lowest", lr.status === 200 && lr.json?.data?.length === 2 && lr.json.data[0].rating === 1 &&
      lr.json?.rating?.average === 2.5 && lr.json?.rating?.count === 2, lr.json);
    const lh = await api("GET", `/v1/listings/${K.id}/reviews?sort=highest&limit=1`, { token: C.key });
    check("listing reviews sort=highest + pagination", lh.json?.data?.[0]?.rating === 4 && !!lh.json?.next_cursor, lh.json);
    const sr = await api("GET", `/v1/stores/v11-${RUN}/reviews`, { token: C.key });
    check("GET store reviews", sr.status === 200 && sr.json?.data?.length === 3 && sr.json?.rating?.count === 3, sr.json?.rating);
    const nf = await api("GET", "/v1/listings/lst_00000000000000000000/reviews", { token: C.key });
    check("reviews of unknown listing -> 404", isErr(nf, 404, "not_found"));

    const buyerReply = await api("POST", `/v1/reviews/${reviewId}/reply`, { token: Dd.key, body: { body: "me too" } });
    check("non-seller cannot reply -> 403", isErr(buyerReply, 403, "forbidden"));
    const emptyReply = await api("POST", `/v1/reviews/${reviewId}/reply`, { token: E.key, body: {} });
    check("reply requires body -> 400", isErr(emptyReply, 400, "invalid_request"));
    const reply = await api("POST", `/v1/reviews/${reviewId}/reply`, { token: E.key, body: { body: "Thanks for buying!" } });
    check("seller replies", reply.status === 201 && reply.json?.seller_reply?.body === "Thanks for buying!" && !!reply.json?.seller_reply?.created_at, reply.json);
    const reply2 = await api("POST", `/v1/reviews/${reviewId}/reply`, { token: E.key, body: { body: "again" } });
    check("second reply -> 409", isErr(reply2, 409, "conflict"));

    const otherEdit = await api("PATCH", `/v1/reviews/${reviewId}`, { token: E.key, body: { rating: 5 } });
    check("non-author edit -> 403", isErr(otherEdit, 403, "forbidden"));
    const edit = await api("PATCH", `/v1/reviews/${reviewId}`, { token: Dd.key, body: { rating: 2, body: "Handle broke." } });
    check("author edits review", edit.status === 200 && edit.json?.rating === 2 && edit.json?.body === "Handle broke." && edit.json?.title === "Good kettle", edit.json);
    const lst2 = await api("GET", `/v1/listings/${K.id}`, { token: C.key });
    check("listing rating recalculated after edit {1.5, 2}", lst2.json?.rating?.average === 1.5 && lst2.json?.rating?.count === 2, lst2.json?.rating);

    const evE = await api("GET", "/v1/events?limit=100", { token: E.key });
    const evD = await api("GET", "/v1/events?limit=100", { token: Dd.key });
    check("review.created delivered to seller", (evE.json?.data ?? []).filter((e) => e.type === "review.created").length === 3);
    check("review.replied delivered to reviewer", (evD.json?.data ?? []).some((e) => e.type === "review.replied" && e.data?.review_id === reviewId) &&
      !(evD.json?.data ?? []).some((e) => e.type === "review.created"));

    const otherDel = await api("DELETE", `/v1/reviews/${reviewId}`, { token: E.key });
    check("non-author delete -> 403", isErr(otherDel, 403, "forbidden"));
    const del = await api("DELETE", `/v1/reviews/${reviewId}`, { token: Dd.key });
    check("author deletes review", del.status === 200 && del.json?.deleted === true);
    const lst3 = await api("GET", `/v1/listings/${K.id}`, { token: C.key });
    check("rating after delete {1.0, 1}", lst3.json?.rating?.average === 1 && lst3.json?.rating?.count === 1, lst3.json?.rating);
    const gone = await api("PATCH", `/v1/reviews/${reviewId}`, { token: Dd.key, body: { rating: 3 } });
    check("edit deleted review -> 404", isErr(gone, 404, "not_found"));

    // Seller E earnings: kettle 3400 - 150 (order 1 confirmed below) + ebook 1000 - 50
    await api("POST", `/v1/orders/${o.json.id}/confirm`, { token: Dd.key });
  }

  section("v1.1 MCP tools");
  {
    const tl = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (tl.json?.result?.tools ?? []).map((t) => t.name);
    const v11 = ["list_categories", "browse_catalog", "get_reviews", "write_review", "update_listing", "get_my_store", "update_store", "cancel_order", "refund_order"];
    check("tools/list includes all 9 v1.1 tools (21 total)", v11.every((n) => names.includes(n)) && names.length === 21, names);
    const cats = await toolCall("list_categories", {});
    check("list_categories", cats.json?.result?.structuredContent?.data?.some((c) => c.slug === "home-kitchen"), cats.json);
    const cat = await toolCall("browse_catalog", { limit: 5 });
    check("browse_catalog", cat.json?.result?.structuredContent?.data?.length === 5, cat.json?.result?.structuredContent);
    const gr = await toolCall("get_reviews", { listing_id: K.id });
    check("get_reviews (listing)", gr.json?.result?.structuredContent?.rating?.count === 1, gr.json);
    const grs = await toolCall("get_reviews", { store_slug: `v11-${RUN}`, sort: "highest" });
    check("get_reviews (store)", grs.json?.result?.structuredContent?.data?.[0]?.rating === 5, grs.json);
    const grBad = await toolCall("get_reviews", {});
    check("get_reviews without target -> isError", grBad.json?.result?.isError === true);
    const ul = await toolCall("update_listing", { listing_id: K.id, price_cents: 3200, inventory: 20 }, E.key);
    check("update_listing", ul.json?.result?.structuredContent?.price_cents === 3200 && ul.json.result.structuredContent.inventory === 20, ul.json);
    const gms = await toolCall("get_my_store", {}, E.key);
    check("get_my_store", gms.json?.result?.structuredContent?.slug === `v11-${RUN}` && gms.json.result.structuredContent.listings?.length === 2, gms.json?.result?.structuredContent?.slug);
    const us = await toolCall("update_store", { description: "Updated via MCP" }, E.key);
    check("update_store", us.json?.result?.structuredContent?.description === "Updated via MCP", us.json);
    const o = await toolCall("create_order", { listing_id: K.id, shipping_address: ADDRESS }, Dd.key);
    const oid = o.json?.result?.structuredContent?.id;
    const co = await toolCall("cancel_order", { order_id: oid, reason: "mcp test" }, Dd.key);
    check("cancel_order", co.json?.result?.structuredContent?.status === "cancelled", co.json);
    const o2 = await toolCall("create_order", { listing_id: K.id, shipping_address: ADDRESS }, Dd.key);
    const ro = await toolCall("refund_order", { order_id: o2.json?.result?.structuredContent?.id, reason: "mcp test" }, E.key);
    check("refund_order", ro.json?.result?.structuredContent?.status === "refunded", ro.json);
    const o3 = await toolCall("create_order", { listing_id: EB.id }, Dd.key);
    const wr = await toolCall("write_review", { order_id: o3.json?.result?.structuredContent?.id, rating: 4, title: "via MCP" }, Dd.key);
    check("write_review", wr.json?.result?.isError === false && wr.json.result.structuredContent?.rating === 4, wr.json);
    const wrUnauth = await toolCall("write_review", { order_id: "ord_x", rating: 4 });
    check("write_review requires auth", wrUnauth.json?.result?.isError === true && wrUnauth.json.result.structuredContent?.error?.code === "unauthorized");
  }

  section("v1.1 Withdraw (sandbox) & ledger");
  {
    const wE = await api("GET", "/v1/wallet", { token: E.key });
    // kettle order: total 3400 (3000 + 400 shipping), fee 150 -> 3250; ebook x2: (1000 - 50) x 2 = 1900
    check("seller E earnings", wE.json?.available_cents === 3250 + 1900, wE.json);
    const tooMuch = await api("POST", "/v1/wallet/withdraw", { token: E.key, body: { amount_cents: 999999 } });
    check("withdraw more than available -> 402", isErr(tooMuch, 402, "insufficient_funds"), tooMuch.json);
    const zero = await api("POST", "/v1/wallet/withdraw", { token: E.key, body: { amount_cents: 0 } });
    check("withdraw 0 -> 400", isErr(zero, 400, "invalid_request"));
    const key = `wd-${RUN}`;
    const w1 = await api("POST", "/v1/wallet/withdraw", { token: E.key, body: { amount_cents: 2000 }, headers: { "idempotency-key": key } });
    const w2 = await api("POST", "/v1/wallet/withdraw", { token: E.key, body: { amount_cents: 2000 }, headers: { "idempotency-key": key } });
    check("withdraw (sandbox) moves available out", w1.status === 201 && w1.json?.available_cents === 5150 - 2000 && w1.json?.withdrawal?.amount_cents === 2000, w1.json);
    check("withdraw idempotent replay", w2.json?.withdrawal?.transfer_id === w1.json?.withdrawal?.transfer_id && w2.headers.get("idempotent-replayed") === "true");
    const tx = await allTransactions(E.key);
    const wE2 = (await api("GET", "/v1/wallet", { token: E.key })).json;
    const payoutEntries = tx.filter((t) => t.type === "payout");
    check("withdrawal recorded as negative payout entry", payoutEntries.some((t) => t.amount_cents === -2000));
    check("seller E: ledger sums match wallet after withdraw",
      tx.filter((t) => t.account === "available").reduce((s, t) => s + t.amount_cents, 0) === wE2.available_cents && wE2.available_cents === 3150, wE2);
    const txD = await allTransactions(Dd.key);
    const wD = (await api("GET", "/v1/wallet", { token: Dd.key })).json;
    check("buyer D: ledger sums match wallet",
      txD.filter((t) => t.account === "available").reduce((s, t) => s + t.amount_cents, 0) === wD.available_cents &&
      txD.filter((t) => t.account === "held").reduce((s, t) => s + t.amount_cents, 0) === wD.held_cents, wD);
  }

  section("Ledger invariants");
  {
    for (const [name, agent] of [["seller A", A], ["buyer B", B]]) {
      const w = (await api("GET", "/v1/wallet", { token: agent.key })).json;
      const tx = await allTransactions(agent.key);
      const sum = (acct) => tx.filter((t) => t.account === acct).reduce((s, t) => s + t.amount_cents, 0);
      check(`${name}: sum(available entries) == available_cents`, sum("available") === w.available_cents, { sum: sum("available"), w });
      check(`${name}: sum(held entries) == held_cents`, sum("held") === w.held_cents, { sum: sum("held"), w });
      const latestAvail = tx.find((t) => t.account === "available");
      check(`${name}: latest balance_after_cents matches wallet`, !latestAvail || latestAvail.balance_after_cents === w.available_cents);
      const byTransfer = new Map();
      for (const t of tx) byTransfer.set(t.transfer_id, (byTransfer.get(t.transfer_id) ?? 0) + t.amount_cents);
      check(`${name}: ledger entry types valid`, tx.every((t) => ["deposit", "escrow_hold", "escrow_release", "payout", "refund", "fee"].includes(t.type) && t.id.startsWith("txn_")));
      if (agent === B) {
        check("buyer B final balance matches expected", w.available_cents === bExpected && w.held_cents === 0, { w, bExpected });
        // For a buyer (no payouts), escrow holds/refunds are internal moves: each transfer nets to 0 or equals a deposit/spend.
        const deposits = tx.filter((t) => t.type === "deposit").reduce((s, t) => s + t.amount_cents, 0);
        const released = tx.filter((t) => t.type === "escrow_release").reduce((s, t) => s + t.amount_cents, 0);
        check("buyer B: deposits + escrow releases == balance", deposits + released === w.available_cents + w.held_cents, { deposits, released, w });
      } else {
        const payouts = tx.filter((t) => t.type === "payout").reduce((s, t) => s + t.amount_cents, 0);
        check("seller A: payouts == available balance", payouts === w.available_cents, { payouts, w });
      }
    }
    const stats = await api("GET", "/v1/stats");
    check("stats reflect completed orders", stats.json?.orders_completed >= 5 && stats.json?.gmv_cents >= 3000 + 2500 + 1500 * 3, stats.json);
  }

  section("Archive");
  {
    const del = await api("DELETE", `/v1/listings/${S.id}`, { token: A.key });
    check("archive listing", del.status === 200 && del.json?.status === "archived");
    const gone = await api("GET", `/v1/listings/${S.id}`);
    check("archived listing -> 404 for public", isErr(gone, 404, "not_found"));
    const buy = await api("POST", "/v1/orders", { token: B.key, body: { listing_id: S.id } });
    check("buy archived listing -> 404", isErr(buy, 404, "not_found"));
  }

  section("Webhooks (optional, local only)");
  {
    const reg = await api("POST", "/v1/agents/register", { body: { name: `Hooked ${RUN}`, webhook_url: HOOK_URL } });
    if (reg.status !== 201) {
      console.log("  SKIP  API does not accept http webhook URLs (expected in production)");
    } else {
      const H = { key: reg.json.credentials.api_key, secret: reg.json.webhook_secret };
      check("register returns webhook_secret once", /^whsec_/.test(H.secret ?? ""));
      await api("POST", "/v1/wallet/deposit", { token: H.key, body: { amount_cents: 5000 } });
      const o = await api("POST", "/v1/orders", { token: H.key, body: { listing_id: D.id } });
      check("hooked agent buys digital", o.json?.status === "completed", o.json);
      for (let i = 0; i < 30 && hooks.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
      const got = hooks.map((h) => JSON.parse(h.body).type);
      check("webhooks delivered (paid, fulfilled, completed)", ["order.paid", "order.fulfilled", "order.completed"].every((t) => got.includes(t)), got);
      const h0 = hooks[0];
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h0?.headers["agentmart-signature"] ?? "");
      const expectedSig = m && crypto.createHmac("sha256", H.secret).update(`${m[1]}.${h0.body}`).digest("hex");
      check("webhook signature verifies (HMAC-SHA256 of ts.body)", !!m && expectedSig === m[2], h0?.headers);
    }
  }

  section("v1.1 Stripe live funding (optional: needs API_BASE_LIVE)");
  if (!LIVE_BASE) {
    console.log("  SKIP  set API_BASE_LIVE (server with STRIPE_SECRET_KEY, STRIPE_API_BASE=fake, STRIPE_WEBHOOK_SECRET) to run");
  } else {
    const live = (method, path, opts = {}) => api(method, path, { ...opts, base: LIVE_BASE });
    const reg = await live("POST", "/v1/agents/register", { body: { name: `Live ${RUN}` } });
    const L = { id: reg.json?.credentials?.agent_id, key: reg.json?.credentials?.api_key };
    const w0 = await live("GET", "/v1/wallet", { token: L.key });
    check("wallet mode is live when STRIPE_SECRET_KEY set", w0.json?.mode === "live", w0.json);
    const small = await live("POST", "/v1/wallet/deposit", { token: L.key, body: { amount_cents: 10 } });
    check("live deposit below Stripe minimum -> 400", isErr(small, 400, "invalid_request"));
    const key = `live-${RUN}`;
    const d1 = await live("POST", "/v1/wallet/deposit", { token: L.key, body: { amount_cents: 2500 }, headers: { "idempotency-key": key } });
    check("live deposit returns Stripe checkout", d1.status === 201 && d1.json?.mode === "live" && /^cs_test_/.test(d1.json?.session_id ?? "") &&
      d1.json?.checkout_url?.startsWith("https://"), d1.json);
    const sent = fakeStripe.requests.at(-1);
    check("checkout session form: mode=payment, line item, client_reference_id, metadata",
      sent?.form.get("mode") === "payment" && sent.form.get("client_reference_id") === L.id && sent.form.get("metadata[agent_id]") === L.id &&
      sent.form.get("metadata[idempotency_key]") === key && sent.form.get("line_items[0][price_data][unit_amount]") === "2500" &&
      sent.form.get("line_items[0][price_data][currency]") === "usd" &&
      sent.form.get("line_items[0][price_data][product_data][name]") === "AgentMart wallet top-up" &&
      sent.auth === "Bearer sk_test_fake_local", sent && Object.fromEntries(sent.form));
    const d2 = await live("POST", "/v1/wallet/deposit", { token: L.key, body: { amount_cents: 2500 }, headers: { "idempotency-key": key } });
    check("live deposit idempotent (one Stripe session)", d2.json?.session_id === d1.json?.session_id && fakeStripe.requests.length === 1, fakeStripe.requests.length);
    const wd = await live("POST", "/v1/wallet/withdraw", { token: L.key, body: { amount_cents: 100 } });
    check("live withdraw -> 501 (Stripe Connect not configured)", isErr(wd, 501, "not_implemented"), wd.json);

    const sessionObj = (status = "paid") => ({ id: d1.json.session_id, object: "checkout.session", amount_total: 2500, currency: "usd",
      payment_status: status, client_reference_id: L.id, metadata: { agent_id: L.id, idempotency_key: key } });
    const event = (id, obj, type = "checkout.session.completed") => JSON.stringify({ id, type, object: "event", data: { object: obj } });
    const sign = (body, ts = Math.floor(Date.now() / 1000), secret = STRIPE_WHSEC) =>
      `t=${ts},v1=${crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
    const hook = (body, sig) => live("POST", "/v1/payments/stripe/webhook", { body, raw: true, headers: sig ? { "stripe-signature": sig } : {} });

    const evt1 = event(`evt_${RUN}_1`, sessionObj());
    const noSig = await hook(evt1, null);
    check("webhook without Stripe-Signature -> 400", isErr(noSig, 400, "invalid_request"), noSig.json);
    const wrongSig = await hook(evt1, sign(evt1, undefined, "whsec_wrong"));
    check("webhook with wrong secret -> 400", isErr(wrongSig, 400, "invalid_request"));
    const stale = await hook(evt1, sign(evt1, Math.floor(Date.now() / 1000) - 600));
    check("webhook outside 5-min tolerance -> 400", isErr(stale, 400, "invalid_request"));
    const tampered = await hook(evt1.replace("2500", "250000"), sign(evt1));
    check("tampered webhook body -> 400", isErr(tampered, 400, "invalid_request"));
    const walletBefore = await live("GET", "/v1/wallet", { token: L.key });
    check("no credit before verified webhook", walletBefore.json?.available_cents === 0);

    const unpaid = event(`evt_${RUN}_0`, sessionObj("unpaid"));
    const u = await hook(unpaid, sign(unpaid));
    check("unpaid session is not credited", u.status === 200 && u.json?.credited === false, u.json);
    const ok1 = await hook(evt1, sign(evt1));
    check("verified checkout.session.completed credits wallet", ok1.status === 200 && ok1.json?.credited === true && ok1.json?.amount_cents === 2500, ok1.json);
    const w1 = await live("GET", "/v1/wallet", { token: L.key });
    check("wallet credited 2500", w1.json?.available_cents === 2500, w1.json);
    const replay = await hook(evt1, sign(evt1));
    check("same event replayed -> duplicate, no double credit", replay.status === 200 && replay.json?.duplicate === true && replay.json?.credited === false, replay.json);
    const evt2 = event(`evt_${RUN}_2`, sessionObj(), "checkout.session.async_payment_succeeded");
    const again = await hook(evt2, sign(evt2));
    check("different event for same session -> not credited again", again.status === 200 && again.json?.credited === false, again.json);
    const other = event(`evt_${RUN}_3`, { id: "pi_x" }, "payment_intent.succeeded");
    const ign = await hook(other, sign(other));
    check("unrelated event types acknowledged and ignored", ign.status === 200 && ign.json?.ignored === true);
    const w2 = await live("GET", "/v1/wallet", { token: L.key });
    const tx = await (async () => (await live("GET", "/v1/wallet/transactions?limit=100", { token: L.key })).json?.data ?? [])();
    check("exactly one deposit entry, balance 2500", w2.json?.available_cents === 2500 && tx.filter((t) => t.type === "deposit").length === 1, { w: w2.json, tx });
    const mf = await live("GET", "/.well-known/agentmart.json");
    check("manifest reports live funding mode", mf.json?.payments?.funding_mode === "live");
  }

  if (process.env.SKIP_RATE_LIMIT_TEST !== "1") {
    section("Rate limiting (429)");
    const reg = await api("POST", "/v1/agents/register", { body: { name: `Burst ${RUN}` } });
    const key = reg.json?.credentials?.api_key;
    let limited = null;
    for (let sent = 0; sent < 260 && !limited; sent += 20) {
      const batch = await Promise.all(Array.from({ length: 20 }, () => api("GET", "/v1/wallet", { token: key })));
      limited = batch.find((r) => r.status === 429) ?? null;
    }
    check("exceeding 120/min -> 429 rate_limited", !!limited && errCode(limited) === "rate_limited" && limited.headers.get("x-ratelimit-remaining") === "0" &&
      Number(limited.headers.get("retry-after")) >= 1, limited?.json);
    const other = await api("GET", "/v1/wallet", { token: B.key });
    check("rate limit is per agent", other.status === 200);
  }
}

try {
  await main();
} catch (e) {
  check(`unexpected exception: ${e?.message ?? e}`, false, e?.stack);
} finally {
  hookServer.close();
  fakeStripe.server?.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - [${f.section}] ${f.name}`);
  console.log("OVERALL: FAIL");
  process.exit(1);
}
console.log("OVERALL: PASS");
process.exit(0);
