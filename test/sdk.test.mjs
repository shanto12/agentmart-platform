// Offline unit tests for sdk/js. Global fetch is replaced so a missed mock cannot hit the network.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, test } from "node:test";
import {
  AgentMart,
  AgentMartError,
  DEFAULT_BASE_URL,
  VERSION,
  newIdempotencyKey,
  unwrap,
} from "../sdk/js/agentmart.mjs";

const saved = {
  api: process.env.AGENTMART_API,
  key: process.env.AGENTMART_API_KEY,
  globalApi: globalThis.AGENTMART_API,
  fetch: globalThis.fetch,
};

delete process.env.AGENTMART_API;
delete process.env.AGENTMART_API_KEY;
delete globalThis.AGENTMART_API;
globalThis.fetch = async () => {
  throw new Error("offline: global fetch was called");
};

after(() => {
  if (saved.api === undefined) delete process.env.AGENTMART_API;
  else process.env.AGENTMART_API = saved.api;
  if (saved.key === undefined) delete process.env.AGENTMART_API_KEY;
  else process.env.AGENTMART_API_KEY = saved.key;
  if (saved.globalApi === undefined) delete globalThis.AGENTMART_API;
  else globalThis.AGENTMART_API = saved.globalApi;
  globalThis.fetch = saved.fetch;
});

function response(spec = {}) {
  const text = Object.prototype.hasOwnProperty.call(spec, "text")
    ? spec.text
    : spec.body === undefined
      ? ""
      : typeof spec.body === "string"
        ? spec.body
        : JSON.stringify(spec.body);
  const headers = spec.headers || {};
  return {
    status: spec.status ?? 200,
    headers: {
      forEach(fn) {
        for (const [key, value] of Object.entries(headers)) fn(String(value), String(key));
      },
    },
    async text() {
      return text;
    },
  };
}

function createClient(handler, opts = {}) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const snap = {
      url: String(url),
      method: init.method,
      headers: { ...(init.headers || {}) },
      body: init.body,
    };
    calls.push(snap);
    if (init.signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    const spec = await handler(snap, calls, init);
    return response(spec || {});
  }
  const client = new AgentMart({
    baseUrl: "http://agentmart.test/api",
    maxRetries: 0,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    timeoutMs: 1000,
    ...opts,
    fetch: fetchImpl,
  });
  return { client, calls };
}

test("version and default base url", () => {
  assert.equal(VERSION, "1.1.0");
  assert.equal(DEFAULT_BASE_URL, "https://spauxptabyipnhjgboxm.supabase.co/functions/v1/api");
});

test("constructor strips trailing slashes and prefers an explicit base url", () => {
  const { client } = createClient(() => ({ body: {} }), { baseUrl: "http://agentmart.test/api///" });
  assert.equal(client.baseUrl, "http://agentmart.test/api");
});

test("constructor reads the env base and key when options omit them", () => {
  process.env.AGENTMART_API = "http://from-env.test/root/";
  process.env.AGENTMART_API_KEY = "am_live_env";
  try {
    const { client } = createClient(() => ({ body: {} }), { baseUrl: undefined, apiKey: undefined });
    assert.equal(client.baseUrl, "http://from-env.test/root");
    assert.equal(client.apiKey, "am_live_env");
  } finally {
    delete process.env.AGENTMART_API;
    delete process.env.AGENTMART_API_KEY;
  }
});

test("globalThis.AGENTMART_API wins over the env base", () => {
  globalThis.AGENTMART_API = "http://global.test/api/";
  process.env.AGENTMART_API = "http://from-env.test/root";
  try {
    const { client } = createClient(() => ({ body: {} }), { baseUrl: undefined });
    assert.equal(client.baseUrl, "http://global.test/api");
  } finally {
    delete globalThis.AGENTMART_API;
    delete process.env.AGENTMART_API;
  }
});

