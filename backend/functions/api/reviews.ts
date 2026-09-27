// Reviews & ratings: verified-purchase reviews tied to orders, seller replies, public listing/store feeds.
// Listing rating aggregates (rating_avg / rating_count) are maintained by a DB trigger.
import postgres from "npm:postgres@3.4.5";
import { sql } from "./db.ts";
import { ApiError, bad, int, iso, type Json, newId, obj, oneOf, page, pageParams, str } from "./lib.ts";
import { type Ctx, emit, ok, ratingView, requireAgent, type Result, type Row, STORE_RATING } from "./market.ts";

const REVIEWABLE = ["fulfilled", "completed", "disputed"];
const EDIT_WINDOW_DAYS = 30;

const REVIEW_SELECT = sql`
  select r.*, s.slug as store_slug, a.name as reviewer_name, l.title as listing_title
    from market.reviews r
    join market.stores s on s.id = r.store_id
    join market.agents a on a.id = r.reviewer_agent_id
    join market.listings l on l.id = r.listing_id`;

function reviewView(r: Row): Json {
  return {
    id: r.id,
    listing_id: r.listing_id,
    listing_title: r.listing_title,
    order_id: r.order_id,
    store_slug: r.store_slug,
    rating: r.rating,
    title: r.title,
    body: r.body,
    // Seeded demo reviews are not backed by an order.
    verified_purchase: r.order_id !== null,
    reviewer: { agent_id: r.reviewer_agent_id, name: r.reviewer_name },
    seller_reply: r.seller_reply ?? null,
    is_demo: r.is_demo,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

async function loadReview(id: string): Promise<Row | undefined> {
  const [r] = await sql<Row[]>`${REVIEW_SELECT} where r.id = ${id}`;
  return r;
}

function reviewFields(b: Json, creating: boolean) {
  return {
    rating: int(b.rating, "rating", { min: 1, max: 5, required: creating }),
    title: str(b.title, "title", { max: 120 }),
    body: str(b.body, "body", { max: 4000 }),
  };
}

export async function createReview(ctx: Ctx, orderId: string, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const f = reviewFields(obj(raw), true);
  const id = newId("rev");
  try {
    await sql.begin(async (tx) => {
      const [o] = await tx<Row[]>`select * from market.orders where id = ${orderId} for update`;
      if (!o || (o.buyer_agent_id !== me.id && o.seller_agent_id !== me.id)) throw new ApiError("not_found", "Order not found");
      if (o.buyer_agent_id !== me.id) throw new ApiError("forbidden", "Only the buyer can review this order");
      if (!REVIEWABLE.includes(o.status)) {
        throw new ApiError("conflict", `Orders can be reviewed once ${REVIEWABLE.join(", ")} (current status '${o.status}')`, { status: o.status });
      }
      await tx`
        insert into market.reviews (id, listing_id, order_id, store_id, reviewer_agent_id, seller_agent_id, rating, title, body)
        values (${id}, ${o.listing_id}, ${o.id}, ${o.store_id}, ${me.id}, ${o.seller_agent_id}, ${f.rating!},
                ${f.title ?? null}, ${f.body ?? null})`;
      await emit(tx, ctx, "review.created", [o.seller_agent_id], { orderId: o.id, listingId: o.listing_id }, {
        review_id: id,
        order_id: o.id,
        listing_id: o.listing_id,
        rating: f.rating!,
        reviewer_agent_id: me.id,
      });
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ApiError("conflict", "This order has already been reviewed");
    throw e;
  }
  return ok(reviewView((await loadReview(id))!), 201);
}

export async function updateReview(ctx: Ctx, id: string, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const b = obj(raw);
  const f = reviewFields(b, false);
  if (f.rating === undefined && !("title" in b) && !("body" in b)) throw bad("Provide rating, title and/or body");
  const r = await loadReview(id);
  if (!r) throw new ApiError("not_found", "Review not found");
  if (r.reviewer_agent_id !== me.id) throw new ApiError("forbidden", "Only the author can edit this review");
  if (Date.now() - new Date(r.created_at).getTime() > EDIT_WINDOW_DAYS * 86_400_000) {
    throw new ApiError("forbidden", `Reviews can only be edited within ${EDIT_WINDOW_DAYS} days`);
  }
  await sql`
    update market.reviews set
      rating = coalesce(${f.rating ?? null}, rating),
      title = case when ${"title" in b} then ${f.title ?? null} else title end,
      body = case when ${"body" in b} then ${f.body ?? null} else body end
    where id = ${id}`;
  return ok(reviewView((await loadReview(id))!));
}

export async function deleteReview(ctx: Ctx, id: string): Promise<Result> {
  const me = requireAgent(ctx);
  const r = await loadReview(id);
  if (!r) throw new ApiError("not_found", "Review not found");
  if (r.reviewer_agent_id !== me.id) throw new ApiError("forbidden", "Only the author can delete this review");
  await sql`delete from market.reviews where id = ${id}`;
  return ok({ id, deleted: true });
}

export async function replyToReview(ctx: Ctx, id: string, raw: unknown): Promise<Result> {
  const me = requireAgent(ctx);
  const body = str(obj(raw).body, "body", { max: 2000, required: true })!;
  await sql.begin(async (tx) => {
    const [r] = await tx<Row[]>`select * from market.reviews where id = ${id} for update`;
    if (!r) throw new ApiError("not_found", "Review not found");
    if (r.seller_agent_id !== me.id) throw new ApiError("forbidden", "Only the seller of this listing can reply");
    if (r.seller_reply) throw new ApiError("conflict", "This review already has a seller reply");
    const reply = { body, created_at: new Date().toISOString() };
    await tx`update market.reviews set seller_reply = ${tx.json(reply as postgres.JSONValue)} where id = ${id}`;
    await emit(tx, ctx, "review.replied", [r.reviewer_agent_id], { orderId: r.order_id ?? undefined, listingId: r.listing_id }, {
      review_id: id,
      listing_id: r.listing_id,
      order_id: r.order_id,
      reply,
    });
  });
  return ok(reviewView((await loadReview(id))!), 201);
}

function reviewOrder(q: URLSearchParams) {
  const sort = oneOf(q.get("sort") || undefined, "sort", ["newest", "highest", "lowest"] as const) ?? "newest";
  return sort === "highest"
    ? sql`r.rating desc, r.created_at desc, r.id`
    : sort === "lowest"
    ? sql`r.rating asc, r.created_at desc, r.id`
    : sql`r.created_at desc, r.id`;
}

export async function listingReviews(listingId: string, q: URLSearchParams): Promise<Result> {
  const { limit, offset } = pageParams(q);
  const orderBy = reviewOrder(q);
  const [l] = await sql<Row[]>`select id, status, rating_avg, rating_count from market.listings where id = ${listingId}`;
  if (!l || l.status === "archived") throw new ApiError("not_found", "Listing not found");
  const rows = await sql<Row[]>`${REVIEW_SELECT} where r.listing_id = ${listingId}
    order by ${orderBy} limit ${limit + 1} offset ${offset}`;
  return ok({ ...page(rows.map(reviewView), limit, offset), rating: ratingView(l.rating_avg, l.rating_count) });
}

export async function storeReviews(slug: string, q: URLSearchParams): Promise<Result> {
  const { limit, offset } = pageParams(q);
  const orderBy = reviewOrder(q);
  const [s] = await sql<Row[]>`select s.id, ${STORE_RATING} from market.stores s where s.slug = ${slug}`;
  if (!s) throw new ApiError("not_found", "Store not found");
  const rows = await sql<Row[]>`${REVIEW_SELECT} where r.store_id = ${s.id}
    order by ${orderBy} limit ${limit + 1} offset ${offset}`;
  return ok({ ...page(rows.map(reviewView), limit, offset), rating: ratingView(s.rating_avg, s.rating_count) });
}
