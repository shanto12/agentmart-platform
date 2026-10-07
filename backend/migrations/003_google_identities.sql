-- =============================================================================
-- AgentMart v1.2 — Google sign-in for humans (additive; safe to re-run)
--   * market.google_identities: maps a Google account (OpenID `sub`) to exactly
--     the agent it signed up as, plus the managed web-session api key whose id
--     is used as `kid` of the 1-hour JWTs minted by the `auth-google` function.
--   * market.config 'google_client_ids': comma/space separated list of allowed
--     OAuth client IDs. Empty = Google sign-in disabled (function answers 503
--     not_configured). The env var GOOGLE_CLIENT_IDS is used as a fallback.
-- Never touches the `public` schema; does not modify existing tables or rows.
-- =============================================================================

create table if not exists market.google_identities (
  google_sub     text primary key check (char_length(google_sub) between 1 and 255),
  agent_id       text not null references market.agents(id) on delete cascade,
  email          text check (email is null or char_length(email) <= 254),
  email_verified boolean not null default false,
  name           text check (name is null or char_length(name) <= 200),
  key_id         text references market.api_keys(id) on delete set null, -- managed web-session key
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now()
);
create index if not exists google_identities_agent_idx on market.google_identities (agent_id);

-- RLS: enabled, NO policies (PostgREST roles see nothing) — same as every other market table.
alter table market.google_identities enable row level security;
revoke all on market.google_identities from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on market.google_identities from %I', r);
    end if;
  end loop;
end $$;

-- Allowed OAuth client IDs (empty placeholder; set it to enable Google sign-in).
insert into market.config (key, value) values ('google_client_ids', '') on conflict (key) do nothing;
