/**
 * Daily-rhythm workflow: collect updates from founders and compose a blunt
 * focus report that keeps everyone on the one money mission. Reads from the
 * people/tasks/reports store and degrades to '' when Postgres is absent.
 */
import { openTasksByPerson, listReports } from '../people/store.js';

export const MISSION =
  'ONE MISSION: sell ELINA real estate to ₹1cr profit — target ~4 bookings/month. ' +
  'Do NOT chase other verticals, hire ahead of sales, take a second mandate before ELINA is on track, or discount brokerage.';

/** Compose the focus report: open load by person, overdue, latest updates, mission. */
export async function buildFocusReport(): Promise<string> {
  let load: Awaited<ReturnType<typeof openTasksByPerson>> = [];
  let reports: Awaited<ReturnType<typeof listReports>> = [];
  try {
    load = await openTasksByPerson();
  } catch {
    /* no Postgres — skip */
  }
  try {
    reports = await listReports({ limit: 8 });
  } catch {
    /* no Postgres — skip */
  }

  const lines: string[] = ['📋 Focus report', MISSION, ''];

  if (load.length) {
    lines.push('Open load by person:');
    for (const g of load) {
      lines.push(`- ${g.assignee}: ${g.count} open${g.overdue ? `, ${g.overdue} OVERDUE` : ''}`);
    }
  } else {
    lines.push('No open tasks tracked yet — assign milestone targets so I can hold the line.');
  }

  if (reports.length) {
    lines.push('', 'Latest updates:');
    for (const r of reports.slice(0, 5)) {
      lines.push(`- ${r.person ?? '?'}: ${r.content.slice(0, 140)}`);
    }
  }

  return lines.join('\n');
}
