/**
 * Reminder tools — set / list / cancel one-shot reminders. These are fire-once
 * nudges (distinct from the recurring cron scheduler): a bit of text delivered
 * to a WhatsApp target at a due time, exactly once, by the reminder loop.
 */
import { add, listPending, cancel } from '../../reminders/store.js';
import { toJid } from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

const MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

/**
 * Best-effort parse of a due time. Accepts relative forms ("in 10 minutes",
 * "2h", "30s", "in 3 days"), "tomorrow", and any absolute date string
 * Date.parse understands (e.g. "2026-07-11 09:00"). Returns null when it can't
 * make sense of the input.
 */
function parseDue(input: string): Date | null {
  const raw = input.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const rel = lower.match(
    /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/,
  );
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2]!;
    const per = u.startsWith('w')
      ? MS.w
      : u.startsWith('d')
        ? MS.d
        : u.startsWith('h')
          ? MS.h
          : u.startsWith('s')
            ? MS.s
            : MS.m;
    if (n > 0) return new Date(Date.now() + n * per);
  }

  if (lower === 'tomorrow') return new Date(Date.now() + MS.d);

  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

export const setReminderTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'set_reminder',
      description:
        'Set a one-shot reminder that pings a WhatsApp target once at a due time. ' +
        'Use for "remind me in 20 minutes to…" style nudges (not recurring schedules).',
      parameters: {
        type: 'object',
        properties: {
          when: {
            type: 'string',
            description:
              'When to fire — e.g. "in 20 minutes", "2h", "tomorrow", or an absolute date/time.',
          },
          text: { type: 'string', description: 'What to remind about.' },
          target: {
            type: 'string',
            description:
              "Number/JID to remind. Defaults to whoever asked (the requester).",
          },
        },
        required: ['when', 'text'],
      },
    },
  },
  async run(args, ctx) {
    const text = String(args.text ?? '').trim();
    if (!text) return 'What should I remind about?';
    const due = parseDue(String(args.when ?? ''));
    if (!due) return `I couldn't read "${String(args.when ?? '')}" as a time. Try "in 20 minutes" or "tomorrow 9am".`;

    const rawTarget = args.target ? String(args.target).trim() : '';
    const target = rawTarget ? toJid(rawTarget) : ctx.actor;
    if (!target) return 'No target to remind — give me a number/JID.';

    try {
      const r = await add({ target_jid: target, text, due, created_by: ctx.actor });
      audit(ctx.actor, 'set_reminder', `#${r.id} → ${target} @ ${r.due}`);
      return `Reminder #${r.id} set for ${r.due} — I'll ping ${target}.`;
    } catch (e) {
      return `Couldn't set the reminder (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};

export const listRemindersTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'List pending one-shot reminders (soonest first).',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    try {
      const rows = await listPending();
      if (!rows.length) return 'No pending reminders.';
      return trim(
        rows
          .map((r) => `#${r.id} @ ${r.due} → ${r.target_jid}: ${r.text}`)
          .join('\n'),
      );
    } catch (e) {
      return `Reminder store unavailable (${(e as Error)?.message ?? 'not configured'}).`;
    }
  },
};

export const cancelReminderTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: 'Cancel a pending one-shot reminder by its id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'The reminder id (from list_reminders).' },
        },
        required: ['id'],
      },
    },
  },
  async run(args, ctx) {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) return 'Give me a valid reminder id.';
    try {
      const ok = await cancel(id);
      if (!ok) return `No pending reminder #${id}.`;
      audit(ctx.actor, 'cancel_reminder', `#${id}`);
      return `Cancelled reminder #${id}.`;
    } catch (e) {
      return `Couldn't cancel the reminder (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};
