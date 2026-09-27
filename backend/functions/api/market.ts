// Business logic: agents, keys, mandates, stores, listings, wallet/ledger, orders, events, webhooks.
// Every function here is transport-agnostic so the REST router and the MCP endpoint share it.
import postgres from "npm:postgres@3.4.5";
import { type AgentRow, type Db, idempotent, mintToken, newApiKey, sql, TOKEN_TTL_SECONDS, type Tx, verifyApiKey } from "./db.ts";
import {
  ApiError,
  bad,
  EMAIL_RE,
  hmacHex,
  httpsUrl,
  int,
  iso,
  type Json,
  newId,
  obj,
  oneOf,
  page,
  pageParams,
  randomHex,
  sha256Hex,
  str,
} from "./lib.ts";

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export interface EventRecord {
  id: string;
  type: string;
  agent_ids: string[];
  order_id: string | null;
  listing_id: string | null;
  data: Json;
  created_at: string;
}

export interface Ctx {
  requestId: string;
  agent: AgentRow | null;
  keyId: string | null;
  baseUrl: string;
  /** Events emitted while handling this request; webhooks fire after success. */
  events: EventRecord[];
}

export function requireAgent(ctx: Ctx): AgentRow {
  if (!ctx.agent) throw new ApiError("unauthorized", "Authentication required: send `Authorization: Bearer <api_key or access_token>`");
  return ctx.agent;
}

export interface Result {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
export const ok = (body: unknown, status = 200): Result => ({ status, body });

export const KINDS = ["physical", "digital", "service"] as const;
export type Kind = (typeof KINDS)[number];
export const ORDER_STATUSES = ["pending_payment", "paid", "fulfilled", "completed", "cancelled", "refunded", "disputed"] as const;

const PLATFORM = "agt_platform";
export const TREASURY = "agt_treasury";
const FEE_BPS = 500; // 5%
const FAUCET_MAX_PER_CALL = 100_000;
const FAUCET_MAX_LIFETIME = 500_000;
const AUTO_RELEASE_DAYS: Record<string, number> = { physical: 7, service: 3 };
const MAX_KEYS = 10;

/** Live funding mode: Stripe Checkout is used when STRIPE_SECRET_KEY is configured. */
export const stripeLive = () => !!Deno.env.get("STRIPE_SECRET_KEY");

const allowInsecureWebhooks = () => Deno.env.get("AGENTMART_ALLOW_INSECURE_WEBHOOKS") === "true";

// ---------------------------------------------------------------------------
// Views (DB row -> public JSON)
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

function agentView(a: Row, self: boolean): Json {
  const v: Json = {
    id: a.id,
    name: a.name,
    description: a.description,
    status: a.status,
    is_demo: a.is_demo,
    created_at: iso(a.created_at),
  };
  if (self) {
    v.email = a.email ?? null;
    v.operator_contact = a.operator_contact;
    v.webhook_url = a.webhook_url;
    v.updated_at = iso(a.updated_at);
  }
  return v;
}

export function walletView(w: Row): Json {
  return {
    agent_id: w.agent_id,
    available_cents: w.available_cents,
    held_cents: w.held_cents,
    currency: w.currency,
    mode: stripeLive() ? "live" : w.mode,
    lifetime_deposits_cents: w.lifetime_deposits_cents,
    faucet_remaining_cents: Math.max(0, FAUCET_MAX_LIFETIME - w.lifetime_deposits_cents),
  };
}

function mandateView(m: Row): Json {
  return {
    max_order_cents: m.max_order_cents,
    daily_limit_cents: m.daily_limit_cents,
    allowed_kinds: m.allowed_kinds,
    updated_at: iso(m.updated_at),
  };
}

/** `{ average (1 decimal) | null, count }` from rating_avg / rating_count columns. */
export function ratingView(avg: unknown, count: unknown): Json {
  const n = Number(count ?? 0);
  return { average: n > 0 && avg != null ? Math.round(Number(avg) * 10) / 10 : null, count: n };
}

/** Store rating aggregate columns for a store row aliased `s`. */
export const STORE_RATING = sql`
  (select round(avg(r.rating)::numeric, 1) from market.reviews r where r.store_id = s.id) as rating_avg,
  (select count(*)::int from market.reviews r where r.store_id = s.id) as rating_count`;

export function storeView(s: Row): Json {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    ships_from: s.ships_from,
    return_policy: s.return_policy,
    owner_agent_id: s.agent_id,
    rating: ratingView(s.rating_avg, s.rating_count),
    is_demo: s.is_demo,
    created_at: iso(s.created_at),
    updated_at: iso(s.updated_at),
  };
}

/** 0-100 score describing how well an agent buyer can evaluate this listing without asking questions. */
export function agentReadiness(l: Row): number {
  let s = 0;
  if ((l.title ?? "").length >= 10) s += 10;
  if ((l.description ?? "").length >= 80) s += 15;
  if (l.category) s += 10;
  const tags = l.tags ?? [];
  s += tags.length >= 3 ? 10 : tags.length >= 1 ? 5 : 0;
  if (l.attributes && Object.keys(l.attributes).length > 0) s += 10;
  if (l.image_url) s += 10;
  if (l.kind !== "physical" || l.inventory !== null) s += 5;
  if (l.kind === "physical" && l.shipping?.ships_to?.length && l.shipping?.handling_days !== undefined) s += 15;
  if (l.kind === "digital" && l.digital_delivery?.type) s += 15;
  if (l.kind === "service" && l.service_terms?.turnaround_days && l.service_terms?.deliverable) s += 15;
  if (l.store_return_policy) s += 10;
  if (l.store_description) s += 5;
  return Math.min(100, s);
}

export function listingView(l: Row, opts: { owner?: boolean } = {}): Json {
  const v: Json = {
    id: l.id,
    title: l.title,
    description: l.description,
    kind: l.kind,
    price_cents: l.price_cents,
    currency: l.currency,
    inventory: l.inventory,
    in_stock: l.status !== "sold_out" && (l.inventory === null || l.inventory > 0),
    category: l.category,
    tags: l.tags,
    attributes: l.attributes,
    image_url: l.image_url,
    shipping: l.kind === "physical" ? l.shipping : undefined,
    digital_delivery: l.kind === "digital"
      ? (opts.owner ? l.digital_delivery : { type: l.digital_delivery?.type ?? null })
      : undefined,
    service_terms: l.kind === "service" ? l.service_terms : undefined,
    status: l.status,
    sold_count: l.sold_count,
    rating: ratingView(l.rating_avg, l.rating_count),
    is_demo: l.is_demo,
    store: { id: l.store_id, slug: l.store_slug, name: l.store_name },
    seller_agent_id: l.agent_id,
    agent_readiness: agentReadiness(l),
    created_at: iso(l.created_at),
    updated_at: iso(l.updated_at),
  };
  for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
  return v;
}

function eventView(e: Row): Json {
  return {
    id: e.id,
    type: e.type,
    order_id: e.order_id,
    listing_id: e.listing_id,
    data: e.data,
    created_at: iso(e.created_at),
  };
}

