/**
 * Shared TypeScript row shapes for the Postgres tables defined in ./schema.ts.
 *
 * Notes on how the `pg` driver maps Postgres types (see ./pg.ts):
 * - SERIAL (int4) primary keys come back as native JS `number`.
 * - TIMESTAMPTZ columns are returned as ISO-ish `string` — ./pg.ts installs a
 *   type parser so they are NOT auto-converted to `Date` (keeps rows JSON-clean).
 * - JSONB columns are parsed into plain objects.
 * - `memories.embedding` is a pgvector column; when selected raw it comes back
 *   as a string like "[0.1,0.2,...]". It is typed here as its logical shape
 *   (`number[] | null`); most queries never select it back, they only order by
 *   similarity. Format it as a `[..]` string on insert.
 */

/** Lifecycle states a task moves through. Stored as free TEXT, so callers may
 * use their own values; these are the conventional ones. */
export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export interface Memory {
  id: number;
  kind: string;
  content: string;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Person {
  id: number;
  name: string;
  role: string | null;
  whatsapp: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
}

export interface Task {
  id: number;
  assignee: string | null;
  title: string;
  detail: string | null;
  milestone: string | null;
  due: string | null;
  status: TaskStatus | string;
  created_at: string;
  updated_at: string;
}

export interface Report {
  id: number;
  person: string | null;
  period: string | null;
  content: string;
  created_at: string;
}

export interface Connector {
  id: number;
  name: string;
  tokens: Record<string, unknown>;
  updated_at: string;
}

export interface Skill {
  id: number;
  name: string;
  kind: string;
  spec: string | null;
  code: string | null;
  enabled: boolean;
  created_at: string;
}
