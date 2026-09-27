// MCP (Model Context Protocol) over Streamable HTTP, JSON responses only (no SSE).
// JSON-RPC 2.0 methods: initialize, notifications/*, ping, tools/list, tools/call.
import { ApiError, type Json } from "./lib.ts";
import * as m from "./market.ts";
import * as pay from "./payments.ts";
import * as rv from "./reviews.ts";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "agentmart", title: "AgentMart", version: "1.1.0" };

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  auth: boolean;
  run: (ctx: m.Ctx, args: Json) => Promise<m.Result>;
}

const S = {
  str: (description: string, extra: Json = {}) => ({ type: "string", description, ...extra }),
  int: (description: string, extra: Json = {}) => ({ type: "integer", description, ...extra }),
};

const addressSchema = {
  type: "object",
  description: "Required for physical listings.",
  properties: {
    name: S.str("Recipient name"),
    line1: S.str("Street address"),
    line2: S.str("Apartment, suite, etc."),
    city: S.str("City"),
    region: S.str("State / province / region"),
    postal_code: S.str("Postal code"),
    country: S.str("ISO 3166-1 alpha-2 country code, e.g. US"),
  },
  required: ["name", "line1", "city", "region", "postal_code", "country"],
};

const q = (args: Json, keys: string[]) => {
  const p = new URLSearchParams();
  for (const k of keys) if (args[k] !== undefined && args[k] !== null) p.set(k, String(args[k]));
  return p;
};

const pick = (args: Json, omit: string[]) => Object.fromEntries(Object.entries(args).filter(([k]) => !omit.includes(k)));

const idStr = (args: Json, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new ApiError("invalid_request", `${key} is required`, { field: key });
  return v;
};

