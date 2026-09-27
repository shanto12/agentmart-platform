// Wallet funding & payouts:
//   * sandbox faucet (market.deposit) when STRIPE_SECRET_KEY is absent
//   * Stripe Checkout live funding + signature-verified, de-duplicated webhook crediting
//   * sandbox withdrawals (live payouts await Stripe Connect)
//   * agent payment-token surface (501, roadmap)
import { idempotent, sql } from "./db.ts";
import { ApiError, bad, hmacHex, int, type Json, obj, timingSafeEqual } from "./lib.ts";
import * as m from "./market.ts";

const LIVE_MIN_CENTS = 50; // Stripe minimum charge (USD)
const LIVE_MAX_CENTS = 1_000_000;
const SIGNATURE_TOLERANCE_S = 300;

const stripeBase = () => (Deno.env.get("STRIPE_API_BASE") ?? "https://api.stripe.com").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

/** POST /v1/wallet/deposit: Stripe Checkout in live mode, sandbox faucet otherwise. */
export async function deposit(ctx: m.Ctx, raw: unknown, idemKey: string | null): Promise<m.Result> {
  if (!m.stripeLive()) return await m.deposit(ctx, raw, idemKey);
  const me = m.requireAgent(ctx);
  const b = obj(raw);
  const amount = int(b.amount_cents, "amount_cents", { min: LIVE_MIN_CENTS, max: LIVE_MAX_CENTS, required: true })!;

  const res = await idempotent(me.id, idemKey, "POST /v1/wallet/deposit", b, async (tx) => {
    const session = await createCheckoutSession(ctx, me.id, amount, idemKey);
    await tx`insert into market.stripe_sessions (session_id, agent_id, amount_cents, idempotency_key, checkout_url)
             values (${session.id}, ${me.id}, ${amount}, ${idemKey}, ${session.url})`;
    return {
      status: 201,
      body: {
        mode: "live",
        checkout_url: session.url,
        session_id: session.id,
        amount_cents: amount,
        currency: "USD",
        status: "open",
        note: "Complete payment at checkout_url; your wallet is credited automatically when Stripe confirms the payment.",
      },
    };
  });
  return { status: res.status, body: res.body, headers: res.replayed ? { "Idempotent-Replayed": "true" } : undefined };
}

async function createCheckoutSession(ctx: m.Ctx, agentId: string, amount: number, idemKey: string | null): Promise<{ id: string; url: string }> {
  const successUrl = Deno.env.get("STRIPE_SUCCESS_URL") ??
    `${ctx.baseUrl}/v1/payments/stripe/return?status=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = Deno.env.get("STRIPE_CANCEL_URL") ?? `${ctx.baseUrl}/v1/payments/stripe/return?status=cancelled`;
  const form = new URLSearchParams({
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: agentId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][price_data][product_data][name]": "AgentMart wallet top-up",
    "metadata[agent_id]": agentId,
    "metadata[purpose]": "wallet_topup",
    "payment_intent_data[metadata][agent_id]": agentId,
  });
  if (idemKey) form.set("metadata[idempotency_key]", idemKey);

  const headers: Record<string, string> = {
    authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (idemKey) headers["idempotency-key"] = `agentmart-${agentId}-${idemKey}`;

  let res: Response;
  try {
    res = await fetch(`${stripeBase()}/v1/checkout/sessions`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    console.error("stripe checkout create failed", e);
    throw new ApiError("internal", "Payment provider unavailable, retry later");
  }
  const data = await res.json().catch(() => ({})) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !data.id || !data.url) {
    console.error("stripe checkout error", res.status, data.error?.message);
    throw new ApiError("internal", `Payment provider error: ${data.error?.message ?? res.status}`);
  }
  return { id: data.id, url: data.url };
}

// ---------------------------------------------------------------------------
// Stripe webhook
// ---------------------------------------------------------------------------

/** Verifies `Stripe-Signature: t=<ts>,v1=<hex>[,v1=...]` against HMAC-SHA256(secret, "<t>.<raw body>"). */
export async function verifyStripeSignature(header: string | null, raw: string, secret: string, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header) return false;
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") t = Number(v);
    else if (k === "v1" && v) sigs.push(v);
  }
  if (t === null || !Number.isFinite(t) || sigs.length === 0) return false;
  if (Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;
  const expected = await hmacHex(secret, `${t}.${raw}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

interface StripeSession {
  id: string;
  amount_total?: number;
  currency?: string;
  payment_status?: string;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
}

/** POST /v1/payments/stripe/webhook — no agent auth; authenticated by Stripe signature. */
export async function stripeWebhook(raw: string, headers: Headers): Promise<m.Result> {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) throw new ApiError("not_implemented", "Stripe webhooks are not configured (STRIPE_WEBHOOK_SECRET missing)");
  if (!(await verifyStripeSignature(headers.get("stripe-signature"), raw, secret))) {
    throw new ApiError("invalid_request", "Invalid or expired Stripe-Signature");
  }
  let event: { id?: string; type?: string; data?: { object?: StripeSession } };
  try {
    event = JSON.parse(raw);
  } catch {
    throw bad("Webhook body is not valid JSON");
  }
  if (!event.id || !event.type) throw bad("Webhook body is not a Stripe event");

  const session = event.data?.object;
  const isFunding = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded";

  const result = await sql.begin(async (tx) => {
    // Event-level dedupe: Stripe retries deliver the same event id.
    const inserted = await tx`
      insert into market.stripe_events (event_id, type, session_id)
      values (${event.id!}, ${event.type!}, ${isFunding ? session?.id ?? null : null})
      on conflict (event_id) do nothing returning event_id`;
    if (inserted.length === 0) return { received: true, duplicate: true, credited: false };
    if (!isFunding || !session?.id) return { received: true, ignored: true, credited: false };
    if (session.payment_status !== "paid") return { received: true, credited: false, reason: `payment_status=${session.payment_status}` };
    if ((session.currency ?? "usd").toLowerCase() !== "usd") return { received: true, credited: false, reason: "unsupported currency" };

    const amount = Number(session.amount_total);
    const agentId = session.metadata?.agent_id ?? session.client_reference_id ?? null;
    if (!Number.isInteger(amount) || amount <= 0 || !agentId) return { received: true, credited: false, reason: "missing amount or agent" };

    // Session-level dedupe: credit each Checkout Session exactly once.
    let [row] = await tx<m.Row[]>`select * from market.stripe_sessions where session_id = ${session.id} for update`;
    if (!row) {
      const [agent] = await tx<m.Row[]>`select id from market.agents where id = ${agentId} and not is_system`;
      if (!agent) return { received: true, credited: false, reason: "unknown agent" };
      [row] = await tx<m.Row[]>`
        insert into market.stripe_sessions (session_id, agent_id, amount_cents)
        values (${session.id}, ${agentId}, ${amount}) returning *`;
    }
    if (row.status === "completed") return { received: true, duplicate: true, credited: false };

    const transferId = await m.postTransfer(tx, [
      { agent: m.TREASURY, account: "available", type: "deposit", amount: -amount },
      { agent: row.agent_id, account: "available", type: "deposit", amount },
    ], { memo: `stripe checkout ${session.id}` });
    await tx`update market.stripe_sessions set status = 'completed', completed_at = now(), transfer_id = ${transferId},
               amount_cents = ${amount} where session_id = ${session.id}`;
    return { received: true, credited: true, agent_id: row.agent_id, amount_cents: amount, transfer_id: transferId };
  });
  return { status: 200, body: result };
}

