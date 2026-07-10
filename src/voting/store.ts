/**
 * Reserved-matter voting store — a structured text vote for decisions that,
 * per the ACRED KB (section 8), require the assent of ALL founders. Shivani
 * opens a vote, posts it to the founders' group, records each founder's choice,
 * and tallies — surfacing exactly who still needs to weigh in.
 *
 * Self-contained, like ../outreach.ts: it owns its schema (idempotent
 * ENSURE_SQL + a lazy ensure()) over the shared pg helper. Degrades gracefully
 * — when Postgres is absent, ensure() throws the clear
 * "Postgres not configured: set DATABASE_URL" error, which the tools catch and
 * surface as a message instead of crashing. Nothing here runs at import time.
 */
import { getPool, query } from '../db/pg.js';

export type VoteStatus = 'open' | 'closed';

export interface Vote {
  id: number;
  question: string;
  /** The choices, in presentation order. Stored as a jsonb string[]. */
  options: string[];
  status: VoteStatus;
  /** JID/name of whoever opened the vote (for the audit trail). */
  created_by: string | null;
  created_at: string;
}

export interface Ballot {
  vote_id: number;
  /** Stable voter key — a founder's canonical JID when known, else free text. */
  voter: string;
  choice: string;
  created_at: string;
}

export interface VoteCount {
  choice: string;
  count: number;
}

export interface VoteTally {
  vote: Vote;
  totalBallots: number;
  /** Every option, in order, with its ballot count (options with 0 included). */
  counts: VoteCount[];
  ballots: Ballot[];
}

/**
 * Just the two tables this subsystem needs. `vote_ballots` keys on
 * (vote_id, voter) so a founder can change their mind — recordBallot upserts
 * on that key rather than stacking duplicate ballots. Created votes-first so the
 * foreign key resolves.
 */
const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS votes (
  id          SERIAL PRIMARY KEY,
  question    TEXT        NOT NULL,
  options     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT        NOT NULL DEFAULT 'open',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_votes_status ON votes (status);

CREATE TABLE IF NOT EXISTS vote_ballots (
  vote_id     INTEGER     NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  voter       TEXT        NOT NULL,
  choice      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vote_id, voter)
);
CREATE INDEX IF NOT EXISTS idx_vote_ballots_vote ON vote_ballots (vote_id);
`;

let ensured = false;

/** Ensure the tables exist before the first read/write. Throws the clear
 *  "not configured" error when Postgres is absent (propagated to the caller). */
async function ensure(): Promise<void> {
  if (ensured) return;
  const pool = getPool();
  if (!pool) throw new Error('Postgres not configured: set DATABASE_URL');
  await pool.query(ENSURE_SQL);
  ensured = true;
}

/** Open a new vote. `options` is stored verbatim as an ordered jsonb array. */
export async function openVote(
  question: string,
  options: string[],
  createdBy?: string | null,
): Promise<Vote> {
  await ensure();
  const rows = await query<Vote>(
    `INSERT INTO votes (question, options, created_by)
     VALUES ($1, $2::jsonb, $3) RETURNING *`,
    [question, JSON.stringify(options), createdBy ?? null],
  );
  return rows[0]!;
}

/** Fetch a single vote by id, or null when it does not exist. */
export async function getVote(id: number): Promise<Vote | null> {
  await ensure();
  const rows = await query<Vote>('SELECT * FROM votes WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Record (or replace) a voter's choice. Upserts on (vote_id, voter) so a founder
 * changing their vote overwrites their prior ballot rather than double-counting.
 */
export async function recordBallot(
  voteId: number,
  voter: string,
  choice: string,
): Promise<Ballot> {
  await ensure();
  const rows = await query<Ballot>(
    `INSERT INTO vote_ballots (vote_id, voter, choice)
     VALUES ($1, $2, $3)
     ON CONFLICT (vote_id, voter)
     DO UPDATE SET choice = EXCLUDED.choice, created_at = now()
     RETURNING *`,
    [voteId, voter, choice],
  );
  return rows[0]!;
}

/**
 * Tally a vote: every option with its count (zeros included), the total ballots
 * cast, and the raw ballots (so callers can reconcile voters against the
 * founders list). Returns null when the vote does not exist.
 */
export async function tally(voteId: number): Promise<VoteTally | null> {
  await ensure();
  const vote = await getVote(voteId);
  if (!vote) return null;
  const ballots = await query<Ballot>(
    'SELECT * FROM vote_ballots WHERE vote_id = $1 ORDER BY created_at, voter',
    [voteId],
  );
  const countMap = new Map<string, number>();
  for (const opt of vote.options) countMap.set(opt, 0); // seed so every option shows
  for (const b of ballots) countMap.set(b.choice, (countMap.get(b.choice) ?? 0) + 1);
  const counts: VoteCount[] = [...countMap.entries()].map(([choice, count]) => ({ choice, count }));
  return { vote, totalBallots: ballots.length, counts, ballots };
}

/** Mark a vote closed. Returns the updated row, or null when it does not exist. */
export async function closeVote(voteId: number): Promise<Vote | null> {
  await ensure();
  const rows = await query<Vote>(
    `UPDATE votes SET status = 'closed' WHERE id = $1 RETURNING *`,
    [voteId],
  );
  return rows[0] ?? null;
}
