import { buildFocusReport } from '../../workflows/daily.js';
import { sendMessage } from '../../whatsapp/gateway.js';
import { enqueueSend } from '../../whatsapp/pacing.js';
import { founders } from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

export const focusReportTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'focus_report',
      description:
        'Build a focus report — open task load by person, overdue items, latest updates, and ' +
        'the one money mission. Returns the text; post it to the group yourself, bluntly, if it helps.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    return await buildFocusReport();
  },
};

export const requestDailyUpdateTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'request_daily_update',
      description:
        "Message each configured founder asking for today's update (what they shipped, what's " +
        'next, blockers). Paced to avoid bans. Use for the daily rhythm.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Optional custom ask; default is the standard daily-update prompt.',
          },
        },
      },
    },
  },
  async run(args, ctx) {
    if (!founders.length) return 'No founders configured (set FOUNDERS in .env).';
    const ask = args.message
      ? String(args.message)
      : "daily update please — what did you ship today, what's next, and any blockers? Keep it to 3 lines.";
    let sent = 0;
    for (const f of founders) {
      try {
        await enqueueSend(() => sendMessage(f.jid, `${f.name}, ${ask}`));
        sent += 1;
      } catch {
        /* skip a failed recipient */
      }
    }
    audit(ctx.actor, 'request_daily_update', `${sent}/${founders.length} founders`);
    return `Asked ${sent}/${founders.length} founders for their daily update.`;
  },
};
