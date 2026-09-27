// AgentMart v1.1 — tiny in-memory mock API for exercising the web frontend.
// Zero dependencies. `node server.js` (PORT env, default 8787; LIVE=1 → wallet mode "live").
// Mirrors the deployed backend's shapes (single resources unwrapped, GET /v1/me →
// {agent,wallet,mandate,store}, GET /v1/stores/me, two-leg ledger, reviews, categories, catalog).
"use strict";
const http = require("http");
const crypto = require("crypto");

const PORT = +process.env.PORT || 8787;
const LIVE = process.env.LIVE === "1";
const rid = () => "req_" + crypto.randomBytes(6).toString("hex");
const id = p => p + "_" + crypto.randomBytes(9).toString("hex");
const now = () => new Date().toISOString();
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const TREASURY = "agt_treasury";

// ---------------- state ----------------
const agents = {}, keys = {}, wallets = {}, mandates = {}, stores = {}, listings = {}, orders = {}, ledger = [], events = [], idem = {}, reviews = {};
let seq = 0;
function mkAgent(name, extra = {}) {
  const a = Object.assign({ id: id("agt"), name, description: null, email: null, operator_contact: null, webhook_url: null, status: "active", is_demo: false, created_at: now(), updated_at: now() }, extra);
  agents[a.id] = a;
  wallets[a.id] = { agent_id: a.id, available_cents: 0, held_cents: 0, currency: "USD", mode: "sandbox", lifetime_deposits_cents: 0 };
  mandates[a.id] = { max_order_cents: 50000, daily_limit_cents: 200000, allowed_kinds: ["physical", "digital", "service"], updated_at: now() };
  return a;
}
function mkKey(agentId, label = null) {
  const secret = "am_live_" + crypto.randomBytes(24).toString("hex");
  const k = { id: id("key"), agent_id: agentId, prefix: secret.slice(0, 16), hash: sha(secret), label, created_at: now(), last_used_at: null, revoked_at: null };
  keys[k.id] = k;
  return { k, secret };
}
const keyView = k => ({ id: k.id, prefix: k.prefix, label: k.label, status: k.revoked_at ? "revoked" : "active", created_at: k.created_at, last_used_at: k.last_used_at, revoked_at: k.revoked_at });
const agentView = (a, self) => { const v = { id: a.id, name: a.name, description: a.description, status: a.status, is_demo: a.is_demo, created_at: a.created_at }; if (self) Object.assign(v, { email: a.email, operator_contact: a.operator_contact, webhook_url: a.webhook_url, updated_at: a.updated_at }); return v; };
const walletView = w => ({ agent_id: w.agent_id, available_cents: w.available_cents, held_cents: w.held_cents, currency: "USD", mode: LIVE ? "live" : "sandbox", lifetime_deposits_cents: w.lifetime_deposits_cents, faucet_remaining_cents: Math.max(0, 500000 - w.lifetime_deposits_cents) });
function ratingAgg(list) { const n = list.length; return { average: n ? Math.round(list.reduce((s, r) => s + r.rating, 0) / n * 10) / 10 : null, count: n }; }
const storeView = s => Object.assign({}, { id: s.id, slug: s.slug, name: s.name, description: s.description, ships_from: s.ships_from, return_policy: s.return_policy, owner_agent_id: s.agent_id, rating: ratingAgg(Object.values(reviews).filter(r => r.store_id === s.id)), is_demo: s.is_demo, created_at: s.created_at, updated_at: s.updated_at || s.created_at });
function readiness(l) {
  const st = stores[l.store_id]; let s = 0;
  if ((l.title || "").length >= 10) s += 10; if ((l.description || "").length >= 80) s += 15; if (l.category) s += 10;
  s += (l.tags || []).length >= 3 ? 10 : (l.tags || []).length ? 5 : 0;
  if (l.attributes && Object.keys(l.attributes).length) s += 10; if (l.image_url) s += 10;
  if (l.kind !== "physical" || l.inventory !== null) s += 5;
  if (l.kind === "physical" && l.shipping && l.shipping.ships_to && l.shipping.ships_to.length) s += 15;
  if (l.kind === "digital" && l.digital_delivery && l.digital_delivery.type) s += 15;
  if (l.kind === "service" && l.service_terms && l.service_terms.turnaround_days && l.service_terms.deliverable) s += 15;
  if (st.return_policy) s += 10; if (st.description) s += 5;
  return Math.min(100, s);
}
function listingView(l, owner = false) {
  const st = stores[l.store_id];
  const v = { id: l.id, title: l.title, description: l.description, kind: l.kind, price_cents: l.price_cents, currency: "USD", inventory: l.inventory, in_stock: l.status !== "sold_out" && (l.inventory === null || l.inventory > 0), category: l.category, tags: l.tags, attributes: l.attributes, image_url: l.image_url,
    shipping: l.kind === "physical" ? l.shipping : undefined, digital_delivery: l.kind === "digital" ? (owner ? l.digital_delivery : { type: l.digital_delivery ? l.digital_delivery.type : null }) : undefined,
    service_terms: l.kind === "service" ? l.service_terms : undefined, status: l.status, sold_count: l.sold_count || 0, rating: ratingAgg(Object.values(reviews).filter(r => r.listing_id === l.id)), is_demo: l.is_demo,
    store: { id: st.id, slug: st.slug, name: st.name }, seller_agent_id: st.agent_id, agent_readiness: readiness(l), created_at: l.created_at, updated_at: l.updated_at || l.created_at };
  Object.keys(v).forEach(k => v[k] === undefined && delete v[k]);
  return v;
}
const reviewView = r => ({ id: r.id, listing_id: r.listing_id, listing_title: listings[r.listing_id].title, order_id: r.order_id, store_slug: stores[r.store_id].slug, rating: r.rating, title: r.title, body: r.body, verified_purchase: r.order_id !== null, reviewer: { agent_id: r.reviewer_agent_id, name: agents[r.reviewer_agent_id].name }, seller_reply: r.seller_reply || null, is_demo: !!r.is_demo, created_at: r.created_at, updated_at: r.updated_at });
function transfer(legs, meta = {}) {
  const tid = id("trf");
  legs.forEach(g => {
    const w = wallets[g.agent] || (wallets[g.agent] = { agent_id: g.agent, available_cents: 0, held_cents: 0, lifetime_deposits_cents: 0 });
    w[g.account + "_cents"] += g.amount;
    ledger.push({ id: id("txn"), transfer_id: tid, agent_id: g.agent, type: g.type, account: g.account, amount_cents: g.amount, balance_after_cents: w[g.account + "_cents"], currency: "USD", order_id: meta.orderId || null, memo: meta.memo || null, created_at: now(), seq: ++seq });
  });
  return tid;
}
function emit(agentIds, type, refs, data) { events.push({ id: id("evt"), seq: ++seq, agent_ids: [...new Set(agentIds)], type, order_id: refs.orderId || null, listing_id: refs.listingId || null, data, created_at: now() }); }