export const TOOLS: Tool[] = [
  {
    name: "register_agent",
    title: "Register agent",
    description: "Register a new agent account. Returns an api_key (shown once) to use as a Bearer token. No auth required.",
    inputSchema: {
      type: "object",
      properties: {
        name: S.str("Agent display name (1-80 chars)"),
        description: S.str("What this agent does"),
        operator_contact: S.str("Operator email (optional)"),
        webhook_url: S.str("https URL to receive signed event webhooks (optional)"),
      },
      required: ["name"],
    },
    auth: false,
    run: (ctx, a) => m.registerAgent(ctx, a),
  },
  {
    name: "search_listings",
    title: "Search listings",
    description: "Full-text search over active listings with optional filters. Prices are integer cents (USD).",
    inputSchema: {
      type: "object",
      properties: {
        q: S.str("Search text (title, description, tags)"),
        kind: { type: "string", enum: ["physical", "digital", "service"] },
        category: S.str("Category filter"),
        min_price: S.int("Minimum price in cents"),
        max_price: S.int("Maximum price in cents"),
        store: S.str("Store slug"),
        min_rating: { type: "number", description: "Minimum average rating 1-5" },
        sort: { type: "string", enum: ["relevance", "price_asc", "price_desc", "newest", "rating"] },
        limit: S.int("1-100, default 20"),
        cursor: S.str("next_cursor from a previous call"),
      },
    },
    auth: false,
    run: (_ctx, a) => m.searchListings(q(a, ["q", "kind", "category", "min_price", "max_price", "min_rating", "store", "sort", "limit", "cursor"])),
  },
  {
    name: "get_listing",
    title: "Get listing",
    description: "Get one listing with rating, seller summary, agent_readiness score and a `purchase` hint (fields needed to buy it).",
    inputSchema: { type: "object", properties: { listing_id: S.str("Listing id (lst_...)") }, required: ["listing_id"] },
    auth: false,
    run: (ctx, a) => m.getListing(ctx, idStr(a, "listing_id")),
  },
  {
    name: "get_wallet",
    title: "Get wallet",
    description: "Get your wallet balances (available and held in escrow), in cents.",
    inputSchema: { type: "object", properties: {} },
    auth: true,
    run: (ctx) => m.getWallet(ctx),
  },
  {
    name: "deposit_sandbox_funds",
    title: "Deposit sandbox funds",
    description:
      "Fund your wallet. Sandbox mode: instant test funds (max 100000 cents per call, 500000 lifetime). Live mode: returns a Stripe checkout_url; the wallet is credited automatically after payment.",
    inputSchema: {
      type: "object",
      properties: {
        amount_cents: S.int("Amount in cents (1-100000)", { minimum: 1, maximum: 100000 }),
        idempotency_key: S.str("Optional idempotency key"),
      },
      required: ["amount_cents"],
    },
    auth: true,
    run: (ctx, a) => pay.deposit(ctx, pick(a, ["idempotency_key"]), (a.idempotency_key as string) ?? null),
  },
  {
    name: "create_order",
    title: "Buy a listing",
    description:
      "Buy a listing. Funds move from your available balance into escrow. Digital goods are delivered and settled instantly (see `delivery`). Physical orders need shipping_address.",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: S.str("Listing id (lst_...)"),
        quantity: S.int("Quantity, default 1", { minimum: 1, maximum: 100 }),
        shipping_address: addressSchema,
        note: S.str("Note to the seller"),
        idempotency_key: S.str("Optional idempotency key; retries with the same key return the original order"),
      },
      required: ["listing_id"],
    },
    auth: true,
    run: (ctx, a) => m.createOrder(ctx, pick(a, ["idempotency_key"]), (a.idempotency_key as string) ?? null),
  },
  {
    name: "list_orders",
    title: "List orders",
    description: "List your orders as buyer and/or seller.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["buyer", "seller"] },
        status: { type: "string", enum: [...m.ORDER_STATUSES] },
        limit: S.int("1-100, default 20"),
        cursor: S.str("next_cursor from a previous call"),
      },
    },
    auth: true,
    run: (ctx, a) => m.listOrders(ctx, q(a, ["role", "status", "limit", "cursor"])),
  },
  {
    name: "get_order",
    title: "Get order",
    description: "Get one order (you must be its buyer or seller).",
    inputSchema: { type: "object", properties: { order_id: S.str("Order id (ord_...)") }, required: ["order_id"] },
    auth: true,
    run: (ctx, a) => m.getOrder(ctx, idStr(a, "order_id")),
  },
  {
    name: "confirm_order",
    title: "Confirm receipt",
    description: "Buyer confirms a fulfilled order; escrow is released to the seller (minus 5% fee).",
    inputSchema: { type: "object", properties: { order_id: S.str("Order id (ord_...)") }, required: ["order_id"] },
    auth: true,
    run: (ctx, a) => m.confirmOrder(ctx, idStr(a, "order_id")),
  },
  {
    name: "create_store",
    title: "Create store",
    description: "Open your store (one per agent). Required before creating listings.",
    inputSchema: {
      type: "object",
      properties: {
        name: S.str("Store name"),
        slug: S.str("URL slug: a-z, 0-9, '-'"),
        description: S.str("Store description"),
        ships_from: S.str("Country/region goods ship from"),
        return_policy: S.str("Return policy"),
      },
      required: ["name", "slug"],
    },
    auth: true,
    run: (ctx, a) => m.createStore(ctx, a),
  },
  {
    name: "create_listing",
    title: "Create listing",
    description:
      "Create a listing in your store. kind=physical requires inventory (and optional shipping); kind=digital requires digital_delivery {type,payload}; kind=service may include service_terms.",
    inputSchema: {
      type: "object",
      properties: {
        title: S.str("Title (<=140 chars)"),
        description: S.str("Description (<=5000 chars)"),
        kind: { type: "string", enum: ["physical", "digital", "service"] },
        price_cents: S.int("Price in cents (50..10000000)", { minimum: 50, maximum: 10000000 }),
        currency: { type: "string", enum: ["USD"] },
        inventory: { type: ["integer", "null"], description: "Stock count; null = unlimited (not allowed for physical)" },
        category: S.str("Category"),
        tags: { type: "array", items: { type: "string" }, maxItems: 10 },
        attributes: { type: "object", description: "Free-form structured attributes" },
        image_url: S.str("https image URL"),
        shipping: {
          type: "object",
          properties: {
            handling_days: { type: "integer" },
            ships_to: { type: "array", items: { type: "string" } },
            shipping_cents: { type: "integer" },
          },
        },
        digital_delivery: {
          type: "object",
          properties: { type: { type: "string", enum: ["url", "text", "license_key"] }, payload: { type: "string" } },
          required: ["type", "payload"],
        },
        service_terms: {
          type: "object",
          properties: { turnaround_days: { type: "integer" }, deliverable: { type: "string" } },
        },
      },
      required: ["title", "description", "kind", "price_cents"],
    },
    auth: true,
    run: (ctx, a) => m.createListing(ctx, a),
  },
  {
    name: "fulfill_order",
    title: "Fulfil order",
    description:
      "Seller marks a paid order fulfilled. Physical: carrier + tracking_number (+ tracking_url). Service: deliverable_url and/or message.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: S.str("Order id (ord_...)"),
        carrier: S.str("Shipping carrier (physical)"),
        tracking_number: S.str("Tracking number (physical)"),
        tracking_url: S.str("https tracking URL (physical)"),
        deliverable_url: S.str("https deliverable URL (service)"),
        message: S.str("Delivery message (service)"),
      },
      required: ["order_id"],
    },
    auth: true,
    run: (ctx, a) => m.fulfillOrder(ctx, idStr(a, "order_id"), pick(a, ["order_id"])),
  },
  {
    name: "list_categories",
    title: "List categories",
    description: "List product categories (slug, name, listing_count) derived from active listings.",
    inputSchema: { type: "object", properties: {} },
    auth: false,
    run: () => m.listCategories(),
  },
  {
    name: "browse_catalog",
    title: "Browse catalog",
    description: "Compact feed of all active listings (id, title, kind, price, shipping, inventory, rating, category, store). Use updated_since for incremental sync.",
    inputSchema: {
      type: "object",
      properties: {
        updated_since: S.str("ISO-8601 timestamp; only listings updated after it"),
        kind: { type: "string", enum: ["physical", "digital", "service"] },
        limit: S.int("1-200, default 100"),
        cursor: S.str("next_cursor from a previous call"),
      },
    },
    auth: false,
    run: (ctx, a) => m.catalog(ctx, q(a, ["updated_since", "kind", "limit", "cursor"])),
  },
  {
    name: "get_reviews",
    title: "Get reviews",
    description: "Reviews for a listing (listing_id) or a store (store_slug), with the rating summary.",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: S.str("Listing id (lst_...)"),
        store_slug: S.str("Store slug"),
        sort: { type: "string", enum: ["newest", "highest", "lowest"] },
        limit: S.int("1-100, default 20"),
        cursor: S.str("next_cursor from a previous call"),
      },
    },
    auth: false,
    run: (_ctx, a) => {
      const p = q(a, ["sort", "limit", "cursor"]);
      if (typeof a.listing_id === "string" && a.listing_id) return rv.listingReviews(a.listing_id, p);
      if (typeof a.store_slug === "string" && a.store_slug) return rv.storeReviews(a.store_slug, p);
      throw new ApiError("invalid_request", "Provide listing_id or store_slug", { field: "listing_id" });
    },
  },
  {
    name: "write_review",
    title: "Write review",
    description: "Buyer reviews an order (status fulfilled, completed or disputed). One review per order.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: S.str("Order id (ord_...)"),
        rating: S.int("1-5", { minimum: 1, maximum: 5 }),
        title: S.str("Short title (<=120 chars)"),
        body: S.str("Review text (<=4000 chars)"),
      },
      required: ["order_id", "rating"],
    },
    auth: true,
    run: (ctx, a) => rv.createReview(ctx, idStr(a, "order_id"), pick(a, ["order_id"])),
  },
  {
    name: "update_listing",
    title: "Update listing",
    description: "Seller updates any mutable field of their listing (price, inventory, description, status active|paused, ...).",
    inputSchema: {
      type: "object",
      properties: {
        listing_id: S.str("Listing id (lst_...)"),
        title: S.str("Title"),
        description: S.str("Description"),
        price_cents: S.int("Price in cents"),
        inventory: { type: ["integer", "null"] },
        category: S.str("Category"),
        tags: { type: "array", items: { type: "string" } },
        attributes: { type: "object" },
        image_url: S.str("https image URL"),
        shipping: { type: "object" },
        digital_delivery: { type: "object" },
        service_terms: { type: "object" },
        status: { type: "string", enum: ["active", "paused"] },
      },
      required: ["listing_id"],
    },
    auth: true,
    run: (ctx, a) => m.patchListing(ctx, idStr(a, "listing_id"), pick(a, ["listing_id"])),
  },
  {
    name: "get_my_store",
    title: "Get my store",
    description: "Your store with all of your listings (including paused and sold out).",
    inputSchema: { type: "object", properties: {} },
    auth: true,
    run: (ctx) => m.getMyStore(ctx),
  },
  {
    name: "update_store",
    title: "Update store",
    description: "Update your store's name, slug, description, ships_from or return_policy.",
    inputSchema: {
      type: "object",
      properties: {
        name: S.str("Store name"),
        slug: S.str("URL slug"),
        description: S.str("Description"),
        ships_from: S.str("Ships from"),
        return_policy: S.str("Return policy"),
      },
    },
    auth: true,
    run: (ctx, a) => m.patchMyStore(ctx, a),
  },
  {
    name: "cancel_order",
    title: "Cancel order",
    description: "Buyer or seller cancels an order that is still 'paid' (full refund to buyer, stock restored).",
    inputSchema: { type: "object", properties: { order_id: S.str("Order id (ord_...)"), reason: S.str("Reason") }, required: ["order_id"] },
    auth: true,
    run: (ctx, a) => m.cancelOrder(ctx, idStr(a, "order_id"), pick(a, ["order_id"])),
  },
  {
    name: "refund_order",
    title: "Refund order",
    description: "Seller refunds an order in status paid, fulfilled or disputed (full refund to buyer).",
    inputSchema: { type: "object", properties: { order_id: S.str("Order id (ord_...)"), reason: S.str("Reason") }, required: ["order_id"] },
    auth: true,
    run: (ctx, a) => m.refundOrder(ctx, idStr(a, "order_id"), pick(a, ["order_id"])),
  },
];

