/**
 * Escalation engine — SLAs on commitments and tasks, with a blunt "who is
 * slipping" summary for the CEO.
 *
 * It is a pure read/compute layer over the two coordination stores that already
 * exist, so it owns no table of its own:
 *   - open commitments live in the local SQLite store (../store/db.ts) and are
 *     always available;
 *   - open tasks live in the Postgres people store (../people/store.ts), which
 *     may be unconfigured. When Postgres is absent, findOverdue() does NOT throw
 *     — it returns the commitment findings plus tasksAvailable=false and a note,
 *     so the caller can still act on what it has.
 *
 * "Overdue" is two things: something past its explicit due date, OR something
 * open longer than the SLA with no deadline attached (a silent slip). The SLA is
 * a whole number of days: pass one, or set ESCALATION_SLA_DAYS, else default 3.
 */
import { store, type Commitment } from '../store/db.js';
import { openTasksByPerson } from '../people/store.js';

const DAY_MS = 86_400_000;
const DEFAULT_SLA_DAYS = 3;

export type OverdueReason = 'past-due' | 'stale';
export type OverdueKind = 'commitment' | 'task';

export interface OverdueItem {
  kind: OverdueKind;
  id: number;
  /** Who is on the hook (commitment owner / task assignee). */
  owner: string;
  /** What was promised / the task title. */
  text: string;
  due: string | null;
  reason: OverdueReason;
  /** Whole days past the due date; null when there was no parseable due date. */
  overdueDays: number | null;
  /** Whole days since it was created. */
  ageDays: number;
  /** Where it came from (commitment source / task milestone), if any. */
  source: string | null;
}

export interface OverdueReport {
  /** Worst offenders first (past-due before stale, longest slip first). */
  items: OverdueItem[];
  slaDays: number;
  /** False when the Postgres task store was unreachable/unconfigured. */
  tasksAvailable: boolean;
  /** Present when a source was skipped (e.g. task store not configured). */
  note?: string;
  generatedAt: string;
}

export interface FindOverdueOptions {
  /** Override the SLA (whole days). Falsy/invalid => env or default. */
  slaDays?: number;
  /** Anchor "now" (mainly for tests). Defaults to the current time. */
  now?: Date;
}

/** A normalized candidate from either store, before SLA evaluation. */
interface Candidate {
  kind: OverdueKind;
  id: number;
  owner: string;
  text: string;
  due: string | null;
  createdAt: string;
  source: string | null;
}

function resolveSlaDays(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const raw = process.env.ESCALATION_SLA_DAYS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SLA_DAYS;
}

/** Flag a candidate as overdue (past its due date) or stale (open past the SLA
 *  with no parseable deadline). Returns null when it is still within bounds. */
function evaluate(c: Candidate, now: number, cutoff: number): OverdueItem | null {
  const dueMs = c.due ? Date.parse(c.due) : Number.NaN;
  const createdMs = Date.parse(c.createdAt);
  const ageDays = Number.isFinite(createdMs) ? Math.floor((now - createdMs) / DAY_MS) : 0;

  const base = {
    kind: c.kind,
    id: c.id,
    owner: c.owner,
    text: c.text,
    due: c.due,
    ageDays,
    source: c.source,
  } as const;

  if (Number.isFinite(dueMs) && dueMs < now) {
    return { ...base, reason: 'past-due', overdueDays: Math.floor((now - dueMs) / DAY_MS) };
  }
  // No usable deadline: escalate only once it has aged past the SLA window.
  if (!Number.isFinite(dueMs) && Number.isFinite(createdMs) && createdMs < cutoff) {
    return { ...base, reason: 'stale', overdueDays: null };
  }
  return null;
}

/** Rank: every past-due item above every stale one, longest slip first. */
function severity(i: OverdueItem): number {
  return i.reason === 'past-due' ? 1_000_000 + (i.overdueDays ?? 0) : i.ageDays;
}

/**
 * Collect every open commitment and task that is past due or older than the SLA.
 * Never throws: a missing Postgres task store is reported via tasksAvailable.
 */
export async function findOverdue(opts: FindOverdueOptions = {}): Promise<OverdueReport> {
  const slaDays = resolveSlaDays(opts.slaDays);
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - slaDays * DAY_MS;
  const items: OverdueItem[] = [];

  // 1) Commitments — local SQLite, always available.
  let commitments: Commitment[] = [];
  try {
    commitments = store.listCommitments('open');
  } catch {
    commitments = [];
  }
  for (const c of commitments) {
    const item = evaluate(
      {
        kind: 'commitment',
        id: c.id,
        owner: c.owner,
        text: c.text,
        due: c.due,
        createdAt: c.created_at,
        source: c.source,
      },
      now,
      cutoff,
    );
    if (item) items.push(item);
  }

  // 2) Tasks — Postgres; degrade cleanly when unconfigured/unreachable.
  let tasksAvailable = true;
  let note: string | undefined;
  try {
    const groups = await openTasksByPerson();
    for (const g of groups) {
      for (const t of g.tasks) {
        const item = evaluate(
          {
            kind: 'task',
            id: t.id,
            owner: t.assignee?.trim() || '(unassigned)',
            text: t.title,
            due: t.due,
            createdAt: t.created_at,
            source: t.milestone,
          },
          now,
          cutoff,
        );
        if (item) items.push(item);
      }
    }
  } catch (e) {
    tasksAvailable = false;
    note = `Task store unavailable (${(e as Error)?.message ?? 'not configured: set DATABASE_URL'}).`;
  }

  items.sort((a, b) => severity(b) - severity(a));

  return { items, slaDays, tasksAvailable, note, generatedAt: new Date(now).toISOString() };
}

/** One blunt line for a single slipping item. */
function describe(it: OverdueItem): string {
  const when =
    it.reason === 'past-due'
      ? `${it.overdueDays}d overdue${it.due ? ` (due ${it.due})` : ''}`
      : `no deadline set, ${it.ageDays}d stale`;
  const src = it.source ? ` [${it.source}]` : '';
  return `[${it.kind} #${it.id}] ${it.text} — ${when}${src}`;
}

/**
 * A blunt, WhatsApp-ready summary of who is slipping, grouped by owner with the
 * heaviest offenders first. Used verbatim as the CEO escalation message.
 */
export function buildEscalation(report: OverdueReport): string {
  const { items, slaDays } = report;
  const tail = report.tasksAvailable ? '' : `\n\n⚠️ ${report.note}`;

  if (!items.length) {
    return `✅ Escalation check: nothing slipping. All open commitments and tasks are within SLA (${slaDays}d).${tail}`;
  }

  const byOwner = new Map<string, OverdueItem[]>();
  for (const it of items) {
    const list = byOwner.get(it.owner) ?? [];
    list.push(it);
    byOwner.set(it.owner, list);
  }
  const owners = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);

  const lines: string[] = [
    `🚨 ESCALATION — ${items.length} item${items.length === 1 ? '' : 's'} slipping (SLA ${slaDays}d)`,
  ];
  for (const [owner, list] of owners) {
    lines.push('', `*${owner}* — ${list.length} slipping:`);
    for (const it of list) lines.push(`  • ${describe(it)}`);
  }
  return lines.join('\n') + tail;
}
