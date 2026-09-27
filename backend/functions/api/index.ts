// AgentMart API — Supabase Edge Function `api`.
// Entry point: CORS, request ids, path normalisation, auth, rate limiting, routing, error format.
import { authenticate, hitRateLimit, type RateInfo } from "./db.ts";
import { descriptor, llmsTxt, manifest, openapi } from "./docs.ts";
import { ApiError, randomHex } from "./lib.ts";
import * as m from "./market.ts";
import { handleMcp } from "./mcp.ts";
import * as pay from "./payments.ts";
import * as rv from "./reviews.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-request-id",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Expose-Headers": "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, Idempotent-Replayed",
  "Access-Control-Max-Age": "86400",
};

const AGENT_LIMIT = 120;
const IP_LIMIT = 60;
const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------

interface Req {
  ctx: m.Ctx;
  params: string[];
  query: URLSearchParams;
  body: unknown;
  rawBody: string;
  headers: Headers;
}
type Handler = (r: Req) => Promise<m.Result>;
type Route = [method: string, pattern: RegExp, handler: Handler];

const ID = "([A-Za-z0-9_-]{1,64})";
const idem = (r: Req) => r.headers.get("idempotency-key")?.trim() || null;

const ROUTES: Route[] = [
  ["GET", /^\/v1\/stats$/, () => m.stats()],
  ["GET", /^\/v1\/categories$/, () => m.listCategories()],
  ["GET", /^\/v1\/catalog$/, (r) => m.catalog(r.ctx, r.query)],
  ["POST", /^\/v1\/agents\/register$/, (r) => m.registerAgent(r.ctx, r.body)],
  ["POST", /^\/v1\/auth\/token$/, (r) => m.issueToken(r.body)],
  ["GET", /^\/v1\/me$/, (r) => m.getMe(r.ctx)],
  ["PATCH", /^\/v1\/me$/, (r) => m.patchMe(r.ctx, r.body)],
  ["GET", /^\/v1\/me\/keys$/, (r) => m.listKeys(r.ctx)],
  ["POST", /^\/v1\/me\/keys$/, (r) => m.createKey(r.ctx, r.body)],
  ["DELETE", new RegExp(`^/v1/me/keys/${ID}$`), (r) => m.revokeKey(r.ctx, r.params[0])],
  ["GET", /^\/v1\/me\/mandate$/, (r) => m.getMandate(r.ctx)],
  ["PUT", /^\/v1\/me\/mandate$/, (r) => m.putMandate(r.ctx, r.body)],
  ["GET", /^\/v1\/stores$/, (r) => m.listStores(r.query)],
  ["POST", /^\/v1\/stores$/, (r) => m.createStore(r.ctx, r.body)],
  ["GET", /^\/v1\/stores\/me$/, (r) => m.getMyStore(r.ctx)],
  ["PATCH", /^\/v1\/stores\/me$/, (r) => m.patchMyStore(r.ctx, r.body)],
  ["GET", new RegExp(`^/v1/stores/${ID}$`), (r) => m.getStore(r.ctx, r.params[0])],
  ["GET", new RegExp(`^/v1/stores/${ID}/reviews$`), (r) => rv.storeReviews(r.params[0], r.query)],
  ["GET", /^\/v1\/listings$/, (r) => m.searchListings(r.query)],
  ["POST", /^\/v1\/listings$/, (r) => m.createListing(r.ctx, r.body)],
  ["GET", new RegExp(`^/v1/listings/${ID}$`), (r) => m.getListing(r.ctx, r.params[0])],
  ["PATCH", new RegExp(`^/v1/listings/${ID}$`), (r) => m.patchListing(r.ctx, r.params[0], r.body)],
  ["DELETE", new RegExp(`^/v1/listings/${ID}$`), (r) => m.archiveListing(r.ctx, r.params[0])],
  ["GET", new RegExp(`^/v1/listings/${ID}/reviews$`), (r) => rv.listingReviews(r.params[0], r.query)],
  ["PATCH", new RegExp(`^/v1/reviews/${ID}$`), (r) => rv.updateReview(r.ctx, r.params[0], r.body)],
  ["DELETE", new RegExp(`^/v1/reviews/${ID}$`), (r) => rv.deleteReview(r.ctx, r.params[0])],
  ["POST", new RegExp(`^/v1/reviews/${ID}/reply$`), (r) => rv.replyToReview(r.ctx, r.params[0], r.body)],
  ["GET", /^\/v1\/wallet$/, (r) => m.getWallet(r.ctx)],
  ["POST", /^\/v1\/wallet\/deposit$/, (r) => pay.deposit(r.ctx, r.body, idem(r))],
  ["POST", /^\/v1\/wallet\/withdraw$/, (r) => pay.withdraw(r.ctx, r.body, idem(r))],
  ["POST", /^\/v1\/wallet\/payment-methods$/, (r) => pay.paymentMethods(r.ctx)],
  ["GET", /^\/v1\/payments\/stripe\/return$/, (r) => Promise.resolve(pay.stripeReturn(r.query))],
  ["GET", /^\/v1\/wallet\/transactions$/, (r) => m.listTransactions(r.ctx, r.query)],
  ["POST", /^\/v1\/orders$/, (r) => m.createOrder(r.ctx, r.body, idem(r))],
  ["GET", /^\/v1\/orders$/, (r) => m.listOrders(r.ctx, r.query)],
  ["GET", new RegExp(`^/v1/orders/${ID}$`), (r) => m.getOrder(r.ctx, r.params[0])],
  ["POST", new RegExp(`^/v1/orders/${ID}/fulfill$`), (r) => m.fulfillOrder(r.ctx, r.params[0], r.body)],
  ["POST", new RegExp(`^/v1/orders/${ID}/confirm$`), (r) => m.confirmOrder(r.ctx, r.params[0])],
  ["POST", new RegExp(`^/v1/orders/${ID}/cancel$`), (r) => m.cancelOrder(r.ctx, r.params[0], r.body)],
  ["POST", new RegExp(`^/v1/orders/${ID}/refund$`), (r) => m.refundOrder(r.ctx, r.params[0], r.body)],
  ["POST", new RegExp(`^/v1/orders/${ID}/dispute$`), (r) => m.disputeOrder(r.ctx, r.params[0], r.body)],
  ["POST", new RegExp(`^/v1/orders/${ID}/review$`), (r) => rv.createReview(r.ctx, r.params[0], r.body)],
  ["GET", /^\/v1\/events$/, (r) => m.listEvents(r.ctx, r.query)],
  ["POST", /^\/v1\/admin\/sweep$/, async (r) => ({ status: 200, body: { released: await m.sweep(r.ctx, { limit: 100 }) } })],
  ["POST", /^\/mcp$/, (r) => handleMcp(r.ctx, r.rawBody)],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strips everything up to and including the `/api` segment (prod: /functions/v1/api/...). */
export function normalisePath(pathname: string): { path: string; prefix: string } {
  const mt = /^(.*?\/api)(?=\/|$)/.exec(pathname);
  const prefix = mt ? mt[1] : "";
  let path = pathname.slice(prefix.length) || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return { path, prefix };
}

function publicBase(url: URL, prefix: string, headers: Headers): string {
  const explicit = Deno.env.get("API_BASE_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  const supa = Deno.env.get("SUPABASE_URL");
  if (supa && /^https:\/\//.test(supa)) return `${supa.replace(/\/$/, "")}/functions/v1/api`;
  const proto = headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = headers.get("x-forwarded-host") ?? url.host;
  return `${proto}://${host}${prefix}`;
}

function clientIp(h: Headers): string {
  return h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0].trim() ?? h.get("x-real-ip") ?? "unknown";
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  if (status === 204 || status === 202 && body == null) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

function errorBody(e: ApiError, requestId: string) {
  return { error: { code: e.code, message: e.message, request_id: requestId, ...(e.details ? { details: e.details } : {}) } };
}

/** Maps unexpected errors (incl. Postgres errors) to ApiError. */
function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const code = (e as { code?: string })?.code;
  if (code === "23505") return new ApiError("conflict", "Resource already exists");
  if (code === "23514" || code === "22P02" || code === "22001" || code === "22003") {
    return new ApiError("invalid_request", "Request violates a data constraint");
  }
  return new ApiError("internal", "Internal server error");
}

const RETRYABLE = new Set(["40P01", "40001"]); // deadlock / serialization failure

// deno-lint-ignore no-explicit-any
const edgeRuntime = (globalThis as any).EdgeRuntime as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
function background(p: Promise<unknown>) {
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(p);
  else p.catch(() => {});
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function handle(req: Request): Promise<Response> {
  const inboundId = req.headers.get("x-request-id");
  const requestId = inboundId && /^[A-Za-z0-9._:-]{1,64}$/.test(inboundId) ? inboundId : `req_${randomHex(10)}`;
  const headers: Record<string, string> = { ...CORS, "X-Request-Id": requestId };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const url = new URL(req.url);
  const { path, prefix } = normalisePath(url.pathname);
  const base = publicBase(url, prefix, req.headers);
  const ctx: m.Ctx = { requestId, agent: null, keyId: null, baseUrl: base, events: [] };

  try {
    // Static discovery documents: no DB, no rate limiting.
    if (req.method === "GET" || req.method === "HEAD") {
      if (path === "/" || path === "/v1") return json(200, descriptor(base), headers);
      if (path === "/v1/openapi.json" || path === "/openapi.json") return json(200, openapi(base), headers);
      if (path === "/.well-known/agentmart.json") return json(200, manifest(base), headers);
      if (path === "/llms.txt") {
        return new Response(llmsTxt(base), { status: 200, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
      }
      if (path === "/mcp") {
        return json(405, errorBody(new ApiError("method_not_allowed", "MCP uses POST (JSON responses; no SSE stream)"), requestId), { ...headers, Allow: "POST" });
      }
    }

    // Stripe webhook: authenticated by its signature, exempt from agent auth and rate limits.
    if (req.method === "POST" && path === "/v1/payments/stripe/webhook") {
      const raw = await req.text();
      if (raw.length > 512 * 1024) throw new ApiError("invalid_request", "Webhook body too large");
      const res = await pay.stripeWebhook(raw, req.headers);
      return json(res.status, res.body, headers);
    }

    // Authentication (API key or JWT) — an invalid credential is always a 401.
    const auth = await authenticate(req.headers.get("authorization"));
    if (auth) {
      ctx.agent = auth.agent;
      ctx.keyId = auth.keyId;
    }

    // Rate limiting: per agent when authenticated, else per client IP.
    const rate: RateInfo = auth
      ? await hitRateLimit(`agent:${auth.agent.id}`, AGENT_LIMIT)
      : await hitRateLimit(`ip:${clientIp(req.headers)}`, IP_LIMIT);
    headers["X-RateLimit-Limit"] = String(rate.limit);
    headers["X-RateLimit-Remaining"] = String(rate.remaining);
    headers["X-RateLimit-Reset"] = String(rate.reset);
    if (auth === null) throw new ApiError("unauthorized", "Invalid, expired or revoked credentials");
    if (rate.exceeded) {
      headers["Retry-After"] = String(Math.max(1, rate.reset - Math.floor(Date.now() / 1000)));
      throw new ApiError("rate_limited", `Rate limit of ${rate.limit} requests/minute exceeded`);
    }

    // Route match
    let handler: Handler | null = null;
    let params: string[] = [];
    let pathMatched = false;
    for (const [method, pattern, h] of ROUTES) {
      const mt = pattern.exec(path);
      if (!mt) continue;
      pathMatched = true;
      if (method === req.method) {
        handler = h;
        params = mt.slice(1).map(decodeURIComponent);
        break;
      }
    }
    if (!handler) {
      if (pathMatched) throw new ApiError("method_not_allowed", `Method ${req.method} not allowed on ${path}`);
      throw new ApiError("not_found", `No route for ${req.method} ${path}`);
    }

    // Body
    let rawBody = "";
    let body: unknown = undefined;
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
      rawBody = await req.text();
      if (rawBody.length > MAX_BODY_BYTES) throw new ApiError("invalid_request", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
      if (rawBody.trim() && path !== "/mcp") {
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new ApiError("invalid_request", "Request body is not valid JSON");
        }
      }
    }

    const r: Req = { ctx, params, query: url.searchParams, body, rawBody, headers: req.headers };
    let result: m.Result | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await handler(r);
        break;
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code && RETRYABLE.has(code) && attempt < 2) {
          ctx.events = []; // the transaction rolled back
          continue;
        }
        throw e;
      }
    }

    background(m.dispatchWebhooks(ctx.events));
    return json(result.status, result.body, { ...headers, ...(result.headers ?? {}) });
  } catch (e) {
    const err = toApiError(e);
    if (err.code === "internal") console.error(`[${requestId}] ${req.method} ${path}`, e);
    return json(err.status, errorBody(err, requestId), headers);
  }
}

if (edgeRuntime) {
  // Supabase edge runtime owns the listener.
  Deno.serve(handle);
} else {
  // Local development: `deno run -A index.ts` listens on PORT (default 8787).
  const port = Number(Deno.env.get("PORT") ?? 8787);
  Deno.serve({ port, onListen: ({ port }) => console.log(`AgentMart API listening on :${port}`) }, handle);
}