// ---------------- seed (product-first) ----------------
mkAgent("AgentMart Treasury", { id: TREASURY }); wallets[TREASURY].available_cents = 1e12;
function seedStore(agentName, s, items) {
  const a = mkAgent(agentName, { is_demo: true });
  const st = Object.assign({ id: id("str"), agent_id: a.id, is_demo: true, created_at: now() }, s);
  stores[st.id] = st;
  return items.map((it, i) => { const l = Object.assign({ id: id("lst"), store_id: st.id, status: "active", is_demo: true, tags: [], attributes: {}, image_url: null, sold_count: 0, created_at: new Date(Date.now() - (30 - i) * 3600e3).toISOString() }, it); listings[l.id] = l; return l; });
}
const ship = (d, c, to = ["US", "CA"]) => ({ handling_days: d, ships_to: to, shipping_cents: c });
const [mug, beans] = seedStore("kiln-bot", { slug: "kiln-and-crane", name: "Kiln & Crane Home", description: "[Demo] Kitchen and home goods, shipped by a very careful robot.", ships_from: "US, Asheville NC", return_policy: "30-day returns, unused" }, [
  { kind: "physical", title: "Stoneware Pour-Over Mug, 12 oz", description: "[Demo] Wheel-thrown stoneware with a speckled oatmeal glaze and a hand-pulled handle. Dishwasher and microwave safe, glazed in small batches.", price_cents: 3800, inventory: 40, category: "home-kitchen", tags: ["mug", "ceramic", "coffee"], attributes: { Material: "Stoneware", Capacity: "12 fl oz", Weight: "410 g" }, shipping: ship(2, 650) },
  { kind: "physical", title: "Single-Origin Coffee Beans — Huila, 1 kg", description: "[Demo] Washed Colombian Huila, roasted to order. Red apple, panela and cocoa nib.", price_cents: 3400, inventory: 3, category: "home-kitchen", tags: ["coffee", "beans"], attributes: { Origin: "Huila, Colombia", Roast: "Medium-light" }, shipping: ship(1, 0, ["US"]) },
  { kind: "physical", title: "Bamboo Desk Organizer, 5 Compartments", description: "[Demo] Sustainably harvested bamboo organizer for pens, cards, phone and sticky notes.", price_cents: 2200, inventory: 60, category: "office-supplies", tags: ["desk", "organizer", "bamboo"], attributes: { Material: "Bamboo", Size: "30 × 12 cm" }, shipping: ship(2, 500) },
]);
const [hub] = seedStore("volt-bot", { slug: "volt-supply", name: "Volt Supply Co.", description: "[Demo] Electronics accessories, pet and outdoor gear.", ships_from: "US, Austin TX", return_policy: "60-day returns" }, [
  { kind: "physical", title: "USB-C 7-in-1 Hub, 4K HDMI, 100 W PD", description: "[Demo] Aluminium USB-C hub with 4K60 HDMI, 2× USB-A 3.2, SD/microSD and 100 W pass-through charging.", price_cents: 4900, inventory: 120, category: "electronics-accessories", tags: ["usb-c", "hub", "hdmi"], attributes: { Ports: "7", HDMI: "4K60", PD: "100 W" }, shipping: ship(1, 0) },
  { kind: "physical", title: "Reflective Dog Leash, 6 ft", description: "[Demo] Padded handle, reflective stitching and a rotating clasp.", price_cents: 1800, inventory: 80, category: "pet", tags: ["dog", "leash"], attributes: { Length: "6 ft" }, shipping: ship(2, 450) },
  { kind: "physical", title: "Rechargeable Camping Lantern, 1000 lm", description: "[Demo] Three light modes, 30-hour runtime, doubles as a power bank.", price_cents: 2900, inventory: 45, category: "outdoor", tags: ["camping", "lantern"], attributes: { Output: "1000 lm", Battery: "5200 mAh" }, shipping: ship(2, 600) },
  { kind: "physical", title: "Lip Balm Set, 4 Flavours", description: "[Demo] Beeswax lip balms: mint, vanilla, citrus and unscented.", price_cents: 1200, inventory: 200, category: "beauty", tags: ["lip balm", "beeswax"], attributes: { Count: "4" }, shipping: ship(3, 300, ["US"]) },
]);
const [font] = seedStore("glyph-agent", { slug: "glyphworks", name: "Glyphworks Digital", description: "[Demo] Software licenses, eBooks, datasets and templates, delivered instantly.", ships_from: "Internet", return_policy: "Refund if not as described" }, [
  { kind: "digital", title: "Pantry Grotesk — Variable Font Family", description: "[Demo] A warm, chunky grotesk with a variable weight axis (200–800) and 540 glyphs covering 90+ Latin languages.", price_cents: 7900, inventory: null, category: "software", tags: ["font", "type", "variable"], attributes: { Formats: "OTF, TTF, WOFF2", Axes: "wght 200–800", Glyphs: "540" }, digital_delivery: { type: "license_key", payload: "DEMO-PANTRY-7Q2K-XX91" } },
  { kind: "digital", title: "Startup Ops Template Pack (42 docs)", description: "[Demo] 42 editable operating documents for teams of 2–50.", price_cents: 4900, inventory: null, category: "templates", tags: ["templates", "ops"], attributes: { Documents: "42", Formats: "Markdown, DOCX" }, digital_delivery: { type: "url", payload: "https://example.com/demo-download/ops-pack.zip" } },
  { kind: "digital", title: "US Retail Price Index Dataset, 2025", description: "[Demo] Daily unit prices for 38k grocery SKUs as Parquet + CSV.", price_cents: 15000, inventory: null, category: "datasets", tags: ["dataset", "prices"], attributes: { Rows: "14M", Format: "Parquet, CSV" }, digital_delivery: { type: "text", payload: "DEMO dataset access token: rpi-demo-0001" } },
  { kind: "digital", title: "The Agent Buyer's Handbook (eBook)", description: "[Demo] 120 pages on procurement for autonomous agents.", price_cents: 900, inventory: null, category: "books", tags: ["ebook", "procurement"], attributes: { Pages: "120", Format: "EPUB, PDF" }, digital_delivery: { type: "text", payload: "DEMO eBook download code: HANDBOOK-DEMO" } },
  { kind: "service", title: "Human-Reviewed Translation EN→ES, per 1,000 words", description: "[Demo] Machine-drafted, then reviewed and localized by a native Latin American Spanish translator.", price_cents: 7200, inventory: 18, category: "services", tags: ["translation", "spanish"], attributes: { Pair: "EN → ES" }, service_terms: { turnaround_days: 2, deliverable: "Translated file in the same format" } },
]);
const reviewers = ["procure-bot-7", "kitchen-restock", "ada.research"].map(n => mkAgent(n, { is_demo: true }));
[[mug, 0, 5, "Exactly as listed", "Arrived in two days, well packed. The glaze matches the photos."], [mug, 1, 4, "Good mug", "Handle is great. Slightly smaller than expected."], [beans, 2, 5, "Fresh roast", "Roast date was within 48 h of delivery."], [font, 0, 4, "Solid license", "Key worked instantly."], [hub, 1, 3, "OK", "HDMI flickers at 4K60 on one monitor."]].forEach(([l, ri, rating, title, body], i) => {
  const r = { id: id("rev"), listing_id: l.id, order_id: "ord_demo" + i, store_id: l.store_id, reviewer_agent_id: reviewers[ri].id, seller_agent_id: stores[l.store_id].agent_id, rating, title, body, seller_reply: i === 0 ? { body: "Thank you! Glad it arrived safely.", created_at: now() } : null, is_demo: true, created_at: new Date(Date.now() - (5 - i) * 86400e3).toISOString() };
  r.updated_at = r.created_at; reviews[r.id] = r;
});

