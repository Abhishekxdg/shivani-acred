/**
 * Customers / prospects store — for autonomous outreach. Founders point Shivani
 * at a customer (add_customer with context), she reaches out and converses to
 * gather requirements, logging what she learns. Backed by the `customers` table.
 * Degrades gracefully when Postgres is absent (customerByJid → null).
 */
import { getPool, query } from './db/pg.js';
import { numberFromJid } from './config.js';

export interface Customer {
  id: number;
  name: string;
  whatsapp: string | null;
  company: string | null;
  needs: string | null;
  context: string | null;
  owner: string | null;
  status: string;
  notes: string | null;
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  whatsapp    TEXT,
  company     TEXT,
  needs       TEXT,
  context     TEXT,
  owner       TEXT,
  status      TEXT        NOT NULL DEFAULT 'new',
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_whatsapp ON customers (whatsapp);
`;

let ensured = false;
async function ensure(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  if (!pool) throw new Error('Postgres not configured: set DATABASE_URL');
  await pool.query(ENSURE_SQL);
  ensured = true;
}

/** Normalize any number/JID to bare digits for storage + matching. */
function digits(input?: string | null): string | null {
  const d = (input ?? '').replace(/[^\d]/g, '');
  return d || null;
}

export interface NewCustomer {
  name: string;
  whatsapp?: string;
  company?: string;
  needs?: string;
  context?: string;
  owner?: string;
}

export async function addCustomer(c: NewCustomer): Promise<Customer> {
  await ensure();
  const rows = await query<Customer>(
    `INSERT INTO customers (name, whatsapp, company, needs, context, owner)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [c.name, digits(c.whatsapp), c.company ?? null, c.needs ?? null, c.context ?? null, c.owner ?? null],
  );
  return rows[0]!;
}

export async function listCustomers(): Promise<Customer[]> {
  await ensure();
  return query<Customer>('SELECT * FROM customers ORDER BY updated_at DESC, id DESC');
}

export async function findCustomer(nameOrId: string | number): Promise<Customer | null> {
  await ensure();
  const raw = String(nameOrId).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const byId = await query<Customer>('SELECT * FROM customers WHERE id = $1', [Number(raw)]);
    if (byId[0]) return byId[0];
  }
  const like = await query<Customer>(
    "SELECT * FROM customers WHERE name ILIKE '%' || $1 || '%' ORDER BY id LIMIT 1",
    [raw],
  );
  return like[0] ?? null;
}

/** Match an incoming DM sender to a known customer (by phone number). */
export async function customerByJid(jid: string): Promise<Customer | null> {
  try {
    await ensure();
  } catch {
    return null;
  }
  const n = digits(numberFromJid(jid) ?? jid);
  if (!n) return null;
  const rows = await query<Customer>('SELECT * FROM customers WHERE whatsapp = $1 LIMIT 1', [n]);
  return rows[0] ?? null;
}

export async function addCustomerNote(id: number, note: string): Promise<boolean> {
  await ensure();
  const rows = await query<Customer>(
    `UPDATE customers
        SET notes = COALESCE(notes || E'\\n', '') || $2, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [id, note],
  );
  return rows.length > 0;
}

export async function setCustomerStatus(id: number, status: string): Promise<void> {
  await ensure();
  await query('UPDATE customers SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
}
