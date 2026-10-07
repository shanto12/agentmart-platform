// Google ID token verification (OpenID Connect, RS256). Pure Web Crypto, no imports,
// so it is unit-testable under Deno or Node (see google_test.ts). The JWKS fetcher is injectable.

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const MAX_TOKEN_CHARS = 8192;
const MAX_LIFETIME_SEC = 24 * 3600;
/** Default maximum age (now - iat) of an accepted ID token. Google tokens live ~1h; a sign-in needs seconds. */
export const DEFAULT_MAX_AGE_SEC = 600;

export type FailReason =
  | "malformed"
  | "alg"
  | "kid"
  | "unknown_key"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "iat"
  | "nbf"
  | "subject"
  | "email"
  | "email_unverified"
  | "nonce"
  | "replayed"
  | "jwks_unavailable";

export class GoogleTokenError extends Error {
  reason: FailReason;
  constructor(reason: FailReason, message?: string) {
    super(message ?? reason);
    this.name = "GoogleTokenError";
    this.reason = reason;
  }
}

export interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}
export interface JwksResult {
  keys: Jwk[];
  maxAgeSec?: number;
}
export type JwksFetcher = () => Promise<JwksResult>;

export interface KeySource {
  getKey(kid: string): Promise<CryptoKey | null>;
}

export interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string; // lower-cased
  email_verified: true;
  name?: string;
  nonce?: string;
  iat: number;
  exp: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new GoogleTokenError("malformed");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  } catch {
    throw new GoogleTokenError("malformed"); // e.g. length % 4 == 1 is not valid base64
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64urlDecode(s)));
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof GoogleTokenError) throw e;
    throw new GoogleTokenError("malformed");
  }
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const LOOSE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Structure parsing (no network, no signature check)
// ---------------------------------------------------------------------------

export interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  kid: string;
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

/** Splits the JWT and checks it is a well-formed RS256 token with a key id. Throws GoogleTokenError. */
export function parseJwtStructure(token: string): ParsedJwt {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) throw new GoogleTokenError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new GoogleTokenError("malformed");
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (header.alg !== "RS256") throw new GoogleTokenError("alg", "Unsupported token algorithm");
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > 128) throw new GoogleTokenError("kid");
  return {
    header,
    payload,
    kid,
    signingInput: enc.encode(`${parts[0]}.${parts[1]}`) as Uint8Array<ArrayBuffer>,
    signature: b64urlDecode(parts[2]),
  };
}

// ---------------------------------------------------------------------------
// JWKS: fetch + cache + rotation handling
// ---------------------------------------------------------------------------

export async function fetchGoogleJwks(): Promise<JwksResult> {
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`JWKS HTTP ${res.status}`);
  }
  const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new Error("JWKS malformed");
  return { keys: body.keys as Jwk[], maxAgeSec: m ? Number(m[1]) : undefined };
}

export interface JwksCacheOptions {
  fetchJwks?: JwksFetcher;
  now?: () => number; // ms
  defaultTtlMs?: number;
  /** Minimum gap between refetches triggered by an unknown kid (protects Google and us from junk-kid floods). */
  minRefetchMs?: number;
}

export class JwksCache implements KeySource {
  keys = new Map<string, CryptoKey>();
  expiresAt = 0;
  lastFetch = -Infinity;
  inflight: Promise<void> | null = null;
  fetchJwks: JwksFetcher;
  now: () => number;
  defaultTtlMs: number;
  minRefetchMs: number;