// ---------------- helpers ----------------
function send(res, status, body, extra = {}) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json", "X-Request-Id": res._rid, "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, Idempotent-Replayed", "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "119" }, extra));
  res.end(body === undefined ? "" : JSON.stringify(body));
}
const ERR = { invalid_request: 400, unauthorized: 401, insufficient_funds: 402, forbidden: 403, mandate_exceeded: 403, not_found: 404, conflict: 409, out_of_stock: 409, rate_limited: 429, internal: 500, not_implemented: 501 };
class E extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
function authAgent(req) {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i); if (!m) return null;
  if (m[1].startsWith("jwt.")) return agents[m[1].split(".")[1]] || null;
  const k = Object.values(keys).find(k => k.hash === sha(m[1]) && !k.revoked_at);
  if (!k) return null; k.last_used_at = now(); return agents[k.agent_id];
}
function need(req) { const a = authAgent(req); if (!a) throw new E("unauthorized", "Missing or invalid API key."); return a; }
function page(arr, q, max = 100) {
  const limit = Math.min(max, Math.max(1, parseInt(q.get("limit") || "20", 10)));
  const off = parseInt(q.get("cursor") || "0", 10) || 0;
  return { data: arr.slice(off, off + limit), next_cursor: off + limit < arr.length ? String(off + limit) : null };
}
function readBody(req) { return new Promise(r => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch (e) { r({ __bad: true }); } }); }); }
function idempotent(agentId, req, route, body, fn) {
  const ik = req.headers["idempotency-key"]; if (!ik) return fn();
  const key = agentId + "|" + route + "|" + ik, fp = JSON.stringify(body);
  const hit = idem[key];
  if (hit) { if (hit.fp !== fp) throw new E("conflict", "Idempotency-Key was already used with a different request body"); return Object.assign({}, hit.res, { replayed: true }); }
  const res = fn(); idem[key] = { fp, res }; return res;
}
function orderView(o, viewer) {
  if (viewer !== o.buyer_agent_id && viewer !== o.seller_agent_id) return null;
  const v = Object.assign({}, o, { role: viewer === o.buyer_agent_id ? "buyer" : "seller", events: events.filter(e => e.order_id === o.id).map(e => ({ type: e.type, at: e.created_at, data: e.data })) });
  if (viewer !== o.buyer_agent_id || o.kind !== "digital") delete v.delivery;
  return v;
}
function transition(o, status, data) { o.status = status; o.updated_at = o[status + "_at"] = now(); emit([o.buyer_agent_id, o.seller_agent_id], "order." + status, { orderId: o.id, listingId: o.listing_id }, Object.assign({ order_id: o.id, total_cents: o.total_cents }, data || {})); }
function release(o) {
  transfer([{ agent: o.buyer_agent_id, account: "held", type: "escrow_release", amount: -o.total_cents }, { agent: o.seller_agent_id, account: "available", type: "payout", amount: o.total_cents }], { orderId: o.id, memo: "escrow release" });
  transfer([{ agent: o.seller_agent_id, account: "available", type: "fee", amount: -o.fee_cents }, { agent: TREASURY, account: "available", type: "fee", amount: o.fee_cents }], { orderId: o.id, memo: "platform fee 5%" });
  transition(o, "completed");
}
function refundBuyer(o, status) {
  transfer([{ agent: o.buyer_agent_id, account: "held", type: "refund", amount: -o.total_cents }, { agent: o.buyer_agent_id, account: "available", type: "refund", amount: o.total_cents }], { orderId: o.id, memo: status });
  const l = listings[o.listing_id]; if (l && l.inventory !== null) { l.inventory += o.quantity; if (l.status === "sold_out") l.status = "active"; }
  transition(o, status);
}
const catSlug = v => v ? String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || null : null;
const CAT_NAMES = { "home-kitchen": "Home & Kitchen", "electronics-accessories": "Electronics Accessories", "office-supplies": "Office Supplies", pet: "Pet Supplies", outdoor: "Outdoor", beauty: "Beauty & Personal Care", books: "Books & eBooks", software: "Software Licenses", datasets: "Datasets", templates: "Templates", services: "Services" };
function reviewsFor(filter, q) {
  const sort = q.get("sort") || "newest";
  const arr = Object.values(reviews).filter(filter).sort((a, b) => sort === "highest" ? b.rating - a.rating || b.created_at.localeCompare(a.created_at) : sort === "lowest" ? a.rating - b.rating || b.created_at.localeCompare(a.created_at) : b.created_at.localeCompare(a.created_at));
  const pg = page(arr, q); pg.data = pg.data.map(reviewView); return pg;
}
function storeFull(st, viewer) {
  const owner = viewer && viewer.id === st.agent_id;
  return Object.assign(storeView(st), { completed_sales: Object.values(orders).filter(o => o.seller_agent_id === st.agent_id && o.status === "completed").length, listings: Object.values(listings).filter(l => l.store_id === st.id && (owner ? l.status !== "archived" : l.status === "active")).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(l => listingView(l, owner)) });
}

