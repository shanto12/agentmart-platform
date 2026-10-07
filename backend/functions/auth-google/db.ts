// Database client plus the cross-cutting DB-backed concerns: auth, rate limiting, idempotency.
import postgres from "npm:postgres@3.4.5";
import { ApiError, randomHex, sha256Hex, signJwt, timingSafeEqual, verifyJwt } from "./lib.ts";

const dbUrl = Deno.env.get("SUPABASE_DB_URL");
if (!dbUrl) console.error("SUPABASE_DB_URL is not set");

/**
 * Shared connection pool. `prepare: false` is required behind the Supabase
 * transaction pooler. int8 (bigint) columns are parsed to JS numbers: all our
 * money amounts are cents well below 2^53.
 */
export const sql = postgres(dbUrl ?? "postgres://invalid", {
  prepare: false,
  max: 3,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

// Accepts either the pool or a transaction handle.
// deno-lint-ignore no-explicit-any
export type Db = postgres.Sql<any> | postgres.TransactionSql<any>;
// deno-lint-ignore no-explicit-any
export type Tx = postgres.TransactionSql<any>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let jwtSecret: string | null = null;

async function getJwtSecret(): Promise<string> {
  if (jwtSecret) return jwtSecret;
  const [row] = await sql<{ value: string }[]>`select value from market.config where key = 'jwt_secret'`;
  if (!row) throw new ApiError("internal", "JWT secret is not configured");
  jwtSecret = row.value;
  return jwtSecret;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const API_KEY_RE = /^am_live_[0-9a-f]{48}$/;
export const KEY_PREFIX_LEN = 16; // "am_live_" + 8 hex chars
export const TOKEN_TTL_SECONDS = 3600;

export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  operator_contact: string | null;
  webhook_url: string | null;
  status: string;
  is_system: boolean;
  is_demo: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AuthResult {
  agent: AgentRow;
  keyId: string;
}

export function newApiKey(): { secret: string; prefix: string } {
  const secret = `am_live_${randomHex(24)}`;
  return { secret, prefix: secret.slice(0, KEY_PREFIX_LEN) };
}

/**
 * Looks up an API key by its prefix, then compares SHA-256 hashes in constant
 * time. Returns null for any mismatch (never reveals which part was wrong).
 */
export async function verifyApiKey(secret: string): Promise<AuthResult | null> {
  if (!API_KEY_RE.test(secret)) return null;
  const hash = await sha256Hex(secret);
  const rows = await sql<(AgentRow & { key_id: string; key_hash: string; last_used_at: Date | null })[]>`
    select a.*, k.id as key_id, k.key_hash, k.last_used_at
      from market.api_keys k join market.agents a on a.id = k.agent_id
     where k.key_prefix = ${secret.slice(0, KEY_PREFIX_LEN)} and k.revoked_at is null`;
  const match = rows.find((r) => timingSafeEqual(r.key_hash, hash));
  if (!match || match.status !== "active" || match.is_system) return null;
  touchKey(match.key_id, match.last_used_at);
  const { key_id, key_hash: _h, last_used_at: _l, ...agent } = match;
  return { agent, keyId: key_id };
}

/** Throttled, best-effort `last_used_at` update (at most once a minute per key). */
function touchKey(keyId: string, last: Date | null) {
  if (last && Date.now() - new Date(last).getTime() < 60_000) return;
  sql`update market.api_keys set last_used_at = now() where id = ${keyId}`.catch(() => {});
}

export async function mintToken(agentId: string, keyId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signJwt({ iss: "agentmart", sub: agentId, kid: keyId, iat: now, exp: now + TOKEN_TTL_SECONDS }, await getJwtSecret());
}

/** Verifies a JWT and checks the agent is active and the originating key is not revoked. */
export async function verifyToken(token: string): Promise<AuthResult | null> {
  const claims = await verifyJwt(token, await getJwtSecret());
  if (!claims) return null;
  const [row] = await sql<AgentRow[]>`
    select a.* from market.agents a
      join market.api_keys k on k.agent_id = a.id and k.id = ${claims.kid} and k.revoked_at is null
     where a.id = ${claims.sub}`;
  if (!row || row.status !== "active" || row.is_system) return null;
  return { agent: row, keyId: claims.kid };
}

/** Resolves `Authorization: Bearer <api_key|jwt>`. undefined = no header; null = invalid credentials. */
export async function authenticate(header: string | null): Promise<AuthResult | null | undefined> {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return null;
  const cred = m[1];
  return cred.startsWith("am_live_") ? await verifyApiKey(cred) : await verifyToken(cred);
}

// ---------------------------------------------------------------------------
// Rate limiting: fixed per-minute windows stored in market.rate_limits.
// ---------------------------------------------------------------------------

export interface RateInfo {
  limit: number;
  remaining: number;
  reset: number; // epoch seconds when the window resets
  exceeded: boolean;
}

export async function hitRateLimit(bucket: string, limit: number): Promise<RateInfo> {
  const [row] = await sql<{ count: number; ws: number }[]>`
    insert into market.rate_limits as r (bucket, window_start, count)
    values (${bucket}, date_trunc('minute', now()), 1)
    on conflict (bucket, window_start) do update set count = r.count + 1
    returning r.count, extract(epoch from r.window_start)::bigint as ws`;
  // Opportunistic cleanup of stale windows (~1% of requests).
  if (Math.random() < 0.01) {
    sql`delete from market.rate_limits where window_start < now() - interval '10 minutes'`.catch(() => {});
  }
  return { limit, remaining: Math.max(0, limit - row.count), reset: row.ws + 60, exceeded: row.count > limit };
}

// ---------------------------------------------------------------------------
// Idempotency (POST /v1/orders, POST /v1/wallet/deposit)
// ---------------------------------------------------------------------------

export interface StoredResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

/**
 * Runs `fn` inside a transaction. When an Idempotency-Key is supplied, the
 * response is stored in the same transaction, so a replay returns exactly the
 * original response and a concurrent duplicate fails on the primary key and
 * then replays the winner's response.
 */
export async function idempotent(
  agentId: string,
  key: string | null,
  route: string,
  requestBody: unknown,
  fn: (tx: Tx) => Promise<{ status: number; body: unknown }>,
): Promise<StoredResponse> {
  if (!key) {
    const res = await sql.begin((tx) => fn(tx));
    return { ...res, replayed: false };
  }
  if (key.length > 255) throw new ApiError("invalid_request", "Idempotency-Key must be at most 255 characters");
  const reqHash = await sha256Hex(JSON.stringify(requestBody ?? null));

  const lookup = async (): Promise<StoredResponse | null> => {
    const [row] = await sql<{ route: string; request_hash: string; status_code: number; response: unknown }[]>`
      select route, request_hash, status_code, response from market.idempotency_keys
       where agent_id = ${agentId} and key = ${key} and created_at > now() - interval '24 hours'`;
    if (!row) return null;
    if (row.route !== route || row.request_hash !== reqHash) {
      throw new ApiError("conflict", "Idempotency-Key was already used with a different request", { field: "Idempotency-Key" });
    }
    return { status: row.status_code, body: row.response, replayed: true };
  };

  const prior = await lookup();
  if (prior) return prior;

  try {
    const res = await sql.begin(async (tx) => {
      const out = await fn(tx);
      await tx`delete from market.idempotency_keys
                where agent_id = ${agentId} and key = ${key} and created_at <= now() - interval '24 hours'`;
      await tx`insert into market.idempotency_keys (agent_id, key, route, request_hash, status_code, response)
               values (${agentId}, ${key}, ${route}, ${reqHash}, ${out.status}, ${tx.json(out.body as postgres.JSONValue)})`;
      return out;
    });
    return { ...res, replayed: false };
  } catch (e) {
    // Lost a race with a concurrent request using the same key: replay the winner.
    if ((e as { code?: string }).code === "23505") {
      const again = await lookup();
      if (again) return again;
    }
    throw e;
  }
}
