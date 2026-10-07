// Shared primitives: errors, ids, crypto (SHA-256, HMAC, HS256 JWT), and input validation.
// No external dependencies — Web Crypto only.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "insufficient_funds"
  | "mandate_exceeded"
  | "out_of_stock"
  | "rate_limited"
  | "not_implemented"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  insufficient_funds: 402,
  forbidden: 403,
  mandate_exceeded: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  out_of_stock: 409,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const bad = (message: string, details?: Record<string, unknown>) =>
  new ApiError("invalid_request", message, details);

// ---------------------------------------------------------------------------
// IDs & random secrets
// ---------------------------------------------------------------------------

export function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Prefixed id, e.g. `ord_` + 20 lowercase hex chars. */
export const newId = (prefix: string) => `${prefix}_${randomHex(10)}`;

// ---------------------------------------------------------------------------
// Encoding & crypto
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string comparison (for equal-length hex digests). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const b64urlJson = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));
export const fromB64urlJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

export interface JwtClaims {
  iss: string;
  sub: string; // agent id
  kid: string; // api key id the token was minted from
  iat: number;
  exp: number;
}

export async function signJwt(claims: JwtClaims, secret: string): Promise<string> {
  const head = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(claims);
  const key = await hmacKey(secret, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Verifies an HS256 JWT (signature via crypto.subtle.verify, i.e. constant-time) and expiry. */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = fromB64urlJson(parts[0]) as { alg?: string };
    if (header.alg !== "HS256") return null;
    const key = await hmacKey(secret, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = fromB64urlJson(parts[1]) as JwtClaims;
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof claims.sub !== "string" || typeof claims.kid !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers. Each takes the raw value and a field name and either
// returns a normalised value or throws a 400 invalid_request naming the field.
// ---------------------------------------------------------------------------

export type Json = Record<string, unknown>;

export function obj(v: unknown, field = "body"): Json {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad(`${field} must be a JSON object`, { field });
  return v as Json;
}

export function str(
  v: unknown,
  field: string,
  opts: { min?: number; max: number; required?: boolean; pattern?: RegExp; patternMsg?: string },
): string | undefined {
  if (v === undefined || v === null || (v === "" && !opts.required)) {
    if (opts.required) throw bad(`${field} is required`, { field });
    return undefined;
  }
  if (typeof v !== "string") throw bad(`${field} must be a string`, { field });
  const s = v.trim();
  const min = opts.min ?? (opts.required ? 1 : 0);
  if (s.length < min) throw bad(`${field} must be at least ${min} characters`, { field });
  if (s.length > opts.max) throw bad(`${field} must be at most ${opts.max} characters`, { field });
  if (opts.pattern && !opts.pattern.test(s)) throw bad(opts.patternMsg ?? `${field} has an invalid format`, { field });
  return s;
}

export function int(
  v: unknown,
  field: string,
  opts: { min: number; max: number; required?: boolean },
): number | undefined {
  if (v === undefined || v === null) {
    if (opts.required) throw bad(`${field} is required`, { field });
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) throw bad(`${field} must be an integer`, { field });
  if (v < opts.min || v > opts.max) throw bad(`${field} must be between ${opts.min} and ${opts.max}`, { field });
  return v;
}

export function oneOf<T extends string>(v: unknown, field: string, values: readonly T[], required = false): T | undefined {
  if (v === undefined || v === null) {
    if (required) throw bad(`${field} is required`, { field });
    return undefined;
  }
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw bad(`${field} must be one of: ${values.join(", ")}`, { field });
  }
  return v as T;
}

export function httpsUrl(v: unknown, field: string, opts: { allowHttp?: boolean } = {}): string | undefined {
  const s = str(v, field, { max: 2048 });
  if (s === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${field} must be a valid URL`, { field });
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) {
    throw bad(`${field} must be an https:// URL`, { field });
  }
  return u.toString();
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pagination: `limit` 1..100 (default 20) and an opaque offset cursor. */
export function pageParams(q: URLSearchParams, max = 100, dflt = 20): { limit: number; offset: number } {
  const rawLimit = q.get("limit");
  let limit = dflt;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > max) throw bad(`limit must be an integer 1..${max}`, { field: "limit" });
  }
  let offset = 0;
  const cursor = q.get("cursor");
  if (cursor) {
    try {
      const c = fromB64urlJson(cursor) as { o?: unknown };
      if (typeof c.o !== "number" || !Number.isInteger(c.o) || c.o < 0) throw new Error();
      offset = c.o;
    } catch {
      throw bad("cursor is invalid", { field: "cursor" });
    }
  }
  return { limit, offset };
}

/** Builds `{ data, next_cursor }` given rows fetched with `limit + 1`. */
export function page<T>(rows: T[], limit: number, offset: number): { data: T[]; next_cursor: string | null } {
  const more = rows.length > limit;
  return { data: more ? rows.slice(0, limit) : rows, next_cursor: more ? b64urlJson({ o: offset + limit }) : null };
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();