  constructor(opts: JwksCacheOptions = {}) {
    this.fetchJwks = opts.fetchJwks ?? fetchGoogleJwks;
    this.now = opts.now ?? Date.now;
    this.defaultTtlMs = opts.defaultTtlMs ?? 3600_000;
    this.minRefetchMs = opts.minRefetchMs ?? 30_000;
  }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const p = (async () => {
      this.lastFetch = this.now();
      const res = await this.fetchJwks();
      const next = new Map<string, CryptoKey>();
      for (const jwk of res.keys) {
        if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.n || !jwk.e) continue;
        if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
        if (jwk.use !== undefined && jwk.use !== "sig") continue;
        try {
          const key = await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          next.set(jwk.kid, key);
        } catch {
          // skip unusable key
        }
      }
      if (next.size === 0) throw new Error("JWKS contained no usable keys");
      this.keys = next;
      const ttl = res.maxAgeSec && res.maxAgeSec > 0 ? Math.min(res.maxAgeSec * 1000, 24 * 3600_000) : this.defaultTtlMs;
      this.expiresAt = this.now() + ttl;
    })().finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  async getKey(kid: string): Promise<CryptoKey | null> {
    try {
      if (this.now() >= this.expiresAt) {
        try {
          await this.refresh();
        } catch (e) {
          if (this.keys.size === 0) throw e; // no stale keys to fall back on
          this.expiresAt = this.now() + 60_000; // serve stale keys and back off instead of refetching on every request
        }
      }
      let key = this.keys.get(kid);
      if (!key && this.now() - this.lastFetch >= this.minRefetchMs) {
        await this.refresh(); // key rotation: unknown kid -> refetch (rate limited)
        key = this.keys.get(kid);
      }
      return key ?? null;
    } catch (e) {
      if (e instanceof GoogleTokenError) throw e;
      throw new GoogleTokenError("jwks_unavailable", "Could not load Google signing keys");
    }
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  clientIds: string[];
  keys: KeySource;
  /** Nonce supplied by the browser. MANDATORY: the token must carry a string nonce equal to this one. */
  nonce?: string;
  nowMs?: number;
  skewSec?: number;
  /** Maximum accepted token age (now - iat), in seconds. Default 600 (10 minutes). */
  maxAgeSec?: number;
}

export async function verifyGoogleIdToken(token: string, opts: VerifyOptions): Promise<GoogleClaims> {
  const skew = opts.skewSec ?? 60;
  const maxAge = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const { payload, kid, signingInput, signature } = parseJwtStructure(token);

  const key = await opts.keys.getKey(kid);
  if (!key) throw new GoogleTokenError("unknown_key");
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signingInput);
  } catch {
    ok = false;
  }
  if (!ok) throw new GoogleTokenError("signature");

  // ---- claims (only trusted after the signature check) ----
  if (typeof payload.iss !== "string" || !GOOGLE_ISSUERS.includes(payload.iss)) throw new GoogleTokenError("issuer");
  if (typeof payload.aud !== "string" || !opts.clientIds.includes(payload.aud)) throw new GoogleTokenError("audience");
  const exp = payload.exp;
  const iat = payload.iat;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp + skew < now) throw new GoogleTokenError("expired");
  if (typeof iat !== "number" || !Number.isFinite(iat) || iat > now + skew || exp <= iat || exp - iat > MAX_LIFETIME_SEC) {
    throw new GoogleTokenError("iat");
  }
  if (now - iat > maxAge + skew) throw new GoogleTokenError("expired", "Google ID token is too old; sign in again");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now + skew)) throw new GoogleTokenError("nbf");
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) throw new GoogleTokenError("subject");

  const emailRaw = payload.email;
  if (typeof emailRaw !== "string") throw new GoogleTokenError("email");
  const email = emailRaw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !LOOSE_EMAIL_RE.test(email)) throw new GoogleTokenError("email");
  if (payload.email_verified !== true) throw new GoogleTokenError("email_unverified");

  // Nonce is mandatory on both sides: the token must carry one and the caller must present the same value.
  const tokenNonce = payload.nonce;
  if (typeof tokenNonce !== "string" || tokenNonce.length === 0 || typeof opts.nonce !== "string" || opts.nonce.length === 0 || !safeEqual(tokenNonce, opts.nonce)) {
    throw new GoogleTokenError("nonce");
  }

  return {
    iss: payload.iss,
    aud: payload.aud,
    sub,
    email,
    email_verified: true,
    name: typeof payload.name === "string" ? payload.name : undefined,
    nonce: tokenNonce,
    iat,
    exp,
  };
}

// ---------------------------------------------------------------------------
// Agent-name derivation (same rules as registerAgent: 1..80 chars)
// ---------------------------------------------------------------------------

function cleanName(s: string): string {
  const flat = s.normalize("NFKC").replace(/[\p{C}\p{Zl}\p{Zp}<>]/gu, " ").replace(/\s+/g, " ").trim();
  const cps = Array.from(flat).slice(0, 80);
  while (cps.join("").length > 80) cps.pop();
  return cps.join("").trim();
}

export function sanitizeAgentName(name: string | undefined, email: string): string {
  const fromName = name ? cleanName(name) : "";
  if (fromName) return fromName;
  const fromEmail = cleanName(email.split("@")[0] ?? "");
  return fromEmail || "Google user";
}

/** Parses a comma/whitespace separated list of OAuth client ids. */
export function parseClientIds(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 256))];
}
