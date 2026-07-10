/**
 * Escalation tools — surface who is slipping and, when it matters, escalate to
 * the CEO on WhatsApp.
 *
 *   list_overdue     (public)   read-only sweep of overdue commitments + tasks.
 *   escalate_overdue (operator) compose the blunt summary and send it to the CEO.
 *
 * Tier note: list_overdue is intended as a PUBLIC (collaborate-tier) tool — add
 * its name to PUBLIC_TOOLS in src/agent/access.ts when wiring it in. escalate_
 * overdue stays operator-only (deny-by-default) and also self-guards below.
 */
import { findOverdue, buildEscalation } from '../../escalation/engine.js';
import { sendMessage } from '../../whatsapp/gateway.js';
import { enqueueSend } from '../../whatsapp/pacing.js';
import { ceoJid } from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

function parseSla(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const listOverdueTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_overdue',
      description:
        'Sweep every open commitment and task and report who is slipping — anything past its due ' +
        'date, or open longer than the SLA with no deadline. Read-only; use this before deciding ' +
        'to escalate.',
      parameters: {
        type: 'object',
        properties: {
          sla_days: {
            type: 'number',
            description:
              'SLA in whole days for items with no deadline (optional; default 3 or ESCALATION_SLA_DAYS).',
          },
        },
      },
    },
  },
  async run(args) {
    try {
      const report = await findOverdue({ slaDays: parseSla(args.sla_days) });
      return trim(buildEscalation(report));
    } catch (e) {
      return `Couldn't run the overdue sweep (${(e as Error)?.message ?? 'unavailable'}).`;
    }
  },
};

export const escalateOverdueTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'escalate_overdue',
      description:
        'Compose the blunt "who is slipping" summary of overdue commitments and tasks and send it ' +
        'to the CEO on WhatsApp. Sends nothing when nothing is slipping. Operator-only.',
      parameters: {
        type: 'object',
        properties: {
          sla_days: {
            type: 'number',
            description: 'SLA in whole days for items with no deadline (optional; default 3).',
          },
        },
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.isOperator) return '🔒 Only the principal can escalate to the CEO.';
    if (!ceoJid) return 'No CEO recipient configured: set CEO_JID (or OPERATOR_JIDS).';
    try {
      const report = await findOverdue({ slaDays: parseSla(args.sla_days) });
      if (!report.items.length) {
        audit(ctx.actor, 'escalate_overdue', 'nothing slipping — not sent');
        const tail = report.tasksAvailable ? '' : ` (${report.note})`;
        return `Nothing slipping within SLA (${report.slaDays}d) — nothing escalated.${tail}`;
      }
      const summary = buildEscalation(report);
      await enqueueSend(() => sendMessage(ceoJid, summary));
      audit(ctx.actor, 'escalate_overdue', `${report.items.length} item(s) -> CEO`);
      return `Escalated ${report.items.length} slipping item(s) to the CEO.`;
    } catch (e) {
      return `Couldn't escalate (${(e as Error)?.message ?? 'store/socket unavailable'}).`;
    }
  },
};

export const escalationTools: AgentTool[] = [listOverdueTool, escalateOverdueTool];
