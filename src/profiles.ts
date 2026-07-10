/**
 * Per-person agent profiles — the personalized face each founder gets.
 *
 * Backed by the `profiles` table (see db/schema.ts), keyed by WhatsApp JID.
 * Degrades gracefully: getProfile() returns null when Postgres is absent (so
 * personalization simply doesn't happen locally), and writes surface the clear
 * "not configured" error for the caller to catch.
 */
import { getPool, query } from './db/pg.js';

export interface Profile {
  jid: string;
  owner_name: string | null;
  agent_name: string | null;
  role: string | null;
  lane: string | null;
  onboarded: boolean;
  prefs: Record<string, unknown>;
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS profiles (
  jid         TEXT PRIMARY KEY,
  owner_name  TEXT,
  agent_name  TEXT,
  role        TEXT,
  lane        TEXT,
  onboarded   BOOLEAN     NOT NULL DEFAULT false,
  prefs       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let ensured = false;

async function ensure(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  if (!pool) throw new Error('Postgres not configured: set DATABASE_URL');
  await pool.query(ENSURE_SQL);
  ensured = true;
}

/** Load a person's profile, or null when there is none / Postgres is absent. */
export async function getProfile(jid: string): Promise<Profile | null> {
  try {
    await ensure();
  } catch {
    return null; // no Postgres → no personalization, base app still works
  }
  const rows = await query<Profile>('SELECT * FROM profiles WHERE jid = $1', [jid]);
  return rows[0] ?? null;
}

export interface ProfileFields {
  owner_name?: string;
  agent_name?: string;
  role?: string;
  lane?: string;
  onboarded?: boolean;
  prefs?: Record<string, unknown>;
}

/** Create/merge a profile. Only provided fields overwrite (COALESCE). Throws the
 *  clear "not configured" error when Postgres is absent (caller should catch). */
export async function upsertProfile(jid: string, fields: ProfileFields): Promise<void> {
  await ensure();
  await query(
    `INSERT INTO profiles (jid, owner_name, agent_name, role, lane, onboarded, prefs, updated_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, false), COALESCE($7::jsonb, '{}'::jsonb), now())
     ON CONFLICT (jid) DO UPDATE SET
       owner_name = COALESCE(EXCLUDED.owner_name, profiles.owner_name),
       agent_name = COALESCE(EXCLUDED.agent_name, profiles.agent_name),
       role       = COALESCE(EXCLUDED.role, profiles.role),
       lane       = COALESCE(EXCLUDED.lane, profiles.lane),
       onboarded  = EXCLUDED.onboarded OR profiles.onboarded,
       prefs      = profiles.prefs || EXCLUDED.prefs,
       updated_at = now()`,
    [
      jid,
      fields.owner_name ?? null,
      fields.agent_name ?? null,
      fields.role ?? null,
      fields.lane ?? null,
      fields.onboarded ?? null,
      fields.prefs ? JSON.stringify(fields.prefs) : null,
    ],
  );
}

export async function setAgentName(jid: string, agentName: string): Promise<void> {
  await upsertProfile(jid, { agent_name: agentName });
}
