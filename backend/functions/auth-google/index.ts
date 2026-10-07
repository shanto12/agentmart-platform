// AgentMart — Supabase Edge Function `auth-google` ("Continue with Google").
// POST { id_token, nonce } -> verifies a Google ID token and returns an AgentMart 1h bearer JWT.
// Deployed with verify_jwt=false: it performs its own (stronger) verification.
import { hitRateLimit, mintToken, sql, TOKEN_TTL_SECONDS } from "./db.ts";
import { ApiError, obj, randomHex, sha256Hex } from "./lib.ts";
import { GoogleTokenError, JwksCache, parseClientIds, parseJwtStructure, verifyGoogleIdToken } from "./google.ts";
import { agentSelfView, loginOrCreate, type LoginOutcome } from "./identity.ts";

// Identical to the `api` function's CORS map (auth is by bearer token, never cookies).
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-request-id",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Expose-Headers": "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, Idempotent-Replayed",
  "Access-Control-Max-Age": "86400",
};

const IP_LIMIT = 20; // requests / minute / IP
const MAX_BODY_BYTES = 16 * 1024;

const jwks = new JwksCache();

/** Error with its own HTTP status, for codes lib.ts does not know (not_configured, upstream_unavailable). */
class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
type ErrLike = { status: number; code: string; message: string; details?: Record<string, unknown> };

function toErr(e: unknown): ErrLike {
  if (e instanceof HttpError || e instanceof ApiError) return e;
  if (e instanceof GoogleTokenError) {
    if (e.reason === "jwks_unavailable") return new HttpError(503, "upstream_unavailable", "Could not reach Google to verify the token; try again shortly");
    return new HttpError(401, "unauthorized", "Invalid, expired or wrong-audience Google ID token", { reason: e.reason });
  }
  return new HttpError(500, "internal", "Internal server error");
}

function clientIp(h: Headers): string {
  return h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0].trim() ?? h.get("x-real-ip") ?? "unknown";
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Allowed OAuth client ids: market.config 'google_client_ids' (read per request), else env GOOGLE_CLIENT_IDS. */
async function configuredClientIds(): Promise<string[]> {
  const [row] = await sql<{ value: string }[]>`select value from market.config where key = 'google_client_ids'`;
  const fromDb = parseClientIds(row?.value);
  return fromDb.length ? fromDb : parseClientIds(Deno.env.get("GOOGLE_CLIENT_IDS"));
}

const RETRYABLE = new Set(["40P01", "40001"]);

async function signIn(claims: Parameters<typeof loginOrCreate>[0], tokenHash: string): Promise<LoginOutcome> {
  let allowEmail = true;
  for (let attempt = 0;; attempt++) {
    try {
      return await loginOrCreate(claims, allowEmail, tokenHash);
    } catch (e) {
      const err = e as { code?: string; constraint_name?: string };
      if (attempt < 3 && err.code === "23505" && String(err.constraint_name ?? "").includes("email")) {
        allowEmail = false; // someone registered this email concurrently: create without it
        continue;
      }
      if (attempt < 3 && err.code && RETRYABLE.has(err.code)) continue;
      throw e;
    }
  }
}

export async function handle(req: Request): Promise<Response> {
  const inboundId = req.headers.get("x-request-id");
  const requestId = inboundId && /^[A-Za-z0-9._:-]{1,64}$/.test(inboundId) ? inboundId : `req_${randomHex(10)}`;
  const headers: Record<string, string> = { ...CORS, "X-Request-Id": requestId };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    if (req.method !== "POST") {
      headers["Allow"] = "POST, OPTIONS";
      throw new ApiError("method_not_allowed", `Method ${req.method} not allowed; use POST`);
    }

    const rate = await hitRateLimit(`gauth:${clientIp(req.headers)}`, IP_LIMIT);
    headers["X-RateLimit-Limit"] = String(rate.limit);
    headers["X-RateLimit-Remaining"] = String(rate.remaining);
    headers["X-RateLimit-Reset"] = String(rate.reset);
    if (rate.exceeded) {
      headers["Retry-After"] = String(Math.max(1, rate.reset - Math.floor(Date.now() / 1000)));
      throw new ApiError("rate_limited", `Rate limit of ${rate.limit} requests/minute exceeded`);
    }

    // ---- body ----
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new ApiError("invalid_request", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    if (!raw.trim()) throw new ApiError("invalid_request", "Request body must be a JSON object with an id_token");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ApiError("invalid_request", "Request body is not valid JSON");
    }
    const b = obj(parsed);
    if (typeof b.id_token !== "string" || b.id_token.trim() === "") {
      throw new ApiError("invalid_request", "id_token is required and must be a string", { field: "id_token" });
    }
    if (typeof b.nonce !== "string" || b.nonce === "" || b.nonce.length > 256) {
      throw new ApiError("invalid_request", "nonce is required and must be a non-empty string of at most 256 characters", { field: "nonce" });
    }
    const idToken = b.id_token.trim();
    const nonce = b.nonce;

    // Cheap structural rejection first (garbage never triggers DB config reads or Google fetches).
    parseJwtStructure(idToken);

    const clientIds = await configuredClientIds();
    if (clientIds.length === 0) throw new HttpError(503, "not_configured", "Google sign-in is not configured on this server");

    const claims = await verifyGoogleIdToken(idToken, { clientIds, keys: jwks, nonce });
    const out = await signIn(claims, await sha256Hex(idToken));
    const token = await mintToken(out.agent.id, out.keyId);

    const body: Record<string, unknown> = { agent: agentSelfView(out.agent) };
    if (out.created) {
      body.credentials = { agent_id: out.agent.id, api_key: out.apiKey, key_id: out.apiKeyId };
      body.note = "Store api_key securely: it is shown only once. Your web session uses a managed key that is never shown; revoking it just signs this browser out. Your sandbox wallet starts at 0; fund it with POST /v1/wallet/deposit.";
    }
    body.token = token;
    body.access_token = token; // alias, same field name as POST /v1/auth/token
    body.token_type = "Bearer";
    body.expires_in = TOKEN_TTL_SECONDS;
    body.created = out.created;
    return json(200, body, headers);
  } catch (e) {
    const err = toErr(e);
    if (err.code === "internal") {
      const pg = e as { code?: string; message?: string };
      console.error(`[${requestId}] auth-google internal error`, pg.code ?? "", pg.message ?? "");
    }
    return json(err.status, { error: { code: err.code, message: err.message, request_id: requestId, ...(err.details ? { details: err.details } : {}) } }, headers);
  }
}

Deno.serve(handle);
