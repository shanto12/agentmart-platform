// Nemotron Listing Copilot — AgentMart's entry feature for the Nebius x
// NVIDIA Global AI Hackathon (Best Apps and Agents track).
//
// POST /v1/listings/enhance takes a seller's rough listing (a title plus
// rough notes) and makes a REAL runtime call to the Nebius Token Factory
// inference API (OpenAI-compatible) running an NVIDIA Nemotron model. The
// model returns a structured listing suggestion — polished description,
// category, tags, extracted attributes and a suggested price band — which
// is validated field-by-field against the same constraints as a listing
// document before it is returned. The seller reviews and edits the
// suggestion in the console; when they publish, the applied enhancement is
// recorded on the listing under `attributes.copilot` and the listing page
// shows the attribution line.
//
// Configuration (Edge Function secrets — see docs/DEPLOY.md §3):
//   TOKEN_FACTORY_API_KEY   required. Token Factory API key.
//   TOKEN_FACTORY_BASE_URL  optional. Default https://api.tokenfactory.nebius.com/v1
//   TOKEN_FACTORY_MODEL     optional. Default nvidia/Nemotron-3.5-Super-VL
//                           (an NVIDIA Nemotron model served by Token Factory).

import { ApiError, bad, int, obj, oneOf, str, type Json } from "./lib.ts";
import { categorySlug, ok, requireAgent, type Ctx, type Result } from "./market.ts";

export const COPILOT_PROVIDER = "Nebius Token Factory";
export const COPILOT_ATTRIBUTION = "Enhanced by NVIDIA Nemotron on Nebius Token Factory";

const DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
const DEFAULT_MODEL = "nvidia/Nemotron-3.5-Super-VL";
const KINDS = ["physical", "digital", "service"] as const;
const REQUEST_TIMEOUT_MS = 45_000;
// Listing price constraints (mirror market.listings checks).
const MIN_PRICE_CENTS = 50;
const MAX_PRICE_CENTS = 10_000_000;

export interface PriceBand {
  min_cents: number;
  max_cents: number;
  suggested_cents: number;
}

export interface CopilotSuggestion {
  description: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, string>;
  price_band_cents: PriceBand;
}

export interface CopilotMeta {
  provider: string;
  model: string;
  attribution: string;
  enhanced_at: string;
}

interface EnhanceInput {
  title: string;
  notes: string;
  kind?: string;
  currentPriceCents?: number | null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are the AgentMart Listing Copilot, powered by NVIDIA Nemotron on Nebius Token Factory. " +
  "AgentMart is a marketplace where AI agents buy and sell goods and services, so listings are " +
  "read by machines first: be specific, factual and complete. You turn a seller's rough listing " +
  "into a polished, agent-ready listing. Use ONLY facts stated in, or clearly implied by, the " +
  "seller's title and notes — never invent brands, certifications, quantities, materials or " +
  "claims that are not there. If a detail is missing, leave it out instead of guessing. " +
  "Respond with a single JSON object and nothing else (no markdown fences, no commentary), " +
  "with exactly these keys: " +
  '"description" (string, 300-1200 characters: what it is, what is included, who it is for, ' +
  "key specs and terms, in plain prose), " +
  '"category" (string, one short category phrase, e.g. "coffee", "home & kitchen", "design services"), ' +
  '"tags" (array of 3-8 short lowercase tags), ' +
  '"attributes" (object of up to 6 key/value string pairs extracted from the notes, e.g. {"Format": "PDF"}), ' +
  '"price_band_cents" (object {"min_cents": int, "max_cents": int, "suggested_cents": int} — a fair ' +
  "USD price band in cents for this item; if the seller named a price, centre the band on it).";

export function buildMessages(input: EnhanceInput): { role: string; content: string }[] {
  const lines = [
    `Title: ${input.title}`,
    `Kind: ${input.kind ?? "unspecified"}`,
    input.currentPriceCents != null ? `Seller's current price: ${input.currentPriceCents} cents (USD)` : null,
    "",
    "Seller's rough notes:",
    input.notes,
  ].filter((x) => x !== null);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ];
}

// ---------------------------------------------------------------------------
// Response parsing & validation
// ---------------------------------------------------------------------------

function clampCents(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(MAX_PRICE_CENTS, Math.max(MIN_PRICE_CENTS, n));
}

/** Extracts the JSON object from a model reply (tolerates fences / prose around it). */
export function extractJsonObject(text: string): Json {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("model reply contained no JSON object");
  return JSON.parse(t.slice(start, end + 1)) as Json;
}

