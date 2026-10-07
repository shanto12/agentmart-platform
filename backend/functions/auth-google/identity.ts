// Maps a verified Google identity to an AgentMart agent: login for known Google accounts,
// atomic agent+wallet+mandate+keys creation for new ones. Mirrors registerAgent / createKey in api/market.ts.
import { newApiKey, sql, type Tx } from "./db.ts";
import { ApiError, iso, newId, sha256Hex } from "./lib.ts";
import { DEFAULT_MAX_AGE_SEC, GoogleTokenError, type GoogleClaims, sanitizeAgentName } from "./google.ts";

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

export const MAX_KEYS = 10; // keep equal to MAX_KEYS in api/market.ts
export const MANAGED_KEY_LABEL = "google-web-session";

export interface LoginOutcome {
  agent: Row;
  keyId: string; // managed web-session key -> JWT `kid`
  created: boolean;
  apiKey?: string; // the visible key, only when created
  apiKeyId?: string;
}

/** Same public projection as agentView(a, true) in api/market.ts. */
export function agentSelfView(a: Row) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    status: a.status,
    is_demo: a.is_demo,
    created_at: iso(a.created_at),
    email: a.email ?? null,
    operator_contact: a.operator_contact,
    webhook_url: a.webhook_url,
    updated_at: iso(a.updated_at),
  };
}

/** Inserts a managed web-session key. Its secret is random, hashed and never returned or stored anywhere else. */
async function insertManagedKey(tx: Tx, agentId: string): Promise<string> {
  const id = newId("key");
  const { secret, prefix } = newApiKey();
  const hash = await sha256Hex(secret);
  await tx`insert into market.api_keys (id, agent_id, key_prefix, key_hash, label)
           values (${id}, ${agentId}, ${prefix}, ${hash}, ${MANAGED_KEY_LABEL})`;
  return id;
}

/**
 * One transaction. `allowEmail=false` creates the agent without an email (used when the
 * Google email already belongs to another agent: we never link or take over by email).
 */
export async function loginOrCreate(claims: GoogleClaims, allowEmail: boolean, tokenHash: string): Promise<LoginOutcome> {
  const name = (claims.name ?? "").slice(0, 200) || null;
  // A token is usable until min(exp, iat + max age) + skew; keep its single-use record a bit longer than that.
  const useExpiresAt = Math.min(claims.exp, claims.iat + DEFAULT_MAX_AGE_SEC) + 300;
  const out = await sql.begin(async (tx) => {
    // Single use: the ID token's hash is recorded in the same transaction as the login, so a failed
    // login (rolled back) does not burn the token, and a replay of a used token is rejected.
    const used = await tx<Row[]>`
      insert into market.google_token_uses (token_hash, expires_at)
      values (${tokenHash}, to_timestamp(${useExpiresAt}))
      on conflict (token_hash) do nothing returning 1 as x`;
    if (used.length === 0) throw new GoogleTokenError("replayed", "This Google ID token has already been used");
    // Serialise concurrent first-logins of the same Google account.
    await tx`select pg_advisory_xact_lock(hashtext(${"google_sub:" + claims.sub}))`;
    const [ident] = await tx<Row[]>`select * from market.google_identities where google_sub = ${claims.sub} for update`;

    if (ident) {
      const [agent] = await tx<Row[]>`select * from market.agents where id = ${ident.agent_id} for update`;
      if (!agent || agent.is_system || agent.status !== "active") {
        throw new ApiError("forbidden", "This account is not active");
      }
      let keyId: string | null = null;
      if (ident.key_id) {
        const [k] = await tx<Row[]>`
          select id from market.api_keys where id = ${ident.key_id} and agent_id = ${agent.id} and revoked_at is null`;
        if (k) keyId = k.id;
      }
      if (!keyId) {
        const [{ n }] = await tx<{ n: number }[]>`
          select count(*)::int as n from market.api_keys where agent_id = ${agent.id} and revoked_at is null`;
        if (n >= MAX_KEYS) {
          throw new ApiError("conflict", `This account already has the maximum of ${MAX_KEYS} active API keys; revoke one and sign in again`);
        }
        keyId = await insertManagedKey(tx, agent.id);
      }
      await tx`update market.google_identities
                  set last_login_at = now(), key_id = ${keyId}, email = ${claims.email}, email_verified = true, name = ${name}
                where google_sub = ${claims.sub}`;
      return { agent, keyId, created: false };
    }

    // ---- new Google account: create agent + wallet + mandate + 2 keys ----
    let email: string | null = null;
    if (allowEmail) {
      const [dup] = await tx<Row[]>`select 1 as x from market.agents where lower(email) = ${claims.email} limit 1`;
      email = dup ? null : claims.email;
    }
    const agentId = newId("agt");
    const apiKeyId = newId("key");
    const { secret, prefix } = newApiKey();
    const hash = await sha256Hex(secret);
    const [agent] = await tx<Row[]>`
      insert into market.agents (id, name, description, operator_contact, webhook_url, webhook_secret, email)
      values (${agentId}, ${sanitizeAgentName(claims.name, claims.email)}, null, null, null, null, ${email}) returning *`;
    await tx`insert into market.api_keys (id, agent_id, key_prefix, key_hash, label)
             values (${apiKeyId}, ${agentId}, ${prefix}, ${hash}, 'default')`;
    const keyId = await insertManagedKey(tx, agentId);
    await tx`insert into market.wallets (agent_id) values (${agentId})`;
    await tx`insert into market.mandates (agent_id) values (${agentId})`;
    await tx`insert into market.google_identities (google_sub, agent_id, email, email_verified, name, key_id)
             values (${claims.sub}, ${agentId}, ${claims.email}, true, ${name}, ${keyId})`;
    return { agent, keyId, created: true, apiKey: secret, apiKeyId };
  });
  await purgeExpiredTokenUses();
  return out;
}

/** Opportunistic, bounded cleanup (~1 call in 20, at most 100 rows). Best effort: never fails a login. */
async function purgeExpiredTokenUses(): Promise<void> {
  if (Math.random() >= 0.05) return;
  try {
    await sql`delete from market.google_token_uses
               where token_hash in (select token_hash from market.google_token_uses where expires_at < now() limit 100)`;
  } catch (e) {
    console.error("auth-google token-use cleanup failed", (e as { message?: string }).message ?? "");
  }
}
