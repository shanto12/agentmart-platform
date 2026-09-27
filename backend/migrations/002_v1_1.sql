-- =============================================================================
-- AgentMart v1.1 — upgrade from 001_market.sql
--   * agent email
--   * reviews & ratings (denormalised listing rating, maintained by trigger)
--   * Stripe Checkout funding (sessions + webhook event dedupe)
--   * faucet_enabled config flag
--   * new event types (review.created, review.replied)
--   * product-first demo reseed with demo reviews
-- Safe on a DB already at 001 (with or without real data) and right after 001
-- on a fresh DB. Re-running it is also safe (demo data is re-seeded).
-- Never touches the `public` schema.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Agent email (private; unique case-insensitively when present)
-- -----------------------------------------------------------------------------
alter table market.agents add column if not exists email text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_email_len' and conrelid = 'market.agents'::regclass) then
    alter table market.agents add constraint agents_email_len check (email is null or char_length(email) <= 254);
  end if;
end $$;
create unique index if not exists agents_email_uidx on market.agents (lower(email)) where email is not null;

-- -----------------------------------------------------------------------------
-- Config flags
-- -----------------------------------------------------------------------------
insert into market.config (key, value) values ('faucet_enabled', 'true') on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Event types
-- -----------------------------------------------------------------------------
alter table market.events drop constraint if exists events_type_check;
alter table market.events add constraint events_type_check check (type in (
  'order.paid', 'order.fulfilled', 'order.completed', 'order.cancelled', 'order.refunded', 'order.disputed',
  'listing.sold_out', 'review.created', 'review.replied'));

-- -----------------------------------------------------------------------------
-- Reviews & ratings
-- -----------------------------------------------------------------------------
alter table market.listings add column if not exists rating_avg numeric(2,1);
alter table market.listings add column if not exists rating_count integer not null default 0;

create table if not exists market.reviews (
  id                text primary key check (id ~ '^rev_[a-z0-9]+$'),
  listing_id        text not null references market.listings(id) on delete cascade,
  order_id          text unique references market.orders(id) on delete cascade, -- null only for seeded demo reviews
  store_id          text not null references market.stores(id) on delete cascade,
  reviewer_agent_id text not null references market.agents(id) on delete cascade,
  seller_agent_id   text not null references market.agents(id) on delete cascade,
  rating            integer not null check (rating between 1 and 5),
  title             text check (title is null or char_length(title) <= 120),
  body              text check (body is null or char_length(body) <= 4000),
  seller_reply      jsonb,   -- { body, created_at }
  is_demo           boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint reviews_not_self check (reviewer_agent_id <> seller_agent_id),
  constraint reviews_order_required check (order_id is not null or is_demo)
);
create index if not exists reviews_listing_idx on market.reviews (listing_id, created_at desc);
create index if not exists reviews_store_idx on market.reviews (store_id, created_at desc);
create index if not exists reviews_reviewer_idx on market.reviews (reviewer_agent_id);
drop trigger if exists reviews_touch on market.reviews;
create trigger reviews_touch before update on market.reviews
  for each row execute function market.touch_updated_at();

-- Keeps listings.rating_avg / rating_count in sync with market.reviews.
create or replace function market.refresh_listing_rating() returns trigger
language plpgsql as $$
declare
  lid text;
begin
  foreach lid in array array[
    case when tg_op in ('INSERT', 'UPDATE') then new.listing_id end,
    case when tg_op in ('UPDATE', 'DELETE') then old.listing_id end
  ] loop
    if lid is not null then
      update market.listings l set
        rating_avg   = (select round(avg(r.rating)::numeric, 1) from market.reviews r where r.listing_id = lid),
        rating_count = (select count(*) from market.reviews r where r.listing_id = lid)
      where l.id = lid;
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists reviews_rating_trg on market.reviews;
create trigger reviews_rating_trg after insert or delete or update of rating, listing_id on market.reviews
  for each row execute function market.refresh_listing_rating();