test("constructor throws when no fetch exists", () => {
  const previous = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    assert.throws(() => new AgentMart({ baseUrl: "http://agentmart.test" }), /no fetch implementation/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("GET builds the query, skips nulls, and sends the bearer token", async () => {
  const { client, calls } = createClient(() => ({ body: { ok: true }, headers: { "X-Request-Id": "req_1" } }), {
    apiKey: "am_live_test",
    userAgent: "agentmart-test",
  });
  const body = await client.request("get", "v1/listings", {
    params: { q: "a b", kind: ["physical", "digital"], skip: null, missing: undefined, limit: 12 },
  });
  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "http://agentmart.test/api/v1/listings");
  assert.equal(url.searchParams.get("q"), "a b");
  assert.deepEqual(url.searchParams.getAll("kind"), ["physical", "digital"]);
  assert.equal(url.searchParams.get("limit"), "12");
  assert.equal(url.searchParams.has("skip"), false);
  assert.equal(calls[0].headers.Authorization, "Bearer am_live_test");
  assert.equal(calls[0].headers.Accept, "application/json");
  assert.equal(calls[0].headers["User-Agent"], "agentmart-test");
  assert.equal(calls[0].headers["Content-Type"], undefined);
  assert.equal(calls[0].body, undefined);
  assert.equal(client.lastRequestId, "req_1");
  assert.equal(client.lastResponseHeaders["x-request-id"], "req_1");
});

test("auth false and an empty api key omit Authorization", async () => {
  const { client, calls } = createClient(() => ({ body: { name: "AgentMart" } }), { apiKey: "am_live_test" });
  await client.serviceInfo();
  assert.equal(calls[0].url, "http://agentmart.test/api/v1");
  assert.equal(calls[0].headers.Authorization, undefined);

  const quiet = createClient(() => ({ body: {} }), { apiKey: "" });
  await quiet.client.request("GET", "/v1/stats");
  assert.equal(quiet.calls[0].headers.Authorization, undefined);
});

test("POST sends JSON, and caller headers override defaults", async () => {
  const { client, calls } = createClient(() => ({ body: { id: "lst_1" } }), { apiKey: "am_live_test" });
  await client.request("POST", "/v1/listings", {
    body: { title: "Mug" },
    headers: { Accept: "application/vnd.custom" },
    idempotencyKey: "idem_fixed",
  });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.equal(calls[0].headers.Accept, "application/vnd.custom");
  assert.equal(calls[0].headers["Idempotency-Key"], "idem_fixed");
  assert.deepEqual(JSON.parse(calls[0].body), { title: "Mug" });
});

test("empty and blank JSON bodies return null; raw returns the text", async () => {
  const empty = createClient(() => ({ text: "" }));
  assert.equal(await empty.client.request("GET", "/v1/me/keys/k"), null);
  const blank = createClient(() => ({ text: " \n" }));
  assert.equal(await blank.client.request("GET", "/v1"), null);
  const raw = createClient(() => ({ text: "hello" }));
  assert.equal(await raw.client.llmsTxt(), "hello");
  assert.equal(raw.calls[0].headers.Accept, "text/plain");
});

test("invalid JSON and error envelopes become AgentMartError", async () => {
  const bad = createClient(() => ({ text: "not-json", headers: { "X-Request-Id": "req_bad" } }));
  await assert.rejects(bad.client.stats(), (err) => {
    assert.ok(err instanceof AgentMartError);
    assert.equal(err.code, "invalid_response");
    assert.equal(err.status, 200);
    assert.equal(err.requestId, "req_bad");
    return true;
  });

  const wrapped = createClient(() => ({
    status: 403,
    body: { error: { code: "mandate_exceeded", message: "over the cap", request_id: "req_body" } },
    headers: { "X-Request-Id": "req_header" },
  }));
  await assert.rejects(wrapped.client.wallet(), (err) => {
    assert.equal(err.code, "mandate_exceeded");
    assert.equal(err.detail, "over the cap");
    assert.equal(err.requestId, "req_body");
    assert.equal(err.request_id, "req_body");
    assert.equal(wrapped.client.lastRequestId, "req_header");
    assert.equal(err.retryable, false);
    assert.match(err.message, /\[403 mandate_exceeded\]/);
    return true;
  });

  const funds = createClient(() => ({ status: 402, body: { error: { message: "no funds" } } }));
  await assert.rejects(funds.client.wallet(), (err) => err.code === "insufficient_funds" && err.retryable === false);

  const html = createClient(() => ({ status: 404, text: "<html>missing</html>" }));
  await assert.rejects(html.client.getListing("lst_x"), (err) => err.code === "not_found" && err.detail === "<html>missing</html>");

  const down = createClient(() => ({ status: 500, text: "" }));
  await assert.rejects(down.client.stats(), (err) => err.code === "internal" && err.retryable === true);
});

test("retries retryable GET and idempotent POST calls, and stops otherwise", async () => {
  const limited = createClient(
    (_snap, calls) => (calls.length === 1
      ? { status: 429, body: { error: { code: "rate_limited", message: "slow" } }, headers: { "Retry-After": "0" } }
      : { body: { ok: true } }),
    { maxRetries: 2 },
  );
  assert.deepEqual(await limited.client.stats(), { ok: true });
  assert.equal(limited.calls.length, 2);

  const once = createClient(() => ({ status: 429, body: { error: { code: "rate_limited", message: "slow" } } }));
  await assert.rejects(once.client.stats(), (err) => err.code === "rate_limited");
  assert.equal(once.calls.length, 1);

  const post = createClient((_snap, calls) => {
    const attempt = calls.filter((call) => call.headers["Idempotency-Key"] === "idem_1").length;
    if (!calls.at(-1).headers["Idempotency-Key"]) return { status: 500, text: "" };
    if (attempt === 1) return { status: 500, text: "" };
    return { body: { id: "ord_1" } };
  }, { maxRetries: 1 });
  await assert.rejects(post.client.request("POST", "/v1/orders", { body: { listing_id: "lst_1" } }));
  assert.equal(post.calls.length, 1);
  assert.deepEqual(
    await post.client.request("POST", "/v1/orders", { body: { listing_id: "lst_1" }, idempotencyKey: "idem_1" }),
    { id: "ord_1" },
  );
  assert.equal(post.calls.length, 3);

  const put = createClient(
    (_snap, calls) => (calls.length === 1 ? { status: 502, text: "" } : { body: { max_order_cents: 1 } }),
    { maxRetries: 1 },
  );
  assert.deepEqual(await put.client.request("PUT", "/v1/me/mandate", { body: {} }), { max_order_cents: 1 });
  assert.equal(put.calls.length, 2);

  const clientError = createClient(() => ({ status: 400, body: { error: { code: "invalid_request", message: "no" } } }), {
    maxRetries: 3,
  });
  await assert.rejects(clientError.client.stats());
  assert.equal(clientError.calls.length, 1);
});

test("network failures retry on GET and an aborted caller signal is rethrown", async () => {
  const flaky = createClient((_snap, calls) => {
    if (calls.length === 1) throw new Error("boom");
    return { body: { agents: 1 } };
  }, { maxRetries: 1 });
  assert.deepEqual(await flaky.client.stats(), { agents: 1 });

  const down = createClient(() => {
    throw new Error("boom");
  });
  await assert.rejects(down.client.request("POST", "/v1/orders", { body: {} }), (err) => {
    assert.equal(err.code, "network_error");
    assert.equal(err.status, 0);
    assert.match(err.detail, /boom/);
    return true;
  });

  const { client } = createClient(() => ({ body: {} }));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(client.request("GET", "/v1", { signal: ac.signal }), (err) => err.name === "AbortError");
});

test("timeout becomes a network error", async () => {
  const { client } = createClient((_snap, _calls, init) => new Promise((_resolve, reject) => {
    const fail = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (init.signal?.aborted) fail();
    else init.signal?.addEventListener("abort", fail, { once: true });
  }), { timeoutMs: 30 });
  await assert.rejects(client.stats(), (err) => err instanceof AgentMartError && err.code === "network_error");
});

test("register and token update the stored credential only when asked", async () => {
  const registered = createClient(() => ({
    body: { agent: { id: "agt_1" }, credentials: { agent_id: "agt_1", api_key: "am_live_new", key_id: "key_1" } },
  }));
  await registered.client.register({ name: "shopper", email: null, description: undefined });
  assert.equal(registered.client.apiKey, "am_live_new");
  assert.equal(registered.calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(registered.calls[0].body), { name: "shopper" });

  const keep = createClient(() => ({
    body: { credentials: { api_key: "am_live_other" } },
  }), { apiKey: "am_live_existing" });
  await keep.client.register({ name: "seller", useCredentials: true });
  assert.equal(keep.client.apiKey, "am_live_existing");

  const skip = createClient(() => ({ body: { credentials: { api_key: "am_live_skip" } } }));
  await skip.client.register({ name: "seller", useCredentials: false });
  assert.equal(skip.client.apiKey, undefined);

  await assert.rejects(createClient(() => ({ body: {} })).client.token(), /api_key required/);

  const minted = createClient(() => ({ body: { access_token: "jwt_1", token_type: "Bearer", expires_in: 3600 } }), {
    apiKey: "am_live_test",
  });
  await minted.client.token({ agent_id: "agt_1", useToken: true });
  assert.equal(minted.client.apiKey, "jwt_1");
  assert.equal(minted.calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(minted.calls[0].body), { agent_id: "agt_1", api_key: "am_live_test" });
});

test("profile, keys, listings, and orders shape their requests", async () => {
  const { client, calls } = createClient(() => ({ body: { id: "ok" } }), { apiKey: "am_live_test" });
  await client.updateMe({ name: "N", email: null, description: undefined });
  assert.deepEqual(JSON.parse(calls.at(-1).body), { name: "N", email: null });

  await client.createListing({ title: "T", description: "D", kind: "digital", price_cents: 100, inventory: null });
  assert.deepEqual(JSON.parse(calls.at(-1).body), {
    title: "T",
    description: "D",
    kind: "digital",
    price_cents: 100,
    currency: "USD",
    inventory: null,
  });

  await client.getListing("lst a");
  assert.equal(calls.at(-1).url, "http://agentmart.test/api/v1/listings/lst%20a");

  await client.createOrder({ listing_id: "lst_1" });
  const order = calls.at(-1);
  assert.equal(order.method, "POST");
  assert.deepEqual(JSON.parse(order.body), { listing_id: "lst_1", quantity: 1 });
  assert.match(order.headers["Idempotency-Key"], /^idem_[0-9a-f]+$/);

  await client.deposit(500, { idempotencyKey: "idem_dep" });
  assert.equal(calls.at(-1).headers["Idempotency-Key"], "idem_dep");
  assert.deepEqual(JSON.parse(calls.at(-1).body), { amount_cents: 500 });

  await client.cancelOrder("ord_1");
  assert.equal(calls.at(-1).body, "{}");
  await client.cancelOrder("ord_1", "changed mind");
  assert.deepEqual(JSON.parse(calls.at(-1).body), { reason: "changed mind" });

  await client.sweep();
  assert.equal(calls.at(-1).url, "http://agentmart.test/api/v1/admin/sweep");
  assert.equal(calls.at(-1).headers.Authorization, undefined);
});

test("list helpers accept a bare array or a page", async () => {
  const arrays = createClient(() => ({ body: [{ slug: "home" }] }));
  assert.deepEqual(await arrays.client.categories(), [{ slug: "home" }]);
  const pages = createClient(() => ({ body: { data: [{ id: "key_1" }] } }));
  assert.deepEqual(await pages.client.listKeys(), [{ id: "key_1" }]);
  const empty = createClient(() => ({ body: {} }));
  assert.deepEqual(await empty.client.categories(), []);
});

test("pagination and catalog sync follow next_cursor and sync_token", async () => {
  const pages = [
    { data: [{ id: "a" }], next_cursor: "c1" },
    { data: [{ id: "b" }], next_cursor: null },
  ];
  const listed = createClient(() => ({ body: pages.shift() }));
  const items = [];
  for await (const item of listed.client.iterListings({ q: "mug", limit: 1 })) items.push(item);
  assert.deepEqual(items, [{ id: "a" }, { id: "b" }]);
  assert.equal(new URL(listed.calls[0].url).searchParams.get("cursor"), null);
  assert.equal(new URL(listed.calls[1].url).searchParams.get("cursor"), "c1");
  assert.equal(new URL(listed.calls[1].url).searchParams.get("q"), "mug");

  const synced = createClient(() => ({
    body: { data: [{ id: "c" }], next_cursor: null, sync_token: "2026-01-01T00:00:00.000Z" },
  }));
  const result = await synced.client.syncCatalog("2020-01-01T00:00:00.000Z", { kind: "digital" });
  assert.equal(result.syncToken, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(result.items, [{ id: "c" }]);
  assert.equal(synced.client.lastSyncToken, "2026-01-01T00:00:00.000Z");
  const query = new URL(synced.calls[0].url).searchParams;
  assert.equal(query.get("updated_since"), "2020-01-01T00:00:00.000Z");
  assert.equal(query.get("kind"), "digital");
});

test("unwrap, idempotency keys, and error retry flags", () => {
  assert.deepEqual(unwrap({ order: { id: "ord_1" } }, "order"), { id: "ord_1" });
  assert.deepEqual(unwrap({ id: "outer", order: { id: "ord_1" } }, "order"), { id: "outer", order: { id: "ord_1" } });
  assert.equal(unwrap(null, "order"), null);
  assert.deepEqual(unwrap({ order: "x" }, "order"), { order: "x" });
  assert.match(newIdempotencyKey(), /^idem_[0-9a-f]{32}$/);
  assert.notEqual(newIdempotencyKey(), newIdempotencyKey());

  const err = new AgentMartError("conflict", "exists", 409, null);
  assert.equal(err.name, "AgentMartError");
  assert.equal(err.retryable, false);
  assert.equal(err.requestId, null);
  assert.equal(new AgentMartError("internal", "x", 500).retryable, true);
  assert.equal(new AgentMartError("network_error", "x", 0).retryable, true);
});

test("verifyWebhook accepts a fresh HMAC and rejects tampering", async () => {
  const secret = "whsec_test";
  const body = "{\"ok\":true}";
  const ts = String(Math.floor(Date.now() / 1000));
  const hex = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const header = `t=${ts}, v1=${hex}`;
  assert.equal(await AgentMart.verifyWebhook(body, header, secret), true);
  assert.equal(await AgentMart.verifyWebhook(body, header, "other"), false);
  assert.equal(await AgentMart.verifyWebhook(`${body}!`, header, secret), false);
  assert.equal(await AgentMart.verifyWebhook(body, "nope", secret), false);
  assert.equal(await AgentMart.verifyWebhook(body, `t=${ts},v1=${hex.slice(0, 8)}`, secret), false);

  const old = String(Math.floor(Date.now() / 1000) - 10_000);
  const oldHex = createHmac("sha256", secret).update(`${old}.${body}`).digest("hex");
  assert.equal(await AgentMart.verifyWebhook(body, `t=${old},v1=${oldHex}`, secret), false);
  assert.equal(await AgentMart.verifyWebhook(body, `t=${old},v1=${oldHex}`, secret, 0), true);
});
