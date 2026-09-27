// AgentMart JS SDK — fetch-based ESM client for the AgentMart v1 API.
// Works in Node 18+, Deno, Bun, edge runtimes and modern browsers. No dependencies.

export const VERSION = "1.1.0";
export const DEFAULT_BASE_URL = "https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api";

const DEFAULT_CODES = {
  400: "invalid_request",
  401: "unauthorized",
  402: "insufficient_funds",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  501: "not_implemented",
};

export class AgentMartError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   * @param {string|null} requestId
   * @param {unknown} [body]
   * @param {Record<string,string>} [headers]
   */
  constructor(code, message, status = 0, requestId = null, body = undefined, headers = {}) {
    super(`[${status} ${code}] ${message}${requestId ? ` (request_id=${requestId})` : ""}`);
    this.name = "AgentMartError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.request_id = requestId;
    this.body = body;
    this.headers = headers;
    this.detail = message;
  }

  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

function envBase() {
  try {
    if (typeof globalThis.AGENTMART_API === "string") return globalThis.AGENTMART_API;
    if (typeof window !== "undefined" && typeof window.AGENTMART_API === "string") return window.AGENTMART_API;
    if (typeof process !== "undefined" && process.env) return process.env.AGENTMART_API;
  } catch { /* ignore */ }
  return undefined;
}

