/**
 * Chief-of-staff routines built on the people/tasks/reports store.
 *
 * These are the reusable, side-effect-light building blocks Shivani runs on a
 * cadence (or on demand): chase whoever still owes a report for a period, and
 * assemble the CEO digest. Both return a human-readable summary string.
 *
 * Degrades gracefully: every path catches the "Postgres not configured" error
 * (and any other failure) and returns the message instead of throwing, so a
 * scheduler tick never crashes the app.
 */
import { founders } from '../config.js';
import { listPeople, listReports, listTasks, openTasksByPerson } from './store.js';
import type { Task } from '../db/types.js';

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

function taskLine(t: Task): string {
  const bits = [`#${t.id} ${t.title}`];
  if (t.milestone) bits.push(`[${t.milestone}]`);
  if (t.due) bits.push(`(due ${t.due.slice(0, 16).replace('T', ' ')})`);
  bits.push(`- ${t.status}`);
  return bits.join(' ');
}

/**
 * Find who still owes a report for the given period and return a summary.
 * People with no `reports` row for that period are "owing". Falls back to the
 * configured founders list when no people have been added yet.
 */
export async function runReportChase(period: string): Promise<string> {
  const p = period.trim();
  if (!p) return 'Specify a period to chase (e.g. "2026-07-10" or "week-28").';

  try {
    const [people, reports, groups] = await Promise.all([
      listPeople(),
      listReports({ period: p, limit: 500 }),
      openTasksByPerson(),
    ]);

    const names = people.length ? people.map((x) => x.name) : founders.map((f) => f.name);
    if (!names.length) {
      return `No people on record to chase for the "${p}" report. Add people first (add_person).`;
    }

    const submitted = new Set(
      reports.map((r) => (r.person ?? '').trim().toLowerCase()).filter(Boolean),
    );
    const owing = names.filter((n) => !submitted.has(n.trim().toLowerCase()));
    const openByName = new Map(groups.map((g) => [g.assignee.toLowerCase(), g] as const));

    if (!owing.length) {
      return `Report chase for "${p}": all ${names.length} on record have reported. Nothing to chase.`;
    }

    const lines = owing.map((n) => {
      const g = openByName.get(n.toLowerCase());
      const load = g ? ` — ${g.count} open task(s)${g.overdue ? `, ${g.overdue} overdue` : ''}` : '';
      return `• ${n}${load}`;
    });

    return [
      `Report chase for "${p}": ${owing.length} of ${names.length} still owe a report.`,
      ...lines,
      reports.length ? `Already reported: ${reports.length}.` : 'No reports received yet.',
    ].join('\n');
  } catch (e) {
    return `Report chase unavailable: ${errText(e)}`;
  }
}

/**
 * Assemble a CEO digest: task health by status, per-person open load, overdue
 * items, milestone breakdown and the latest reports.
 */
export async function buildCeoDigest(): Promise<string> {
  try {
    const [allTasks, groups, reports, people] = await Promise.all([
      listTasks(),
      openTasksByPerson(),
      listReports({ limit: 8 }),
      listPeople(),
    ]);

    if (!allTasks.length && !people.length && !reports.length) {
      return 'CEO digest: nothing tracked yet. Add people, assign tasks and collect reports first.';
    }

    // Status tally.
    const byStatus = new Map<string, number>();
    for (const t of allTasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    const statusLine =
      [...byStatus.entries()].map(([s, n]) => `${s} ${n}`).join(', ') || 'no tasks';

    // Overdue open tasks.
    const now = Date.now();
    const overdue = allTasks
      .filter((t) => t.due && Date.parse(t.due) < now && t.status !== 'done' && t.status !== 'cancelled')
      .sort((a, b) => Date.parse(a.due ?? '') - Date.parse(b.due ?? ''));

    // Milestone breakdown of open tasks.
    const openTasks = groups.flatMap((g) => g.tasks);
    const byMilestone = new Map<string, number>();
    for (const t of openTasks) {
      const m = t.milestone?.trim() || '(no milestone)';
      byMilestone.set(m, (byMilestone.get(m) ?? 0) + 1);
    }

    const out: string[] = [];
    out.push('CEO DIGEST');
    out.push(`People tracked: ${people.length} · Tasks: ${allTasks.length} (${statusLine})`);

    out.push('');
    out.push('Open load by person:');
    if (groups.length) {
      for (const g of groups) {
        out.push(`• ${g.assignee}: ${g.count} open${g.overdue ? `, ${g.overdue} overdue` : ''}`);
      }
    } else {
      out.push('• none');
    }

    out.push('');
    out.push('By milestone:');
    if (byMilestone.size) {
      for (const [m, n] of byMilestone) out.push(`• ${m}: ${n} open`);
    } else {
      out.push('• none');
    }

    out.push('');
    out.push(`Overdue: ${overdue.length}`);
    for (const t of overdue.slice(0, 10)) {
      out.push(`• ${t.assignee ?? '(unassigned)'}: ${taskLine(t)}`);
    }

    out.push('');
    out.push('Latest reports:');
    if (reports.length) {
      for (const r of reports) {
        const who = r.person ?? '(unknown)';
        const when = r.created_at.slice(0, 16).replace('T', ' ');
        const snippet = r.content.length > 140 ? `${r.content.slice(0, 140)}…` : r.content;
        out.push(`• ${who} [${r.period ?? '—'}] ${when}: ${snippet}`);
      }
    } else {
      out.push('• none');
    }

    return out.join('\n');
  } catch (e) {
    return `CEO digest unavailable: ${errText(e)}`;
  }
}
