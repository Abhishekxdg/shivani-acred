/**
 * Projects store — NEW-PROJECT INTAKE for the chief-of-staff brain.
 *
 * When a founder says "start a new project", Shivani captures WHAT it is, its
 * goal, and — the point of intake — WHERE to start and HOW to start, plus any
 * free-text details. Each project can then accrue milestones (the plan) in a
 * sibling `project_milestones` table.
 *
 * Self-contained like src/outreach.ts and src/people/store.ts: it owns its
 * idempotent ENSURE_SQL, runs a lazy ensure() on first use over ../db/pg.js,
 * and degrades gracefully — when Postgres is absent the clear
 * "Postgres not configured: set DATABASE_URL" error propagates so tools can
 * catch it and surface a message instead of crashing. Nothing runs at import
 * time, so the base app still boots with no Postgres configured.
 */
import { getPool, query } from '../db/pg.js';

export interface Project {
  id: number;
  name: string;
  kind: string | null;
  goal: string | null;
  where_to_start: string | null;
  how_to_start: string | null;
  details: string | null;
  owner: string | null;
  status: string;
  created_at: string;
}

export interface Milestone {
  id: number;
  project_id: number;
  title: string;
  detail: string | null;
  status: string;
  due: string | null;
  created_at: string;
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id             SERIAL PRIMARY KEY,
  name           TEXT        NOT NULL,
  kind           TEXT,
  goal           TEXT,
  where_to_start TEXT,
  how_to_start   TEXT,
  details        TEXT,
  owner          TEXT,
  status         TEXT        NOT NULL DEFAULT 'planning',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner);

CREATE TABLE IF NOT EXISTS project_milestones (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER     NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  detail      TEXT,
  status      TEXT        NOT NULL DEFAULT 'open',
  due         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones (project_id);
`;

let ensured = false;

/** Ensure the tables exist before the first read/write. Throws the clear
 *  "not configured" error when Postgres is absent (propagated from query()). */
async function ensure(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  if (!pool) throw new Error('Postgres not configured: set DATABASE_URL');
  await pool.query(ENSURE_SQL);
  ensured = true;
}

export interface NewProject {
  name: string;
  kind?: string;
  goal?: string;
  where_to_start?: string;
  how_to_start?: string;
  details?: string;
  owner?: string;
  status?: string;
}

/** Create a project. Unset optional fields are stored as NULL. */
export async function add(p: NewProject): Promise<Project> {
  await ensure();
  const rows = await query<Project>(
    `INSERT INTO projects (name, kind, goal, where_to_start, how_to_start, details, owner, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'planning'))
     RETURNING *`,
    [
      p.name,
      p.kind ?? null,
      p.goal ?? null,
      p.where_to_start ?? null,
      p.how_to_start ?? null,
      p.details ?? null,
      p.owner ?? null,
      p.status ?? null,
    ],
  );
  return rows[0]!;
}

export async function list(): Promise<Project[]> {
  await ensure();
  return query<Project>('SELECT * FROM projects ORDER BY created_at DESC, id DESC');
}

/** Find a project by numeric id, exact (case-insensitive) name, or partial name. */
export async function get(nameOrId: string | number): Promise<Project | null> {
  await ensure();
  const raw = String(nameOrId).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const byId = await query<Project>('SELECT * FROM projects WHERE id = $1', [Number(raw)]);
    if (byId[0]) return byId[0];
  }
  const exact = await query<Project>(
    'SELECT * FROM projects WHERE lower(name) = lower($1) ORDER BY id LIMIT 1',
    [raw],
  );
  if (exact[0]) return exact[0];

  const like = await query<Project>(
    "SELECT * FROM projects WHERE name ILIKE '%' || $1 || '%' ORDER BY id LIMIT 1",
    [raw],
  );
  return like[0] ?? null;
}

/** Fields update_project may patch. Only provided keys are written. */
export interface ProjectPatch {
  name?: string;
  kind?: string;
  goal?: string;
  where_to_start?: string;
  how_to_start?: string;
  details?: string;
  owner?: string;
  status?: string;
}

const PATCHABLE: readonly (keyof ProjectPatch)[] = [
  'name',
  'kind',
  'goal',
  'where_to_start',
  'how_to_start',
  'details',
  'owner',
  'status',
];

/**
 * Update the mutable fields of a project (details, status, goal, the where/how
 * of starting, owner, kind, name). Only keys present on `patch` are written;
 * returns the updated row, or null when the id is unknown or nothing to change.
 */
export async function updateDetails(id: number, patch: ProjectPatch): Promise<Project | null> {
  await ensure();
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of PATCHABLE) {
    const val = patch[key];
    if (val === undefined) continue;
    params.push(val);
    sets.push(`${key} = $${params.length}`);
  }
  if (sets.length === 0) return get(id);
  params.push(id);
  const rows = await query<Project>(
    `UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

export interface NewMilestone {
  title: string;
  detail?: string;
  status?: string;
  due?: string;
}

/** Append a milestone (a plan step) to a project. */
export async function addMilestone(projectId: number, m: NewMilestone): Promise<Milestone> {
  await ensure();
  const rows = await query<Milestone>(
    `INSERT INTO project_milestones (project_id, title, detail, status, due)
     VALUES ($1, $2, $3, COALESCE($4, 'open'), $5)
     RETURNING *`,
    [projectId, m.title, m.detail ?? null, m.status ?? null, m.due ?? null],
  );
  return rows[0]!;
}

/** Milestones for a project, oldest first (plan order). */
export async function listMilestones(projectId: number): Promise<Milestone[]> {
  await ensure();
  return query<Milestone>(
    'SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY created_at, id',
    [projectId],
  );
}
