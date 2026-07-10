/**
 * Memory consolidation — keeps super-memory premium instead of letting it rot.
 *
 * Three passes, all scoped to one memory namespace (or every namespace when no
 * scope is given), run over the `memories` table (see src/db/schema.ts):
 *   1. Dedup      — drop exact-duplicate content, then near-duplicate content
 *                   (pgvector cosine distance), keeping the oldest canonical row.
 *   2. Summarize  — fold each large cluster of same-kind notes into one compact
 *                   LLM-written 'summary' memory, then delete the folded sources.
 *   3. Decay      — delete very old, never-recalled entries and mark middle-aged
 *                   ones as stale, sparing a few protected kinds.
 *
 * Self-contained store discipline (mirrors src/outreach.ts): its own idempotent
 * ENSURE_SQL + lazy ensure() over db/pg.js. It NEVER throws and NEVER assumes the
 * canonical schema ran. When Postgres is absent it returns a clear no-op string;
 * when the LLM/embeddings are absent the summarize pass simply leaves clusters
 * intact. Callers get a human-readable report string in every case.
 */
import { getPool, query } from '../db/pg.js';
import { embed } from './embeddings.js';
import { llm, MODEL } from '../llm/openrouter.js';
import { logger } from '../logger.js';

// --- tunables ---------------------------------------------------------------

/** Cosine distance (pgvector `<=>`) below which two same-kind memories are
 *  treated as near-duplicates. ~0.08 ≈ 92%+ cosine similarity. */
const NEAR_DUP_DISTANCE = 0.08;
/** A same-kind group this size or larger in one scope is a "large cluster". */
const CLUSTER_MIN_SIZE = 8;
/** Cap LLM calls per run so consolidation stays cheap. */
const MAX_CLUSTERS_PER_RUN = 8;
/** Cap the notes folded into a single summary (protects context + latency). */
const MAX_SOURCES_PER_CLUSTER = 100;
/** Memories older than this (and never recalled) are marked stale. */
const STALE_AFTER_DAYS = 90;
/** Memories older than this (and never recalled) are deleted outright. */
const DELETE_AFTER_DAYS = 180;
/** Kinds that are never near-deduped, summarized away, or decayed. */
const PROTECTED_KINDS = ['summary', 'decision', 'pinned'];

const NOT_CONFIGURED =
  'Memory consolidation is a no-op: not configured — set DATABASE_URL ' +
  '(Postgres with the pgvector extension).';

const SUMMARY_SYSTEM =
  'You compress a set of related long-term memory notes into ONE dense, factual ' +
  'summary. Preserve concrete facts, names, numbers, decisions and preferences; ' +
  'drop redundancy and filler. Output only the summary — no preamble, no bullet ' +
  'headers unless they add signal. Keep it under ~120 words.';

// --- own idempotent schema (see hard rules) ---------------------------------

