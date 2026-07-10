/**
 * Reserved-matter voting tools — a structured text vote for decisions that
 * (per ACRED KB section 8) require the assent of ALL founders. Shivani opens a
 * vote, posts it to the founders' group, records each founder's choice, tallies
 * the result, and closes it. Every tally reconciles ballots against the
 * configured founders list so a "reserved matter" is only settled once every
 * founder has weighed in.
 *
 * All four tools are the 'public' tier: founders (and the principal) act on them
 * directly in the founders' group or a DM. Postgres-absent degrades to a clear
 * "not configured" message via the store's ensure().
 */
import {
  openVote,
  getVote,
  recordBallot,
  tally,
  closeVote,
  type Vote,
  type Ballot,
  type VoteTally,
} from '../../voting/store.js';
import { sendMessage } from '../../whatsapp/gateway.js';
import { enqueueSend } from '../../whatsapp/pacing.js';
import {
  founders,
  founderByJid,
  foundersGroupJid,
  numberFromJid,
  toJid,
  type Founder,
} from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

// --- helpers ----------------------------------------------------------------

/** Parse a vote id from tool args (number or numeric string); null when invalid. */
function parseVoteId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Find a configured founder by (case-insensitive) name. */
function founderByName(name: string): Founder | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return founders.find((f) => f.name.toLowerCase() === n);
}

/**
 * Resolve a free-text voter (a JID, a bare number, or a founder's name) to a
 * founder when possible. Returns the founder plus the key to persist: a
 * founder's canonical JID when matched (so device/@lid variants collapse), else
 * the trimmed raw string.
 */
function resolveVoter(raw: string): { founder?: Founder; key: string; label: string } {
  const trimmed = raw.trim();
  const f = founderByJid(toJid(trimmed)) ?? founderByName(trimmed);
  if (f) return { founder: f, key: f.jid, label: f.name };
  return { key: trimmed, label: trimmed };
}

/** True when `voter` (a stored ballot key) belongs to founder `f`. */
function ballotIsFrom(voter: string, f: Founder): boolean {
  if (voter === f.jid) return true;
  const vn = numberFromJid(voter);
  const fn = numberFromJid(f.jid);
  if (vn && fn && vn === fn) return true;
  return voter.trim().toLowerCase() === f.name.toLowerCase();
}

interface FounderReconciliation {
  voted: Array<{ founder: Founder; choice: string }>;
  missing: Founder[];
  /** True only when there is at least one founder AND none are missing. */
  allVoted: boolean;
}

/** Match cast ballots against the configured founders list. */
function reconcileFounders(ballots: Ballot[]): FounderReconciliation {
  const voted: Array<{ founder: Founder; choice: string }> = [];
  const missing: Founder[] = [];
  for (const f of founders) {
    const b = ballots.find((x) => ballotIsFrom(x.voter, f));
    if (b) voted.push({ founder: f, choice: b.choice });
    else missing.push(f);
  }
  return { voted, missing, allVoted: founders.length > 0 && missing.length === 0 };
}

/** Clean caller-supplied options: trim, drop empties, de-dupe (case-insensitive). */
function cleanOptions(input: unknown): string[] {
  const arr: unknown[] = Array.isArray(input)
    ? input
    : typeof input === 'string' && input.trim()
      ? input.split(',')
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const s = String(raw).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.length ? out : ['Yes', 'No'];
}

/** The message Shivani posts to the founders' group to open a vote. */
function composeAnnouncement(vote: Vote): string {
  return [
    `🗳️ Reserved-matter vote #${vote.id} — needs ALL founders`,
    '',
    vote.question,
    '',
    'Options:',
    ...vote.options.map((o, i) => `${i + 1}. ${o}`),
    '',
    `Reply and I'll record it, e.g. "vote #${vote.id} ${vote.options[0] ?? 'Yes'}".`,
  ].join('\n');
}

/** Render a tally with founder reconciliation for a tool reply. */
function formatTally(t: VoteTally): string {
  const { vote, counts, totalBallots, ballots } = t;
  const rec = reconcileFounders(ballots);
  const lines: string[] = [];
  lines.push(`🗳️ Vote #${vote.id} [${vote.status}] — ${vote.question}`);
  lines.push('');
  for (const c of counts) lines.push(`  ${c.choice}: ${c.count}`);
  lines.push('');
  lines.push(`Ballots cast: ${totalBallots}`);
  if (founders.length === 0) {
    lines.push("⚠️ No founders configured (set FOUNDERS) — can't verify all-founder assent.");
  } else {
    lines.push(`Founders voted: ${rec.voted.length}/${founders.length}`);
    for (const v of rec.voted) lines.push(`  ✅ ${v.founder.name}: ${v.choice}`);
    if (rec.missing.length) {
      lines.push(`Still needed from: ${rec.missing.map((f) => f.name).join(', ')}`);
    }
    lines.push(
      rec.allVoted ? '✅ All founders have voted.' : '⏳ Not all founders have voted yet.',
    );
  }
  return lines.join('\n');
}

// --- tools ------------------------------------------------------------------

