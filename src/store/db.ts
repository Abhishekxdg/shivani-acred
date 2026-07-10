import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

mkdirSync(config.DATA_DIR, { recursive: true });

const db = new Database(join(config.DATA_DIR, 'cos-agent.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation, id);

  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    expr TEXT NOT NULL,
    instruction TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    text TEXT NOT NULL,
    due TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Schedule {
  id: string;
  expr: string;
  instruction: string;
}

export interface Commitment {
  id: number;
  owner: string;
  text: string;
  due: string | null;
  status: string;
  source: string | null;
  created_at: string;
}

export const store = {
  // --- conversation history -------------------------------------------------
  addMessage(conversation: string, role: 'user' | 'assistant', content: string): void {
    db.prepare('INSERT INTO messages (conversation, role, content) VALUES (?, ?, ?)').run(
      conversation,
      role,
      content,
    );
  },

  recentMessages(conversation: string, limit = 30): StoredMessage[] {
    const rows = db
      .prepare('SELECT role, content FROM messages WHERE conversation = ? ORDER BY id DESC LIMIT ?')
      .all(conversation, limit) as { role: string; content: string }[];
    return rows
      .reverse()
      .map((r) => ({ role: r.role as StoredMessage['role'], content: r.content }));
  },

  // --- long-term memory -----------------------------------------------------
  setMemory(key: string, value: string): void {
    db.prepare(
      `INSERT INTO memory (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(key, value);
  },

  allMemory(): { key: string; value: string }[] {
    return db.prepare('SELECT key, value FROM memory ORDER BY key').all() as {
      key: string;
      value: string;
    }[];
  },

  // --- audit ----------------------------------------------------------------
  audit(actor: string, action: string, detail?: string): void {
    db.prepare('INSERT INTO audit (actor, action, detail) VALUES (?, ?, ?)').run(
      actor,
      action,
      detail ?? null,
    );
  },

  // --- schedules (persisted so cron survives restarts) ----------------------
  upsertSchedule(id: string, expr: string, instruction: string): void {
    db.prepare(
      `INSERT INTO schedules (id, expr, instruction) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET expr = excluded.expr, instruction = excluded.instruction`,
    ).run(id, expr, instruction);
  },

  deleteSchedule(id: string): void {
    db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  },

  allSchedules(): Schedule[] {
    return db.prepare('SELECT id, expr, instruction FROM schedules').all() as Schedule[];
  },

  // --- commitments ----------------------------------------------------------
  addCommitment(owner: string, text: string, due?: string, source?: string): number {
    const info = db
      .prepare('INSERT INTO commitments (owner, text, due, source) VALUES (?, ?, ?, ?)')
      .run(owner, text, due ?? null, source ?? null);
    return Number(info.lastInsertRowid);
  },

  listCommitments(status?: string): Commitment[] {
    if (status) {
      return db
        .prepare('SELECT * FROM commitments WHERE status = ? ORDER BY id DESC')
        .all(status) as Commitment[];
    }
    return db.prepare('SELECT * FROM commitments ORDER BY id DESC').all() as Commitment[];
  },

  updateCommitment(id: number, status: string): boolean {
    const info = db
      .prepare("UPDATE commitments SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
    return info.changes > 0;
  },
};

export default db;