const ENSURE_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memories (
  id          SERIAL PRIMARY KEY,
  kind        TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  embedding   vector(1536),
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'company';
-- Recall tracking so decay can spare memories that actually get used. Populated
-- by future recall instrumentation; absent that, these stay at their defaults
-- and decay is simply age-based (which is the intent for a fresh install).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS recall_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_recalled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories (kind);
`;

let ensured = false;
async function ensure(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  if (!pool) throw new Error('Postgres not configured: set DATABASE_URL');
  await pool.query(ENSURE_SQL);
  ensured = true;
}

// --- options + result -------------------------------------------------------

export interface ConsolidateOptions {
  /** Fold large same-kind clusters into LLM summaries (default true). */
  summarize?: boolean;
  /** Mark stale / delete very old, never-recalled memories (default true). */
  decay?: boolean;
}

/** Format a JS number[] as the pgvector text literal `[a,b,c]` (like store.ts). */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// --- pass 1a: exact-duplicate content ---------------------------------------

async function dedupExact(scope?: string): Promise<number> {
  const params: unknown[] = [];
  const scopeClause = scope ? ` AND m.scope = $${params.push(scope)}` : '';
  const rows = await query<{ n: number }>(
    `WITH del AS (
       DELETE FROM memories m
        USING memories keep
        WHERE m.scope = keep.scope
          AND m.content = keep.content
          AND m.id > keep.id${scopeClause}
       RETURNING m.id
     )
     SELECT count(*)::int AS n FROM del`,
    params,
  );
  return rows[0]?.n ?? 0;
}

// --- pass 1b: near-duplicate content (vector similarity) --------------------

async function dedupNear(scope?: string): Promise<number> {
  const params: unknown[] = [NEAR_DUP_DISTANCE, PROTECTED_KINDS];
  const scopeClause = scope ? ` AND m.scope = $${params.push(scope)}` : '';
  const rows = await query<{ n: number }>(
    `WITH del AS (
       DELETE FROM memories m
        USING memories keep
        WHERE m.embedding IS NOT NULL
          AND keep.embedding IS NOT NULL
          AND m.scope = keep.scope
          AND m.kind = keep.kind
          AND m.id > keep.id
          AND m.content <> keep.content
          AND m.kind <> ALL($2::text[])
          AND (m.embedding <=> keep.embedding) < $1${scopeClause}
       RETURNING m.id
     )
     SELECT count(*)::int AS n FROM del`,
    params,
  );
  return rows[0]?.n ?? 0;
}

// --- pass 2: summarize large clusters ---------------------------------------

interface ClusterRow {
  scope: string;
  kind: string;
  n: number;
}

async function summarizeClusters(scope?: string): Promise<{ clusters: number; folded: number }> {
  const params: unknown[] = [PROTECTED_KINDS, CLUSTER_MIN_SIZE, MAX_CLUSTERS_PER_RUN];
  const scopeClause = scope ? ` AND scope = $${params.push(scope)}` : '';
  const clusters = await query<ClusterRow>(
    `SELECT scope, kind, count(*)::int AS n
       FROM memories
      WHERE kind <> ALL($1::text[])${scopeClause}
      GROUP BY scope, kind
     HAVING count(*) >= $2
      ORDER BY n DESC
      LIMIT $3`,
    params,
  );

  let done = 0;
  let folded = 0;
  for (const c of clusters) {
    const n = await summarizeOne(c.scope, c.kind);
    if (n > 0) {
      done += 1;
      folded += n;
    }
  }
  return { clusters: done, folded };
}

/** Fold one (scope, kind) cluster into a single 'summary' memory. Returns the
 *  number of source notes folded, or 0 when the LLM is unavailable/empty (in
 *  which case the cluster is left untouched — no data loss). */
async function summarizeOne(clusterScope: string, kind: string): Promise<number> {
  const sources = await query<{ id: number; content: string }>(
    `SELECT id, content FROM memories
      WHERE scope = $1 AND kind = $2
      ORDER BY created_at ASC, id ASC
      LIMIT $3`,
    [clusterScope, kind, MAX_SOURCES_PER_CLUSTER],
  );
  if (sources.length < CLUSTER_MIN_SIZE) return 0;

  let summary = '';
  try {
    const res = await llm.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content:
            `These ${sources.length} notes are all of kind "${kind}". ` +
            `Fold them into ONE compact memory:\n\n` +
            sources.map((s, i) => `${i + 1}. ${s.content}`).join('\n'),
        },
      ],
    });
    summary = (res.choices[0]?.message?.content ?? '').trim();
  } catch (err) {
    logger.warn(err, 'consolidation: cluster summary LLM call failed; leaving cluster intact');
    return 0;
  }
  if (!summary) return 0;

  const embedding = await embed(summary); // null when embeddings unconfigured
  const vec = embedding ? toVectorLiteral(embedding) : null;
  const ids = sources.map((s) => s.id);
  const metadata = {
    consolidated: true,
    consolidated_from_kind: kind,
    source_count: sources.length,
    source_ids: ids,
  };

  await query(
    `INSERT INTO memories (kind, content, embedding, metadata, scope)
     VALUES ('summary', $1, $2::vector, $3::jsonb, $4)`,
    [summary, vec, JSON.stringify(metadata), clusterScope],
  );
  await query(`DELETE FROM memories WHERE id = ANY($1::int[])`, [ids]);
  return sources.length;
}

// --- pass 3: decay stale, never-recalled entries ----------------------------

async function decayStale(scope?: string): Promise<{ deleted: number; marked: number }> {
  // Delete the very old first so we don't waste a mark on rows about to go.
  const delParams: unknown[] = [DELETE_AFTER_DAYS, PROTECTED_KINDS];
  const delScope = scope ? ` AND scope = $${delParams.push(scope)}` : '';
  const del = await query<{ n: number }>(
    `WITH d AS (
       DELETE FROM memories
        WHERE created_at < now() - make_interval(days => $1)
          AND recall_count = 0
          AND kind <> ALL($2::text[])${delScope}
       RETURNING id
     )
     SELECT count(*)::int AS n FROM d`,
    delParams,
  );

  // Mark the middle-aged, never-recalled, not-yet-flagged rows as stale.
  const markParams: unknown[] = [STALE_AFTER_DAYS, PROTECTED_KINDS];
  const markScope = scope ? ` AND scope = $${markParams.push(scope)}` : '';
  const mark = await query<{ n: number }>(
    `WITH m AS (
       UPDATE memories
          SET metadata = metadata || jsonb_build_object('stale', true, 'stale_at', now()::text)
        WHERE created_at < now() - make_interval(days => $1)
          AND recall_count = 0
          AND kind <> ALL($2::text[])
          AND (metadata->>'stale') IS DISTINCT FROM 'true'${markScope}
       RETURNING id
     )
     SELECT count(*)::int AS n FROM m`,
    markParams,
  );

  return { deleted: del[0]?.n ?? 0, marked: mark[0]?.n ?? 0 };
}

// --- public entry point -----------------------------------------------------

/**
 * Consolidate long-term memory. Pass a `scope` to sweep one namespace
 * (e.g. 'company' or 'profile:<number>'); omit it to sweep every scope,
 * deduping/summarizing/decaying within each. Returns a report string and
 * never throws — a no-op string when Postgres is absent.
 */
export async function consolidateMemory(
  scope?: string,
  opts: ConsolidateOptions = {},
): Promise<string> {
  const targetScope = scope?.trim() || undefined;

  if (!getPool()) return NOT_CONFIGURED;
  try {
    await ensure();
  } catch (err) {
    logger.warn(err, 'consolidation: ensure() failed (store unavailable)');
    return NOT_CONFIGURED;
  }

  const doSummarize = opts.summarize !== false;
  const doDecay = opts.decay !== false;

  try {
    const exact = await dedupExact(targetScope);
    const near = await dedupNear(targetScope);
    const summary = doSummarize
      ? await summarizeClusters(targetScope)
      : { clusters: 0, folded: 0 };
    const decayed = doDecay ? await decayStale(targetScope) : { deleted: 0, marked: 0 };

    const where = targetScope ? `scope "${targetScope}"` : 'all scopes';
    const dupes = exact + near;
    return (
      `Memory consolidation (${where}): ` +
      `removed ${dupes} duplicate ${plural(dupes, 'memory', 'memories')} ` +
      `(${exact} exact, ${near} near); ` +
      `summarized ${summary.clusters} ${plural(summary.clusters, 'cluster', 'clusters')} ` +
      `(${summary.folded} notes folded into summaries); ` +
      `marked ${decayed.marked} stale, deleted ${decayed.deleted} very old.`
    );
  } catch (err) {
    logger.warn(err, 'consolidation failed mid-run');
    return `Memory consolidation hit an error (partially applied): ${
      (err as Error)?.message ?? 'unknown error'
    }.`;
  }
}