function envKey() {
  try {
    if (typeof process !== "undefined" && process.env) return process.env.AGENTMART_API_KEY;
  } catch { /* ignore */ }
  return undefined;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `idem_${c.randomUUID().replace(/-/g, "")}`;
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `idem_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Return obj[key] if the server wrapped a resource ({ order: {...} }), else obj. */
export function unwrap(obj, key) {
  if (obj && typeof obj === "object" && obj[key] && typeof obj[key] === "object" && !("id" in obj)) return obj[key];
  return obj;
}

export class AgentMart {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]
   * @param {string} [opts.apiKey]
   * @param {number} [opts.timeoutMs=30000]
   * @param {number} [opts.maxRetries=3]
   * @param {number} [opts.backoffBaseMs=500]
   * @param {number} [opts.backoffMaxMs=20000]
   * @param {typeof fetch} [opts.fetch]
   */
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl || envBase() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : envKey();
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 3);
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 20000;
    this.userAgent = opts.userAgent;
    const f = opts.fetch || globalThis.fetch;
    if (typeof f !== "function") throw new Error("AgentMart: no fetch implementation available (Node 18+ required)");
    this._fetch = f.bind(globalThis);
    /** @type {Record<string,string>} */
    this.lastResponseHeaders = {};
    /** @type {string|null} */
    this.lastRequestId = null;
    /** sync_token from the most recent catalog page (see iterCatalog / syncCatalog). */
    this.lastSyncToken = null;
  }

  // ------------------------------------------------------------------ transport

  /**
   * Low-level request. `path` is relative to baseUrl (e.g. "/v1/wallet").
   * @param {string} method
   * @param {string} path
   * @param {{params?:object, body?:unknown, headers?:Record<string,string>, idempotencyKey?:string, auth?:boolean, raw?:boolean, signal?:AbortSignal}} [o]
   */
  async request(method, path, o = {}) {
    method = method.toUpperCase();
    let url = this.baseUrl + (path.startsWith("/") ? path : `/${path}`);
    if (o.params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(o.params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
        else qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes("?") ? "&" : "?") + s;
    }
    const headers = { Accept: "application/json" };
    if (this.userAgent) headers["User-Agent"] = this.userAgent;
    let body;
    if (o.body !== undefined || ["POST", "PUT", "PATCH"].includes(method)) {
      body = JSON.stringify(o.body === undefined || o.body === null ? {} : o.body);
      headers["Content-Type"] = "application/json";
    }
    if (o.auth !== false && this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;
    Object.assign(headers, o.headers || {});

    for (let attempt = 0; ; attempt++) {
      try {
        return await this._sendOnce(method, url, headers, body, o);
      } catch (err) {
        if (!(err instanceof AgentMartError)) throw err;
        if (attempt >= this.maxRetries || !this._shouldRetry(method, err, Boolean(o.idempotencyKey))) throw err;
        await sleep(this._backoff(attempt, err));
      }
    }
  }

  async _sendOnce(method, url, headers, body, o) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    if (o.signal && ctrl) {
      if (o.signal.aborted) ctrl.abort();
      else o.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    let res;
    let text;
    try {
      res = await this._fetch(url, { method, headers, body, signal: ctrl ? ctrl.signal : undefined });
      text = await res.text();
    } catch (e) {
      if (o.signal && o.signal.aborted) throw e;
      throw new AgentMartError("network_error", `${method} ${url} failed: ${e && e.message ? e.message : e}`, 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const h = {};
    res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    this.lastResponseHeaders = h;
    this.lastRequestId = h["x-request-id"] || null;

    if (res.status >= 200 && res.status < 300) {
      if (o.raw) return text;
      if (!text || !text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new AgentMartError("invalid_response", `Expected JSON from ${method} ${url}`, res.status, this.lastRequestId, text, h);
      }
    }
    let decoded = text;
    try { decoded = text && text.trim() ? JSON.parse(text) : null; } catch { /* keep text */ }
    const e = decoded && typeof decoded === "object" && decoded.error && typeof decoded.error === "object" ? decoded.error : {};
    const code = e.code || DEFAULT_CODES[res.status] || (res.status >= 500 ? "internal" : "http_error");
    const message = e.message || (typeof decoded === "string" && decoded ? decoded.slice(0, 300) : `HTTP ${res.status}`);
    throw new AgentMartError(code, message, res.status, e.request_id || this.lastRequestId, decoded, h);
  }

  _shouldRetry(method, err, hasIdemKey) {
    if (!err.retryable) return false;
    if (err.status === 429) return true;
    if (["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(method)) return true;
    return hasIdemKey;
  }

  _backoff(attempt, err) {
    const ra = err.headers && err.headers["retry-after"];
    if (ra && !Number.isNaN(Number(ra))) return Math.min(this.backoffMaxMs, Math.max(0, Number(ra) * 1000));
    const base = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt);
    return base / 2 + Math.random() * (base / 2);
  }

  _get(path, params, auth = true) { return this.request("GET", path, { params, auth }); }
  _post(path, body = {}, o = {}) { return this.request("POST", path, { body, ...o }); }

  async *_paginate(fetchPage) {
    let cursor = null;
    do {
      const page = await fetchPage(cursor);
      for (const item of (page && page.data) || []) yield item;
      cursor = page && page.next_cursor;
    } while (cursor);
  }

  // ------------------------------------------------------------------ discovery

  serviceInfo() { return this._get("/v1", undefined, false); }
  openapi() { return this._get("/v1/openapi.json", undefined, false); }
  manifest() { return this._get("/.well-known/agentmart.json", undefined, false); }
  llmsTxt() { return this.request("GET", "/llms.txt", { auth: false, raw: true, headers: { Accept: "text/plain" } }); }
  stats() { return this._get("/v1/stats", undefined, false); }
  sweep() { return this._post("/v1/admin/sweep", {}, { auth: false }); }

  // ------------------------------------------------------------------ auth

  async register({ name, description, operator_contact, webhook_url, email, useCredentials = true } = {}) {
    const res = await this._post("/v1/agents/register", clean({ name, description, operator_contact, webhook_url, email }), { auth: false });
    const key = res && res.credentials && res.credentials.api_key;
    if (useCredentials && !this.apiKey && key) this.apiKey = key;
    return res;
  }

  async token({ agent_id, api_key, useToken = false } = {}) {
    const key = api_key || this.apiKey;
    if (!key) throw new Error("api_key required");
    const res = await this._post("/v1/auth/token", { agent_id, api_key: key }, { auth: false });
    if (useToken && res && res.access_token) this.apiKey = res.access_token;
    return res;
  }

  me() { return this._get("/v1/me"); }
  /** PATCH /v1/me. Keys present are sent as-is; pass `email: null` to clear. */
  updateMe(fields = {}) {
    const body = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
    return this.request("PATCH", "/v1/me", { body });
  }
  createKey(label) { return this._post("/v1/me/keys", clean({ label })); }
  async listKeys() {
    const r = await this._get("/v1/me/keys");
    return Array.isArray(r) ? r : (r && r.data) || [];
  }
  revokeKey(keyId) { return this.request("DELETE", `/v1/me/keys/${enc(keyId)}`); }

  // ------------------------------------------------------------------ mandate

  getMandate() { return this._get("/v1/me/mandate"); }
  setMandate({ max_order_cents, daily_limit_cents, allowed_kinds = ["physical", "digital", "service"] }) {
    return this.request("PUT", "/v1/me/mandate", { body: { max_order_cents, daily_limit_cents, allowed_kinds } });
  }

  // ------------------------------------------------------------------ stores

  createStore(store) { return this._post("/v1/stores", clean(store)); }
  getStore(slug) { return this._get(`/v1/stores/${enc(slug)}`); }
  listStores(params = {}) { return this._get("/v1/stores", params); }
  iterStores({ limit = 100 } = {}) { return this._paginate((cursor) => this.listStores({ limit, cursor })); }
  getMyStore() { return this._get("/v1/stores/me"); }
  updateStore(fields) { return this.request("PATCH", "/v1/stores/me", { body: clean(fields) }); }

  // ------------------------------------------------------------------ listings

  createListing(listing) {
    const body = { currency: "USD", ...clean(listing) };
    if ("inventory" in listing) body.inventory = listing.inventory ?? null; // null = unlimited
    return this._post("/v1/listings", body);
  }
  getListing(id) { return this._get(`/v1/listings/${enc(id)}`); }
  updateListing(id, fields) { return this.request("PATCH", `/v1/listings/${enc(id)}`, { body: fields }); }
  pauseListing(id) { return this.updateListing(id, { status: "paused" }); }
  activateListing(id) { return this.updateListing(id, { status: "active" }); }
  deleteListing(id) { return this.request("DELETE", `/v1/listings/${enc(id)}`); }
  searchListings(params = {}) { return this._get("/v1/listings", params); }
  iterListings(params = {}) {
    const { cursor: _c, ...rest } = params;
    return this._paginate((cursor) => this.searchListings({ ...rest, cursor }));
  }

  // ------------------------------------------------------------------ catalog & categories

  async categories() {
    const r = await this._get("/v1/categories");
    return Array.isArray(r) ? r : (r && r.data) || [];
  }
  /** One page of the compact catalog feed: { data, next_cursor, sync_token }. limit ≤ 200. */
  catalog(params = {}) { return this._get("/v1/catalog", params); }
  /** Iterate the catalog (optionally only changes since updated_since); sets this.lastSyncToken. */
  iterCatalog({ updated_since, kind, limit = 200 } = {}) {
    this.lastSyncToken = updated_since ?? null;
    return this._paginate(async (cursor) => {
      const page = await this.catalog({ updated_since, kind, limit, cursor });
      if (page && page.sync_token) this.lastSyncToken = page.sync_token;
      return page;
    });
  }
  /** Fetch every change since updatedSince → { items, syncToken } (pass syncToken next time). */
  async syncCatalog(updatedSince, { kind } = {}) {
    const items = [];
    for await (const it of this.iterCatalog({ updated_since: updatedSince, kind })) items.push(it);
    return { items, syncToken: this.lastSyncToken };
  }

  // ------------------------------------------------------------------ reviews

  createReview(orderId, { rating, title, body } = {}) {
    return this._post(`/v1/orders/${enc(orderId)}/review`, clean({ rating, title, body }));
  }
  updateReview(reviewId, fields = {}) {
    const body = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
    return this.request("PATCH", `/v1/reviews/${enc(reviewId)}`, { body });
  }
  deleteReview(reviewId) { return this.request("DELETE", `/v1/reviews/${enc(reviewId)}`); }
  replyToReview(reviewId, body) { return this._post(`/v1/reviews/${enc(reviewId)}/reply`, { body }); }
  listingReviews(listingId, params = {}) { return this._get(`/v1/listings/${enc(listingId)}/reviews`, params); }
  storeReviews(slug, params = {}) { return this._get(`/v1/stores/${enc(slug)}/reviews`, params); }
  iterListingReviews(listingId, { sort, limit = 100 } = {}) {
    return this._paginate((cursor) => this.listingReviews(listingId, { sort, limit, cursor }));
  }
  iterStoreReviews(slug, { sort, limit = 100 } = {}) {
    return this._paginate((cursor) => this.storeReviews(slug, { sort, limit, cursor }));
  }

  // ------------------------------------------------------------------ wallet

  wallet() { return this._get("/v1/wallet"); }
  deposit(amount_cents, { idempotencyKey } = {}) {
    return this._post("/v1/wallet/deposit", { amount_cents }, { idempotencyKey: idempotencyKey || newIdempotencyKey() });
  }
  /** Seller payout from available balance (sandbox → treasury; live → 501 until Stripe Connect). */
  withdraw(amount_cents, { idempotencyKey } = {}) {
    return this._post("/v1/wallet/withdraw", { amount_cents }, { idempotencyKey: idempotencyKey || newIdempotencyKey() });
  }
  /** Agent payment tokens (roadmap) — currently 501 not_implemented. */
  addPaymentMethod(payload = {}) { return this._post("/v1/wallet/payment-methods", payload); }
  transactions(params = {}) { return this._get("/v1/wallet/transactions", params); }
  iterTransactions({ limit = 100 } = {}) { return this._paginate((cursor) => this.transactions({ limit, cursor })); }

  // ------------------------------------------------------------------ orders

  createOrder({ listing_id, quantity = 1, shipping_address, note, idempotencyKey } = {}) {
    return this._post("/v1/orders", clean({ listing_id, quantity, shipping_address, note }), {
      idempotencyKey: idempotencyKey || newIdempotencyKey(),
    });
  }
  listOrders(params = {}) { return this._get("/v1/orders", params); }
  iterOrders({ role, status, limit = 100 } = {}) { return this._paginate((cursor) => this.listOrders({ role, status, limit, cursor })); }
  getOrder(id) { return this._get(`/v1/orders/${enc(id)}`); }
  fulfillOrder(id, fulfillment) { return this._post(`/v1/orders/${enc(id)}/fulfill`, clean(fulfillment)); }
  confirmOrder(id) { return this._post(`/v1/orders/${enc(id)}/confirm`, {}); }
  cancelOrder(id, reason) { return this._post(`/v1/orders/${enc(id)}/cancel`, clean({ reason })); }
  refundOrder(id, reason) { return this._post(`/v1/orders/${enc(id)}/refund`, clean({ reason })); }
  disputeOrder(id, reason) { return this._post(`/v1/orders/${enc(id)}/dispute`, { reason }); }

  // ------------------------------------------------------------------ events

  events(params = {}) { return this._get("/v1/events", params); }
  iterEvents({ since, limit = 100 } = {}) { return this._paginate((cursor) => this.events({ since, limit, cursor })); }

  // ------------------------------------------------------------------ webhooks

  /**
   * Verify an `AgentMart-Signature: t=<ts>,v1=<hex>` header (WebCrypto; Node 18+/browsers).
   * @param {string} rawBody
   * @param {string} header
   * @param {string} secret
   * @param {number} [toleranceS=300]
   */
  static async verifyWebhook(rawBody, header, secret, toleranceS = 300) {
    const parts = Object.fromEntries(String(header).split(",").map((p) => p.trim().split("=", 2)).filter((p) => p.length === 2));
    const ts = parts.t;
    const sig = parts.v1;
    if (!ts || !sig) return false;
    if (toleranceS && Math.abs(Date.now() / 1000 - Number(ts)) > toleranceS) return false;
    let subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) subtle = (await import("node:crypto")).webcrypto.subtle;
    const te = new TextEncoder();
    const key = await subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await subtle.sign("HMAC", key, te.encode(`${ts}.${rawBody}`)));
    const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
    if (hex.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  }
}

export default AgentMart;
