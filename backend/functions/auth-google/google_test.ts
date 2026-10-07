// Unit tests for the Google ID token verifier. No network: a fake JWKS is injected.
//   Deno:  deno test google_test.ts
//   Node:  node --experimental-strip-types --test google_test.ts   (Node >= 22.6)
import test from "node:test";
import assert from "node:assert/strict";
import {
  GoogleTokenError,
  JwksCache,
  type Jwk,
  parseClientIds,
  parseJwtStructure,
  sanitizeAgentName,
  verifyGoogleIdToken,
  type FailReason,
} from "./google.ts";

const CLIENT = "1234567890-abc.apps.googleusercontent.com";
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const jsonB64 = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));

async function genKey() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as Jwk;
  return { priv: kp.privateKey, jwk };
}

const keyA = await genKey();
const keyB = await genKey(); // an attacker's key

async function sign(
  claims: Record<string, unknown>,
  opts: { kid?: string; alg?: string; priv?: CryptoKey; header?: Record<string, unknown> } = {},
): Promise<string> {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? "kidA", ...(opts.header ?? {}) };
  const signingInput = `${jsonB64(header)}.${jsonB64(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, opts.priv ?? keyA.priv, enc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT,
  sub: "110169484474386276334",
  email: "Jane.Doe@Example.com",
  email_verified: true,
  name: "Jane Doe",
  nonce: "n0",
  iat: NOW - 10,
  exp: NOW + 3590,
  ...over,
});

function cacheWith(keys: Jwk[], counter = { n: 0 }, now = { t: NOW_MS }) {
  const cache = new JwksCache({
    fetchJwks: () => {
      counter.n++;
      return Promise.resolve({ keys, maxAgeSec: 3600 });
    },
    now: () => now.t,
    minRefetchMs: 30_000,
  });
  return { cache, counter, now };
}
const jwkWith = (jwk: Jwk, kid: string): Jwk => ({ ...jwk, kid, alg: "RS256", use: "sig" });

async function rejects(p: Promise<unknown>, reason: FailReason) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GoogleTokenError, `expected GoogleTokenError, got ${e}`);
    assert.equal((e as GoogleTokenError).reason, reason);
    return;
  }
  assert.fail(`expected rejection with reason ${reason}`);
}

// The default request nonce matches goodClaims(); pass `nonce: undefined` explicitly to omit it.
const verify = (token: string, cache: JwksCache, extra: { nonce?: string; clientIds?: string[]; maxAgeSec?: number } = {}) =>
  verifyGoogleIdToken(token, {
    clientIds: extra.clientIds ?? [CLIENT],
    keys: cache,
    nonce: "nonce" in extra ? extra.nonce : "n0",
    nowMs: NOW_MS,
    maxAgeSec: extra.maxAgeSec,
  });

test("valid token verifies and normalises email", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  const c = await verify(await sign(goodClaims()), cache);
  assert.equal(c.sub, "110169484474386276334");
  assert.equal(c.email, "jane.doe@example.com");
  assert.equal(c.email_verified, true);
  assert.equal(c.name, "Jane Doe");
});

test("issuer without scheme is accepted; other issuers are not", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  await verify(await sign(goodClaims({ iss: "accounts.google.com" })), cache);
  await rejects(verify(await sign(goodClaims({ iss: "https://evil.example.com" })), cache), "issuer");
  await rejects(verify(await sign(goodClaims({ iss: "https://accounts.google.com.evil.com" })), cache), "issuer");
  await rejects(verify(await sign(goodClaims({ iss: undefined })), cache), "issuer");
});

test("wrong audience / multiple configured client ids", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  await rejects(verify(await sign(goodClaims({ aud: "someone-else.apps.googleusercontent.com" })), cache), "audience");
  await rejects(verify(await sign(goodClaims({ aud: [CLIENT] })), cache), "audience"); // arrays are refused
  await rejects(verify(await sign(goodClaims()), cache, { clientIds: [] }), "audience");
  const other = "other-client.apps.googleusercontent.com";
  const c = await verify(await sign(goodClaims({ aud: other })), cache, { clientIds: [CLIENT, other] });
  assert.equal(c.aud, other);
});

test("expiry, clock skew and iat sanity", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  await rejects(verify(await sign(goodClaims({ iat: NOW - 4000, exp: NOW - 400 })), cache), "expired");
  await verify(await sign(goodClaims({ iat: NOW - 100, exp: NOW - 30 })), cache); // exp within 60s skew
  await rejects(verify(await sign(goodClaims({ exp: undefined })), cache), "expired");
  await rejects(verify(await sign(goodClaims({ exp: "9999999999" })), cache), "expired");
  await rejects(verify(await sign(goodClaims({ iat: NOW + 3000, exp: NOW + 6600 })), cache), "iat"); // from the future
  await rejects(verify(await sign(goodClaims({ iat: undefined })), cache), "iat");
  await rejects(verify(await sign(goodClaims({ iat: NOW - 10, exp: NOW + 10 * 86400 })), cache), "iat"); // absurd lifetime
  await rejects(verify(await sign(goodClaims({ nbf: NOW + 3600 })), cache), "nbf");
});

test("token age: 11 minutes old rejected, 5 minutes old accepted, maxAgeSec configurable", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  await rejects(verify(await sign(goodClaims({ iat: NOW - 665, exp: NOW + 2935 })), cache), "expired"); // 11 min (+5s)
  await rejects(verify(await sign(goodClaims({ iat: NOW - 1800, exp: NOW + 1800 })), cache), "expired"); // 30 min
  await verify(await sign(goodClaims({ iat: NOW - 300, exp: NOW + 3300 })), cache); // 5 min
  await verify(await sign(goodClaims({ iat: NOW - 660, exp: NOW + 2940 })), cache); // exactly 600s + 60s skew: still accepted
  await rejects(verify(await sign(goodClaims({ iat: NOW - 661, exp: NOW + 2939 })), cache), "expired"); // one second past
  await rejects(verify(await sign(goodClaims({ iat: NOW - 300, exp: NOW + 3300 })), cache, { maxAgeSec: 100 }), "expired");
  await verify(await sign(goodClaims({ iat: NOW - 300, exp: NOW + 3300 })), cache, { maxAgeSec: 3600 });
});

test("signature segment with length % 4 == 1 is malformed (401), not a crash", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  const good = await sign(goodClaims());
  const [h, p] = good.split(".");
  await rejects(verify(`${h}.${p}.AAAAA`, cache), "malformed");
  assert.throws(() => parseJwtStructure(`${h}.${p}.A`), (e) => e instanceof GoogleTokenError && e.reason === "malformed");
});

test("alg=none, HS256, missing kid and malformed tokens are rejected before any key lookup", async () => {
  const { cache, counter } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  const none = `${jsonB64({ alg: "none", typ: "JWT", kid: "kidA" })}.${jsonB64(goodClaims())}.`;
  await rejects(verify(none, cache), "malformed"); // empty signature segment
  const none2 = `${jsonB64({ alg: "none", typ: "JWT", kid: "kidA" })}.${jsonB64(goodClaims())}.AAAA`;
  await rejects(verify(none2, cache), "alg");
  const hs = `${jsonB64({ alg: "HS256", typ: "JWT", kid: "kidA" })}.${jsonB64(goodClaims())}.AAAA`;
  await rejects(verify(hs, cache), "alg");
  const lower = `${jsonB64({ alg: "rs256", typ: "JWT", kid: "kidA" })}.${jsonB64(goodClaims())}.AAAA`;
  await rejects(verify(lower, cache), "alg");
  const nokid = `${jsonB64({ alg: "RS256", typ: "JWT" })}.${jsonB64(goodClaims())}.AAAA`;
  await rejects(verify(nokid, cache), "kid");
  for (const t of ["", "garbage", "a.b", "a.b.c.d", "..", "not base64!.x.y", `${jsonB64([1])}.${jsonB64({})}.AAAA`]) {
    await rejects(verify(t, cache), "malformed");
  }
  await rejects(verify("a".repeat(9000), cache), "malformed");
  assert.equal(counter.n, 0, "malformed tokens must not trigger a JWKS fetch");
  assert.throws(() => parseJwtStructure("x.y.z"), GoogleTokenError);
});

test("signature: tampered payload, attacker key with a known kid, and truncated signature", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  const good = await sign(goodClaims());
  const [h, , s] = good.split(".");
  const tampered = `${h}.${jsonB64(goodClaims({ sub: "999", email: "admin@victim.com" }))}.${s}`;
  await rejects(verify(tampered, cache), "signature");
  await rejects(verify(await sign(goodClaims(), { priv: keyB.priv }), cache), "signature");
  await rejects(verify(good.slice(0, -8), cache), "signature");
  const flipped = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
  await rejects(verify(flipped, cache), "signature");
});

test("email must be present, well-formed and verified === true", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  await rejects(verify(await sign(goodClaims({ email_verified: false })), cache), "email_unverified");
  await rejects(verify(await sign(goodClaims({ email_verified: "true" })), cache), "email_unverified");
  await rejects(verify(await sign(goodClaims({ email_verified: undefined })), cache), "email_unverified");
  await rejects(verify(await sign(goodClaims({ email: undefined })), cache), "email");
  await rejects(verify(await sign(goodClaims({ email: "not-an-email" })), cache), "email");
  await rejects(verify(await sign(goodClaims({ email: 42 })), cache), "email");
  await rejects(verify(await sign(goodClaims({ sub: "" })), cache), "subject");
  await rejects(verify(await sign(goodClaims({ sub: 12345 })), cache), "subject");
});

test("nonce rules: mandatory on both the token and the request", async () => {
  const { cache } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  const withNonce = await sign(goodClaims({ nonce: "abc123" }));
  assert.equal((await verify(withNonce, cache, { nonce: "abc123" })).nonce, "abc123");
  await rejects(verify(withNonce, cache, { nonce: "other" }), "nonce");
  await rejects(verify(withNonce, cache, { nonce: undefined }), "nonce"); // token has nonce, none supplied
  await rejects(verify(withNonce, cache, { nonce: "" }), "nonce");
  const noNonce = await sign(goodClaims({ nonce: undefined }));
  await rejects(verify(noNonce, cache, { nonce: undefined }), "nonce"); // neither: no longer accepted
  await rejects(verify(noNonce, cache, { nonce: "abc123" }), "nonce"); // supplied but token has none
  await rejects(verify(await sign(goodClaims({ nonce: 12345 })), cache, { nonce: "12345" }), "nonce"); // non-string
  await rejects(verify(await sign(goodClaims({ nonce: "" })), cache, { nonce: "" }), "nonce");
});

test("JWKS: cached, rotation refetch, refetch throttling, failure handling", async () => {
  const keys: Jwk[] = [jwkWith(keyA.jwk, "kidA")];
  const counter = { n: 0 };
  const now = { t: NOW_MS };
  const { cache } = cacheWith(keys, counter, now);
  await verify(await sign(goodClaims()), cache);
  await verify(await sign(goodClaims()), cache);
  assert.equal(counter.n, 1, "second verification uses the cache");

  // unknown kid within the throttle window -> no refetch
  await rejects(verify(await sign(goodClaims(), { kid: "kidB", priv: keyB.priv }), cache), "unknown_key");
  assert.equal(counter.n, 1);

  // rotation: Google publishes kidB; after the throttle window a token with kidB triggers one refetch
  keys.push(jwkWith(keyB.jwk, "kidB"));
  now.t += 31_000;
  const c = await verify(await sign(goodClaims({ iat: NOW + 21, exp: NOW + 3600 }), { kid: "kidB", priv: keyB.priv }), cache).catch((e) => e);
  // clock moved forward 31s but verification still uses NOW_MS: iat is within skew, so it passes
  assert.ok(!(c instanceof Error), String(c));
  assert.equal(counter.n, 2);

  // TTL expiry -> refetch
  now.t += 3600_000 + 1;
  await verify(await sign(goodClaims()), cache);
  assert.equal(counter.n, 3);

  // fetch failure with no cached keys -> jwks_unavailable
  const failing = new JwksCache({ fetchJwks: () => Promise.reject(new Error("network down")), now: () => NOW_MS });
  await rejects(verify(await sign(goodClaims()), failing), "jwks_unavailable");

  // fetch failure with stale keys -> falls back to stale keys
  let fail = false;
  const t2 = { t: NOW_MS };
  const stale = new JwksCache({
    fetchJwks: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve({ keys: [jwkWith(keyA.jwk, "kidA")], maxAgeSec: 60 })),
    now: () => t2.t,
  });
  await verify(await sign(goodClaims()), stale);
  fail = true;
  t2.t += 120_000;
  await verify(await sign(goodClaims()), stale);

  // L5: refresh failure with stale keys backs off for 60s instead of refetching on every request
  let calls = 0;
  let down = false;
  const t3 = { t: NOW_MS };
  const backoff = new JwksCache({
    fetchJwks: () => {
      calls++;
      return down ? Promise.reject(new Error("down")) : Promise.resolve({ keys: [jwkWith(keyA.jwk, "kidA")], maxAgeSec: 60 });
    },
    now: () => t3.t,
  });
  await verify(await sign(goodClaims()), backoff);
  assert.equal(calls, 1);
  down = true;
  t3.t += 120_000; // TTL expired
  await verify(await sign(goodClaims()), backoff); // refetch attempted, fails, stale keys used
  assert.equal(calls, 2);
  await verify(await sign(goodClaims()), backoff);
  await verify(await sign(goodClaims()), backoff);
  assert.equal(calls, 2, "no refetch during the 60s back-off");
  t3.t += 61_000;
  await verify(await sign(goodClaims()), backoff);
  assert.equal(calls, 3, "retries after the back-off");

  // garbage JWKS (no usable keys) -> jwks_unavailable
  const empty = new JwksCache({ fetchJwks: () => Promise.resolve({ keys: [{ kty: "EC", kid: "x" }] }), now: () => NOW_MS });
  await rejects(verify(await sign(goodClaims()), empty), "jwks_unavailable");
});

test("concurrent verifications share one JWKS fetch", async () => {
  const { cache, counter } = cacheWith([jwkWith(keyA.jwk, "kidA")]);
  const tok = await sign(goodClaims());
  await Promise.all([1, 2, 3, 4, 5].map(() => verify(tok, cache)));
  assert.equal(counter.n, 1);
});

test("sanitizeAgentName follows the 1..80 char register rules", () => {
  assert.equal(sanitizeAgentName("  Jane   Doe ", "j@x.com"), "Jane Doe");
  assert.equal(sanitizeAgentName("<script>alert(1)</script>", "j@x.com"), "script alert(1) /script");
  assert.equal(sanitizeAgentName("a\u0000b\u202Ec\u200Bd", "j@x.com"), "a b c d");
  assert.equal(sanitizeAgentName("x".repeat(200), "j@x.com").length, 80);
  assert.ok(sanitizeAgentName("😀".repeat(100), "j@x.com").length <= 80);
  assert.equal(sanitizeAgentName(undefined, "jane.doe@example.com"), "jane.doe");
  assert.equal(sanitizeAgentName("   ", "jane@example.com"), "jane");
  assert.equal(sanitizeAgentName("\u0000", "@example.com"), "Google user");
});

test("parseClientIds", () => {
  assert.deepEqual(parseClientIds(""), []);
  assert.deepEqual(parseClientIds(null), []);
  assert.deepEqual(parseClientIds(" a.apps.googleusercontent.com, b ;c\n a.apps.googleusercontent.com"), ["a.apps.googleusercontent.com", "b", ";c"]);
});