/** Validates a raw model reply into a CopilotSuggestion. Throws on unusable output. */
export function parseSuggestion(text: string, fallbackPriceCents?: number | null): CopilotSuggestion {
  const raw = extractJsonObject(text);
  const o = obj(raw, "copilot response");

  const description = typeof o.description === "string" ? o.description.trim() : "";
  if (description.length < 20 || description.length > 5000) {
    throw new Error("model reply had no usable description");
  }

  const category = categorySlug(typeof o.category === "string" ? o.category : null);

  let tags: string[] = [];
  if (Array.isArray(o.tags)) {
    tags = [...new Set(
      o.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toLowerCase().slice(0, 40))
        .filter((t) => t.length > 0),
    )].slice(0, 10);
  }

  const attributes: Record<string, string> = {};
  if (o.attributes && typeof o.attributes === "object" && !Array.isArray(o.attributes)) {
    for (const [k, v] of Object.entries(o.attributes as Record<string, unknown>)) {
      if (Object.keys(attributes).length >= 6) break;
      const key = k.trim().slice(0, 60);
      if (!key || typeof v !== "string") continue;
      const val = v.trim().slice(0, 200);
      if (val) attributes[key] = val;
    }
  }

  const band = (o.price_band_cents && typeof o.price_band_cents === "object")
    ? o.price_band_cents as Record<string, unknown>
    : {};
  const centre = fallbackPriceCents ?? 2500;
  let min = clampCents(band.min_cents, Math.max(MIN_PRICE_CENTS, Math.round(centre * 0.8)));
  let max = clampCents(band.max_cents, Math.round(centre * 1.25));
  let suggested = clampCents(band.suggested_cents, centre);
  if (min > max) [min, max] = [max, min];
  suggested = Math.min(max, Math.max(min, suggested));

  return {
    description,
    category,
    tags,
    attributes,
    price_band_cents: { min_cents: min, max_cents: max, suggested_cents: suggested },
  };
}

// ---------------------------------------------------------------------------
// Token Factory call
// ---------------------------------------------------------------------------

interface CopilotConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function copilotConfig(): CopilotConfig {
  const apiKey = Deno.env.get("TOKEN_FACTORY_API_KEY")?.trim();
  if (!apiKey) {
    throw new ApiError(
      "not_implemented",
      "The Nemotron Listing Copilot is not configured on this deployment: TOKEN_FACTORY_API_KEY is not set.",
    );
  }
  return {
    apiKey,
    baseUrl: (Deno.env.get("TOKEN_FACTORY_BASE_URL")?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: Deno.env.get("TOKEN_FACTORY_MODEL")?.trim() || DEFAULT_MODEL,
  };
}

/** Makes the live Token Factory chat-completions call and returns the reply text. */
export async function callTokenFactory(cfg: CopilotConfig, input: EnhanceInput): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: buildMessages(input),
        temperature: 0.4,
        max_tokens: 1500,
      }),
    });
  } catch (e) {
    throw new ApiError(
      "internal",
      `Could not reach Nebius Token Factory: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new ApiError(
      "internal",
      `Nebius Token Factory request failed (HTTP ${res.status}).`,
      { upstream_status: res.status, upstream_body: detail },
    );
  }
  const data = await res.json().catch(() => null) as {
    choices?: { message?: { content?: unknown } }[];
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : ""))
      .join("");
    if (text) return text;
  }
  throw new ApiError("internal", "Nebius Token Factory returned an empty response.");
}

// ---------------------------------------------------------------------------
// Handler — POST /v1/listings/enhance
// ---------------------------------------------------------------------------

export async function enhanceListing(ctx: Ctx, raw: unknown): Promise<Result> {
  requireAgent(ctx);
  const b = obj(raw);
  const input: EnhanceInput = {
    title: str(b.title, "title", { max: 140, required: true })!,
    notes: str(b.notes, "notes", { max: 4000, required: true })!,
    kind: oneOf(b.kind, "kind", KINDS, false),
    currentPriceCents: b.current_price_cents === undefined || b.current_price_cents === null
      ? null
      : int(b.current_price_cents, "current_price_cents", { min: 0, max: MAX_PRICE_CENTS }),
  };
  if (input.notes.length < 10) throw bad("notes must describe the listing (10+ characters)", { field: "notes" });

  const cfg = copilotConfig();
  const reply = await callTokenFactory(cfg, input);
  let suggestion: CopilotSuggestion;
  try {
    suggestion = parseSuggestion(reply, input.currentPriceCents);
  } catch {
    throw new ApiError("internal", "Nemotron returned a response that could not be validated as a listing. Please try again.");
  }
  const meta: CopilotMeta = {
    provider: COPILOT_PROVIDER,
    model: cfg.model,
    attribution: COPILOT_ATTRIBUTION,
    enhanced_at: new Date().toISOString(),
  };
  return ok({ suggestion, copilot: meta });
}
