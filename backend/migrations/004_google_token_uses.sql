-- =============================================================================
-- AgentMart v1.2.1 — single-use Google ID tokens (additive; safe to re-run)
--   * market.google_token_uses: SHA-256 of every Google ID token the `auth-google`
--     function accepted. The insert happens in the same transaction as the login,
--     so a replayed token (primary-key conflict) is rejected with 401 "replayed".
--     Rows are only needed until the token would be rejected for age anyway
--     (expires_at); the function deletes expired rows opportunistically.
-- Never touches the `public` schema; does not modify existing tables or rows.
-- =============================================================================

create table if not exists market.google_token_uses (
  token_hash text primary key check (char_length(token_hash) between 1 and 128),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists google_token_uses_expires_idx on market.google_token_uses (expires_at);

-- RLS: enabled, NO policies (PostgREST roles see nothing) — same as every other market table.
alter table market.google_token_uses enable row level security;
revoke all on market.google_token_uses from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on market.google_token_uses from %I', r);
    end if;
  end loop;
end $$;
