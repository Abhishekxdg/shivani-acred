/**
 * Leads store — the top of the ELINA sales funnel.
 *
 * Every enquiry that comes in (paid digital lead-gen, channel partners,
 * referrals) lands here as a lead, then moves down the funnel:
 *   new → qualified → visit → booked   (or → lost at any point).
 * ACRED's target pace is ~120–150 qualified enquiries → 25–30 site visits →
 * ~4 bookings/month, so this table is the scoreboard Sales runs against.
 *
 * Self-contained like src/outreach.ts and src/people/store.ts: its OWN
 * idempotent ENSURE_SQL runs lazily on first use over ../db/pg.js, and it
 * degrades gracefully — when Postgres is absent the "not configured: set
 * DATABASE_URL" error propagates so tools can catch it and surface a clear
 * message instead of crashing. Nothing runs at import time.
 */
import { getPool, query } from '../db/pg.js';

/** Funnel stages a lead moves through. */
export type LeadStatus = 'new' | 'qualified' | 'visit' | 'booked' | 'lost';

export const LEAD_STATUSES: readonly LeadStatus[] = [
  'new',
  'qualified',
  'visit',
  'booked',
  'lost',
] as const;

export function isLeadStatus(s: string): s is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(s);
}

export interface Lead {
  id: number;
  name: string;
  phone: string | null;
  source: string | null;
  utm: string | null;
  status: LeadStatus;
  score: number | null;
  assignee: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  phone       TEXT,
  source      TEXT,
  utm         TEXT,
  status      TEXT        NOT NULL DEFAULT 'new',
  score       INTEGER,
  assignee    TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_assignee ON leads (assignee);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (phone);
`;

let ensured = false;

/** Ensure the table exists before the first read/write. Throws the clear
 *  "not configured" error when Postgres is absent (propagated from query()). */
async function ensure(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  if (!pool) throw new Error('Postgres not configured: set DATABASE_URL');
  await pool.query(ENSURE_SQL);
  ensured = true;
}

/** Normalize any number/JID to bare digits for storage + dedup matching. */
function digits(input?: string | null): string | null {
  const d = (input ?? '').replace(/[^\d]/g, '');
  return d || null;
}

/** Clamp a lead score into a sane 0–100 band (null when not provided). */
function clampScore(input?: number | null): number | null {
  if (input === undefined || input === null || Number.isNaN(input)) return null;
  return Math.max(0, Math.min(100, Math.round(input)));
}

export interface NewLead {
  name: string;
  phone?: string;
  source?: string;
  utm?: string;
  assignee?: string;
  notes?: string;
  /** Optional initial score (0–100); usually set later by qualify. */
  score?: number;
}

/** Look up an existing lead by phone number (for dedup on intake). */
export async function findLeadByPhone(phone: string): Promise<Lead | null> {
  await ensure();
  const n = digits(phone);
  if (!n) return null;
  const rows = await query<Lead>('SELECT * FROM leads WHERE phone = $1 ORDER BY id LIMIT 1', [n]);
  return rows[0] ?? null;
}

/**
 * Insert a new lead. Deduplicates on phone: if a lead with the same number
 * already exists it is returned untouched (never a second row), so repeat
 * enquiries and re-imports don't inflate the funnel.
 */
export async function addLead(l: NewLead): Promise<{ lead: Lead; deduped: boolean }> {
  await ensure();
  const phone = digits(l.phone);
  if (phone) {
    const existing = await findLeadByPhone(phone);
    if (existing) return { lead: existing, deduped: true };
  }
  const rows = await query<Lead>(
    `INSERT INTO leads (name, phone, source, utm, assignee, notes, score)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      l.name,
      phone,
      l.source ?? null,
      l.utm ?? null,
      l.assignee ?? null,
      l.notes ?? null,
      clampScore(l.score),
    ],
  );
  return { lead: rows[0]!, deduped: false };
}

/** Find a lead by numeric id, exact (case-insensitive) name, or partial name. */
export async function findLead(nameOrId: string | number): Promise<Lead | null> {
  await ensure();
  const raw = String(nameOrId).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const byId = await query<Lead>('SELECT * FROM leads WHERE id = $1', [Number(raw)]);
    if (byId[0]) return byId[0];
  }
  const exact = await query<Lead>(
    'SELECT * FROM leads WHERE lower(name) = lower($1) ORDER BY id LIMIT 1',
    [raw],
  );
  if (exact[0]) return exact[0];

  const like = await query<Lead>(
    "SELECT * FROM leads WHERE name ILIKE '%' || $1 || '%' ORDER BY id LIMIT 1",
    [raw],
  );
  return like[0] ?? null;
}

export interface LeadFilter {
  status?: LeadStatus;
  assignee?: string;
  limit?: number;
}

/** List leads, optionally narrowed by status and/or assignee (newest activity first). */
export async function listLeads(filter: LeadFilter = {}): Promise<Lead[]> {
  await ensure();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filter.assignee) {
    params.push(filter.assignee);
    clauses.push(`assignee ILIKE '%' || $${params.length} || '%'`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(filter.limit ?? 100, 500)));
  return query<Lead>(
    `SELECT * FROM leads ${where} ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
}

/** Append a timestamped-ish note line to a lead (preserves prior notes). */
export async function addLeadNote(id: number, note: string): Promise<boolean> {
  await ensure();
  const rows = await query<Lead>(
    `UPDATE leads
        SET notes = COALESCE(notes || E'\\n', '') || $2, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, note],
  );
  return rows.length > 0;
}

/**
 * Qualify a lead: mark it 'qualified', record a score (0–100) and optionally
 * append why. This is the gate into the counted funnel (qualified enquiries →
 * visits → bookings).
 */
export async function qualifyLead(
  id: number,
  score?: number,
  note?: string,
): Promise<Lead | null> {
  await ensure();
  const rows = await query<Lead>(
    `UPDATE leads
        SET status = 'qualified',
            score = COALESCE($2, score),
            notes = CASE WHEN $3::text IS NULL OR $3 = ''
                         THEN notes
                         ELSE COALESCE(notes || E'\\n', '') || $3 END,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, clampScore(score), note && note.trim() ? note : null],
  );
  return rows[0] ?? null;
}

/** Assign a lead to a founder (or anyone), by their display name. */
export async function assignLead(id: number, assignee: string): Promise<Lead | null> {
  await ensure();
  const rows = await query<Lead>(
    `UPDATE leads SET assignee = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, assignee],
  );
  return rows[0] ?? null;
}

/** Move a lead to a new funnel status. */
export async function updateLeadStatus(id: number, status: LeadStatus): Promise<Lead | null> {
  await ensure();
  const rows = await query<Lead>(
    `UPDATE leads SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return rows[0] ?? null;
}

/** Counts per funnel stage — the Sales scoreboard snapshot. */
export type FunnelCounts = Record<LeadStatus, number> & { total: number };

export async function funnelCounts(): Promise<FunnelCounts> {
  await ensure();
  const rows = await query<{ status: string; n: string }>(
    'SELECT status, COUNT(*)::text AS n FROM leads GROUP BY status',
  );
  const out = { new: 0, qualified: 0, visit: 0, booked: 0, lost: 0, total: 0 } as FunnelCounts;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (isLeadStatus(r.status)) out[r.status] = n;
    out.total += n;
  }
  return out;
}