export const openVoteTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'open_vote',
      description:
        'Open a reserved-matter vote — a decision that needs the assent of ALL founders ' +
        '(ACRED KB section 8). Returns a ready-to-post message for the founders\' group; set ' +
        'post=true to also send it to the group now.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'What the founders are deciding.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'The choices. Defaults to Yes / No. At least two distinct options.',
          },
          post: {
            type: 'boolean',
            description: "Also post the vote to the founders' group immediately.",
          },
        },
        required: ['question'],
      },
    },
  },
  async run(args, ctx) {
    const question = String(args.question ?? '').trim();
    if (!question) return 'What is the vote about? Give me a question.';
    const options = cleanOptions(args.options);
    if (options.length < 2) {
      return 'A vote needs at least two distinct options (e.g. Yes / No).';
    }
    try {
      const vote = await openVote(question, options, ctx.actor);
      audit(ctx.actor, 'open_vote', `#${vote.id} ${question}`);
      const announcement = composeAnnouncement(vote);
      if (args.post === true) {
        if (!foundersGroupJid) {
          return trim(
            `Opened vote #${vote.id}, but no founders' group is configured ` +
              `(set FOUNDERS_GROUP_JID). Post this yourself:\n\n${announcement}`,
          );
        }
        await enqueueSend(() => sendMessage(foundersGroupJid, announcement));
        audit(ctx.actor, 'open_vote.posted', `#${vote.id} -> ${foundersGroupJid}`);
        return trim(`Opened vote #${vote.id} and posted it to the founders' group.\n\n${announcement}`);
      }
      return trim(`Opened vote #${vote.id}. Post this to the founders' group:\n\n${announcement}`);
    } catch (e) {
      return `Couldn't open the vote (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};

export const recordVoteTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'record_vote',
      description:
        "Record a founder's choice on an open vote. Identify the voter by JID, number, or " +
        'name; the choice must be one of the vote\'s options. Re-recording replaces their ' +
        'earlier ballot.',
      parameters: {
        type: 'object',
        properties: {
          vote_id: { type: 'number', description: 'The vote id (from open_vote).' },
          voter: { type: 'string', description: "The founder's JID, number, or name." },
          choice: { type: 'string', description: 'One of the vote\'s options.' },
        },
        required: ['vote_id', 'voter', 'choice'],
      },
    },
  },
  async run(args, ctx) {
    const id = parseVoteId(args.vote_id);
    if (id === null) return 'Which vote? Give me the vote id.';
    const rawVoter = String(args.voter ?? '').trim();
    if (!rawVoter) return 'Who is voting? Give me a founder JID, number, or name.';
    const rawChoice = String(args.choice ?? '').trim();
    if (!rawChoice) return 'What did they choose?';
    try {
      const vote = await getVote(id);
      if (!vote) return `No vote #${id}.`;
      if (vote.status !== 'open') return `Vote #${id} is ${vote.status} — no new ballots.`;
      const choice = vote.options.find((o) => o.toLowerCase() === rawChoice.toLowerCase());
      if (!choice) {
        return `"${rawChoice}" isn't an option for vote #${id}. Options: ${vote.options.join(', ')}.`;
      }
      const { key, label } = resolveVoter(rawVoter);
      await recordBallot(id, key, choice);
      audit(ctx.actor, 'record_vote', `#${id} ${label} -> ${choice}`);
      const t = await tally(id);
      const rec = t ? reconcileFounders(t.ballots) : null;
      const tail =
        rec && founders.length
          ? rec.allVoted
            ? ' All founders have now voted.'
            : ` Still waiting on: ${rec.missing.map((f) => f.name).join(', ')}.`
          : '';
      return `Recorded ${label}: ${choice} on vote #${id}.${tail}`;
    } catch (e) {
      return `Couldn't record the vote (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};

export const tallyVoteTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'tally_vote',
      description:
        'Count the ballots on a vote and report whether ALL founders have voted yet, naming ' +
        'anyone still outstanding (a reserved matter is only settled once every founder has voted).',
      parameters: {
        type: 'object',
        properties: {
          vote_id: { type: 'number', description: 'The vote id.' },
        },
        required: ['vote_id'],
      },
    },
  },
  async run(args) {
    const id = parseVoteId(args.vote_id);
    if (id === null) return 'Which vote? Give me the vote id.';
    try {
      const t = await tally(id);
      if (!t) return `No vote #${id}.`;
      return trim(formatTally(t));
    } catch (e) {
      return `Vote store unavailable (${(e as Error)?.message ?? 'not configured'}).`;
    }
  },
};

export const closeVoteTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'close_vote',
      description:
        'Close a vote so no further ballots are accepted, and return the final tally with ' +
        'founder reconciliation.',
      parameters: {
        type: 'object',
        properties: {
          vote_id: { type: 'number', description: 'The vote id.' },
        },
        required: ['vote_id'],
      },
    },
  },
  async run(args, ctx) {
    const id = parseVoteId(args.vote_id);
    if (id === null) return 'Which vote? Give me the vote id.';
    try {
      const vote = await closeVote(id);
      if (!vote) return `No vote #${id}.`;
      audit(ctx.actor, 'close_vote', `#${id}`);
      const t = await tally(id);
      return trim(`Closed vote #${id}.${t ? `\n\n${formatTally(t)}` : ''}`);
    } catch (e) {
      return `Couldn't close the vote (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};