/** GET /v1/payments/stripe/return — landing target for Checkout success/cancel redirects. */
export function stripeReturn(q: URLSearchParams): m.Result {
  const status = q.get("status") === "success" ? "success" : "cancelled";
  return {
    status: 200,
    body: {
      status,
      session_id: q.get("session_id"),
      message: status === "success"
        ? "Payment received. Your AgentMart wallet is credited as soon as Stripe confirms it (usually seconds)."
        : "Checkout was cancelled; no funds were moved.",
    },
  };
}

// ---------------------------------------------------------------------------
// Withdrawals & payment methods
// ---------------------------------------------------------------------------

export async function withdraw(ctx: m.Ctx, raw: unknown, idemKey: string | null): Promise<m.Result> {
  const me = m.requireAgent(ctx);
  if (m.stripeLive()) {
    throw new ApiError("not_implemented", "Live seller payouts require Stripe Connect, which is not configured yet");
  }
  const b = obj(raw);
  const amount = int(b.amount_cents, "amount_cents", { min: 1, max: 100_000_000, required: true })!;
  const res = await idempotent(me.id, idemKey, "POST /v1/wallet/withdraw", b, async (tx) => {
    const transferId = await m.postTransfer(tx, [
      { agent: me.id, account: "available", type: "payout", amount: -amount },
      { agent: m.TREASURY, account: "available", type: "payout", amount },
    ], { memo: "sandbox withdrawal" });
    const [w] = await tx<m.Row[]>`select * from market.wallets where agent_id = ${me.id}`;
    const body: Json = {
      ...m.walletView(w),
      withdrawal: { amount_cents: amount, transfer_id: transferId, destination: "sandbox_treasury", status: "paid" },
    };
    return { status: 201, body };
  });
  return { status: res.status, body: res.body, headers: res.replayed ? { "Idempotent-Replayed": "true" } : undefined };
}

export function paymentMethods(ctx: m.Ctx): Promise<m.Result> {
  m.requireAgent(ctx);
  return Promise.reject(
    new ApiError(
      "not_implemented",
      "Agent payment tokens are on the roadmap (Stripe Shared Payment Tokens / Link agentic payments, Visa Intelligent Commerce and Mastercard Agent Pay tokens). For now fund your wallet with POST /v1/wallet/deposit.",
      { roadmap: ["stripe_shared_payment_tokens", "link_agentic_payments", "visa_agent_tokens", "mastercard_agent_pay"] },
    ),
  );
}