create index if not exists listings_rating_idx on market.listings (rating_avg desc nulls last) where status = 'active';
create index if not exists listings_updated_idx on market.listings (updated_at, id) where status = 'active';

-- -----------------------------------------------------------------------------
-- Stripe Checkout funding
-- -----------------------------------------------------------------------------
create table if not exists market.stripe_sessions (
  session_id      text primary key,
  agent_id        text not null references market.agents(id) on delete restrict,
  amount_cents    bigint not null check (amount_cents > 0),
  currency        text not null default 'USD',
  status          text not null default 'open' check (status in ('open', 'completed', 'expired')),
  idempotency_key text,
  checkout_url    text,
  transfer_id     text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index if not exists stripe_sessions_agent_idx on market.stripe_sessions (agent_id, created_at desc);

-- Every processed Stripe event id (webhook dedupe).
create table if not exists market.stripe_events (
  event_id    text primary key,
  type        text not null,
  session_id  text,
  received_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- RLS + privileges for the new tables
-- -----------------------------------------------------------------------------
alter table market.reviews         enable row level security;
alter table market.stripe_sessions enable row level security;
alter table market.stripe_events   enable row level security;
revoke all on market.reviews, market.stripe_sessions, market.stripe_events from public;
revoke all on all functions in schema market from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema market from %I', r);
      execute format('revoke all on all sequences in schema market from %I', r);
      execute format('revoke all on all functions in schema market from %I', r);
    end if;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Product-first demo reseed
-- -----------------------------------------------------------------------------
do $$
declare
  a_nw  text;  s_nw  text;   -- Northwind Supply: home & kitchen, office, electronics accessories
  a_th  text;  s_th  text;   -- Trailhead Outfitters: outdoor, pet, beauty
  a_pf  text;  s_pf  text;   -- PromptForge: digital
  a_tr  text;  s_tr  text;   -- TaskRunner Services: services
  r record;
begin
  -- 1. Retire the old demo catalogue: delete demo listings that never sold, archive the rest.
  delete from market.reviews where is_demo;
  delete from market.listings l
   where l.is_demo and not exists (select 1 from market.orders o where o.listing_id = l.id);
  update market.listings set status = 'archived' where is_demo and status <> 'archived';

  -- 2. Ensure the demo sellers and stores exist (created by 001, plus a new outdoor store).
  select s.agent_id, s.id into a_nw, s_nw from market.stores s where s.slug = 'northwind-supply';
  select s.agent_id, s.id into a_pf, s_pf from market.stores s where s.slug = 'promptforge';
  select s.agent_id, s.id into a_tr, s_tr from market.stores s where s.slug = 'taskrunner-services';
  select s.agent_id, s.id into a_th, s_th from market.stores s where s.slug = 'trailhead-outfitters';

  if a_nw is null then
    a_nw := market.gen_id('agt'); s_nw := market.gen_id('str');
    insert into market.agents (id, name, description, is_demo) values (a_nw, 'Northwind Supply Bot', 'Demo seller agent.', true);
    insert into market.stores (id, agent_id, slug, name, is_demo) values (s_nw, a_nw, 'northwind-supply', 'Northwind Supply', true);
  end if;
  if a_pf is null then
    a_pf := market.gen_id('agt'); s_pf := market.gen_id('str');
    insert into market.agents (id, name, description, is_demo) values (a_pf, 'PromptForge', 'Demo seller agent.', true);
    insert into market.stores (id, agent_id, slug, name, is_demo) values (s_pf, a_pf, 'promptforge', 'PromptForge', true);
  end if;
  if a_tr is null then
    a_tr := market.gen_id('agt'); s_tr := market.gen_id('str');
    insert into market.agents (id, name, description, is_demo) values (a_tr, 'TaskRunner Services', 'Demo seller agent.', true);
    insert into market.stores (id, agent_id, slug, name, is_demo) values (s_tr, a_tr, 'taskrunner-services', 'TaskRunner Services', true);
  end if;
  if a_th is null then
    a_th := market.gen_id('agt'); s_th := market.gen_id('str');
    insert into market.agents (id, name, description, is_demo)
      values (a_th, 'Trailhead Outfitters Bot', 'Demo seller agent that stocks outdoor, pet and personal-care products.', true);
    insert into market.stores (id, agent_id, slug, name, is_demo) values (s_th, a_th, 'trailhead-outfitters', 'Trailhead Outfitters', true);
  end if;

  -- Demo agents: unknown random API keys, wallets, default mandates.
  for r in select unnest(array[a_nw, a_th, a_pf, a_tr]) as id loop
    if not exists (select 1 from market.api_keys where agent_id = r.id) then
      insert into market.api_keys (id, agent_id, key_prefix, key_hash, label)
      values (market.gen_id('key'), r.id, 'am_live_' || encode(extensions.gen_random_bytes(4), 'hex'),
              encode(extensions.digest(extensions.gen_random_bytes(32), 'sha256'), 'hex'), 'seed (unknown secret)');
    end if;
    insert into market.wallets (agent_id) values (r.id) on conflict do nothing;
    insert into market.mandates (agent_id) values (r.id) on conflict do nothing;
  end loop;

  update market.stores set
    description = '[Demo] Home, kitchen, office and desk-setup essentials, restocked by an autonomous purchasing agent.',
    ships_from = 'US-TX', return_policy = '30-day returns on unopened items; defective items replaced free.'
   where id = s_nw;
  update market.stores set
    description = '[Demo] Outdoor gear, pet supplies and personal care, shipped fast from Colorado.',
    ships_from = 'US-CO', return_policy = '60-day no-questions returns; buyer pays return shipping.'
   where id = s_th;
  update market.stores set
    description = '[Demo] Instant-delivery digital products for agents: ebooks, software licenses, datasets and templates.',
    ships_from = null, return_policy = 'Digital goods are non-refundable once delivered; broken downloads re-issued.'
   where id = s_pf;
  update market.stores set
    description = '[Demo] A small menu of agent-performed services with fixed scope and turnaround.',
    ships_from = null, return_policy = 'Full refund if the deliverable is not accepted.'
   where id = s_tr;

  -- 3. New catalogue: 16 physical, 8 digital, 2 services.
  insert into market.listings
    (id, store_id, agent_id, title, description, kind, price_cents, inventory, category, tags, attributes,
     image_url, shipping, digital_delivery, service_terms, is_demo)
  select market.gen_id('lst'), v.store_id, v.agent_id, v.title, v.description, v.kind, v.price_cents, v.inventory,
         v.category, v.tags, v.attributes::jsonb, v.image_url, v.shipping::jsonb, v.digital::jsonb, v.service::jsonb, true
  from (values
    -- Northwind Supply ---------------------------------------------------------
    (s_nw, a_nw, 'Stainless Steel Pour-Over Coffee Kettle (1L)',
     '[Demo] Gooseneck pour-over kettle with built-in thermometer, 1-litre capacity, works on gas, electric and induction hobs.',
     'physical', 3499, 40, 'home-kitchen', array['kettle','coffee','pour-over','kitchen'],
     '{"material":"18/8 stainless steel","capacity_l":1,"induction":true}', 'https://images.unsplash.com/photo-1544233726-9f1d2b27be8b?w=800',
     '{"handling_days":1,"ships_to":["US","CA"],"shipping_cents":599}', null, null),
    (s_nw, a_nw, 'Bamboo Cutting Board Set (3 pcs)',
     '[Demo] Three organic bamboo cutting boards (small, medium, large) with juice grooves and side handles.',
     'physical', 2899, 60, 'home-kitchen', array['cutting-board','bamboo','kitchen'],
     '{"pieces":3,"material":"bamboo"}', 'https://images.unsplash.com/photo-1594383094736-8e4a4a6ea2de?w=800',
     '{"handling_days":2,"ships_to":["US"],"shipping_cents":499}', null, null),
    (s_nw, a_nw, 'Glass Meal-Prep Containers (10-pack)',
     '[Demo] Ten oven-, microwave- and dishwasher-safe borosilicate glass containers with leak-proof snap lids.',
     'physical', 3999, 35, 'home-kitchen', array['meal-prep','containers','glass'],
     '{"count":10,"capacity_ml":880}', 'https://images.unsplash.com/photo-1584473457406-6240486418e9?w=800',
     '{"handling_days":2,"ships_to":["US"],"shipping_cents":799}', null, null),
    (s_nw, a_nw, 'USB-C 7-in-1 Hub',
     '[Demo] Aluminium USB-C hub with 4K HDMI, 100W power delivery passthrough, 2x USB-A 3.0, SD and microSD readers.',
     'physical', 3999, 50, 'electronics-accessories', array['usb-c','hub','hdmi','laptop'],
     '{"ports":7,"hdmi":"4K@30Hz","pd_watts":100}', 'https://images.unsplash.com/photo-1625842268584-8f3296236761?w=800',
     '{"handling_days":1,"ships_to":["US","CA","GB"],"shipping_cents":399}', null, null),
    (s_nw, a_nw, 'Braided USB-C to USB-C Cable, 2m (3-pack)',
     '[Demo] 100W / 5A e-marked braided cables, USB 2.0 data, tested to 20,000 bends.',
     'physical', 1599, 200, 'electronics-accessories', array['cable','usb-c','charging'],
     '{"length_m":2,"watts":100,"count":3}', 'https://images.unsplash.com/photo-1601524909162-ae8725290836?w=800',
     '{"handling_days":1,"ships_to":["US","CA"],"shipping_cents":0}', null, null),
    (s_nw, a_nw, 'Wireless Charging Stand (15W)',
     '[Demo] Qi2-compatible 15W charging stand for phones and earbuds; includes USB-C cable and wall adapter.',
     'physical', 2999, 45, 'electronics-accessories', array['wireless-charger','qi','phone'],
     '{"watts":15,"standard":"Qi2"}', 'https://images.unsplash.com/photo-1586816879360-004f5b0c51e5?w=800',
     '{"handling_days":1,"ships_to":["US"],"shipping_cents":499}', null, null),
    (s_nw, a_nw, 'Ergonomic Mesh Office Chair',
     '[Demo] Breathable mesh office chair with adjustable lumbar support, 3D armrests and 135° recline. Supports up to 300 lb.',
     'physical', 24900, 12, 'office-supplies', array['chair','ergonomic','office','desk'],
     '{"max_load_lb":300,"recline_deg":135}', 'https://images.unsplash.com/photo-1580480055273-228ff5388ef8?w=800',
     '{"handling_days":3,"ships_to":["US"],"shipping_cents":2999}', null, null),
    (s_nw, a_nw, 'Dotted Notebook A5 (2-pack)',
     '[Demo] Two lay-flat A5 notebooks with 160 pages of 100gsm dotted paper, numbered pages and index.',
     'physical', 1899, 120, 'office-supplies', array['notebook','stationery','journal'],
     '{"size":"A5","pages":160,"paper_gsm":100}', 'https://images.unsplash.com/photo-1531346878377-a5be20888e57?w=800',
     '{"handling_days":1,"ships_to":["US","CA","GB"],"shipping_cents":399}', null, null),
    -- Trailhead Outfitters -----------------------------------------------------
    (s_th, a_th, 'Insulated Water Bottle, 32oz',
     '[Demo] Double-wall vacuum-insulated steel bottle keeps drinks cold 24h or hot 12h. Leak-proof straw lid.',
     'physical', 2999, 80, 'outdoor', array['water-bottle','insulated','hiking'],
     '{"capacity_oz":32,"cold_hours":24,"hot_hours":12}', 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=800',
     '{"handling_days":1,"ships_to":["US","CA"],"shipping_cents":499}', null, null),
    (s_th, a_th, 'Ultralight Backpacking Tent (2-person)',
     '[Demo] Freestanding 2-person, 3-season tent weighing 1.3 kg with two doors and vestibules. Packs to 45 cm.',
     'physical', 18900, 15, 'outdoor', array['tent','backpacking','camping','ultralight'],
     '{"capacity":2,"weight_kg":1.3,"seasons":3}', 'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?w=800',
     '{"handling_days":2,"ships_to":["US"],"shipping_cents":0}', null, null),
    (s_th, a_th, 'Rechargeable LED Headlamp (400 lumen)',
     '[Demo] 400-lumen USB-C rechargeable headlamp with red night mode, IPX6 waterproofing and motion sensor.',
     'physical', 2499, 70, 'outdoor', array['headlamp','camping','running'],
     '{"lumens":400,"waterproof":"IPX6"}', 'https://images.unsplash.com/photo-1510312305653-8ed496efae75?w=800',
     '{"handling_days":1,"ships_to":["US","CA"],"shipping_cents":399}', null, null),
    (s_th, a_th, 'Orthopedic Memory-Foam Dog Bed (Large)',
     '[Demo] Egg-crate memory-foam dog bed with washable, water-resistant cover and non-slip base. 42 x 30 in.',
     'physical', 7999, 20, 'pet', array['dog-bed','pet','orthopedic'],
     '{"size_in":"42x30","washable_cover":true}', 'https://images.unsplash.com/photo-1541599540903-216a46ca1dc0?w=800',
     '{"handling_days":2,"ships_to":["US"],"shipping_cents":1299}', null, null),
    (s_th, a_th, 'Interactive Cat Puzzle Feeder',
     '[Demo] Slow-feeder puzzle with three difficulty levels to keep indoor cats engaged. Dishwasher safe.',
     'physical', 1999, 55, 'pet', array['cat','feeder','puzzle','pet'],
     '{"levels":3,"dishwasher_safe":true}', 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=800',
     '{"handling_days":1,"ships_to":["US","CA"],"shipping_cents":499}', null, null),
    (s_th, a_th, 'Mineral Sunscreen SPF 50 (3 oz)',
     '[Demo] Reef-friendly zinc-oxide sunscreen, water resistant 80 minutes, fragrance free.',
     'physical', 1699, 150, 'beauty', array['sunscreen','spf50','skincare'],
     '{"spf":50,"size_oz":3,"fragrance_free":true}', 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800',
     '{"handling_days":1,"ships_to":["US"],"shipping_cents":399}', null, null),
    (s_th, a_th, 'Vitamin C Brightening Serum (1 oz)',
     '[Demo] 15% L-ascorbic acid serum with vitamin E and ferulic acid in an airless pump bottle.',
     'physical', 2400, 90, 'beauty', array['serum','vitamin-c','skincare'],
     '{"size_oz":1,"vitamin_c_pct":15}', 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800',
     '{"handling_days":1,"ships_to":["US","CA"],"shipping_cents":399}', null, null),
    (s_th, a_th, 'Compact Camping Stove',
     '[Demo] 3,000 W folding canister stove with piezo ignition and wind shield; boils 1 L in 3.5 minutes.',
     'physical', 4499, 30, 'outdoor', array['stove','camping','backpacking'],
     '{"output_w":3000,"boil_time_min":3.5}', 'https://images.unsplash.com/photo-1487730116645-74489c95b41b?w=800',
     '{"handling_days":2,"ships_to":["US"],"shipping_cents":599}', null, null),
    -- PromptForge (digital) ----------------------------------------------------
    (s_pf, a_pf, 'Guide: Building Reliable Tool-Using Agents (eBook)',
     '[Demo] 120-page PDF on designing tool-using LLM agents: planning loops, retries, idempotency, evaluation harnesses and guardrails.',
     'digital', 1900, null, 'books', array['ebook','agents','engineering'],
     '{"pages":120,"format":"pdf"}', 'https://images.unsplash.com/photo-1532012197267-da84d127e765?w=800',
     null, '{"type":"text","payload":"[Demo] Thanks for buying! Chapter 1: Every tool call is a network call — design for retries..."}', null),
    (s_pf, a_pf, 'The Agent Commerce Playbook (eBook)',
     '[Demo] Practical guide to selling to AI buyers: structured listings, machine-readable policies and agent-friendly checkout.',
     'digital', 1200, null, 'books', array['ebook','ecommerce','agents'],
     '{"pages":84,"format":"epub"}', 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=800',
     null, '{"type":"text","payload":"[Demo] Playbook excerpt: write titles for machines first, humans second..."}', null),
    (s_pf, a_pf, 'AgentOps Dashboard — 1-Year License',
     '[Demo] One-year license key for a (fictional) agent observability dashboard: traces, token spend, tool latency and alerting.',
     'digital', 4900, 500, 'software', array['license','observability','agents'],
     '{"seats":1,"term_months":12}', null,
     null, '{"type":"license_key","payload":"DEMO-AGNT-OPS0-0000-0000"}', null),
    (s_pf, a_pf, 'PDF Toolkit Pro — Lifetime License',
     '[Demo] Lifetime license for a (fictional) desktop PDF toolkit: merge, split, OCR and redact. Windows and macOS.',
     'digital', 2900, 1000, 'software', array['license','pdf','productivity'],
     '{"platforms":["windows","macos"],"term":"lifetime"}', null,
     null, '{"type":"license_key","payload":"DEMO-PDFK-LIFE-0000-0000"}', null),
    (s_pf, a_pf, 'US ZIP Code Geo Dataset (CSV)',
     '[Demo] 41,000+ US ZIP codes with city, state, county, latitude/longitude and timezone. Clean CSV, UTF-8.',
     'digital', 900, null, 'datasets', array['dataset','geo','csv','zip-codes'],
     '{"rows":41000,"format":"csv"}', null,
     null, '{"type":"url","payload":"https://example.com/demo/agentmart-zip-dataset.csv"}', null),
    (s_pf, a_pf, 'E-commerce Product Taxonomy Dataset (JSON)',
     '[Demo] 5,500-node product category taxonomy with parent paths and synonyms, ready for classification tasks.',
     'digital', 1500, null, 'datasets', array['dataset','taxonomy','json','ecommerce'],
     '{"nodes":5500,"format":"json"}', null,
     null, '{"type":"url","payload":"https://example.com/demo/product-taxonomy.json"}', null),
    (s_pf, a_pf, 'Notion Small-Business Operating System Template',
     '[Demo] Notion template with CRM, inventory, order tracking and weekly review dashboards.',
     'digital', 2400, null, 'templates', array['notion','template','small-business'],
     '{"app":"notion","pages":14}', null,
     null, '{"type":"url","payload":"https://example.com/demo/notion-smb-os"}', null),
    (s_pf, a_pf, 'Invoice & Quote Spreadsheet Templates (Excel/Sheets)',
     '[Demo] Ten professional invoice and quote templates with automatic tax and totals, for Excel and Google Sheets.',
     'digital', 700, null, 'templates', array['spreadsheet','invoice','template'],
     '{"count":10,"apps":["excel","google-sheets"]}', null,
     null, '{"type":"text","payload":"[Demo] Download link: https://example.com/demo/invoice-templates.zip"}', null),
    -- TaskRunner Services ------------------------------------------------------
    (s_tr, a_tr, 'Product Listing Optimization (up to 10 SKUs)',
     '[Demo] Rewrite titles, bullets and attributes for up to 10 product listings so both shoppers and AI agents can evaluate them.',
     'service', 7500, 10, 'services', array['listing','copywriting','ecommerce'],
     '{"max_skus":10}', null, null, null,
     '{"turnaround_days":2,"deliverable":"CSV of optimized listing fields"}'),
    (s_tr, a_tr, 'Code Review for a Pull Request (up to 500 lines)',
     '[Demo] Detailed review of one pull request up to 500 changed lines: correctness, security, readability and tests.',
     'service', 4500, null, 'services', array['code-review','security','pull-request'],
     '{"languages":["python","typescript","go"]}', null, null, null,
     '{"turnaround_days":1,"deliverable":"Review summary plus inline comments"}')
  ) as v(store_id, agent_id, title, description, kind, price_cents, inventory, category, tags, attributes,
         image_url, shipping, digital, service)
  where not exists (
    select 1 from market.listings x where x.store_id = v.store_id and x.title = v.title and x.status <> 'archived');

  -- 4. Demo reviews (seeded, not from real orders: order_id null, verified_purchase false).
  insert into market.reviews (id, listing_id, order_id, store_id, reviewer_agent_id, seller_agent_id,
                              rating, title, body, seller_reply, is_demo)
  select market.gen_id('rev'), l.id, null, l.store_id, v.reviewer, l.agent_id, v.rating, v.title, v.body,
         case when v.reply is null then null
              else jsonb_build_object('body', v.reply, 'created_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) end,
         true
  from (values
    ('Stainless Steel Pour-Over Coffee Kettle (1L)', a_th, 5, 'Precise pours', '[Demo] Thermometer is accurate to a degree; arrived in 2 days.', 'Thanks — enjoy the coffee!'),
    ('Stainless Steel Pour-Over Coffee Kettle (1L)', a_pf, 4, 'Great kettle', '[Demo] Handle gets a little warm but otherwise excellent.', null),
    ('USB-C 7-in-1 Hub', a_th, 5, 'Works with every laptop we tried', '[Demo] 4K output and passthrough charging both worked first time.', null),
    ('USB-C 7-in-1 Hub', a_tr, 4, 'Solid', '[Demo] Runs slightly warm under load.', 'Good note — we added airflow guidance to the listing.'),
    ('Ergonomic Mesh Office Chair', a_pf, 5, 'Back pain gone', '[Demo] Lumbar support is genuinely adjustable. Assembly took 20 minutes.', null),
    ('Insulated Water Bottle, 32oz', a_nw, 5, 'Ice lasted all day', '[Demo] Still had ice after 26 hours in a hot car.', null),
    ('Ultralight Backpacking Tent (2-person)', a_nw, 4, 'Light and roomy', '[Demo] Great weight; the stakes are flimsy, bring your own.', 'Upgraded stakes now ship with every tent.'),
    ('Orthopedic Memory-Foam Dog Bed (Large)', a_pf, 5, 'Our lab loves it', '[Demo] Cover washes well and the foam has not flattened.', null),
    ('Mineral Sunscreen SPF 50 (3 oz)', a_tr, 4, 'No white cast', '[Demo] Rubs in clear; a bit thick.', null),
    ('Guide: Building Reliable Tool-Using Agents (eBook)', a_nw, 5, 'Required reading', '[Demo] The idempotency chapter alone saved us a week.', null),
    ('AgentOps Dashboard — 1-Year License', a_th, 3, 'Decent', '[Demo] Key activated instantly; alerting is basic.', 'Alert routing rules land next quarter.'),
    ('US ZIP Code Geo Dataset (CSV)', a_tr, 5, 'Clean data', '[Demo] No duplicates, timezone column is a nice touch.', null),
    ('Product Listing Optimization (up to 10 SKUs)', a_th, 5, 'Agent-readiness went up', '[Demo] Our listings now score 100 on agent readiness.', null)
  ) as v(listing_title, reviewer, rating, title, body, reply)
  join market.listings l on l.title = v.listing_title and l.is_demo and l.status = 'active'
  where l.agent_id <> v.reviewer;
end $$;
