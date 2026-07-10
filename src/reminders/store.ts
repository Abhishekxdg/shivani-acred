/**
 * Reminders store — one-shot, fire-once reminders (distinct from the recurring
 * cron scheduler). A reminder is a bit of text delivered to a WhatsApp target at
 * a due time, exactly once. Backed by the `reminders` table.
 *
 * Self-contained: owns its idempotent ENSURE_SQL + a lazy ensure() over the
 * shared Postgres helper. Degrades gracefully when Postgres is absent —
 * mutating helpers surface the clear "not configured" error (so tools can catch
 * and report it), while listDue() simply returns [] so the delivery loop can
 * no-op silently instead of erroring every tick.
 */
import { getPool, query } from '../db/pg.js';

export interface Reminder {
  id: number;
  target_jid: string;
  text: string;
  /** TIMESTAMPTZ returned as a raw ISO-ish string (see db/pg type parsers). */
  due: string;
  fired: boolean;
  created_by: string | null;
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS reminders (
  id          SERIAL PRIMARY KEY,
  target_jid  TEXT        NOT NULL,
  text        TEXT        NOT NULL,
  due         TIMESTAMPTZ NOT NULL,
  fired       BOOLEAN     NOT NULL DEFAULT false,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders (due) WHERE fired = false;
`;

let ensured = false;
async function ensure(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  if (!pool) throw new Error('Postgres not configured: set DATABASE_URL');
  await pool.query(ENSURE_SQL);
  ensured = true;
}

export interface NewReminder {
  target_jid: string;
  text: string;
  /** When it should fire. */
  due: Date;
  /** JID of whoever asked for it (for the audit trail / attribution). */
  created_by?: string | null;
}

export async function add(r: NewReminder): Promise<Reminder> {
  await ensure();
  const rows = await query<Reminder>(
    `INSERT INTO reminders (target_jid, text, due, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [r.target_jid, r.text, r.due.toISOString(), r.created_by ?? null],
  );
  return rows[0]!;
}

/**
 * Unfired reminders whose due time has arrived (<= now), oldest first.
 * Returns [] when Postgres is absent so the delivery loop can no-op silently.
 */
export async function listDue(now: Date): Promise<Reminder[]> {
  if (!getPool()) return [];
  await ensure();
  return query<Reminder>(
    `SELECT * FROM reminders
      WHERE fired = false AND due <= $1
      ORDER BY due, id`,
    [now.toISOString()],
  );
}

/** All reminders still waiting to fire, soonest first. */
export async function listPending(): Promise<Reminder[]> {
  await ensure();
  return query<Reminder>(
    `SELECT * FROM reminders WHERE fired = false ORDER BY due, id`,
  );
}

/** Mark a reminder delivered so it never fires again. */
export async function markFired(id: number): Promise<void> {
  await ensure();
  await query('UPDATE reminders SET fired = true WHERE id = $1', [id]);
}

/** Cancel a pending reminder. Returns false when no pending row matched. */
export async function cancel(id: number): Promise<boolean> {
  await ensure();
  const rows = await query<{ id: number }>(
    'DELETE FROM reminders WHERE id = $1 AND fired = false RETURNING id',
    [id],
  );
  return rows.length > 0;
}
