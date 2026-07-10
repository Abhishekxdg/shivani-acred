/**
 * Super-memory: semantic + episodic long-term store over Postgres (pgvector).
 *
 * Backed by the `memories` table in src/db/schema.ts. Every function degrades
 * gracefully — when Postgres is unconfigured/unreachable or embeddings are not
 * configured, writes are silently skipped and reads return '' / [] instead of
 * throwing. The base app keeps working with none of this set up.
 *
 * Recall strategy:
 *   1. If the query can be embedded AND pgvector is available, order by vector
 *      similarity (`embedding <-> queryEmbedding`).
 *   2. Otherwise fall back to a case-insensitive `ILIKE` keyword match.
 */
import { query } from '../db/pg.js';
import { type Memory } from '../db/types.js';
import { embed } from './embeddings.js';
import { logger } from '../logger.js';

/** Format a JS number[] as the pgvector text literal `[a,b,c]`. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/**
 * Persist a memory. Embeds `content` (best effort — embedding may be null) and
 * inserts a row into `memories`. Never throws: if Postgres is absent the write
 * is skipped and a warning is logged.
 */
export async function remember(
  kind: string,
  content: string,
  metadata: Record<string, unknown> = {},
  scope = 'company',
): Promise<void> {
  const text = content.trim();
  if (!text) return;

  const embedding = await embed(text); // null when embeddings unconfigured/failed
  const vecLiteral = embedding ? toVectorLiteral(embedding) : null;

  try {
    await query(
      `INSERT INTO memories (kind, content, embedding, metadata, scope)
       VALUES ($1, $2, $3::vector, $4::jsonb, $5)`,
      [kind, text, vecLiteral, JSON.stringify(metadata ?? {}), scope],
    );
  } catch (err) {
    // Postgres missing/unreachable, or vector-dim mismatch — degrade quietly.
    logger.warn(err, 'remember() skipped: memory store unavailable');
  }
}

/**
 * Recall the most relevant memories for a query. Returns [] when nothing matches
 * or when the store is unavailable. Uses vector similarity when possible, else a
 * keyword fallback.
 */
export async function recall(
  queryText: string,
  limit = 8,
  scopes?: string[],
): Promise<Memory[]> {
  const q = queryText.trim();
  if (!q) return [];
  const scopeFilter = scopes && scopes.length ? scopes : null;

  // 1) Semantic search when we can embed the query.
  const embedding = await embed(q);
  if (embedding) {
    try {
      const sql = `SELECT id, kind, content, metadata, created_at
           FROM memories
          WHERE embedding IS NOT NULL${scopeFilter ? ' AND scope = ANY($3)' : ''}
          ORDER BY embedding <-> $1::vector
          LIMIT $2`;
      const params = scopeFilter
        ? [toVectorLiteral(embedding), limit, scopeFilter]
        : [toVectorLiteral(embedding), limit];
      return await query<Memory>(sql, params);
    } catch (err) {
      // pgvector missing or query failed — fall through to keyword search.
      logger.warn(err, 'semantic recall failed; falling back to keyword search');
    }
  }

  // 2) Keyword fallback (also the path when embeddings are unconfigured).
  try {
    const sql = `SELECT id, kind, content, metadata, created_at
         FROM memories
        WHERE content ILIKE $1${scopeFilter ? ' AND scope = ANY($3)' : ''}
        ORDER BY created_at DESC
        LIMIT $2`;
    const params = scopeFilter ? [`%${q}%`, limit, scopeFilter] : [`%${q}%`, limit];
    return await query<Memory>(sql, params);
  } catch (err) {
    // Postgres missing/unreachable.
    logger.warn(err, 'recall() unavailable: memory store not configured');
    return [];
  }
}

/**
 * Build a compact, prompt-injectable block of the memories most relevant to a
 * query. Returns '' when there is nothing to inject (so it can be concatenated
 * into a system prompt unconditionally).
 */
export async function recallContext(
  queryText: string,
  limit = 8,
  scopes?: string[],
): Promise<string> {
  const memories = await recall(queryText, limit, scopes);
  if (memories.length === 0) return '';

  const lines = memories.map((m) => {
    const when = (m.created_at ?? '').slice(0, 10);
    const tag = when ? `${m.kind} · ${when}` : m.kind;
    return `- [${tag}] ${m.content}`;
  });
  return `Relevant long-term memories:\n${lines.join('\n')}`;
}
