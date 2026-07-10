/**
 * Postgres access layer for Shivani's long-term brain (pgvector-backed).
 *
 * Degrades gracefully: when `DATABASE_URL` is unset, `getPool()` returns null
 * and every dependent feature is expected to surface a clear
 * "not configured: set DATABASE_URL" message instead of throwing at import time.
 * The base app boots fine with no Postgres configured.
 */
import { Pool, types } from 'pg';
import { logger } from '../logger.js';
import { SCHEMA_SQL } from './schema.js';

// Return TIMESTAMPTZ (1184) and TIMESTAMP (1114) as raw strings rather than JS
// Date objects, so rows serialize cleanly to JSON when handed to the model.
types.setTypeParser(1184, (v: string) => v);
types.setTypeParser(1114, (v: string) => v);

let pool: Pool | null = null;

/**
 * Singleton pg Pool, or null when Postgres is not configured.
 * Reads `DATABASE_URL` lazily so the pool is created on first real use.
 */
export function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new Pool({ connectionString: url });
    pool.on('error', (err) => logger.error(err, 'pg pool error (idle client)'));
    logger.info('pg pool created');
  }
  return pool;
}

/**
 * Run a query and return its rows. Throws a clear Error when Postgres is not
 * configured, so callers can catch and report "not configured: set DATABASE_URL".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const p = getPool();
  if (!p) throw new Error('Postgres not configured: set DATABASE_URL');
  const res = await p.query(sql, params);
  return res.rows as T[];
}

/** True when Postgres is configured AND reachable (a `SELECT 1` succeeds). */
export async function isReady(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query('SELECT 1');
    return true;
  } catch (err) {
    logger.warn(err, 'pg isReady() check failed');
    return false;
  }
}

/**
 * Ensure the pgvector extension and all tables exist. Idempotent — safe to call
 * on every boot. Throws a clear Error when Postgres is not configured.
 */
export async function initSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('Postgres not configured: set DATABASE_URL');
  await p.query(SCHEMA_SQL);
  logger.info('pg schema ensured (pgvector + tables)');
}

/** Close the pool (for graceful shutdown). Safe to call when unconfigured. */
export async function end(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