type RpcId = string | number | null;
interface RpcReq {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Json;
}

const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

async function callTool(ctx: m.Ctx, params: Json): Promise<Json> {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${String(params.name)}`), { rpcCode: -32602 });
  const args = (params.arguments ?? {}) as Json;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw Object.assign(new Error("arguments must be an object"), { rpcCode: -32602 });
  }
  try {
    if (tool.auth && !ctx.agent) {
      throw new ApiError("unauthorized", "This tool requires `Authorization: Bearer <api_key>` on the MCP HTTP request. Call register_agent first to obtain a key.");
    }
    const res = await tool.run(ctx, args);
    const structured = res.body && typeof res.body === "object" && !Array.isArray(res.body) ? res.body : { result: res.body };
    return { content: [{ type: "text", text: JSON.stringify(res.body, null, 2) }], structuredContent: structured, isError: false };
  } catch (e) {
    if (e instanceof ApiError) {
      const err = { error: { code: e.code, message: e.message, status: e.status, ...(e.details ? { details: e.details } : {}), request_id: ctx.requestId } };
      return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }], structuredContent: err, isError: true };
    }
    throw e;
  }
}

async function handleOne(ctx: m.Ctx, req: RpcReq): Promise<Json | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "Invalid Request");
  }
  if (req.method.startsWith("notifications/")) return null;
  try {
    let result: unknown;
    switch (req.method) {
      case "initialize": {
        const requested = String(req.params?.protocolVersion ?? "");
        result = {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "AgentMart is a marketplace for AI agents. Call register_agent to get an api_key, then send it as `Authorization: Bearer <api_key>` on every MCP request. Fund your sandbox wallet with deposit_sandbox_funds, find items with search_listings, and buy with create_order. Money is integer cents (USD).",
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) };
        break;
      case "tools/call":
        result = await callTool(ctx, (req.params ?? {}) as Json);
        break;
      default:
        return isNotification ? null : rpcError(id, -32601, `Method not found: ${req.method}`);
    }
    return isNotification ? null : rpcResult(id, result);
  } catch (e) {
    const code = (e as { rpcCode?: number }).rpcCode;
    if (code) return rpcError(id, code, (e as Error).message);
    console.error("mcp internal error", e);
    return rpcError(id, -32603, "Internal error", { request_id: ctx.requestId });
  }
}

/** Handles a POSTed JSON-RPC message or batch. Returns null body => HTTP 202 (notifications only). */
export async function handleMcp(ctx: m.Ctx, raw: string): Promise<{ status: number; body: unknown }> {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { status: 400, body: rpcError(null, -32700, "Parse error") };
  }
  if (Array.isArray(msg)) {
    if (msg.length === 0) return { status: 400, body: rpcError(null, -32600, "Invalid Request") };
    const out = (await Promise.all(msg.map((r) => handleOne(ctx, r as RpcReq)))).filter((x) => x !== null);
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  if (!msg || typeof msg !== "object") return { status: 400, body: rpcError(null, -32600, "Invalid Request") };
  const out = await handleOne(ctx, msg as RpcReq);
  return out ? { status: 200, body: out } : { status: 202, body: null };
}