function orderView(o: Row, viewerId: string, events: Row[]): Json {
  const isBuyer = viewerId === o.buyer_agent_id;
  const v: Json = {
    id: o.id,
    status: o.status,
    listing_id: o.listing_id,
    listing_title: o.listing_title,
    kind: o.kind,
    quantity: o.quantity,
    unit_price_cents: o.unit_price_cents,
    shipping_cents: o.shipping_cents,
    subtotal_cents: o.subtotal_cents,
    total_cents: o.total_cents,
    fee_cents: o.fee_cents,
    currency: o.currency,
    buyer_agent_id: o.buyer_agent_id,
    seller_agent_id: o.seller_agent_id,
    store_slug: o.store_slug,
    role: isBuyer ? "buyer" : "seller",
    shipping_address: o.shipping_address,
    note: o.note,
    fulfillment: o.fulfillment,
    dispute: o.dispute,
    auto_release_at: iso(o.auto_release_at),
    paid_at: iso(o.paid_at),
    fulfilled_at: iso(o.fulfilled_at),
    completed_at: iso(o.completed_at),
    cancelled_at: iso(o.cancelled_at),
    refunded_at: iso(o.refunded_at),
    disputed_at: iso(o.disputed_at),
    events: events.map((e) => ({ type: e.type, at: iso(e.created_at), data: e.data })),
    created_at: iso(o.created_at),
    updated_at: iso(o.updated_at),
  };
  // Digital payload is only ever shown to the buyer, once paid.
  if (isBuyer && o.kind === "digital" && ["paid", "fulfilled", "completed", "disputed"].includes(o.status)) {
    v.delivery = o.delivery;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Events & webhooks
// ---------------------------------------------------------------------------

export async function emit(
  tx: Db,
  ctx: Ctx,
  type: string,
  agentIds: string[],
  refs: { orderId?: string; listingId?: string },
  data: Json,
): Promise<void> {
  const id = newId("evt");
  const [row] = await tx<{ created_at: Date }[]>`
    insert into market.events (id, type, agent_ids, order_id, listing_id, data)
    values (${id}, ${type}, ${agentIds}, ${refs.orderId ?? null}, ${refs.listingId ?? null}, ${tx.json(data as postgres.JSONValue)})
    returning created_at`;
  ctx.events.push({
    id,
    type,
    agent_ids: agentIds,
    order_id: refs.orderId ?? null,
    listing_id: refs.listingId ?? null,
    data,
    created_at: iso(row.created_at)!,
  });
}

function orderEventData(o: Row, extra: Json = {}): Json {
  return {
    order_id: o.id,
    status: o.status,
    listing_id: o.listing_id,
    kind: o.kind,
    total_cents: o.total_cents,
    buyer_agent_id: o.buyer_agent_id,
    seller_agent_id: o.seller_agent_id,
    ...extra,
  };
}

/**
 * Best-effort webhook fan-out for events committed by this request. Each POST
 * is signed `AgentMart-Signature: t=<ts>,v1=<hmac_sha256(secret, "ts.body")>`,
 * has a 3s timeout and is logged to market.webhook_deliveries. Never throws.
 */
export async function dispatchWebhooks(events: EventRecord[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const ids = [...new Set(events.flatMap((e) => e.agent_ids))];
    const targets = await sql<{ id: string; webhook_url: string; webhook_secret: string }[]>`
      select id, webhook_url, webhook_secret from market.agents
       where id = any(${ids}) and webhook_url is not null and webhook_secret is not null and status = 'active'`;
    if (targets.length === 0) return;
    const jobs: Promise<void>[] = [];
    for (const ev of events) {
      for (const t of targets) {
        if (!ev.agent_ids.includes(t.id)) continue;
        jobs.push(deliver(ev, t));
      }
    }
    await Promise.allSettled(jobs);
  } catch (e) {
    console.error("webhook dispatch failed", e);
  }
}

async function deliver(ev: EventRecord, t: { id: string; webhook_url: string; webhook_secret: string }): Promise<void> {
  const body = JSON.stringify({
    id: ev.id,
    type: ev.type,
    created_at: ev.created_at,
    agent_id: t.id,
    order_id: ev.order_id,
    listing_id: ev.listing_id,
    data: ev.data,
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(t.webhook_secret, `${ts}.${body}`);
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(t.webhook_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "AgentMart-Webhooks/1.0",
        "agentmart-event": ev.type,
        "agentmart-event-id": ev.id,
        "agentmart-signature": `t=${ts},v1=${sig}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    status = res.status;
    await res.body?.cancel();
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 500);
  }
  const okd = status !== null && status >= 200 && status < 300;
  if (!okd) console.warn(`webhook ${ev.id} -> ${t.webhook_url} failed: ${status ?? error}`);
  await sql`insert into market.webhook_deliveries (event_id, agent_id, url, status_code, ok, error, duration_ms)
            values (${ev.id}, ${t.id}, ${t.webhook_url}, ${status}, ${okd}, ${error}, ${Date.now() - started})`
    .catch((e) => console.error("webhook log failed", e));
}

export async function listEvents(ctx: Ctx, q: URLSearchParams): Promise<Result> {
  const me = requireAgent(ctx);
  const { limit, offset } = pageParams(q);
  const since = q.get("since");
  let sinceFrag = sql``;
  if (since) {
    if (since.startsWith("evt_")) {
      sinceFrag = sql`and e.seq > coalesce((select seq from market.events where id = ${since}), 0)`;
    } else {
      const d = new Date(since);
      if (isNaN(d.getTime())) throw bad("since must be an ISO-8601 timestamp or an event id", { field: "since" });
      sinceFrag = sql`and e.created_at > ${d}`;
    }
  }
  const rows = await sql<Row[]>`
    select * from market.events e
     where ${me.id} = any(e.agent_ids) ${sinceFrag}
     order by e.seq asc limit ${limit + 1} offset ${offset}`;
  const p = page(rows.map(eventView), limit, offset);
  const last = p.data.at(-1);
  return ok({ ...p, next_since: last ? last.id : since ?? null });
}

// ---------------------------------------------------------------------------
// Agents, auth, keys
// ---------------------------------------------------------------------------

function webhookUrl(v: unknown): string | null | undefined {
  if (v === null) return null;
  const insecure = allowInsecureWebhooks();
  const u = httpsUrl(v, "webhook_url", { allowHttp: insecure });
  if (u === undefined) return undefined;
  if (!insecure) {
    const host = new URL(u).hostname;
    // Minimal SSRF guard: no loopback / private / link-local literals.
    if (
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.startsWith("[")
    ) {
      throw bad("webhook_url must be a public https URL", { field: "webhook_url" });
    }
  }
  return u;
}

/** Optional agent email: validated, lower-cased, <= 254 chars. null clears it. */
function emailField(v: unknown): string | null | undefined {
  if (v === null) return null;
  return str(v, "email", { max: 254, pattern: EMAIL_RE, patternMsg: "email must be a valid email address" })?.toLowerCase();
}

function emailConflict(e: unknown): never {
  if ((e as { code?: string }).code === "23505" && String((e as { constraint_name?: string }).constraint_name ?? "").includes("email")) {
    throw new ApiError("conflict", "An agent with this email already exists", { field: "email" });
  }
  throw e;
}

export async function registerAgent(_ctx: Ctx, raw: unknown): Promise<Result> {
  const b = obj(raw);
  const name = str(b.name, "name", { max: 80, required: true })!;
  const description = str(b.description, "description", { max: 1000 }) ?? null;
  const contact = str(b.operator_contact, "operator_contact", { max: 254, pattern: EMAIL_RE, patternMsg: "operator_contact must be an email address" }) ?? null;
  const hook = webhookUrl(b.webhook_url) ?? null;
  const email = emailField(b.email) ?? null;
  const agentId = newId("agt");
  const keyId = newId("key");
  const { secret, prefix } = newApiKey();
  const hash = await sha256Hex(secret);
  const whsec = hook ? `whsec_${randomHex(24)}` : null;

  const agent = await sql.begin(async (tx) => {
    const [a] = await tx<Row[]>`
      insert into market.agents (id, name, description, operator_contact, webhook_url, webhook_secret, email)
      values (${agentId}, ${name}, ${description}, ${contact}, ${hook}, ${whsec}, ${email}) returning *`;
    await tx`insert into market.api_keys (id, agent_id, key_prefix, key_hash, label)
             values (${keyId}, ${agentId}, ${prefix}, ${hash}, 'default')`;
    await tx`insert into market.wallets (agent_id) values (${agentId})`;
    await tx`insert into market.mandates (agent_id) values (${agentId})`;
    return a;
  }).catch(emailConflict);

  const body: Json = {
    agent: agentView(agent, true),
    credentials: { agent_id: agentId, api_key: secret, key_id: keyId },
    note: "Store api_key securely: it is shown only once. Use it as `Authorization: Bearer <api_key>` or exchange it at POST /v1/auth/token for a 1h JWT. Your sandbox wallet starts at 0; fund it with POST /v1/wallet/deposit.",
  };
  if (whsec) body.webhook_secret = whsec;
  return ok(body, 201);
}

export async function issueToken(raw: unknown): Promise<Result> {
  const b = obj(raw);
  const agentId = str(b.agent_id, "agent_id", { max: 64, required: true })!;
  const apiKey = str(b.api_key, "api_key", { max: 128, required: true })!;
  const auth = await verifyApiKey(apiKey);
  if (!auth || auth.agent.id !== agentId) throw new ApiError("unauthorized", "Invalid agent_id or api_key");
  return ok({
    access_token: await mintToken(auth.agent.id, auth.keyId),
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
  });
}

export async function getMe(ctx: Ctx): Promise<Result> {
  const me = requireAgent(ctx);
  const [[w], [m], [s]] = await Promise.all([
    sql<Row[]>`select * from market.wallets where agent_id = ${me.id}`,
    sql<Row[]>`select * from market.mandates where agent_id = ${me.id}`,
    sql<Row[]>`select s.*, ${STORE_RATING} from market.stores s where s.agent_id = ${me.id}`,
  ]);
  return ok({
    agent: agentView(me, true),
    wallet: walletView(w),
    mandate: mandateView(m),
    store: s ? storeView(s) : null,
    auth: { key_id: ctx.keyId },
  });
}

export async function patchMe(ctx: Ctx, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const b = obj(raw);
  const name = str(b.name, "name", { max: 80 });
  const description = "description" in b ? (str(b.description, "description", { max: 1000 }) ?? null) : undefined;
  const contact = "operator_contact" in b
    ? (str(b.operator_contact, "operator_contact", { max: 254, pattern: EMAIL_RE, patternMsg: "operator_contact must be an email address" }) ?? null)
    : undefined;
  const hook = "webhook_url" in b ? (webhookUrl(b.webhook_url) ?? null) : undefined;
  const email = "email" in b ? (emailField(b.email) ?? null) : undefined;
  // A new secret is issued whenever a (new or changed) webhook URL is set.
  const rotate = hook !== undefined && hook !== null;
  const whsec = rotate ? `whsec_${randomHex(24)}` : hook === null ? null : undefined;

  const [a] = await sql<Row[]>`
    update market.agents set
      name = coalesce(${name ?? null}, name),
      description = case when ${description !== undefined} then ${description ?? null} else description end,
      operator_contact = case when ${contact !== undefined} then ${contact ?? null} else operator_contact end,
      webhook_url = case when ${hook !== undefined} then ${hook ?? null} else webhook_url end,
      webhook_secret = case when ${whsec !== undefined} then ${whsec ?? null} else webhook_secret end,
      email = case when ${email !== undefined} then ${email ?? null} else email end
    where id = ${me.id} returning *`.catch(emailConflict);
  const body: Json = { agent: agentView(a, true) };
  if (rotate) body.webhook_secret = whsec;
  return ok(body);
}

function keyView(k: Row): Json {
  return {
    id: k.id,
    prefix: k.key_prefix,
    label: k.label,
    status: k.revoked_at ? "revoked" : "active",
    created_at: iso(k.created_at),
    last_used_at: iso(k.last_used_at),
    revoked_at: iso(k.revoked_at),
  };
}

export async function listKeys(ctx: Ctx): Promise<Result> {
  const me = requireAgent(ctx);
  const rows = await sql<Row[]>`select * from market.api_keys where agent_id = ${me.id} order by created_at`;
  return ok({ data: rows.map(keyView), next_cursor: null });
}

export async function createKey(ctx: Ctx, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const b = raw === undefined || raw === null ? {} : obj(raw);
  const label = str(b.label, "label", { max: 80 }) ?? null;
  const { secret, prefix } = newApiKey();
  const hash = await sha256Hex(secret);
  const id = newId("key");
  const row = await sql.begin(async (tx) => {
    // Serialise key creation per agent so the cap can't be raced.
    await tx`select id from market.agents where id = ${me.id} for update`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from market.api_keys where agent_id = ${me.id} and revoked_at is null`;
    if (n >= MAX_KEYS) throw new ApiError("conflict", `An agent may have at most ${MAX_KEYS} active keys`);
    const [k] = await tx<Row[]>`
      insert into market.api_keys (id, agent_id, key_prefix, key_hash, label)
      values (${id}, ${me.id}, ${prefix}, ${hash}, ${label}) returning *`;
    return k;
  });
  return ok({ key: keyView(row), api_key: secret, note: "The api_key is shown only once." }, 201);
}

export async function revokeKey(ctx: Ctx, keyId: string): Promise<Result> {
  const me = requireAgent(ctx);
  const row = await sql.begin(async (tx) => {
    await tx`select id from market.agents where id = ${me.id} for update`;
    const [k] = await tx<Row[]>`select * from market.api_keys where id = ${keyId} and agent_id = ${me.id}`;
    if (!k) throw new ApiError("not_found", "Key not found");
    if (k.revoked_at) return k;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from market.api_keys where agent_id = ${me.id} and revoked_at is null`;
    if (n <= 1) throw new ApiError("conflict", "Cannot revoke the last active key; create another key first");
    const [u] = await tx<Row[]>`update market.api_keys set revoked_at = now() where id = ${keyId} returning *`;
    return u;
  });
  return ok({ key: keyView(row) });
}

// ---------------------------------------------------------------------------
// Mandate
// ---------------------------------------------------------------------------

export async function getMandate(ctx: Ctx): Promise<Result> {
  const me = requireAgent(ctx);
  const [m] = await sql<Row[]>`select * from market.mandates where agent_id = ${me.id}`;
  return ok(mandateView(m));
}

export async function putMandate(ctx: Ctx, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const b = obj(raw);
  const maxOrder = int(b.max_order_cents, "max_order_cents", { min: 0, max: 100_000_000, required: true })!;
  const daily = int(b.daily_limit_cents, "daily_limit_cents", { min: 0, max: 1_000_000_000, required: true })!;
  if (!Array.isArray(b.allowed_kinds)) throw bad("allowed_kinds must be an array", { field: "allowed_kinds" });
  const kinds = [...new Set(b.allowed_kinds.map((k, i) => oneOf(k, `allowed_kinds[${i}]`, KINDS, true)!))];
  const [m] = await sql<Row[]>`
    insert into market.mandates (agent_id, max_order_cents, daily_limit_cents, allowed_kinds)
    values (${me.id}, ${maxOrder}, ${daily}, ${kinds})
    on conflict (agent_id) do update set max_order_cents = excluded.max_order_cents,
      daily_limit_cents = excluded.daily_limit_cents, allowed_kinds = excluded.allowed_kinds
    returning *`;
  return ok(mandateView(m));
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;

function storeFields(b: Json, creating: boolean) {
  const slug = str(b.slug, "slug", {
    max: 48,
    required: creating,
    pattern: SLUG_RE,
    patternMsg: "slug must be 1-48 chars of a-z, 0-9 and '-', not starting or ending with '-'",
  });
  if (slug === "me") throw bad("slug 'me' is reserved", { field: "slug" });
  return {
    slug,
    name: str(b.name, "name", { max: 80, required: creating }),
    description: str(b.description, "description", { max: 2000 }),
    ships_from: str(b.ships_from, "ships_from", { max: 80 }),
    return_policy: str(b.return_policy, "return_policy", { max: 2000 }),
  };
}

export async function createStore(ctx: Ctx, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const f = storeFields(obj(raw), true);
  try {
    const [s] = await sql<Row[]>`
      insert into market.stores (id, agent_id, slug, name, description, ships_from, return_policy)
      values (${newId("str")}, ${me.id}, ${f.slug!}, ${f.name!}, ${f.description ?? null}, ${f.ships_from ?? null}, ${f.return_policy ?? null})
      returning *`;
    return ok(storeView(s), 201);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      const detail = String((e as { constraint_name?: string }).constraint_name ?? "");
      if (detail.includes("agent")) throw new ApiError("conflict", "This agent already has a store (one store per agent in v1)");
      throw new ApiError("conflict", `Store slug '${f.slug}' is already taken`, { field: "slug" });
    }
    throw e;
  }
}

export const LISTING_SELECT = sql`
  select l.*, s.slug as store_slug, s.name as store_name,
         s.return_policy as store_return_policy, s.description as store_description
    from market.listings l join market.stores s on s.id = l.store_id`;

export async function getStore(ctx: Ctx, slug: string): Promise<Result> {
  const [s] = await sql<Row[]>`select s.*, ${STORE_RATING} from market.stores s where s.slug = ${slug}`;
  if (!s) throw new ApiError("not_found", "Store not found");
  const owner = ctx.agent?.id === s.agent_id;
  const listings = await sql<Row[]>`${LISTING_SELECT}
    where l.store_id = ${s.id} and ${owner ? sql`l.status <> 'archived'` : sql`l.status = 'active'`}
    order by l.created_at desc limit 200`;
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from market.orders where seller_agent_id = ${s.agent_id} and status = 'completed'`;
  return ok({ ...storeView(s), completed_sales: n, listings: listings.map((l) => listingView(l, { owner })) });
}

export async function getMyStore(ctx: Ctx): Promise<Result> {
  const me = requireAgent(ctx);
  const [s] = await sql<Row[]>`select slug from market.stores where agent_id = ${me.id}`;
  if (!s) throw new ApiError("not_found", "You have no store yet: POST /v1/stores");
  return await getStore(ctx, s.slug);
}

export async function patchMyStore(ctx: Ctx, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const b = obj(raw);
  const f = storeFields(b, false);
  const has = (k: string) => k in b;
  try {
    const [s] = await sql<Row[]>`
      update market.stores set
        slug = coalesce(${f.slug ?? null}, slug),
        name = coalesce(${f.name ?? null}, name),
        description = case when ${has("description")} then ${f.description ?? null} else description end,
        ships_from = case when ${has("ships_from")} then ${f.ships_from ?? null} else ships_from end,
        return_policy = case when ${has("return_policy")} then ${f.return_policy ?? null} else return_policy end
      where agent_id = ${me.id} returning *`;
    if (!s) throw new ApiError("not_found", "You have no store yet: POST /v1/stores");
    const [full] = await sql<Row[]>`select s.*, ${STORE_RATING} from market.stores s where s.id = ${s.id}`;
    return ok(storeView(full));
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ApiError("conflict", `Store slug '${f.slug}' is already taken`, { field: "slug" });
    throw e;
  }
}

export async function listStores(q: URLSearchParams): Promise<Result> {
  const { limit, offset } = pageParams(q);
  const rows = await sql<Row[]>`
    select s.*, ${STORE_RATING},
           (select count(*)::int from market.listings l where l.store_id = s.id and l.status = 'active') as active_listings
      from market.stores s order by s.created_at desc limit ${limit + 1} offset ${offset}`;
  return ok(page(rows.map((s) => ({ ...storeView(s), active_listings: s.active_listings })), limit, offset));
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

interface ListingFields {
  title: string;
  description: string;
  kind: Kind;
  price_cents: number;
  currency: "USD";
  inventory: number | null;
  category: string | null;
  tags: string[];
  attributes: Json;
  image_url: string | null;
  shipping: Json | null;
  digital_delivery: Json | null;
  service_terms: Json | null;
  status?: "active" | "paused";
}

/** Validates a full listing document (create, or current+patch merged). */
function validateListing(b: Json, opts: { allowStatus: boolean }): ListingFields {
  const kind = oneOf(b.kind, "kind", KINDS, true)!;
  const currency = oneOf(b.currency ?? "USD", "currency", ["USD"] as const, true)!;
  let inventory: number | null = null;
  if (b.inventory !== undefined && b.inventory !== null) {
    inventory = int(b.inventory, "inventory", { min: 0, max: 1_000_000 })!;
  } else if (kind === "physical") {
    throw bad("inventory (integer) is required for physical listings", { field: "inventory" });
  }

  let tags: string[] = [];
  if (b.tags !== undefined && b.tags !== null) {
    if (!Array.isArray(b.tags)) throw bad("tags must be an array of strings", { field: "tags" });
    if (b.tags.length > 10) throw bad("tags may contain at most 10 items", { field: "tags" });
    tags = [...new Set(b.tags.map((t, i) => str(t, `tags[${i}]`, { max: 40, required: true })!.toLowerCase()))];
  }

  let attributes: Json = {};
  if (b.attributes !== undefined && b.attributes !== null) {
    attributes = obj(b.attributes, "attributes");
    if (JSON.stringify(attributes).length > 5000) throw bad("attributes must serialise to at most 5000 characters", { field: "attributes" });
  }

  let shipping: Json | null = null;
  if (b.shipping !== undefined && b.shipping !== null) {
    if (kind !== "physical") throw bad("shipping is only allowed for physical listings", { field: "shipping" });
    const s = obj(b.shipping, "shipping");
    let shipsTo = ["US"];
    if (s.ships_to !== undefined) {
      if (!Array.isArray(s.ships_to) || s.ships_to.length === 0 || s.ships_to.length > 250) {
        throw bad("shipping.ships_to must be a non-empty array of ISO country codes", { field: "shipping.ships_to" });
      }
      shipsTo = [...new Set(s.ships_to.map((c, i) =>
        str(c, `shipping.ships_to[${i}]`, { max: 2, min: 2, required: true, pattern: /^[A-Za-z]{2}$/ })!.toUpperCase()
      ))];
    }
    shipping = {
      handling_days: int(s.handling_days, "shipping.handling_days", { min: 0, max: 60 }) ?? 3,
      ships_to: shipsTo,
      shipping_cents: int(s.shipping_cents, "shipping.shipping_cents", { min: 0, max: 1_000_000 }) ?? 0,
    };
  } else if (kind === "physical") {
    shipping = { handling_days: 3, ships_to: ["US"], shipping_cents: 0 };
  }

  let digital: Json | null = null;
  if (b.digital_delivery !== undefined && b.digital_delivery !== null) {
    if (kind !== "digital") throw bad("digital_delivery is only allowed for digital listings", { field: "digital_delivery" });
    const d = obj(b.digital_delivery, "digital_delivery");
    const type = oneOf(d.type, "digital_delivery.type", ["url", "text", "license_key"] as const, true)!;
    const payload = type === "url"
      ? httpsUrl(d.payload, "digital_delivery.payload") ?? (() => {
        throw bad("digital_delivery.payload is required", { field: "digital_delivery.payload" });
      })()
      : str(d.payload, "digital_delivery.payload", { max: 5000, required: true })!;
    digital = { type, payload };
  } else if (kind === "digital") {
    throw bad("digital_delivery { type, payload } is required for digital listings", { field: "digital_delivery" });
  }

  let service: Json | null = null;
  if (b.service_terms !== undefined && b.service_terms !== null) {
    if (kind !== "service") throw bad("service_terms is only allowed for service listings", { field: "service_terms" });
    const s = obj(b.service_terms, "service_terms");
    service = {
      turnaround_days: int(s.turnaround_days, "service_terms.turnaround_days", { min: 1, max: 365 }) ?? null,
      deliverable: str(s.deliverable, "service_terms.deliverable", { max: 1000 }) ?? null,
    };
  }

  const out: ListingFields = {
    title: str(b.title, "title", { max: 140, required: true })!,
    description: str(b.description, "description", { max: 5000, required: true })!,
    kind,
    price_cents: int(b.price_cents, "price_cents", { min: 50, max: 10_000_000, required: true })!,
    currency,
    inventory,
    category: categorySlug(str(b.category, "category", { max: 60 })),
    tags,
    attributes,
    image_url: httpsUrl(b.image_url, "image_url") ?? null,
    shipping,
    digital_delivery: digital,
    service_terms: service,
  };
  if (b.status !== undefined) {
    if (!opts.allowStatus) throw bad("status cannot be set on create", { field: "status" });
    out.status = oneOf(b.status, "status", ["active", "paused"] as const, true);
  }
  return out;
}

/** Normalises a category to a slug ("Home & Kitchen" -> "home-kitchen"). */
export function categorySlug(v: string | undefined | null): string | null {
  if (!v) return null;
  const slug = v.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || null;
}

export async function loadListing(db: Db, id: string, lock = false): Promise<Row | undefined> {
  const [l] = lock
    ? await db<Row[]>`${LISTING_SELECT} where l.id = ${id} for update of l`
    : await db<Row[]>`${LISTING_SELECT} where l.id = ${id}`;
  return l;
}

export async function createListing(ctx: Ctx, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const b = obj(raw);
  const f = validateListing(b, { allowStatus: false });
  const [store] = await sql<Row[]>`select id from market.stores where agent_id = ${me.id}`;
  if (!store) throw new ApiError("forbidden", "Create a store first: POST /v1/stores");
  const id = newId("lst");
  await sql`
    insert into market.listings (id, store_id, agent_id, title, description, kind, price_cents, currency, inventory,
      category, tags, attributes, image_url, shipping, digital_delivery, service_terms, status)
    values (${id}, ${store.id}, ${me.id}, ${f.title}, ${f.description}, ${f.kind}, ${f.price_cents}, ${f.currency},
      ${f.inventory}, ${f.category}, ${f.tags}, ${sql.json(f.attributes as postgres.JSONValue)}, ${f.image_url},
      ${f.shipping ? sql.json(f.shipping as postgres.JSONValue) : null},
      ${f.digital_delivery ? sql.json(f.digital_delivery as postgres.JSONValue) : null},
      ${f.service_terms ? sql.json(f.service_terms as postgres.JSONValue) : null},
      ${f.inventory === 0 ? "sold_out" : "active"})`;
  const l = await loadListing(sql, id);
  return ok(listingView(l!, { owner: true }), 201);
}

export async function patchListing(ctx: Ctx, id: string, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const patch = obj(raw);
  if ("kind" in patch) throw bad("kind cannot be changed", { field: "kind" });
  return ok(await sql.begin(async (tx) => {
    const cur = await loadListing(tx, id, true);
    if (!cur || cur.status === "archived") throw new ApiError("not_found", "Listing not found");
    if (cur.agent_id !== me.id) throw new ApiError("forbidden", "Only the seller can modify this listing");
    const merged: Json = {
      title: cur.title,
      description: cur.description,
      kind: cur.kind,
      price_cents: cur.price_cents,
      currency: cur.currency,
      inventory: cur.inventory,
      category: cur.category,
      tags: cur.tags,
      attributes: cur.attributes,
      image_url: cur.image_url,
      shipping: cur.shipping,
      digital_delivery: cur.digital_delivery,
      service_terms: cur.service_terms,
      ...patch,
    };
    const f = validateListing(merged, { allowStatus: true });
    // Status: explicit active/paused wins; otherwise keep, flipping sold_out<->active with stock.
    let status: string = f.status ?? (cur.status === "sold_out" ? "active" : cur.status);
    if (status === "active" && f.inventory === 0) status = "sold_out";
    await tx`
      update market.listings set title = ${f.title}, description = ${f.description}, price_cents = ${f.price_cents},
        inventory = ${f.inventory}, category = ${f.category}, tags = ${f.tags},
        attributes = ${tx.json(f.attributes as postgres.JSONValue)}, image_url = ${f.image_url},
        shipping = ${f.shipping ? tx.json(f.shipping as postgres.JSONValue) : null},
        digital_delivery = ${f.digital_delivery ? tx.json(f.digital_delivery as postgres.JSONValue) : null},
        service_terms = ${f.service_terms ? tx.json(f.service_terms as postgres.JSONValue) : null},
        status = ${status}
      where id = ${id}`;
    return listingView((await loadListing(tx, id))!, { owner: true });
  }));
}

export async function archiveListing(ctx: Ctx, id: string): Promise<Result> {
  const me = requireAgent(ctx);
  const l = await loadListing(sql, id);
  if (!l || l.status === "archived") throw new ApiError("not_found", "Listing not found");
  if (l.agent_id !== me.id) throw new ApiError("forbidden", "Only the seller can archive this listing");
  await sql`update market.listings set status = 'archived' where id = ${id}`;
  return ok(listingView({ ...l, status: "archived" }, { owner: true }));
}

export async function getListing(ctx: Ctx, id: string): Promise<Result> {
  const l = await loadListing(sql, id);
  const owner = !!l && ctx.agent?.id === l.agent_id;
  if (!l || (l.status === "archived" && !owner)) throw new ApiError("not_found", "Listing not found");
  const [seller] = await sql<Row[]>`
    select a.id, a.name, a.is_demo, a.created_at,
      (select count(*)::int from market.orders o where o.seller_agent_id = a.id and o.status = 'completed') as completed_sales,
      (select count(*)::int from market.listings x where x.agent_id = a.id and x.status = 'active') as active_listings
    from market.agents a where a.id = ${l.agent_id}`;
  return ok({
    ...listingView(l, { owner }),
    seller: {
      agent_id: seller.id,
      name: seller.name,
      is_demo: seller.is_demo,
      member_since: iso(seller.created_at),
      completed_sales: seller.completed_sales,
      active_listings: seller.active_listings,
      store: { slug: l.store_slug, name: l.store_name, return_policy: l.store_return_policy },
    },
    purchase: purchaseHint(l),
  });
}

/** Machine-readable "how to buy this" hint for agents. */
function purchaseHint(l: Row): Json {
  const physical = l.kind === "physical";
  return {
    available: l.status === "active" && (l.inventory === null || l.inventory > 0),
    endpoint: "POST /v1/orders",
    mcp_tool: "create_order",
    auth: "Authorization: Bearer <api_key | access_token>",
    required_fields: physical ? ["listing_id", "shipping_address"] : ["listing_id"],
    optional_fields: physical ? ["quantity", "note"] : ["quantity", "note", "shipping_address"],
    shipping_address_fields: physical ? ["name", "line1", "line2?", "city", "region", "postal_code", "country"] : undefined,
    ships_to: physical ? (l.shipping?.ships_to ?? []) : undefined,
    max_quantity: l.inventory === null ? 100 : Math.min(100, l.inventory),
    example: {
      listing_id: l.id,
      quantity: 1,
      ...(physical
        ? { shipping_address: { name: "Receiving Dock", line1: "1 Main St", city: "Austin", region: "TX", postal_code: "78701", country: (l.shipping?.ships_to ?? ["US"])[0] ?? "US" } }
        : {}),
    },
    headers: { "Idempotency-Key": "<unique key per purchase attempt>" },
    settlement: l.kind === "digital"
      ? "instant: order completes and `delivery` is returned in the response"
      : "escrow: funds held until you POST /v1/orders/{id}/confirm (auto-release " + (physical ? "7" : "3") + " days after fulfilment)",
  };
}

const CATEGORY_NAMES: Record<string, string> = {
  "home-kitchen": "Home & Kitchen",
  "electronics-accessories": "Electronics Accessories",
  "office-supplies": "Office Supplies",
  "pet": "Pet Supplies",
  "outdoor": "Outdoor",
  "beauty": "Beauty & Personal Care",
  "books": "Books & eBooks",
  "software": "Software Licenses",
  "datasets": "Datasets",
  "templates": "Templates",
  "services": "Services",
};
const categoryName = (slug: string) =>
  CATEGORY_NAMES[slug] ?? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** SQL expression normalising l.category to its slug (legacy rows may not be slugs). */
const CATEGORY_SLUG_SQL = sql`nullif(trim(both '-' from regexp_replace(lower(l.category), '[^a-z0-9]+', '-', 'g')), '')`;

export async function listCategories(): Promise<Result> {
  const rows = await sql<{ slug: string; n: number }[]>`
    select ${CATEGORY_SLUG_SQL} as slug, count(*)::int as n
      from market.listings l
     where l.status = 'active' and l.category is not null
     group by 1 having ${CATEGORY_SLUG_SQL} is not null
     order by n desc, slug`;
  return ok({ data: rows.map((r) => ({ slug: r.slug, name: categoryName(r.slug), listing_count: r.n })), next_cursor: null });
}

/** Compact full-catalog feed for agents that sync the marketplace (incremental via updated_since). */
export async function catalog(ctx: Ctx, q: URLSearchParams): Promise<Result> {
  const { limit, offset } = pageParams(q, 200, 100);
  const sinceRaw = q.get("updated_since");
  let since: Date | null = null;
  if (sinceRaw) {
    since = new Date(sinceRaw);
    if (isNaN(since.getTime())) throw bad("updated_since must be an ISO-8601 timestamp", { field: "updated_since" });
  }
  const kind = oneOf(q.get("kind") || undefined, "kind", KINDS);
  const rows = await sql<Row[]>`
    select l.id, l.title, l.kind, l.price_cents, l.currency, l.shipping, l.inventory, l.rating_avg, l.rating_count,
           l.category, l.updated_at, s.slug as store_slug
      from market.listings l join market.stores s on s.id = l.store_id
     where l.status = 'active'
       ${since ? sql`and l.updated_at > ${since}` : sql``}
       ${kind ? sql`and l.kind = ${kind}` : sql``}
     order by l.updated_at asc, l.id
     limit ${limit + 1} offset ${offset}`;
  const p = page(rows, limit, offset);
  const last = p.data.at(-1);
  return ok({
    data: p.data.map((l) => ({
      id: l.id,
      title: l.title,
      kind: l.kind,
      price_cents: l.price_cents,
      currency: l.currency,
      shipping_cents: l.kind === "physical" ? (l.shipping?.shipping_cents ?? 0) : 0,
      inventory: l.inventory,
      rating: ratingView(l.rating_avg, l.rating_count),
      category: l.category,
      store_slug: l.store_slug,
      url: `${ctx.baseUrl}/v1/listings/${l.id}`,
      updated_at: iso(l.updated_at),
    })),
    next_cursor: p.next_cursor,
    // Pass as updated_since on the next sync once next_cursor is null.
    sync_token: last ? iso(last.updated_at) : (sinceRaw ?? null),
  });
}

export async function searchListings(q: URLSearchParams): Promise<Result> {
  const { limit, offset } = pageParams(q);
  const text = str(q.get("q"), "q", { max: 200 });
  const kind = oneOf(q.get("kind") || undefined, "kind", KINDS);
  const category = categorySlug(str(q.get("category"), "category", { max: 60 }));
  const minRatingRaw = q.get("min_rating");
  let minRating: number | undefined;
  if (minRatingRaw !== null && minRatingRaw !== "") {
    minRating = Number(minRatingRaw);
    if (!Number.isFinite(minRating) || minRating < 1 || minRating > 5) throw bad("min_rating must be a number 1..5", { field: "min_rating" });
  }
  const store = str(q.get("store"), "store", { max: 48 });
  const num = (name: string) => {
    const v = q.get(name);
    if (v === null || v === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw bad(`${name} must be a non-negative integer (cents)`, { field: name });
    return n;
  };
  const minPrice = num("min_price");
  const maxPrice = num("max_price");
  const sort = oneOf(q.get("sort") || undefined, "sort", ["relevance", "price_asc", "price_desc", "newest", "rating"] as const) ??
    (text ? "relevance" : "newest");

  const like = text ? `%${text.replace(/[\\%_]/g, (m) => "\\" + m)}%` : null;
  const tsq = text ? sql`websearch_to_tsquery('english', ${text})` : sql`null`;
  const orderBy = sort === "price_asc"
    ? sql`l.price_cents asc, l.id`
    : sort === "price_desc"
    ? sql`l.price_cents desc, l.id`
    : sort === "rating"
    ? sql`l.rating_avg desc nulls last, l.rating_count desc, l.id`
    : sort === "relevance" && text
    ? sql`rank desc, l.created_at desc, l.id`
    : sql`l.created_at desc, l.id`;

  const rows = await sql<Row[]>`
    select * from (
      select l.*, s.slug as store_slug, s.name as store_name,
             s.return_policy as store_return_policy, s.description as store_description,
             ${text ? sql`ts_rank(l.search_tsv, ${tsq}) + case when l.title ilike ${like} then 0.5 else 0 end` : sql`0`} as rank
        from market.listings l join market.stores s on s.id = l.store_id
       where l.status = 'active'
         ${text ? sql`and (l.search_tsv @@ ${tsq} or l.title ilike ${like} or ${text.toLowerCase()} = any(l.tags))` : sql``}
         ${kind ? sql`and l.kind = ${kind}` : sql``}
         ${category ? sql`and ${CATEGORY_SLUG_SQL} = ${category}` : sql``}
         ${minRating !== undefined ? sql`and l.rating_avg >= ${minRating}` : sql``}
         ${store ? sql`and s.slug = ${store}` : sql``}
         ${minPrice !== undefined ? sql`and l.price_cents >= ${minPrice}` : sql``}
         ${maxPrice !== undefined ? sql`and l.price_cents <= ${maxPrice}` : sql``}
    ) l
    order by ${orderBy}
    limit ${limit + 1} offset ${offset}`;
  return ok(page(rows.map((l) => listingView(l)), limit, offset));
}

// ---------------------------------------------------------------------------
// Wallet & ledger
// ---------------------------------------------------------------------------

type LedgerType = "deposit" | "escrow_hold" | "escrow_release" | "payout" | "refund" | "fee";
interface Leg {
  agent: string;
  account: "available" | "held";
  type: LedgerType;
  amount: number; // signed cents
}

/**
 * Posts one balanced transfer. Locks every touched wallet with SELECT ... FOR
 * UPDATE in agent-id order (deadlock-safe), updates balances, and writes one
 * ledger entry per leg with its running balance. A deferred DB trigger also
 * asserts the transfer sums to zero at commit.
 */
export async function postTransfer(tx: Tx, legs: Leg[], meta: { orderId?: string; memo?: string } = {}): Promise<string> {
  const legsNz = legs.filter((l) => l.amount !== 0);
  if (legsNz.reduce((s, l) => s + l.amount, 0) !== 0) throw new ApiError("internal", "Unbalanced transfer");
  const ids = [...new Set(legsNz.map((l) => l.agent))].sort();
  const wallets = await tx<Row[]>`
    select agent_id, available_cents, held_cents from market.wallets
     where agent_id = any(${ids}) order by agent_id for update`;
  const byId = new Map(wallets.map((w) => [w.agent_id as string, { available: w.available_cents as number, held: w.held_cents as number }]));
  const transferId = newId("trf");
  for (const leg of legsNz) {
    const w = byId.get(leg.agent);
    if (!w) throw new ApiError("internal", `Wallet missing for ${leg.agent}`);
    w[leg.account] += leg.amount;
    if (w.held < 0 || (w.available < 0 && leg.agent !== TREASURY)) {
      throw new ApiError("insufficient_funds", "Insufficient available balance");
    }
    await tx`insert into market.ledger_entries
               (id, transfer_id, agent_id, account, type, amount_cents, balance_after_cents, order_id, memo)
             values (${newId("txn")}, ${transferId}, ${leg.agent}, ${leg.account}, ${leg.type}, ${leg.amount},
                     ${w[leg.account]}, ${meta.orderId ?? null}, ${meta.memo ?? null})`;
  }
  for (const [agent, w] of byId) {
    await tx`update market.wallets set available_cents = ${w.available}, held_cents = ${w.held} where agent_id = ${agent}`;
  }
  return transferId;
}

export async function getWallet(ctx: Ctx): Promise<Result> {
  const me = requireAgent(ctx);
  const [w] = await sql<Row[]>`select * from market.wallets where agent_id = ${me.id}`;
  return ok(walletView(w));
}

/** Reads a boolean flag from market.config (missing => default). */
export async function configFlag(key: string, dflt: boolean): Promise<boolean> {
  const [row] = await sql<{ value: string }[]>`select value from market.config where key = ${key}`;
  return row ? row.value.trim().toLowerCase() === "true" : dflt;
}

/** Sandbox faucet deposit (live Stripe funding is handled in payments.ts). */
export async function deposit(ctx: Ctx, raw: unknown, idemKey: string | null): Promise<Result> {
  const me = requireAgent(ctx);
  const b = obj(raw);
  if (!(await configFlag("faucet_enabled", true))) {
    throw new ApiError("forbidden", "Sandbox faucet disabled");
  }
  const amount = int(b.amount_cents, "amount_cents", { min: 1, max: FAUCET_MAX_PER_CALL, required: true })!;
  const res = await idempotent(me.id, idemKey, "POST /v1/wallet/deposit", b, async (tx) => {
    const [w] = await tx<Row[]>`select lifetime_deposits_cents from market.wallets where agent_id = ${me.id} for update`;
    if (w.lifetime_deposits_cents + amount > FAUCET_MAX_LIFETIME) {
      throw new ApiError("forbidden", `Sandbox faucet lifetime limit is ${FAUCET_MAX_LIFETIME} cents per agent`, {
        remaining_cents: Math.max(0, FAUCET_MAX_LIFETIME - w.lifetime_deposits_cents),
      });
    }
    const transferId = await postTransfer(tx, [
      { agent: TREASURY, account: "available", type: "deposit", amount: -amount },
      { agent: me.id, account: "available", type: "deposit", amount },
    ], { memo: "sandbox faucet deposit" });
    const [nw] = await tx<Row[]>`
      update market.wallets set lifetime_deposits_cents = lifetime_deposits_cents + ${amount}
       where agent_id = ${me.id} returning *`;
    return { status: 201, body: { ...walletView(nw), deposit: { amount_cents: amount, transfer_id: transferId } } };
  });
  return { status: res.status, body: res.body, headers: res.replayed ? { "Idempotent-Replayed": "true" } : undefined };
}

export async function listTransactions(ctx: Ctx, q: URLSearchParams): Promise<Result> {
  const me = requireAgent(ctx);
  const { limit, offset } = pageParams(q);
  const rows = await sql<Row[]>`
    select * from market.ledger_entries where agent_id = ${me.id}
     order by seq desc limit ${limit + 1} offset ${offset}`;
  return ok(page(rows.map((e) => ({
    id: e.id,
    transfer_id: e.transfer_id,
    type: e.type,
    account: e.account,
    amount_cents: e.amount_cents,
    balance_after_cents: e.balance_after_cents,
    currency: e.currency,
    order_id: e.order_id,
    memo: e.memo,
    created_at: iso(e.created_at),
  })), limit, offset));
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const ORDER_SELECT = sql`select o.*, s.slug as store_slug from market.orders o join market.stores s on s.id = o.store_id`;

async function orderEvents(db: Db, ids: string[]): Promise<Map<string, Row[]>> {
  const map = new Map<string, Row[]>();
  if (ids.length === 0) return map;
  const rows = await db<Row[]>`
    select order_id, type, data, created_at from market.events where order_id = any(${ids}) order by seq`;
  for (const r of rows) {
    if (!map.has(r.order_id)) map.set(r.order_id, []);
    map.get(r.order_id)!.push(r);
  }
  return map;
}

async function renderOrder(db: Db, id: string, viewerId: string): Promise<Json> {
  const [o] = await db<Row[]>`${ORDER_SELECT} where o.id = ${id}`;
  const ev = await orderEvents(db, [id]);
  return orderView(o, viewerId, ev.get(id) ?? []);
}

/** Locks an order for a state transition and checks the caller is a party to it. */
async function lockOrder(tx: Tx, id: string, agentId: string): Promise<Row> {
  const [o] = await tx<Row[]>`select * from market.orders where id = ${id} for update`;
  if (!o || (o.buyer_agent_id !== agentId && o.seller_agent_id !== agentId)) throw new ApiError("not_found", "Order not found");
  return o;
}

function requireStatus(o: Row, allowed: string[], action: string) {
  if (!allowed.includes(o.status)) {
    throw new ApiError("conflict", `Cannot ${action} an order in status '${o.status}' (allowed: ${allowed.join(", ")})`, {
      status: o.status,
    });
  }
}

/** Escrow release: buyer held -> seller available (minus fee) + platform fee. */
async function releaseEscrow(tx: Tx, ctx: Ctx, o: Row, reason: string): Promise<void> {
  const fee = o.fee_cents as number;
  await postTransfer(tx, [
    { agent: o.buyer_agent_id, account: "held", type: "escrow_release", amount: -o.total_cents },
    { agent: o.seller_agent_id, account: "available", type: "payout", amount: o.total_cents - fee },
    { agent: PLATFORM, account: "available", type: "fee", amount: fee },
  ], { orderId: o.id, memo: reason });
  const [u] = await tx<Row[]>`
    update market.orders set status = 'completed', completed_at = now(), auto_release_at = null
     where id = ${o.id} returning *`;
  await emit(tx, ctx, "order.completed", [o.buyer_agent_id, o.seller_agent_id], { orderId: o.id, listingId: o.listing_id },
    orderEventData(u, { payout_cents: o.total_cents - fee, fee_cents: fee, reason }));
}

/** Returns held funds to the buyer's available balance. */
async function refundEscrow(tx: Tx, o: Row, memo: string): Promise<void> {
  await postTransfer(tx, [
    { agent: o.buyer_agent_id, account: "held", type: "refund", amount: -o.total_cents },
    { agent: o.buyer_agent_id, account: "available", type: "refund", amount: o.total_cents },
  ], { orderId: o.id, memo });
}

function shippingAddress(v: unknown): Json {
  const a = obj(v, "shipping_address");
  const f = (k: string, max: number, required = true) => str(a[k], `shipping_address.${k}`, { max, required });
  return {
    name: f("name", 100)!,
    line1: f("line1", 200)!,
    line2: f("line2", 200, false) ?? null,
    city: f("city", 100)!,
    region: f("region", 100)!,
    postal_code: f("postal_code", 20)!,
    country: str(a.country, "shipping_address.country", {
      max: 2,
      min: 2,
      required: true,
      pattern: /^[A-Za-z]{2}$/,
      patternMsg: "shipping_address.country must be a 2-letter ISO country code",
    })!.toUpperCase(),
  };
}

export async function createOrder(ctx: Ctx, raw: unknown, idemKey: string | null): Promise<Result> {
  const me = requireAgent(ctx);
  const b = obj(raw);
  const listingId = str(b.listing_id, "listing_id", { max: 64, required: true })!;
  const quantity = int(b.quantity, "quantity", { min: 1, max: 100 }) ?? 1;
  const note = str(b.note, "note", { max: 1000 }) ?? null;

  const res = await idempotent(me.id, idemKey, "POST /v1/orders", b, async (tx) => {
    const l = await loadListing(tx, listingId, true);
    if (!l || l.status === "archived") throw new ApiError("not_found", "Listing not found");
    if (l.agent_id === me.id) throw new ApiError("forbidden", "You cannot buy your own listing");
    if (l.status === "paused") throw new ApiError("conflict", "Listing is paused and cannot be purchased");
    if (l.status === "sold_out" || (l.inventory !== null && l.inventory < quantity)) {
      throw new ApiError("out_of_stock", `Insufficient stock (available: ${l.inventory ?? 0})`, { available: l.inventory ?? 0 });
    }

    let address: Json | null = null;
    if (l.kind === "physical") {
      if (b.shipping_address === undefined || b.shipping_address === null) {
        throw bad("shipping_address is required for physical listings", { field: "shipping_address" });
      }
      address = shippingAddress(b.shipping_address);
      const shipsTo: string[] = l.shipping?.ships_to ?? [];
      if (shipsTo.length && !shipsTo.includes(address.country as string)) {
        throw bad(`This listing ships only to: ${shipsTo.join(", ")}`, { field: "shipping_address.country" });
      }
    } else if (b.shipping_address !== undefined && b.shipping_address !== null) {
      address = shippingAddress(b.shipping_address);
    }

    const subtotal = l.price_cents * quantity;
    const shippingCents = l.kind === "physical" ? (l.shipping?.shipping_cents ?? 0) : 0;
    const total = subtotal + shippingCents;
    const fee = Math.round((subtotal * FEE_BPS) / 10_000);

    // Lock the buyer wallet first: serialises this buyer's orders so the
    // rolling 24h mandate check and balance check cannot be raced.
    const [w] = await tx<Row[]>`select available_cents from market.wallets where agent_id = ${me.id} for update`;
    const [m] = await tx<Row[]>`select * from market.mandates where agent_id = ${me.id}`;
    if (m) {
      if (!m.allowed_kinds.includes(l.kind)) {
        throw new ApiError("mandate_exceeded", `Your mandate does not allow buying '${l.kind}' listings`, { rule: "allowed_kinds" });
      }
      if (total > m.max_order_cents) {
        throw new ApiError("mandate_exceeded", `Order total ${total} exceeds mandate max_order_cents ${m.max_order_cents}`, {
          rule: "max_order_cents",
          total_cents: total,
          limit_cents: m.max_order_cents,
        });
      }
      const [{ spent }] = await tx<{ spent: number }[]>`
        select coalesce(sum(total_cents), 0)::bigint as spent from market.orders
         where buyer_agent_id = ${me.id} and created_at > now() - interval '24 hours'
           and status not in ('cancelled', 'refunded')`;
      if (spent + total > m.daily_limit_cents) {
        throw new ApiError("mandate_exceeded", `Order would exceed mandate daily_limit_cents ${m.daily_limit_cents} (spent in last 24h: ${spent})`, {
          rule: "daily_limit_cents",
          spent_cents: spent,
          total_cents: total,
          limit_cents: m.daily_limit_cents,
        });
      }
    }
    if (w.available_cents < total) {
      throw new ApiError("insufficient_funds", `Order total ${total} exceeds available balance ${w.available_cents}`, {
        total_cents: total,
        available_cents: w.available_cents,
      });
    }

    // Inventory
    if (l.inventory !== null) {
      const left = l.inventory - quantity;
      await tx`update market.listings set inventory = ${left}, sold_count = sold_count + ${quantity},
                 status = ${left === 0 ? "sold_out" : l.status} where id = ${l.id}`;
      if (left === 0) {
        await emit(tx, ctx, "listing.sold_out", [l.agent_id], { listingId: l.id }, { listing_id: l.id, title: l.title });
      }
    } else {
      await tx`update market.listings set sold_count = sold_count + ${quantity} where id = ${l.id}`;
    }

    const orderId = newId("ord");
    const delivery = l.kind === "digital" ? l.digital_delivery : null;
    const [o] = await tx<Row[]>`
      insert into market.orders (id, buyer_agent_id, seller_agent_id, listing_id, store_id, listing_title, kind, quantity,
        unit_price_cents, shipping_cents, subtotal_cents, total_cents, fee_cents, status, shipping_address, note, delivery, paid_at)
      values (${orderId}, ${me.id}, ${l.agent_id}, ${l.id}, ${l.store_id}, ${l.title}, ${l.kind}, ${quantity},
        ${l.price_cents}, ${shippingCents}, ${subtotal}, ${total}, ${fee}, 'paid',
        ${address ? tx.json(address as postgres.JSONValue) : null}, ${note},
        ${delivery ? tx.json(delivery as postgres.JSONValue) : null}, now())
      returning *`;
    await postTransfer(tx, [
      { agent: me.id, account: "available", type: "escrow_hold", amount: -total },
      { agent: me.id, account: "held", type: "escrow_hold", amount: total },
    ], { orderId, memo: "escrow hold" });
    const parties = [me.id, l.agent_id];
    await emit(tx, ctx, "order.paid", parties, { orderId, listingId: l.id }, orderEventData(o));

    // Digital goods: delivered and settled instantly.
    if (l.kind === "digital") {
      const [f] = await tx<Row[]>`
        update market.orders set status = 'fulfilled', fulfilled_at = now(),
          fulfillment = ${tx.json({ method: "instant_digital", delivery_type: delivery?.type ?? null })}
         where id = ${orderId} returning *`;
      await emit(tx, ctx, "order.fulfilled", parties, { orderId, listingId: l.id }, orderEventData(f, { automatic: true }));
      await releaseEscrow(tx, ctx, f, "digital instant settlement");
    }
    return { status: 201, body: await renderOrder(tx, orderId, me.id) };
  });
  return { status: res.status, body: res.body, headers: res.replayed ? { "Idempotent-Replayed": "true" } : undefined };
}

/**
 * Lazy auto-release: completes fulfilled orders whose release window passed.
 * Cheap when there is nothing to do (partial index), safe under concurrency
 * (SKIP LOCKED), and idempotent.
 */
export async function sweep(ctx: Ctx, opts: { orderId?: string; limit?: number } = {}): Promise<number> {
  const due = opts.orderId
    ? await sql<{ id: string }[]>`select id from market.orders where id = ${opts.orderId} and status = 'fulfilled' and auto_release_at <= now()`
    : await sql<{ id: string }[]>`select id from market.orders where status = 'fulfilled' and auto_release_at <= now() order by auto_release_at limit ${opts.limit ?? 25}`;
  if (due.length === 0) return 0;
  let n = 0;
  await sql.begin(async (tx) => {
    const rows = await tx<Row[]>`
      select * from market.orders where id = any(${due.map((d) => d.id)})
         and status = 'fulfilled' and auto_release_at <= now()
       order by id for update skip locked`;
    for (const o of rows) {
      await releaseEscrow(tx, ctx, o, "auto-release after review window");
      n++;
    }
  });
  return n;
}

export async function listOrders(ctx: Ctx, q: URLSearchParams): Promise<Result> {
  const me = requireAgent(ctx);
  await sweep(ctx).catch((e) => console.error("sweep failed", e));
  const { limit, offset } = pageParams(q);
  const role = oneOf(q.get("role") || undefined, "role", ["buyer", "seller"] as const);
  const status = oneOf(q.get("status") || undefined, "status", ORDER_STATUSES);
  const who = role === "buyer"
    ? sql`o.buyer_agent_id = ${me.id}`
    : role === "seller"
    ? sql`o.seller_agent_id = ${me.id}`
    : sql`(o.buyer_agent_id = ${me.id} or o.seller_agent_id = ${me.id})`;
  const rows = await sql<Row[]>`${ORDER_SELECT}
    where ${who} ${status ? sql`and o.status = ${status}` : sql``}
    order by o.created_at desc, o.id limit ${limit + 1} offset ${offset}`;
  const p = page(rows, limit, offset);
  const ev = await orderEvents(sql, p.data.map((o) => o.id));
  return ok({ data: p.data.map((o) => orderView(o, me.id, ev.get(o.id) ?? [])), next_cursor: p.next_cursor });
}

export async function getOrder(ctx: Ctx, id: string): Promise<Result> {
  const me = requireAgent(ctx);
  await sweep(ctx, { orderId: id }).catch((e) => console.error("sweep failed", e));
  const [o] = await sql<Row[]>`${ORDER_SELECT} where o.id = ${id}`;
  if (!o || (o.buyer_agent_id !== me.id && o.seller_agent_id !== me.id)) throw new ApiError("not_found", "Order not found");
  const ev = await orderEvents(sql, [id]);
  return ok(orderView(o, me.id, ev.get(id) ?? []));
}

async function transition(ctx: Ctx, id: string, fn: (tx: Tx, o: Row, me: AgentRow) => Promise<void>): Promise<Result> {
  const me = requireAgent(ctx);
  const body = await sql.begin(async (tx) => {
    const o = await lockOrder(tx, id, me.id);
    await fn(tx, o, me);
    return await renderOrder(tx, id, me.id);
  });
  return ok(body);
}

export function fulfillOrder(ctx: Ctx, id: string, raw: unknown): Promise<Result> {
  return transition(ctx, id, async (tx, o, me) => {
    if (o.seller_agent_id !== me.id) throw new ApiError("forbidden", "Only the seller can fulfil this order");
    requireStatus(o, ["paid"], "fulfil");
    const b = raw === undefined || raw === null ? {} : obj(raw);
    let fulfillment: Json;
    if (o.kind === "physical") {
      fulfillment = {
        method: "shipment",
        carrier: str(b.carrier, "carrier", { max: 60, required: true })!,
        tracking_number: str(b.tracking_number, "tracking_number", { max: 100, required: true })!,
        tracking_url: httpsUrl(b.tracking_url, "tracking_url") ?? null,
      };
    } else {
      const url = httpsUrl(b.deliverable_url, "deliverable_url") ?? null;
      const message = str(b.message, "message", { max: 5000 }) ?? null;
      if (!url && !message) throw bad("Provide deliverable_url and/or message", { field: "deliverable_url" });
      fulfillment = { method: "service_delivery", deliverable_url: url, message };
    }
    const days = AUTO_RELEASE_DAYS[o.kind] ?? 7;
    const [u] = await tx<Row[]>`
      update market.orders set status = 'fulfilled', fulfilled_at = now(),
        fulfillment = ${tx.json({ ...fulfillment, fulfilled_at: new Date().toISOString() } as postgres.JSONValue)},
        auto_release_at = now() + make_interval(days => ${days})
       where id = ${o.id} returning *`;
    await emit(tx, ctx, "order.fulfilled", [o.buyer_agent_id, o.seller_agent_id], { orderId: o.id, listingId: o.listing_id },
      orderEventData(u, { fulfillment, auto_release_at: iso(u.auto_release_at) }));
  });
}

export function confirmOrder(ctx: Ctx, id: string): Promise<Result> {
  return transition(ctx, id, async (tx, o, me) => {
    if (o.buyer_agent_id !== me.id) throw new ApiError("forbidden", "Only the buyer can confirm this order");
    requireStatus(o, ["fulfilled"], "confirm");
    await releaseEscrow(tx, ctx, o, "buyer confirmed");
  });
}

export function cancelOrder(ctx: Ctx, id: string, raw: unknown): Promise<Result> {
  return transition(ctx, id, async (tx, o, me) => {
    requireStatus(o, ["paid"], "cancel");
    const b = raw === undefined || raw === null ? {} : obj(raw);
    const reason = str(b.reason, "reason", { max: 1000 }) ?? null;
    await refundEscrow(tx, o, "order cancelled");
    // Restock (and un-sell-out) the listing.
    await tx`update market.listings set
               inventory = case when inventory is null then null else inventory + ${o.quantity} end,
               sold_count = greatest(0, sold_count - ${o.quantity}),
               status = case when status = 'sold_out' then 'active' else status end
             where id = ${o.listing_id}`;
    const [u] = await tx<Row[]>`update market.orders set status = 'cancelled', cancelled_at = now() where id = ${o.id} returning *`;
    await emit(tx, ctx, "order.cancelled", [o.buyer_agent_id, o.seller_agent_id], { orderId: o.id, listingId: o.listing_id },
      orderEventData(u, { cancelled_by: me.id === o.buyer_agent_id ? "buyer" : "seller", reason, refunded_cents: o.total_cents }));
  });
}

export function refundOrder(ctx: Ctx, id: string, raw: unknown): Promise<Result> {
  return transition(ctx, id, async (tx, o, me) => {
    if (o.seller_agent_id !== me.id) throw new ApiError("forbidden", "Only the seller can refund this order");
    requireStatus(o, ["paid", "fulfilled", "disputed"], "refund");
    const b = raw === undefined || raw === null ? {} : obj(raw);
    const reason = str(b.reason, "reason", { max: 1000 }) ?? null;
    await refundEscrow(tx, o, "seller refund");
    const [u] = await tx<Row[]>`
      update market.orders set status = 'refunded', refunded_at = now(), auto_release_at = null where id = ${o.id} returning *`;
    await emit(tx, ctx, "order.refunded", [o.buyer_agent_id, o.seller_agent_id], { orderId: o.id, listingId: o.listing_id },
      orderEventData(u, { reason, refunded_cents: o.total_cents }));
  });
}

export function disputeOrder(ctx: Ctx, id: string, raw: unknown): Promise<Result> {
  return transition(ctx, id, async (tx, o, me) => {
    if (o.buyer_agent_id !== me.id) throw new ApiError("forbidden", "Only the buyer can dispute this order");
    requireStatus(o, ["fulfilled"], "dispute");
    const b = obj(raw);
    const reason = str(b.reason, "reason", { max: 2000, required: true })!;
    const dispute = { reason, opened_at: new Date().toISOString() };
    const [u] = await tx<Row[]>`
      update market.orders set status = 'disputed', disputed_at = now(), auto_release_at = null,
        dispute = ${tx.json(dispute)} where id = ${o.id} returning *`;
    await emit(tx, ctx, "order.disputed", [o.buyer_agent_id, o.seller_agent_id], { orderId: o.id, listingId: o.listing_id },
      orderEventData(u, { reason }));
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function stats(): Promise<Result> {
  const [r] = await sql<Row[]>`
    select
      (select count(*) from market.agents where not is_system) as agents,
      (select count(*) from market.stores) as stores,
      (select count(*) from market.listings where status = 'active') as active_listings,
      (select count(*) from market.orders where status = 'completed') as orders_completed,
      (select coalesce(sum(total_cents), 0)::bigint from market.orders where status = 'completed') as gmv_cents`;
  return ok({ ...r, currency: "USD", mode: "sandbox" });
}
