-- =============================================================================
-- AgentMart v1 — schema `market`
-- Applies cleanly on a fresh database that has an `extensions` schema.
-- Never touches the `public` schema.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists market;

-- Lock the schema down: only the owner (the edge function's direct DB connection) uses it.
revoke all on schema market from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema market from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema market from authenticated';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Prefixed random id: '<prefix>_' + 20 lowercase hex chars.
create or replace function market.gen_id(prefix text) returns text
language sql volatile as $$
  select prefix || '_' || encode(extensions.gen_random_bytes(10), 'hex')
$$;

create or replace function market.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Config (secrets never leave the DB via the API)
-- -----------------------------------------------------------------------------
create table market.config (
  key        text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);

insert into market.config (key, value)
values ('jwt_secret', encode(extensions.gen_random_bytes(32), 'hex'));

-- -----------------------------------------------------------------------------
-- Agents & credentials
-- -----------------------------------------------------------------------------
create table market.agents (
  id               text primary key check (id ~ '^agt_[a-z0-9_]+$'),
  name             text not null check (char_length(name) between 1 and 80),
  description      text check (description is null or char_length(description) <= 1000),
  operator_contact text check (operator_contact is null or char_length(operator_contact) <= 254),
  webhook_url      text check (webhook_url is null or char_length(webhook_url) <= 2048),
  webhook_secret   text,
  status           text not null default 'active' check (status in ('active', 'suspended')),
  is_system        boolean not null default false,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger agents_touch before update on market.agents
  for each row execute function market.touch_updated_at();

create table market.api_keys (
  id           text primary key check (id ~ '^key_[a-z0-9]+$'),
  agent_id     text not null references market.agents(id) on delete cascade,
  key_prefix   text not null,               -- first 16 chars of the secret, for lookup
  key_hash     text not null unique,        -- hex SHA-256 of the full secret
  label        text check (label is null or char_length(label) <= 80),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_keys_prefix_idx on market.api_keys (key_prefix);
create index api_keys_agent_idx on market.api_keys (agent_id);

-- -----------------------------------------------------------------------------
-- Mandates (self-imposed spending guardrails)
-- -----------------------------------------------------------------------------
create table market.mandates (
  agent_id          text primary key references market.agents(id) on delete cascade,
  max_order_cents   bigint not null default 50000  check (max_order_cents >= 0),
  daily_limit_cents bigint not null default 200000 check (daily_limit_cents >= 0),
  allowed_kinds     text[] not null default array['physical','digital','service']
                    check (allowed_kinds <@ array['physical','digital','service']),
  updated_at        timestamptz not null default now()
);
create trigger mandates_touch before update on market.mandates
  for each row execute function market.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Wallets & double-entry ledger
-- -----------------------------------------------------------------------------
create table market.wallets (
  agent_id                text primary key references market.agents(id) on delete restrict,
  currency                text not null default 'USD' check (currency = 'USD'),
  available_cents         bigint not null default 0,
  held_cents              bigint not null default 0 check (held_cents >= 0),
  lifetime_deposits_cents bigint not null default 0 check (lifetime_deposits_cents >= 0),
  mode                    text not null default 'sandbox' check (mode in ('sandbox', 'live')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- Only the treasury (faucet source) may go negative.
  constraint wallets_available_nonneg check (available_cents >= 0 or agent_id = 'agt_treasury')
);
create trigger wallets_touch before update on market.wallets
  for each row execute function market.touch_updated_at();

-- Each money movement is a "transfer" (transfer_id) made of >= 2 entries summing to zero.
-- `account` distinguishes an agent's spendable balance from funds held in escrow.
create table market.ledger_entries (
  seq                 bigserial unique,
  id                  text primary key check (id ~ '^txn_[a-z0-9]+$'),
  transfer_id         text not null,
  agent_id            text not null references market.agents(id) on delete restrict,
  account             text not null check (account in ('available', 'held')),
  type                text not null check (type in ('deposit','escrow_hold','escrow_release','payout','refund','fee')),
  amount_cents        bigint not null check (amount_cents <> 0),
  balance_after_cents bigint not null,
  currency            text not null default 'USD' check (currency = 'USD'),
  order_id            text,
  memo                text,
  created_at          timestamptz not null default now()
);
create index ledger_agent_idx on market.ledger_entries (agent_id, seq desc);
create index ledger_transfer_idx on market.ledger_entries (transfer_id);
create index ledger_order_idx on market.ledger_entries (order_id) where order_id is not null;

-- Deferred invariant: every transfer balances to zero at commit time.
create or replace function market.check_transfer_balanced() returns trigger
language plpgsql as $$
declare
  s bigint;
begin
  select coalesce(sum(amount_cents), 0) into s
    from market.ledger_entries where transfer_id = new.transfer_id;
  if s <> 0 then
    raise exception 'ledger transfer % is unbalanced (sum=%)', new.transfer_id, s
      using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger ledger_transfer_balanced
  after insert on market.ledger_entries
  deferrable initially deferred
  for each row execute function market.check_transfer_balanced();

-- -----------------------------------------------------------------------------
-- Stores & listings
-- -----------------------------------------------------------------------------
create table market.stores (
  id            text primary key check (id ~ '^str_[a-z0-9]+$'),
  agent_id      text not null unique references market.agents(id) on delete cascade,
  slug          text not null unique
                check (slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$' and slug <> 'me'),
  name          text not null check (char_length(name) between 1 and 80),
  description   text check (description is null or char_length(description) <= 2000),
  ships_from    text check (ships_from is null or char_length(ships_from) <= 80),
  return_policy text check (return_policy is null or char_length(return_policy) <= 2000),
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger stores_touch before update on market.stores
  for each row execute function market.touch_updated_at();

create table market.listings (
  id               text primary key check (id ~ '^lst_[a-z0-9]+$'),
  store_id         text not null references market.stores(id) on delete cascade,
  agent_id         text not null references market.agents(id) on delete cascade,
  title            text not null check (char_length(title) between 1 and 140),
  description      text not null check (char_length(description) between 1 and 5000),
  kind             text not null check (kind in ('physical', 'digital', 'service')),
  price_cents      bigint not null check (price_cents between 50 and 10000000),
  currency         text not null default 'USD' check (currency = 'USD'),
  inventory        integer check (inventory is null or inventory >= 0),
  category         text check (category is null or char_length(category) <= 60),
  tags             text[] not null default '{}' check (coalesce(array_length(tags, 1), 0) <= 10),
  attributes       jsonb not null default '{}'::jsonb,
  image_url        text,
  shipping         jsonb,   -- physical only
  digital_delivery jsonb,   -- digital only; payload is private
  service_terms    jsonb,   -- service only
  status           text not null default 'active'
                   check (status in ('active', 'paused', 'sold_out', 'archived')),
  sold_count       integer not null default 0,
  is_demo          boolean not null default false,
  search_tsv       tsvector,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint listings_physical_inventory check (kind <> 'physical' or inventory is not null),
  constraint listings_kind_fields check (
    (kind = 'physical' or shipping is null) and
    (kind = 'digital'  or digital_delivery is null) and
    (kind = 'service'  or service_terms is null)
  )
);
create trigger listings_touch before update on market.listings
  for each row execute function market.touch_updated_at();

-- Weighted full-text document: title (A) > tags/category (B) > description (C).
create or replace function market.listings_tsv() returns trigger
language plpgsql as $$
begin
  new.search_tsv :=
      setweight(to_tsvector('english', coalesce(new.title, '')), 'A')
   || setweight(to_tsvector('english', coalesce(array_to_string(new.tags, ' '), '') || ' ' || coalesce(new.category, '')), 'B')
   || setweight(to_tsvector('english', coalesce(new.description, '')), 'C');
  return new;
end $$;
create trigger listings_tsv_trg before insert or update of title, description, tags, category
  on market.listings for each row execute function market.listings_tsv();

create index listings_search_idx   on market.listings using gin (search_tsv);
create index listings_status_kind  on market.listings (status, kind);
create index listings_category_idx on market.listings (category) where status = 'active';
create index listings_price_idx    on market.listings (price_cents) where status = 'active';
create index listings_created_idx  on market.listings (created_at desc);
create index listings_store_idx    on market.listings (store_id);

-- -----------------------------------------------------------------------------
-- Orders (escrow state machine)
-- -----------------------------------------------------------------------------
create table market.orders (
  id               text primary key check (id ~ '^ord_[a-z0-9]+$'),
  buyer_agent_id   text not null references market.agents(id),
  seller_agent_id  text not null references market.agents(id),
  listing_id       text not null references market.listings(id),
  store_id         text not null references market.stores(id),
  listing_title    text not null,
  kind             text not null check (kind in ('physical', 'digital', 'service')),
  quantity         integer not null check (quantity between 1 and 1000),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  shipping_cents   bigint not null default 0 check (shipping_cents >= 0),
  subtotal_cents   bigint not null check (subtotal_cents >= 0),
  total_cents      bigint not null check (total_cents >= 0),
  fee_cents        bigint not null default 0 check (fee_cents >= 0),
  currency         text not null default 'USD' check (currency = 'USD'),
  status           text not null check (status in
                   ('pending_payment','paid','fulfilled','completed','cancelled','refunded','disputed')),
  shipping_address jsonb,
  note             text,
  fulfillment      jsonb,
  delivery         jsonb,   -- digital payload snapshot, buyer-only
  dispute          jsonb,
  auto_release_at  timestamptz,
  paid_at          timestamptz,
  fulfilled_at     timestamptz,
  completed_at     timestamptz,
  cancelled_at     timestamptz,
  refunded_at      timestamptz,
  disputed_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint orders_not_self check (buyer_agent_id <> seller_agent_id)
);
create trigger orders_touch before update on market.orders
  for each row execute function market.touch_updated_at();
create index orders_buyer_idx   on market.orders (buyer_agent_id, created_at desc);
create index orders_seller_idx  on market.orders (seller_agent_id, created_at desc);
create index orders_listing_idx on market.orders (listing_id);
create index orders_autorelease_idx on market.orders (auto_release_at) where status = 'fulfilled';

-- -----------------------------------------------------------------------------
-- Events (polling feed + webhook source) and webhook delivery log
-- -----------------------------------------------------------------------------
create table market.events (
  seq        bigserial unique,
  id         text primary key check (id ~ '^evt_[a-z0-9]+$'),
  type       text not null check (type in ('order.paid','order.fulfilled','order.completed',
             'order.cancelled','order.refunded','order.disputed','listing.sold_out')),
  agent_ids  text[] not null,           -- recipients (buyer and/or seller)
  order_id   text,
  listing_id text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_agents_idx on market.events using gin (agent_ids);
create index events_order_idx on market.events (order_id) where order_id is not null;

create table market.webhook_deliveries (
  id          bigserial primary key,
  event_id    text not null,
  agent_id    text not null,
  url         text not null,
  status_code integer,
  ok          boolean not null,
  error       text,
  duration_ms integer,
  created_at  timestamptz not null default now()
);
create index webhook_deliveries_agent_idx on market.webhook_deliveries (agent_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Idempotency & rate limiting
-- -----------------------------------------------------------------------------
create table market.idempotency_keys (
  agent_id     text not null references market.agents(id) on delete cascade,
  key          text not null check (char_length(key) between 1 and 255),
  route        text not null,
  request_hash text not null,
  status_code  integer not null,
  response     jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (agent_id, key)
);
create index idempotency_created_idx on market.idempotency_keys (created_at);

create table market.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket, window_start)
);
create index rate_limits_window_idx on market.rate_limits (window_start);

-- -----------------------------------------------------------------------------
-- RLS: enabled everywhere, NO policies (PostgREST roles see nothing).
-- -----------------------------------------------------------------------------
alter table market.config             enable row level security;
alter table market.agents             enable row level security;
alter table market.api_keys           enable row level security;
alter table market.mandates           enable row level security;
alter table market.wallets            enable row level security;
alter table market.ledger_entries     enable row level security;
alter table market.stores             enable row level security;
alter table market.listings           enable row level security;
alter table market.orders             enable row level security;
alter table market.events             enable row level security;
alter table market.webhook_deliveries enable row level security;
alter table market.idempotency_keys   enable row level security;
alter table market.rate_limits        enable row level security;

revoke all on all tables in schema market from public;
revoke all on all sequences in schema market from public;
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
-- Seed data
-- -----------------------------------------------------------------------------
-- System accounts: platform (collects fees) and treasury (sandbox faucet source; may go negative).
insert into market.agents (id, name, description, is_system) values
  ('agt_platform', 'AgentMart Platform', 'Platform fee account.', true),
  ('agt_treasury', 'AgentMart Treasury', 'Sandbox funding source for faucet deposits.', true);
insert into market.wallets (agent_id) values ('agt_platform'), ('agt_treasury');

-- Demo sellers, stores, and listings. API keys are hashes of random bytes: nobody knows them.
do $$
declare
  a1 text := market.gen_id('agt');
  a2 text := market.gen_id('agt');
  a3 text := market.gen_id('agt');
  s1 text := market.gen_id('str');
  s2 text := market.gen_id('str');
  s3 text := market.gen_id('str');
  ag text;
begin
  insert into market.agents (id, name, description, is_demo) values
    (a1, 'Northwind Supply Bot', 'Demo seller agent that stocks developer hardware and pantry goods.', true),
    (a2, 'PromptForge',          'Demo seller agent that sells digital goods: prompt packs, datasets, templates.', true),
    (a3, 'TaskRunner Services',  'Demo seller agent offering on-demand services performed by agents.', true);

  foreach ag in array array[a1, a2, a3] loop
    insert into market.api_keys (id, agent_id, key_prefix, key_hash, label)
    values (market.gen_id('key'), ag,
            'am_live_' || encode(extensions.gen_random_bytes(4), 'hex'),
            encode(extensions.digest(extensions.gen_random_bytes(32), 'sha256'), 'hex'),
            'seed (unknown secret)');
    insert into market.wallets (agent_id) values (ag);
    insert into market.mandates (agent_id) values (ag);
  end loop;

  insert into market.stores (id, agent_id, slug, name, description, ships_from, return_policy, is_demo) values
    (s1, a1, 'northwind-supply', 'Northwind Supply',
     '[Demo] Developer hardware and office pantry staples, restocked by an autonomous purchasing agent.',
     'US-TX', '30-day returns on unopened items.', true),
    (s2, a2, 'promptforge', 'PromptForge',
     '[Demo] Instant-delivery digital goods for agents: prompt packs, datasets and templates.',
     null, 'Digital goods are non-refundable once delivered.', true),
    (s3, a3, 'taskrunner-services', 'TaskRunner Services',
     '[Demo] Agent-performed services with clear turnaround times and deliverables.',
     null, 'Full refund if the deliverable is not accepted.', true);

  insert into market.listings
    (id, store_id, agent_id, title, description, kind, price_cents, inventory, category, tags, attributes,
     image_url, shipping, digital_delivery, service_terms, is_demo)
  values
    -- Physical
    (market.gen_id('lst'), s1, a1, 'USB-C 7-in-1 Hub',
     '[Demo] Aluminium USB-C hub with 4K HDMI, 100W power delivery passthrough, 2x USB-A 3.0, SD and microSD readers. Plug-and-play on macOS, Windows and Linux.',
     'physical', 3999, 25, 'electronics', array['usb-c','hub','hdmi','laptop'],
     '{"brand":"Northwind","color":"space gray","weight_g":95}'::jsonb,
     'https://images.unsplash.com/photo-1625842268584-8f3296236761?w=800',
     '{"handling_days":2,"ships_to":["US","CA"],"shipping_cents":499}'::jsonb, null, null, true),
    (market.gen_id('lst'), s1, a1, 'Mechanical Keyboard (Hot-swap, 75%)',
     '[Demo] Compact 75% mechanical keyboard with hot-swappable sockets, gasket mount, PBT keycaps and USB-C. Ships with tactile brown switches.',
     'physical', 8900, 10, 'electronics', array['keyboard','mechanical','hot-swap'],
     '{"layout":"ANSI 75%","switches":"tactile brown","connection":"USB-C"}'::jsonb,
     'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=800',
     '{"handling_days":3,"ships_to":["US"],"shipping_cents":899}'::jsonb, null, null, true),
    (market.gen_id('lst'), s1, a1, 'Raspberry Pi 5 Starter Kit (8GB)',
     '[Demo] Raspberry Pi 5 8GB with active cooler, 27W USB-C power supply, 64GB microSD preloaded with Raspberry Pi OS, and case.',
     'physical', 12900, 8, 'electronics', array['raspberry-pi','sbc','maker','kit'],
     '{"ram_gb":8,"storage_gb":64}'::jsonb,
     'https://images.unsplash.com/photo-1553406830-ef2513450d76?w=800',
     '{"handling_days":2,"ships_to":["US","CA","GB"],"shipping_cents":699}'::jsonb, null, null, true),
    (market.gen_id('lst'), s1, a1, 'Single-Origin Coffee Beans, 1kg',
     '[Demo] Whole-bean Ethiopian Yirgacheffe, washed process, medium-light roast. Notes of jasmine, bergamot and stone fruit. Roasted to order.',
     'physical', 3200, 40, 'grocery', array['coffee','beans','office-pantry'],
     '{"origin":"Ethiopia","roast":"medium-light","weight_kg":1}'::jsonb,
     'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=800',
     '{"handling_days":1,"ships_to":["US"],"shipping_cents":599}'::jsonb, null, null, true),
    -- Digital
    (market.gen_id('lst'), s2, a2, 'Customer-Support Agent Prompt Pack (50 prompts)',
     '[Demo] 50 production-tested system and task prompts for customer-support agents: triage, refunds, escalation, tone control and multilingual replies.',
     'digital', 1500, null, 'prompts', array['prompts','support','llm','templates'],
     '{"format":"markdown","prompt_count":50}'::jsonb,
     null, null,
     '{"type":"text","payload":"[Demo] Thanks for your purchase! Prompt #1: You are a calm, precise support agent. Always confirm the customer''s goal before acting..."}'::jsonb,
     null, true),
    (market.gen_id('lst'), s2, a2, 'US ZIP Code Geo Dataset (CSV)',
     '[Demo] 41,000+ US ZIP codes with city, state, county, latitude/longitude and timezone. Clean CSV, UTF-8, updated quarterly.',
     'digital', 900, null, 'datasets', array['dataset','geo','csv','zip-codes'],
     '{"rows":41000,"format":"csv"}'::jsonb,
     null, null,
     '{"type":"url","payload":"https://example.com/demo/agentmart-zip-dataset.csv"}'::jsonb,
     null, true),
    (market.gen_id('lst'), s2, a2, 'AgentOps Dashboard — 1-Year License',
     '[Demo] One-year license key for a (fictional) agent observability dashboard: traces, token spend, tool-call latency and alerting.',
     'digital', 4900, 500, 'software', array['license','observability','agents'],
     '{"seats":1,"term_months":12}'::jsonb,
     null, null,
     '{"type":"license_key","payload":"DEMO-AGNT-OPS0-0000-0000"}'::jsonb,
     null, true),
    (market.gen_id('lst'), s2, a2, 'Guide: Building Reliable Tool-Using Agents (eBook)',
     '[Demo] 120-page PDF on designing tool-using LLM agents: planning loops, retries, idempotency, evaluation harnesses and guardrails.',
     'digital', 1900, null, 'books', array['ebook','agents','engineering'],
     '{"pages":120,"format":"pdf"}'::jsonb,
     null, null,
     '{"type":"url","payload":"https://example.com/demo/reliable-agents-ebook.pdf"}'::jsonb,
     null, true),
    -- Services
    (market.gen_id('lst'), s3, a3, 'Code Review for a Pull Request (up to 500 lines)',
     '[Demo] Detailed review of one pull request up to 500 changed lines: correctness, security, readability and test coverage, delivered as inline comments plus a summary.',
     'service', 4500, null, 'software-services', array['code-review','security','pull-request'],
     '{"languages":["python","typescript","go"]}'::jsonb,
     null, null, null,
     '{"turnaround_days":1,"deliverable":"Review summary (markdown) plus inline comments"}'::jsonb, true),
    (market.gen_id('lst'), s3, a3, 'Data Labeling: 1,000 Text Classification Items',
     '[Demo] Label 1,000 short text items against your taxonomy (up to 20 classes) with a 5% double-annotated quality sample.',
     'service', 6000, 20, 'data-services', array['labeling','nlp','dataset'],
     '{"items":1000,"max_classes":20}'::jsonb,
     null, null, null,
     '{"turnaround_days":2,"deliverable":"Labeled CSV plus agreement report"}'::jsonb, true),
    (market.gen_id('lst'), s3, a3, 'Logo Concepts (3 Directions)',
     '[Demo] Three distinct logo concepts with one round of revisions, delivered as SVG and PNG with a mini style sheet.',
     'service', 15000, 5, 'design', array['logo','branding','design'],
     '{"concepts":3,"revisions":1}'::jsonb,
     null, null, null,
     '{"turnaround_days":5,"deliverable":"SVG/PNG logo files and style sheet"}'::jsonb, true),
    (market.gen_id('lst'), s3, a3, 'Technical SEO Audit (up to 200 pages)',
     '[Demo] Crawl-based SEO audit covering indexability, Core Web Vitals, structured data and internal linking, with a prioritized fix list.',
     'service', 9900, null, 'marketing', array['seo','audit','web'],
     '{"max_pages":200}'::jsonb,
     null, null, null,
     '{"turnaround_days":3,"deliverable":"PDF report with prioritized fixes"}'::jsonb, true);
end $$;
