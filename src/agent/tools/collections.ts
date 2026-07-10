/**
 * Collections / receivables tools — track money owed and chase it before it
 * rots. Brokerage cash lands big and late, so overdue invoices are a top KB
 * failure mode; these tools make the position visible and the chase deliberate.
 *
 * Tiers:
 *   public   — add_receivable, list_receivables, mark_paid, receivables_summary
 *   operator — due_reminders (sends outbound WhatsApp, so operator-gated)
 */
import {
  addReceivable,
  listReceivables,
  markPaid,
  receivableTotals,
  type Receivable,
  type ReceivableStatus,
} from '../../collections/store.js';
import { sendMessage } from '../../whatsapp/gateway.js';
import { enqueueSend } from '../../whatsapp/pacing.js';
import { toJid, ceoJid, foundersGroupJid, founders } from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Format a rupee amount compactly, e.g. ₹12,50,000. */
function inr(amount: number): string {
  return `₹${inrFmt.format(Math.round(amount))}`;
}

/** Date portion of a raw TIMESTAMPTZ string, or a placeholder when open-ended. */
function fmtDue(due: string | null): string {
  if (!due) return 'no due date';
  const t = Date.parse(due);
  if (Number.isNaN(t)) return String(due);
  return new Date(t).toISOString().slice(0, 10);
}

/** True when an unpaid receivable is already past its due date. */
function isOverdue(r: Receivable): boolean {
  if (r.status === 'paid' || !r.due) return false;
  const t = Date.parse(r.due);
  return !Number.isNaN(t) && t < Date.now();
}

/** One-line rendering of a receivable for lists and reminders. */
function line(r: Receivable): string {
  const flag = isOverdue(r) ? ' ⚠ OVERDUE' : '';
  const proj = r.project ? ` {${r.project}}` : '';
  return `#${r.id} [${r.status}] ${r.party} — ${inr(r.amount_inr)} (due ${fmtDue(r.due)})${proj}${flag}`;
}

export const addReceivableTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'add_receivable',
      description:
        'Record money owed to us (a receivable): who owes it, how much in INR, and when it is ' +
        'due. Log brokerage/invoice collections here so overdue money can be chased on purpose.',
      parameters: {
        type: 'object',
        properties: {
          party: { type: 'string', description: 'Who owes the money (client/builder/partner).' },
          amount_inr: { type: 'number', description: 'Amount owed, in rupees.' },
          due: { type: 'string', description: 'Due date in words or ISO (optional).' },
          project: { type: 'string', description: 'The deal/project it belongs to (optional).' },
          notes: { type: 'string', description: 'Any context (optional).' },
        },
        required: ['party', 'amount_inr'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const r = await addReceivable({
        party: String(args.party),
        amount_inr: Number(args.amount_inr),
        due: args.due ? String(args.due) : undefined,
        project: args.project ? String(args.project) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
      });
      audit(ctx.actor, 'add_receivable', `#${r.id} ${r.party} ${inr(r.amount_inr)}`);
      return `Recorded receivable #${r.id}: ${r.party} owes ${inr(r.amount_inr)} (due ${fmtDue(r.due)}).`;
    } catch (e) {
      return `Couldn't record the receivable (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};

export const listReceivablesTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_receivables',
      description:
        'List receivables, soonest-due first. Filter by status (pending/partial/paid) or set ' +
        'overdue=true to see only unpaid money already past its due date.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'partial', 'paid'] },
          overdue: { type: 'boolean', description: 'Only unpaid rows past due.' },
        },
      },
    },
  },
  async run(args) {
    try {
      const rows = await listReceivables({
        status: args.status ? (String(args.status) as ReceivableStatus) : undefined,
        overdue: args.overdue === true,
      });
      if (!rows.length) return 'No receivables match.';
      return trim(rows.map(line).join('\n'));
    } catch (e) {
      return `Receivables store unavailable (${(e as Error)?.message ?? 'not configured'}).`;
    }
  },
};

export const markPaidTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'mark_paid',
      description:
        'Mark a receivable paid by its id (or status=partial for a part-payment). Optionally ' +
        'append a note, e.g. the UTR or how much came in.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: {
            type: 'string',
            enum: ['paid', 'partial'],
            description: 'Default paid; use partial for a part-payment.',
          },
          note: { type: 'string', description: 'Optional note to append.' },
        },
        required: ['id'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const id = Number(args.id);
      const status = args.status === 'partial' ? 'partial' : 'paid';
      const r = await markPaid(id, {
        status,
        note: args.note ? String(args.note) : undefined,
      });
      if (!r) return `No receivable #${id}.`;
      audit(ctx.actor, 'mark_paid', `#${id} -> ${status}`);
      return `Receivable #${id} (${r.party}) marked ${status}.`;
    } catch (e) {
      return `Couldn't update the receivable (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};

export const receivablesSummaryTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'receivables_summary',
      description:
        'Snapshot of money-in: total outstanding, how much of it is overdue, and total ' +
        'collected — plus the overdue items themselves. Use for cash-position check-ins.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    try {
      const [t, overdue] = await Promise.all([
        receivableTotals(),
        listReceivables({ overdue: true }),
      ]);
      const head =
        `Outstanding ${inr(t.outstanding)} across ${t.openCount} — ` +
        `of which ${inr(t.overdue)} overdue (${t.overdueCount}). ` +
        `Collected ${inr(t.paid)}.`;
      if (!overdue.length) return head;
      return trim(`${head}\nOverdue:\n${overdue.map(line).join('\n')}`);
    } catch (e) {
      return `Receivables store unavailable (${(e as Error)?.message ?? 'not configured'}).`;
    }
  },
};

/** Resolve a reminder recipient: an explicit target (founder name/number/JID),
 *  else the CEO, else the founders group. Returns '' when nothing is configured. */
function reminderTarget(to?: string): string {
  const raw = (to ?? '').trim();
  if (raw) {
    const byName = founders.find((f) => f.name.toLowerCase() === raw.toLowerCase());
    return byName ? byName.jid : toJid(raw);
  }
  return ceoJid || foundersGroupJid || '';
}

export const dueRemindersTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'due_reminders',
      description:
        'Message the owner/CEO a WhatsApp digest of overdue receivables (total + each item) so ' +
        'the late money gets chased. Paced to avoid bans. Operator-only.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Optional recipient (founder name, number, or JID). Defaults to the CEO.',
          },
        },
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.isOperator) return '🔒 Only the operator can send due reminders.';
    const to = reminderTarget(args.to ? String(args.to) : undefined);
    if (!to) {
      return 'No recipient configured — set CEO_JID or FOUNDERS_GROUP_JID, or pass "to".';
    }
    try {
      const overdue = await listReceivables({ overdue: true });
      if (!overdue.length) return 'No overdue receivables — nothing to chase.';
      const total = overdue.reduce((sum, r) => sum + r.amount_inr, 0);
      const body =
        `Overdue receivables: ${inr(total)} across ${overdue.length}. Please chase:\n` +
        overdue.map(line).join('\n');
      await enqueueSend(() => sendMessage(to, trim(body, 3_000)));
      audit(ctx.actor, 'due_reminders', `${overdue.length} overdue (${inr(total)}) -> ${to}`);
      return `Sent a reminder on ${overdue.length} overdue receivable(s) (${inr(total)}).`;
    } catch (e) {
      return `Couldn't send due reminders (${(e as Error)?.message ?? 'store/socket unavailable'}).`;
    }
  },
};
