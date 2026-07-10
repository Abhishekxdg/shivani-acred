/**
 * Collections / receivables store — the money-in tracker.
 *
 * Brokerage revenue arrives big and late, so unpaid invoices silently pile up:
 * a top failure mode for the business. This store keeps an explicit ledger of
 * what is owed, to whom, by when — so overdue money can be chased on purpose
 * instead of discovered by accident.
 *
 * Self-contained like ../outreach.ts and ../people/store.ts: its own idempotent
 * ENSURE_SQL + a lazy ensure() over ../db/pg.ts. Nothing runs at import time, so
 * the base app boots with no Postgres. When `DATABASE_URL` is unset, ensure()
 * (via query()) throws a clear "Postgres not configured: set DATABASE_URL" that
 * callers catch and surface as a message rather than crashing.
 */
import { getPool, query } from '../db/pg.js';

/** A receivable is money owed to us, moving pending → partial → paid. */
export type ReceivableStatus = 'pending' | 'partial' | 'paid';

const STATUSES: readonly ReceivableStatus[] = ['pending', 'partial', 'paid'];

export interface Receivable {
  id: number;
  /** Who owes the money (client, builder, channel partner). */
  party: string;
  /** Amount owed, in whole/paise-accurate rupees (returned as a JS number). */
  amount_inr: number;
  /** When it is due, ISO string, or null when open-ended. */
  due: string | null;
  status: ReceivableStatus;
  /** The deal/project this collection belongs to (optional). */
  project: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS receivables (
  id          SERIAL PRIMARY KEY,
  party       TEXT          NOT NULL,
  amount_inr  NUMERIC(14,2) NOT NULL,
  due         TIMESTAMPTZ,
  status      TEXT          NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','partial','paid')),
  project     TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receivables_status ON receivables (status);
CREATE INDEX IF NOT EXISTS idx_receivables_due ON receivables (due);
`;

/** Columns projected on every read — casts NUMERIC to a JS number for the model. */
const COLS =
  'id, party, amount_inr::float8 AS amount_inr, due, status, project, notes, created_at, updated_at';

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

/** Best-effort normalize a due date to an ISO string; returns null when the
 *  input is empty or not parseable, so free text stays out of the TIMESTAMPTZ
 *  column instead of throwing a cast error. */
export function normalizeDue(due?: string | null): string | null {
  const raw = (due ?? '').trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Coerce arbitrary input to a known status; unknown values fall back to pending. */
function normalizeStatus(status?: string | null): ReceivableStatus {
  const s = (status ?? '').trim().toLowerCase();
  return (STATUSES as readonly string[]).includes(s) ? (s as ReceivableStatus) : 'pending';
}

export interface NewReceivable {
  party: string;
  amount_inr: number;
  due?: string;
  project?: string;
  notes?: string;
  status?: ReceivableStatus;
}

/** Record a new receivable. Throws on a non-finite/negative amount. */
export async function addReceivable(r: NewReceivable): Promise<Receivable> {
  await ensure();
  const amount = Number(r.amount_inr);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`invalid amount_inr: ${String(r.amount_inr)}`);
  }
  const rows = await query<Receivable>(
    `INSERT INTO receivables (party, amount_inr, due, project, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLS}`,
    [
      r.party,
      amount,
      normalizeDue(r.due),
      r.project ?? null,
      r.notes ?? null,
      normalizeStatus(r.status),
    ],
  );
  return rows[0]!;
}

export interface ReceivableFilter {
  /** Exact status match. */
  status?: ReceivableStatus;
  /** When true, only unpaid rows past their due date. */
  overdue?: boolean;
}

/** List receivables, optionally by status or overdue-only, soonest-due first. */
export async function listReceivables(filter: ReceivableFilter = {}): Promise<Receivable[]> {
  await ensure();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    params.push(normalizeStatus(filter.status));
    clauses.push(`status = $${params.length}`);
  }
  if (filter.overdue) {
    clauses.push(`status <> 'paid' AND due IS NOT NULL AND due < now()`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return query<Receivable>(
    `SELECT ${COLS} FROM receivables ${where} ORDER BY due NULLS LAST, id`,
    params,
  );
}

/** Fetch a single receivable by id, or null when it doesn't exist. */
export async function getReceivable(id: number): Promise<Receivable | null> {
  await ensure();
  const rows = await query<Receivable>(`SELECT ${COLS} FROM receivables WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Mark a receivable paid (or partial), optionally appending a note. Returns the
 *  updated row, or null when no receivable has that id. */
export async function markPaid(
  id: number,
  opts: { status?: ReceivableStatus; note?: string } = {},
): Promise<Receivable | null> {
  await ensure();
  const status = normalizeStatus(opts.status ?? 'paid');
  const note = opts.note?.trim() || null;
  const rows = await query<Receivable>(
    `UPDATE receivables
        SET status = $2,
            notes = CASE WHEN $3::text IS NULL THEN notes
                         ELSE COALESCE(notes || E'\\n', '') || $3 END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${COLS}`,
    [id, status, note],
  );
  return rows[0] ?? null;
}

/** Aggregate money-in position: outstanding, overdue, and collected. */
export interface ReceivableTotals {
  /** Sum of everything not yet fully paid (pending + partial). */
  outstanding: number;
  /** Sum of unpaid rows already past their due date. */
  overdue: number;
  /** Sum of everything marked paid. */
  paid: number;
  /** Count of unpaid rows. */
  openCount: number;
  /** Count of unpaid rows past due. */
  overdueCount: number;
}

/** One-row rollup of the whole ledger, computed in SQL so it never depends on
 *  paging all rows into memory. */
export async function receivableTotals(): Promise<ReceivableTotals> {
  await ensure();
  const rows = await query<{
    outstanding: number;
    overdue: number;
    paid: number;
    open_count: number;
    overdue_count: number;
  }>(
    `SELECT
       COALESCE(SUM(amount_inr) FILTER (WHERE status <> 'paid'), 0)::float8 AS outstanding,
       COALESCE(SUM(amount_inr) FILTER (
         WHERE status <> 'paid' AND due IS NOT NULL AND due < now()), 0)::float8 AS overdue,
       COALESCE(SUM(amount_inr) FILTER (WHERE status = 'paid'), 0)::float8 AS paid,
       COUNT(*) FILTER (WHERE status <> 'paid')::int AS open_count,
       COUNT(*) FILTER (
         WHERE status <> 'paid' AND due IS NOT NULL AND due < now())::int AS overdue_count
     FROM receivables`,
  );
  const r = rows[0]!;
  return {
    outstanding: r.outstanding,
    overdue: r.overdue,
    paid: r.paid,
    openCount: r.open_count,
    overdueCount: r.overdue_count,
  };
}
