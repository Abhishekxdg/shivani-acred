/**
 * Canonical Postgres schema for Shivani's long-term brain.
 *
 * This SQL is fully idempotent (CREATE EXTENSION / TABLE IF NOT EXISTS) so it is
 * safe to run on every boot via `initSchema()` in ./pg.ts. It requires the
 * pgvector extension for the `memories.embedding` column (1536 dims, matching
 * OpenAI-style text-embedding vectors).
 *
 * Ids use SERIAL (int4) so the `pg` driver returns them as native JS numbers
 * (bigint would come back as a string) — see ./types.ts.
 */
export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

-- Semantic memory: embedded notes/facts the agent can recall by similarity.
CREATE TABLE IF NOT EXISTS memories (
  id          SERIAL PRIMARY KEY,
  kind        TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  embedding   vector(1536),
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories (kind);
-- Memory namespace: 'company' = shared brain, 'profile:<number>' = a person's private space.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'company';
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope);

-- People the chief-of-staff coordinates with (founders, team, contacts).
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

-- Tasks the agent tracks against people and milestones.
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

-- Generated reports / digests (per person, per period).
CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  person      TEXT,
  period      TEXT,
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OAuth / API tokens for external connectors, keyed by connector name.
CREATE TABLE IF NOT EXISTS connectors (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  tokens      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Learned / installed skills the agent can grow at runtime.
CREATE TABLE IF NOT EXISTS skills (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  kind        TEXT        NOT NULL,
  spec        TEXT,
  code        TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customers / prospects Shivani reaches out to and converses with.
CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  whatsapp    TEXT,          -- bare number (digits) for matching + outreach
  company     TEXT,
  needs       TEXT,          -- what they want
  context     TEXT,          -- who/why, captured from the founder
  owner       TEXT,          -- founder who owns the relationship
  status      TEXT        NOT NULL DEFAULT 'new',
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_whatsapp ON customers (whatsapp);

-- Per-person agent profile: the personalized face each founder gets (their
-- chosen name for the agent, their identity/lane), keyed by WhatsApp JID.
CREATE TABLE IF NOT EXISTS profiles (
  jid         TEXT PRIMARY KEY,
  owner_name  TEXT,
  agent_name  TEXT,
  role        TEXT,
  lane        TEXT,
  onboarded   BOOLEAN     NOT NULL DEFAULT false,
  prefs       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
