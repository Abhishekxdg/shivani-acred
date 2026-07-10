/**
 * People / Tasks / Reports store — the chief-of-staff coordination brain.
 *
 * A thin, typed CRUD layer over the `people`, `tasks` and `reports` tables
 * defined in ../db/schema.ts, using the Postgres helper in ../db/pg.ts.
 *
 * Degrades gracefully: when Postgres is not configured (`DATABASE_URL` unset),
 * `query()` throws a clear "Postgres not configured: set DATABASE_URL" error.
 * These functions let that error propagate unchanged so callers (tools/routines)
 * can catch it and surface the message instead of crashing. Nothing here runs at
 * import time, so the base app still boots with no Postgres configured.
 */
import { getPool, query } from '../db/pg.js';
import type { Person, Report, Task } from '../db/types.js';

/** Statuses that count as "no longer open" for chase / digest purposes. */
const CLOSED_STATUSES = ['done', 'cancelled'] as const;

/**
 * Defensive, idempotent creation of just the three tables this module needs.
 * The canonical schema (with pgvector etc.) lives in ../db/schema.ts and is run
 * by initSchema() at boot; this mirror lets the subsystem work even if that was
 * never invoked. CREATE TABLE IF NOT EXISTS never alters an existing table, so
 * there is no conflict when the canonical schema already created them.
 */
const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS people (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  role        TEXT,
  whatsapp    TEXT,
  email       TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_people_name ON people (name);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  assignee    TEXT,
  title       TEXT        NOT NULL,
  detail      TEXT,
  milestone   TEXT,
  due         TIMESTAMPTZ,
  status      TEXT        NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee);

CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  person      TEXT,
  period      TEXT,
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let ensured = false;

/** Ensure the tables exist before the first read/write. Throws the clear
 *  "not configured" error when Postgres is absent (propagated from query()). */
async function ensureTables(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  if (!pool) throw new Error('Postgres not configured: set DATABASE_URL');
  await pool.query(ENSURE_SQL);
  ensured = true;
}

/** Best-effort normalize a due date to an ISO string; returns null when the
 *  input is empty or not a parseable date (so free-text like "friday" is kept
 *  out of the TIMESTAMPTZ column rather than throwing a cast error). */
export function normalizeDue(due?: string | null): string | null {
  const raw = (due ?? '').trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// --- people -----------------------------------------------------------------

export async function addPerson(
  name: string,
  role?: string,
  whatsapp?: string,
  email?: string,
  notes?: string,
): Promise<Person> {
  await ensureTables();
  const rows = await query<Person>(
    `INSERT INTO people (name, role, whatsapp, email, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, role ?? null, whatsapp ?? null, email ?? null, notes ?? null],
  );
  return rows[0]!;
}

export async function listPeople(): Promise<Person[]> {
  await ensureTables();
  return query<Person>('SELECT * FROM people ORDER BY name');
}

/** Find a person by numeric id, exact (case-insensitive) name, or partial name. */
export async function findPerson(nameOrId: string | number): Promise<Person | null> {
  await ensureTables();
  const raw = String(nameOrId).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const byId = await query<Person>('SELECT * FROM people WHERE id = $1', [Number(raw)]);
    if (byId[0]) return byId[0];
  }
  const exact = await query<Person>(
    'SELECT * FROM people WHERE lower(name) = lower($1) ORDER BY id LIMIT 1',
    [raw],
  );
  if (exact[0]) return exact[0];

  const like = await query<Person>(
    "SELECT * FROM people WHERE name ILIKE '%' || $1 || '%' ORDER BY id LIMIT 1",
    [raw],
  );
  return like[0] ?? null;
}

// --- tasks ------------------------------------------------------------------

export async function assignTask(
  assignee: string | null,
  title: string,
  detail?: string,
  milestone?: string,
  due?: string,
): Promise<Task> {
  await ensureTables();
  const rows = await query<Task>(
    `INSERT INTO tasks (assignee, title, detail, milestone, due)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [assignee ?? null, title, detail ?? null, milestone ?? null, normalizeDue(due)],
  );
  return rows[0]!;
}

export interface TaskFilter {
  status?: string;
  assignee?: string;
  milestone?: string;
  /** When true, return everything except done/cancelled. */
  openOnly?: boolean;
}

export async function listTasks(filter: TaskFilter = {}): Promise<Task[]> {
  await ensureTables();
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
  if (filter.milestone) {
    params.push(filter.milestone);
    clauses.push(`milestone ILIKE '%' || $${params.length} || '%'`);
  }
  if (filter.openOnly) {
    clauses.push(`NOT (status = ANY($${params.push(CLOSED_STATUSES)}))`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return query<Task>(`SELECT * FROM tasks ${where} ORDER BY due NULLS LAST, id`, params);
}

export async function updateTaskStatus(id: number, status: string): Promise<Task | null> {
  await ensureTables();
  const rows = await query<Task>(
    `UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [status, id],
  );
  return rows[0] ?? null;
}

/** Open tasks grouped by assignee, most-loaded person first. */
export interface PersonOpenTasks {
  assignee: string;
  count: number;
  overdue: number;
  tasks: Task[];
}

export async function openTasksByPerson(): Promise<PersonOpenTasks[]> {
  await ensureTables();
  const rows = await query<Task>(
    `SELECT * FROM tasks WHERE NOT (status = ANY($1))
     ORDER BY assignee NULLS LAST, due NULLS LAST, id`,
    [CLOSED_STATUSES],
  );

  const now = Date.now();
  const groups = new Map<string, PersonOpenTasks>();
  for (const t of rows) {
    const key = t.assignee?.trim() || '(unassigned)';
    const g = groups.get(key) ?? { assignee: key, count: 0, overdue: 0, tasks: [] };
    g.tasks.push(t);
    g.count += 1;
    if (t.due && Date.parse(t.due) < now) g.overdue += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.overdue - a.overdue || b.count - a.count);
}

// --- reports ----------------------------------------------------------------

export async function addReport(
  person: string | null,
  period: string | null,
  content: string,
): Promise<Report> {
  await ensureTables();
  const rows = await query<Report>(
    `INSERT INTO reports (person, period, content) VALUES ($1, $2, $3) RETURNING *`,
    [person ?? null, period ?? null, content],
  );
  return rows[0]!;
}

export async function listReports(
  filter: { person?: string; period?: string; limit?: number } = {},
): Promise<Report[]> {
  await ensureTables();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.person) {
    params.push(filter.person);
    clauses.push(`person ILIKE '%' || $${params.length} || '%'`);
  }
  if (filter.period) {
    params.push(filter.period);
    clauses.push(`period = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(filter.limit ?? 100, 500)));
  return query<Report>(
    `SELECT * FROM reports ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
}