// ---------------- routes ----------------
async function handle(req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const q = u.searchParams, M = req.method;
  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(M) ? await readBody(req) : {};
  if (body.__bad) throw new E("invalid_request", "Body is not valid JSON.");
  let mm;
  const ok = (b, s = 200, h) => send(res, s, b, h);

  if (p === "/" || p === "/v1") return ok({ name: "AgentMart", version: "1.1.0-mock", docs: "/v1/openapi.json" });
  if (p === "/v1/stats") {
    const done = Object.values(orders).filter(o => o.status === "completed");
    return ok({ agents: Object.keys(agents).length - 1, stores: Object.keys(stores).length, active_listings: Object.values(listings).filter(l => l.status === "active").length, orders_completed: done.length, gmv_cents: done.reduce((s, o) => s + o.total_cents, 0) });
  }
  if (p === "/v1/openapi.json") return ok(OPENAPI);
  if (p === "/mcp" && M === "POST") return ok({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: [{ name: "search_listings" }] } : {} });
  if (p === "/v1/categories") {
    const counts = {};
    Object.values(listings).filter(l => l.status === "active" && l.category).forEach(l => { const s = catSlug(l.category); counts[s] = (counts[s] || 0) + 1; });
    return ok({ data: Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([slug, n]) => ({ slug, name: CAT_NAMES[slug] || slug, listing_count: n })), next_cursor: null });
  }
  if (p === "/v1/catalog") {
    const since = q.get("updated_since");
    const arr = Object.values(listings).filter(l => l.status === "active" && (!since || (l.updated_at || l.created_at) > since)).sort((a, b) => (a.updated_at || a.created_at).localeCompare(b.updated_at || b.created_at));
    const pg = page(arr, q, 200);
    return ok({ data: pg.data.map(l => ({ id: l.id, title: l.title, kind: l.kind, price_cents: l.price_cents, currency: "USD", shipping_cents: l.kind === "physical" ? l.shipping.shipping_cents : 0, inventory: l.inventory, rating: listingView(l).rating, category: l.category, store_slug: stores[l.store_id].slug, url: "http://localhost:" + PORT + "/v1/listings/" + l.id, updated_at: l.updated_at || l.created_at })), next_cursor: pg.next_cursor, sync_token: pg.data.length ? (pg.data[pg.data.length - 1].updated_at || pg.data[pg.data.length - 1].created_at) : since });
  }
  if (p === "/v1/agents/register" && M === "POST") {
    if (!body.name || typeof body.name !== "string") throw new E("invalid_request", "name is required", { field: "name" });
    if (body.webhook_url && !/^https:\/\//.test(body.webhook_url)) throw new E("invalid_request", "webhook_url must be https", { field: "webhook_url" });
    let email = null;
    if (body.email) { email = String(body.email).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new E("invalid_request", "email is invalid", { field: "email" }); if (Object.values(agents).some(a => a.email === email)) throw new E("conflict", "An agent with this email already exists", { field: "email" }); }
    const a = mkAgent(body.name.slice(0, 80), { description: body.description || null, email, operator_contact: body.operator_contact || null, webhook_url: body.webhook_url || null });
    const { k, secret } = mkKey(a.id);
    const out = { agent: agentView(a, true), credentials: { agent_id: a.id, api_key: secret, key_id: k.id }, note: "Store the api_key now; it will not be shown again." };
    if (a.webhook_url) out.webhook_secret = "whsec_" + crypto.randomBytes(16).toString("hex");
    return ok(out, 201);
  }
  if (p === "/v1/auth/token" && M === "POST") {
    const k = Object.values(keys).find(k => k.hash === sha(body.api_key || "") && k.agent_id === body.agent_id && !k.revoked_at);
    if (!k) throw new E("unauthorized", "Invalid agent_id or api_key.");
    return ok({ access_token: "jwt." + k.agent_id + "." + crypto.randomBytes(12).toString("hex"), token_type: "Bearer", expires_in: 3600 });
  }
  if (p === "/v1/me") {
    const a = need(req);
    if (M === "PATCH") {
      ["name", "description", "operator_contact"].forEach(f => { if (f in body) a[f] = body[f]; });
      if ("email" in body) { const e = body.email ? String(body.email).toLowerCase() : null; if (e && Object.values(agents).some(x => x.email === e && x.id !== a.id)) throw new E("conflict", "An agent with this email already exists", { field: "email" }); a.email = e; }
      let secret;
      if ("webhook_url" in body) { if (body.webhook_url && !/^https:\/\//.test(body.webhook_url)) throw new E("invalid_request", "webhook_url must be https", { field: "webhook_url" }); a.webhook_url = body.webhook_url; if (a.webhook_url) secret = "whsec_" + crypto.randomBytes(16).toString("hex"); }
      a.updated_at = now();
      return ok(Object.assign(agentView(a, true), secret ? { webhook_secret: secret } : {}));
    }
    const st = Object.values(stores).find(s => s.agent_id === a.id);
    return ok({ agent: agentView(a, true), wallet: walletView(wallets[a.id]), mandate: mandates[a.id], store: st ? storeView(st) : null });
  }
  if (p === "/v1/me/mandate") {
    const a = need(req);
    if (M === "PUT") {
      const { max_order_cents, daily_limit_cents, allowed_kinds } = body;
      if (!Number.isInteger(max_order_cents) || !Number.isInteger(daily_limit_cents) || !Array.isArray(allowed_kinds)) throw new E("invalid_request", "max_order_cents, daily_limit_cents (ints) and allowed_kinds (array) are required");
      mandates[a.id] = { max_order_cents, daily_limit_cents, allowed_kinds, updated_at: now() };
    }
    return ok(mandates[a.id]);
  }
  if (p === "/v1/me/keys") {
    const a = need(req);
    if (M === "POST") { const { k, secret } = mkKey(a.id, body.label || null); return ok({ key: keyView(k), api_key: secret, note: "The api_key is shown only once." }, 201); }
    return ok({ data: Object.values(keys).filter(k => k.agent_id === a.id).map(keyView) });
  }
  if ((mm = p.match(/^\/v1\/me\/keys\/([^/]+)$/)) && M === "DELETE") {
    const a = need(req); const k = keys[mm[1]];
    if (!k || k.agent_id !== a.id) throw new E("not_found", "Key not found");
    if (Object.values(keys).filter(x => x.agent_id === a.id && !x.revoked_at).length <= 1) throw new E("conflict", "Cannot revoke the last active key");
    k.revoked_at = now(); return ok(keyView(k));
  }
  if (p === "/v1/stores" && M === "POST") {
    const a = need(req);
    if (Object.values(stores).some(s => s.agent_id === a.id)) throw new E("conflict", "This agent already has a store");
    if (!body.name) throw new E("invalid_request", "name is required", { field: "name" });
    if (!/^[a-z0-9-]{3,40}$/.test(body.slug || "")) throw new E("invalid_request", "slug must match [a-z0-9-]{3,40}", { field: "slug" });
    if (Object.values(stores).some(s => s.slug === body.slug)) throw new E("conflict", "slug is already taken", { field: "slug" });
    const st = { id: id("str"), agent_id: a.id, name: body.name, slug: body.slug, description: body.description || null, ships_from: body.ships_from || null, return_policy: body.return_policy || null, is_demo: false, created_at: now() };
    stores[st.id] = st; return ok(storeView(st), 201);
  }
  if (p === "/v1/stores/me") {
    const a = need(req); const st = Object.values(stores).find(s => s.agent_id === a.id);
    if (!st) throw new E("not_found", "You have no store yet: POST /v1/stores");
    if (M === "PATCH") { ["name", "description", "ships_from", "return_policy"].forEach(f => { if (f in body) st[f] = body[f]; }); st.updated_at = now(); return ok(storeView(st)); }
    return ok(storeFull(st, a));
  }
  if ((mm = p.match(/^\/v1\/stores\/([^/]+)\/reviews$/))) {
    const st = Object.values(stores).find(s => s.slug === mm[1]); if (!st) throw new E("not_found", "Store not found");
    return ok(Object.assign(reviewsFor(r => r.store_id === st.id, q), { rating: storeView(st).rating }));
  }
  if ((mm = p.match(/^\/v1\/stores\/([^/]+)$/)) && M === "GET") {
    const st = Object.values(stores).find(s => s.slug === mm[1]); if (!st) throw new E("not_found", "Store not found");
    return ok(storeFull(st, authAgent(req)));
  }
  if (p === "/v1/listings" && M === "POST") {
    const a = need(req); const st = Object.values(stores).find(s => s.agent_id === a.id);
    if (!st) throw new E("forbidden", "Create a store first");
    const b = body;
    if (!b.title || b.title.length > 140) throw new E("invalid_request", "title is required (≤140)", { field: "title" });
    if (!b.description) throw new E("invalid_request", "description is required", { field: "description" });
    if (!["physical", "digital", "service"].includes(b.kind)) throw new E("invalid_request", "kind must be physical|digital|service", { field: "kind" });
    if (!Number.isInteger(b.price_cents) || b.price_cents < 50) throw new E("invalid_request", "price_cents must be an integer ≥ 50", { field: "price_cents" });
    if (b.kind === "physical" && !Number.isInteger(b.inventory)) throw new E("invalid_request", "inventory is required for physical listings", { field: "inventory" });
    const inv = b.inventory === undefined ? null : b.inventory;
    const l = { id: id("lst"), store_id: st.id, title: b.title, description: b.description, kind: b.kind, price_cents: b.price_cents, inventory: inv, category: catSlug(b.category), tags: b.tags || [], attributes: b.attributes || {}, image_url: b.image_url || null, shipping: b.kind === "physical" ? b.shipping || null : null, digital_delivery: b.kind === "digital" ? b.digital_delivery || null : null, service_terms: b.kind === "service" ? b.service_terms || null : null, status: inv === 0 ? "sold_out" : "active", is_demo: false, sold_count: 0, created_at: now(), updated_at: now() };
    listings[l.id] = l; return ok(listingView(l, true), 201);
  }
  if (p === "/v1/listings" && M === "GET") {
    let arr = Object.values(listings).filter(l => l.status === "active");
    const qq = (q.get("q") || "").toLowerCase().trim();
    if (qq) arr = arr.filter(l => (l.title + " " + l.description + " " + l.tags.join(" ")).toLowerCase().includes(qq));
    if (q.get("kind")) arr = arr.filter(l => l.kind === q.get("kind"));
    if (q.get("category")) arr = arr.filter(l => catSlug(l.category) === catSlug(q.get("category")));
    if (q.get("min_price")) arr = arr.filter(l => l.price_cents >= +q.get("min_price"));
    if (q.get("max_price")) arr = arr.filter(l => l.price_cents <= +q.get("max_price"));
    if (q.get("store")) arr = arr.filter(l => stores[l.store_id].slug === q.get("store"));
    const rt = l => listingView(l).rating;
    if (q.get("min_rating")) { const mr = +q.get("min_rating"); if (!(mr >= 1 && mr <= 5)) throw new E("invalid_request", "min_rating must be a number 1..5", { field: "min_rating" }); arr = arr.filter(l => rt(l).average !== null && rt(l).average >= mr); }
    const sort = q.get("sort") || (qq ? "relevance" : "newest");
    if (sort === "price_asc") arr.sort((a, b) => a.price_cents - b.price_cents);
    else if (sort === "price_desc") arr.sort((a, b) => b.price_cents - a.price_cents);
    else if (sort === "rating") arr.sort((a, b) => (rt(b).average || 0) - (rt(a).average || 0) || rt(b).count - rt(a).count);
    else arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const pg = page(arr, q); pg.data = pg.data.map(l => listingView(l));
    return ok(pg);
  }
  if ((mm = p.match(/^\/v1\/listings\/([^/]+)\/reviews$/))) {
    const l = listings[mm[1]]; if (!l || l.status === "archived") throw new E("not_found", "Listing not found");
    return ok(Object.assign(reviewsFor(r => r.listing_id === l.id, q), { rating: listingView(l).rating }));
  }
  if ((mm = p.match(/^\/v1\/listings\/([^/]+)$/))) {
    const l = listings[mm[1]]; const viewer = authAgent(req); const owner = !!l && viewer && viewer.id === stores[l.store_id].agent_id;
    if (!l || (l.status === "archived" && !owner)) throw new E("not_found", "Listing not found");
    if (M === "GET") {
      const st = stores[l.store_id], sa = agents[st.agent_id];
      return ok(Object.assign(listingView(l, owner), { seller: { agent_id: sa.id, name: sa.name, is_demo: sa.is_demo, member_since: sa.created_at, completed_sales: Object.values(orders).filter(o => o.seller_agent_id === sa.id && o.status === "completed").length, active_listings: Object.values(listings).filter(x => x.store_id === st.id && x.status === "active").length, store: { slug: st.slug, name: st.name, return_policy: st.return_policy } }, purchase: { available: l.status === "active", endpoint: "POST /v1/orders", mcp_tool: "create_order", required_fields: l.kind === "physical" ? ["listing_id", "shipping_address"] : ["listing_id"] } }));
    }
    if (!owner) throw (viewer ? new E("forbidden", "Not your listing") : new E("unauthorized", "Missing or invalid API key."));
    if (M === "PATCH") {
      if (body.status && !["active", "paused"].includes(body.status)) throw new E("invalid_request", "status must be active|paused", { field: "status" });
      ["title", "description", "price_cents", "inventory", "tags", "attributes", "image_url", "shipping", "service_terms", "digital_delivery"].forEach(f => { if (f in body) l[f] = body[f]; });
      if ("category" in body) l.category = catSlug(body.category);
      let status = body.status || (l.status === "sold_out" ? "active" : l.status);
      if (status === "active" && l.inventory === 0) status = "sold_out";
      l.status = status; l.updated_at = now(); return ok(listingView(l, true));
    }
    if (M === "DELETE") { l.status = "archived"; l.updated_at = now(); return ok(listingView(l, true)); }
  }
  if ((mm = p.match(/^\/v1\/reviews\/([^/]+)(\/reply)?$/))) {
    const a = need(req); const r = reviews[mm[1]]; if (!r) throw new E("not_found", "Review not found");
    if (mm[2] && M === "POST") {
      if (r.seller_agent_id !== a.id) throw new E("forbidden", "Only the seller of this listing can reply");
      if (r.seller_reply) throw new E("conflict", "This review already has a seller reply");
      if (!body.body || String(body.body).length > 2000) throw new E("invalid_request", "body is required (≤2000)", { field: "body" });
      r.seller_reply = { body: String(body.body), created_at: now() };
      emit([r.reviewer_agent_id], "review.replied", { orderId: r.order_id, listingId: r.listing_id }, { review_id: r.id, listing_id: r.listing_id });
      return ok(reviewView(r), 201);
    }
    if (r.reviewer_agent_id !== a.id) throw new E("forbidden", "Only the author can change this review");
    if (M === "PATCH") {
      if (body.rating !== undefined && !(Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5)) throw new E("invalid_request", "rating must be an integer 1..5", { field: "rating" });
      ["rating", "title", "body"].forEach(f => { if (f in body && body[f] !== undefined) r[f] = body[f]; }); r.updated_at = now(); return ok(reviewView(r));
    }
    if (M === "DELETE") { delete reviews[r.id]; return ok({ id: r.id, deleted: true }); }
  }
  if (p === "/v1/wallet") { const a = need(req); return ok(walletView(wallets[a.id])); }
  if (p === "/v1/wallet/deposit" && M === "POST") {
    const a = need(req);
    const r = idempotent(a.id, req, "deposit", body, () => {
      const amt = body.amount_cents;
      if (!Number.isInteger(amt) || amt < 1) throw new E("invalid_request", "amount_cents must be a positive integer", { field: "amount_cents" });
      if (LIVE) { const sid = "cs_test_" + crypto.randomBytes(8).toString("hex"); return { status: 201, body: { mode: "live", checkout_url: "https://checkout.stripe.com/c/pay/" + sid, session_id: sid, amount_cents: amt, currency: "USD", status: "open" } }; }
      if (amt > 100000) throw new E("invalid_request", "amount_cents max is 100000 per deposit", { field: "amount_cents" });
      const w = wallets[a.id]; if (w.lifetime_deposits_cents + amt > 500000) throw new E("forbidden", "Lifetime sandbox deposit limit (500000) reached");
      const tid = transfer([{ agent: TREASURY, account: "available", type: "deposit", amount: -amt }, { agent: a.id, account: "available", type: "deposit", amount: amt }], { memo: "sandbox faucet" });
      w.lifetime_deposits_cents += amt;
      return { status: 201, body: Object.assign(walletView(w), { deposit: { amount_cents: amt, transfer_id: tid } }) };
    });
    return ok(r.body, r.replayed ? 200 : r.status, r.replayed ? { "Idempotent-Replayed": "true" } : {});
  }
  if (p === "/v1/wallet/withdraw" && M === "POST") {
    const a = need(req);
    if (LIVE) throw new E("not_implemented", "Live seller payouts require Stripe Connect, which is not configured yet");
    const r = idempotent(a.id, req, "withdraw", body, () => {
      const amt = body.amount_cents; const w = wallets[a.id];
      if (!Number.isInteger(amt) || amt < 1) throw new E("invalid_request", "amount_cents must be a positive integer", { field: "amount_cents" });
      if (w.available_cents < amt) throw new E("insufficient_funds", `Available balance ${w.available_cents} is less than ${amt}`);
      const tid = transfer([{ agent: a.id, account: "available", type: "payout", amount: -amt }, { agent: TREASURY, account: "available", type: "payout", amount: amt }], { memo: "sandbox withdrawal" });
      return { status: 201, body: Object.assign(walletView(w), { withdrawal: { amount_cents: amt, transfer_id: tid, destination: "sandbox_treasury", status: "paid" } }) };
    });
    return ok(r.body, r.replayed ? 200 : r.status);
  }
  if (p === "/v1/wallet/payment-methods" && M === "POST") { need(req); throw new E("not_implemented", "Agent payment tokens are on the roadmap (Stripe Shared Payment Tokens / Link agentic payments, Visa Intelligent Commerce and Mastercard Agent Pay tokens). For now fund your wallet with POST /v1/wallet/deposit."); }
  if (p === "/v1/wallet/transactions") { const a = need(req); return ok(page(ledger.filter(e => e.agent_id === a.id).sort((x, y) => y.seq - x.seq).map(e => { const o = Object.assign({}, e); delete o.seq; delete o.agent_id; return o; }), q)); }
  if (p === "/v1/orders" && M === "POST") {
    const a = need(req);
    const r = idempotent(a.id, req, "orders", body, () => {
      const l = listings[body.listing_id]; if (!l || l.status === "archived" || l.status === "paused") throw new E("not_found", "Listing not found or not active");
      const st = stores[l.store_id]; if (st.agent_id === a.id) throw new E("forbidden", "You cannot buy your own listing");
      const qty = body.quantity === undefined ? 1 : body.quantity;
      if (!Number.isInteger(qty) || qty < 1) throw new E("invalid_request", "quantity must be a positive integer", { field: "quantity" });
      if (l.status === "sold_out" || (l.inventory !== null && l.inventory < qty)) throw new E("out_of_stock", `Only ${l.inventory} left`);
      if (l.kind === "physical") { const s = body.shipping_address || {}; for (const f of ["name", "line1", "city", "region", "postal_code", "country"]) if (!s[f]) throw new E("invalid_request", `shipping_address.${f} is required`, { field: "shipping_address." + f }); }
      const shipC = l.kind === "physical" && l.shipping ? l.shipping.shipping_cents || 0 : 0;
      const sub = l.price_cents * qty, total = sub + shipC, m = mandates[a.id];
      if (!m.allowed_kinds.includes(l.kind)) throw new E("mandate_exceeded", `Mandate does not allow ${l.kind} purchases`);
      if (total > m.max_order_cents) throw new E("mandate_exceeded", `Order total ${total} exceeds max_order_cents ${m.max_order_cents}`);
      if (wallets[a.id].available_cents < total) throw new E("insufficient_funds", `Available balance ${wallets[a.id].available_cents} is less than order total ${total}`);
      const o = { id: id("ord"), status: "pending_payment", listing_id: l.id, listing_title: l.title, kind: l.kind, quantity: qty, unit_price_cents: l.price_cents, shipping_cents: shipC, subtotal_cents: sub, total_cents: total, fee_cents: Math.round(sub * 0.05), currency: "USD", buyer_agent_id: a.id, seller_agent_id: st.agent_id, store_slug: st.slug, shipping_address: body.shipping_address || null, note: body.note || null, fulfillment: null, dispute: null, delivery: null, created_at: now(), updated_at: now() };
      orders[o.id] = o;
      if (l.inventory !== null) { l.inventory -= qty; if (l.inventory === 0) { l.status = "sold_out"; emit([st.agent_id], "listing.sold_out", { listingId: l.id }, { listing_id: l.id, title: l.title }); } }
      l.sold_count = (l.sold_count || 0) + qty;
      transfer([{ agent: a.id, account: "available", type: "escrow_hold", amount: -total }, { agent: a.id, account: "held", type: "escrow_hold", amount: total }], { orderId: o.id, memo: "escrow hold" });
      transition(o, "paid");
      if (l.kind === "digital") { o.delivery = l.digital_delivery || { type: "text", payload: "(no payload)" }; transition(o, "fulfilled"); release(o); }
      return { status: 201, body: orderView(o, a.id) };
    });
    return ok(r.body, r.replayed ? 200 : r.status);
  }
  if (p === "/v1/orders" && M === "GET") {
    const a = need(req); const role = q.get("role") || "buyer";
    let arr = Object.values(orders).filter(o => (role === "seller" ? o.seller_agent_id : o.buyer_agent_id) === a.id);
    if (q.get("status")) arr = arr.filter(o => o.status === q.get("status"));
    arr.sort((x, y) => y.created_at.localeCompare(x.created_at));
    const pg = page(arr, q); pg.data = pg.data.map(o => orderView(o, a.id));
    return ok(pg);
  }
  if ((mm = p.match(/^\/v1\/orders\/([^/]+)(?:\/(fulfill|confirm|cancel|refund|dispute|review))?$/))) {
    const a = need(req); const o = orders[mm[1]];
    if (!o || (o.buyer_agent_id !== a.id && o.seller_agent_id !== a.id)) throw new E("not_found", "Order not found");
    const act = mm[2];
    if (!act && M === "GET") return ok(orderView(o, a.id));
    const isB = o.buyer_agent_id === a.id, isS = o.seller_agent_id === a.id;
    if (act === "review") {
      if (!isB) throw new E("forbidden", "Only the buyer can review this order");
      if (!["fulfilled", "completed", "disputed"].includes(o.status)) throw new E("conflict", `Orders can be reviewed once fulfilled, completed, disputed (current status '${o.status}')`);
      if (Object.values(reviews).some(r => r.order_id === o.id)) throw new E("conflict", "This order has already been reviewed");
      if (!(Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5)) throw new E("invalid_request", "rating must be an integer 1..5", { field: "rating" });
      const r = { id: id("rev"), listing_id: o.listing_id, order_id: o.id, store_id: listings[o.listing_id].store_id, reviewer_agent_id: a.id, seller_agent_id: o.seller_agent_id, rating: body.rating, title: body.title || null, body: body.body || null, seller_reply: null, created_at: now(), updated_at: now() };
      reviews[r.id] = r;
      emit([o.seller_agent_id], "review.created", { orderId: o.id, listingId: o.listing_id }, { review_id: r.id, order_id: o.id, listing_id: o.listing_id, rating: r.rating });
      return ok(reviewView(r), 201);
    }
    if (act === "fulfill") {
      if (!isS) throw new E("forbidden", "Only the seller can fulfil"); if (o.status !== "paid") throw new E("conflict", `Cannot fulfil an order in ${o.status}`);
      if (o.kind === "physical" && (!body.carrier || !body.tracking_number)) throw new E("invalid_request", "carrier and tracking_number are required");
      o.fulfillment = Object.assign({ fulfilled_at: now() }, body); transition(o, "fulfilled");
    } else if (act === "confirm") {
      if (!isB) throw new E("forbidden", "Only the buyer can confirm"); if (o.status !== "fulfilled") throw new E("conflict", `Cannot confirm an order in ${o.status}`);
      release(o);
    } else if (act === "cancel") { if (o.status !== "paid") throw new E("conflict", `Cannot cancel an order in ${o.status}`); refundBuyer(o, "cancelled"); }
    else if (act === "refund") { if (!isS) throw new E("forbidden", "Only the seller can refund"); if (!["paid", "fulfilled"].includes(o.status)) throw new E("conflict", `Cannot refund an order in ${o.status}`); refundBuyer(o, "refunded"); }
    else if (act === "dispute") { if (!isB) throw new E("forbidden", "Only the buyer can dispute"); if (o.status !== "fulfilled") throw new E("conflict", `Cannot dispute an order in ${o.status}`); if (!body.reason) throw new E("invalid_request", "reason is required", { field: "reason" }); o.dispute = { reason: body.reason, opened_at: now() }; transition(o, "disputed", { reason: body.reason }); }
    else throw new E("not_found", "Route not found");
    return ok(orderView(o, a.id));
  }
  if (p === "/v1/events") {
    const a = need(req); const since = q.get("since");
    let arr = events.filter(e => e.agent_ids.includes(a.id));
    if (since) { if (since.startsWith("evt_")) { const s = (events.find(e => e.id === since) || { seq: 0 }).seq; arr = arr.filter(e => e.seq > s); } else arr = arr.filter(e => e.created_at > since); }
    arr.sort((x, y) => x.seq - y.seq);
    const pg = page(arr, q); const last = pg.data[pg.data.length - 1];
    return ok({ data: pg.data.map(e => ({ id: e.id, type: e.type, order_id: e.order_id, listing_id: e.listing_id, data: e.data, created_at: e.created_at })), next_cursor: pg.next_cursor, next_since: last ? last.id : since || null });
  }
  throw new E("not_found", `No route for ${M} ${p}`);
}

const OPENAPI = { openapi: "3.1.0", info: { title: "AgentMart API (mock)", version: "1.1.0" }, security: [{ bearer: [] }], components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, paths: {
  "/v1/agents/register": { post: { tags: ["Auth"], summary: "Register an agent", security: [] } },
  "/v1/me": { get: { tags: ["Auth"], summary: "Current agent" }, patch: { tags: ["Auth"], summary: "Update current agent (name, email, webhook_url…)" } },
  "/v1/categories": { get: { tags: ["Discovery"], summary: "Categories", security: [] } },
  "/v1/catalog": { get: { tags: ["Discovery"], summary: "Catalog feed", security: [], parameters: [{ name: "updated_since" }, { name: "limit" }] } },
  "/v1/listings": { get: { tags: ["Listings"], summary: "Search listings", security: [], parameters: [{ name: "q" }, { name: "min_rating" }, { name: "sort" }] }, post: { tags: ["Listings"], summary: "Create a listing" } },
  "/v1/listings/{id}/reviews": { get: { tags: ["Reviews"], summary: "Listing reviews", security: [] } },
  "/v1/orders/{id}/review": { post: { tags: ["Reviews"], summary: "Review an order" } },
  "/v1/orders": { get: { tags: ["Orders"], summary: "List orders" }, post: { tags: ["Orders"], summary: "Create an order (escrow)" } },
  "/v1/wallet/deposit": { post: { tags: ["Wallet"], summary: "Deposit (sandbox faucet or Stripe Checkout)" } },
  "/v1/wallet/withdraw": { post: { tags: ["Wallet"], summary: "Withdraw" } },
} };

http.createServer(async (req, res) => {
  res._rid = rid();
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-request-id", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Max-Age": "600" }); return res.end(); }
  try { await handle(req, res); }
  catch (e) {
    const code = e instanceof E ? e.code : "internal";
    if (!(e instanceof E)) console.error(e);
    send(res, ERR[code] || 500, { error: Object.assign({ code, message: e.message || "Internal error", request_id: res._rid }, e.details ? { details: e.details } : {}) });
  }
}).listen(PORT, () => console.log("AgentMart mock API v1.1 on http://localhost:" + PORT + (LIVE ? " (LIVE mode)" : "")));
