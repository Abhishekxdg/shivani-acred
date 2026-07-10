/**
 * acred OS (Supabase) READ connector.
 *
 * acred OS is ACRED's internal Next.js + Supabase CRM/ops tool (KB §18). This
 * module lets Shivani read LIVE operational numbers — real bookings, pace, and
 * the inventory-spine (units with states) — so she reports the truth instead of
 * relying on founder self-reports.
 *
 * READ-ONLY: every function only issues SELECTs against Supabase.
 *
 * Degrades gracefully: the client is built lazily from `SUPABASE_URL` +
 * `SUPABASE_SERVICE_KEY`. When either is missing, every function returns the
 * clear `ACREDOS_NOT_CONNECTED` string rather than throwing — so the base app
 * boots fine with nothing configured. Query-time errors (missing table, bad
 * column) are caught and surfaced as a readable "acred OS error: ..." message.
 *
 * The default table/column names below match the acred-portal schema, but can
 * be overridden with the optional `ACRED_*` env vars without a code change if
 * the real schema differs.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../logger.js';

export const ACREDOS_NOT_CONNECTED =
  'acred OS not connected: set SUPABASE_URL/SUPABASE_SERVICE_KEY';

// Optional schema overrides (defaults suit the inventory-spine acred-portal DB).
const BOOKINGS_TABLE = process.env.ACRED_BOOKINGS_TABLE?.trim() || 'bookings';
const BOOKINGS_DATE_COL = process.env.ACRED_BOOKINGS_DATE_COL?.trim() || 'created_at';
const UNITS_TABLE = process.env.ACRED_UNITS_TABLE?.trim() || 'units';
const UNITS_STATE_COL = process.env.ACRED_UNITS_STATE_COL?.trim() || 'status';

/** Rows scanned when tallying inventory by state (cap so a huge table is safe). */
const INVENTORY_SCAN_CAP = 10_000;

/** Minimal shape of a Supabase/PostgREST error (avoids a hard type import). */
interface PgErrorLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

let client: SupabaseClient | null = null;

/**
 * Lazily build (and memoize) the Supabase client from env, or return null when
 * `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are unset. Re-checks env until the first
 * successful build, so wiring the keys later works without a restart.
 */
function acredClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  logger.info('acred OS (Supabase) client created');
  return client;
}

/** First instant of the current month in UTC, as an ISO string (pace boundary). */
function monthStartISO(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Format a PostgREST query error for a human, without leaking internals. */
function pgError(table: string, error: PgErrorLike): string {
  logger.warn({ table, error }, 'acred OS query error');
  const code = error.code ? ` (${error.code})` : '';
  return `acred OS error reading ${table}: ${error.message ?? 'query failed'}${code}`;
}

/** Format an unexpected (thrown) error — e.g. a network/transport failure. */
function acredError(err: unknown): string {
  logger.error(err, 'acred OS read error');
  return `acred OS error: ${(err as Error)?.message ?? String(err)}`;
}

/**
 * Real booking numbers: total bookings and bookings created this month, so
 * Shivani can report actual pace against the ~4/month target.
 */
export async function bookingsSummary(): Promise<string> {
  const sb = acredClient();
  if (!sb) return ACREDOS_NOT_CONNECTED;
  try {
    const total = await sb.from(BOOKINGS_TABLE).select('*', { count: 'exact', head: true });
    if (total.error) return pgError(BOOKINGS_TABLE, total.error);

    const since = monthStartISO();
    const month = await sb
      .from(BOOKINGS_TABLE)
      .select('*', { count: 'exact', head: true })
      .gte(BOOKINGS_DATE_COL, since);
    if (month.error) return pgError(BOOKINGS_TABLE, month.error);

    const t = total.count ?? 0;
    const m = month.count ?? 0;
    return (
      `Bookings (from acred OS) — total: ${t}; this month (since ${since.slice(0, 10)}): ${m}. ` +
      'Target pace ~4 bookings/month.'
    );
  } catch (err) {
    return acredError(err);
  }
}

/**
 * The inventory-spine: units grouped by their state/status. The acred OS CRM is
 * units-with-states (not a lead funnel), so this is the core operational view.
 */
export async function inventoryByState(): Promise<string> {
  const sb = acredClient();
  if (!sb) return ACREDOS_NOT_CONNECTED;
  try {
    const { data, error } = await sb
      .from(UNITS_TABLE)
      .select(UNITS_STATE_COL)
      .limit(INVENTORY_SCAN_CAP);
    if (error) return pgError(UNITS_TABLE, error);

    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (!rows.length) return 'No units found in acred OS inventory.';

    const tally = new Map<string, number>();
    for (const r of rows) {
      const raw = r[UNITS_STATE_COL];
      const key = raw === null || raw === undefined || raw === '' ? '(unset)' : String(raw);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const lines = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([state, n]) => `${state}: ${n}`);

    const capped = rows.length >= INVENTORY_SCAN_CAP ? ` (capped at ${INVENTORY_SCAN_CAP})` : '';
    return `Inventory by state — ${rows.length} units${capped}:\n${lines.join('\n')}`;
  } catch (err) {
    return acredError(err);
  }
}

export interface SafeReadOpts {
  table: string;
  /** Column → value equality filters, all ANDed together. */
  filters?: Record<string, unknown>;
  /** Comma-separated column list to return; defaults to all columns. */
  columns?: string;
  /** Max rows to return (clamped to 1–100). */
  limit?: number;
}

/**
 * Generic, read-only SELECT against any acred OS table with optional simple
 * equality filters. Only SELECTs are possible, so this can never mutate data.
 * Returns matching rows as pretty JSON, or a clear not-connected/error string.
 */
export async function safeRead(opts: SafeReadOpts): Promise<string> {
  const sb = acredClient();
  if (!sb) return ACREDOS_NOT_CONNECTED;
  const table = opts.table?.trim();
  if (!table) return 'acred OS error: a table name is required.';

  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
  const columns = opts.columns?.trim() || '*';

  try {
    let q = sb.from(table).select(columns);
    if (opts.filters && typeof opts.filters === 'object') {
      for (const [col, val] of Object.entries(opts.filters)) {
        if (val === undefined || val === null) continue;
        q = q.eq(col, val as string | number | boolean);
      }
    }
    const { data, error } = await q.limit(limit);
    if (error) return pgError(table, error);

    const rows = (data ?? []) as unknown[];
    if (!rows.length) return `No rows in ${table} matched.`;
    return `${rows.length} row(s) from ${table}:\n${JSON.stringify(rows, null, 2)}`;
  } catch (err) {
    return acredError(err);
  }
}
