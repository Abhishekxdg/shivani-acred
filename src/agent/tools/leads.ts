/**
 * Lead-pipeline tools — the ELINA sales machine's funnel controls.
 *
 * Sales points Shivani at enquiries; she captures them, qualifies, assigns to a
 * founder, walks them down the funnel (new → qualified → visit → booked / lost)
 * and nudges them with follow-ups. Mirrors the ACRED target pace of
 * ~120–150 qualified enquiries → 25–30 site visits → ~4 bookings/month.
 *
 * Read/write tools are 'public' tier; lead_followup sends outbound WhatsApp and
 * is 'operator' tier (a founder or the principal only), paced to avoid bans.
 */
import {
  addLead,
  listLeads,
  findLead,
  qualifyLead,
  assignLead,
  updateLeadStatus,
  addLeadNote,
  funnelCounts,
  isLeadStatus,
  LEAD_STATUSES,
  type Lead,
  type LeadStatus,
} from '../../leads/store.js';
import { sendMessage } from '../../whatsapp/gateway.js';
import { enqueueSend } from '../../whatsapp/pacing.js';
import { toJid, founders, founderByJid } from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

/** One-line rendering of a lead for list/summary output. */
function fmtLead(l: Lead): string {
  const bits = [`#${l.id}`, `[${l.status}]`, l.name];
  if (l.score !== null) bits.push(`(score ${l.score})`);
  if (l.assignee) bits.push(`→ ${l.assignee}`);
  if (l.source) bits.push(`via ${l.source}`);
  return bits.join(' ');
}

/** Turn a store error into a stable, human message (never throws). */
function storeErr(e: unknown): string {
  const msg = (e as Error)?.message ?? 'store unavailable';
  return /not configured/i.test(msg)
    ? 'Lead store not configured: set DATABASE_URL.'
    : `Lead store error (${msg}).`;
}

export const addLeadTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'add_lead',
      description:
        'Capture a new enquiry at the top of the sales funnel. Deduplicates on phone number, ' +
        'so re-adding the same number returns the existing lead instead of a duplicate.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The lead's name." },
          phone: { type: 'string', description: 'Their phone/WhatsApp number (used for dedup + follow-up).' },
          source: { type: 'string', description: 'Where they came from — e.g. digital, channel-partner, referral.' },
          utm: { type: 'string', description: 'UTM attribution string (campaign/source/medium) if known.' },
          assignee: { type: 'string', description: 'Founder who owns this lead (optional at intake).' },
          notes: { type: 'string', description: 'Anything known about what they want.' },
        },
        required: ['name'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const { lead, deduped } = await addLead({
        name: String(args.name),
        phone: args.phone ? String(args.phone) : undefined,
        source: args.source ? String(args.source) : undefined,
        utm: args.utm ? String(args.utm) : undefined,
        assignee: args.assignee ? String(args.assignee) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
      });
      if (deduped) {
        return `Already have this lead: ${fmtLead(lead)}. No duplicate created.`;
      }
      audit(ctx.actor, 'add_lead', `#${lead.id} ${lead.name}`);
      return `Added lead ${fmtLead(lead)}. Qualify it when you've sized up the enquiry.`;
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const listLeadsTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_leads',
      description:
        'List leads, optionally filtered by funnel status and/or assignee. Includes a funnel ' +
        'snapshot (counts per stage) so you can see the pipeline at a glance.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...LEAD_STATUSES],
            description: 'Only leads in this funnel stage.',
          },
          assignee: { type: 'string', description: 'Only leads owned by this founder.' },
        },
      },
    },
  },
  async run(args) {
    try {
      const status = args.status ? String(args.status) : undefined;
      if (status && !isLeadStatus(status)) {
        return `Unknown status "${status}". Use one of: ${LEAD_STATUSES.join(', ')}.`;
      }
      const funnel = await funnelCounts();
      const header =
        `Funnel: ${funnel.new} new · ${funnel.qualified} qualified · ${funnel.visit} visit · ` +
        `${funnel.booked} booked · ${funnel.lost} lost (${funnel.total} total)`;
      const rows = await listLeads({
        status: status as LeadStatus | undefined,
        assignee: args.assignee ? String(args.assignee) : undefined,
      });
      if (!rows.length) return `${header}\n\nNo leads match that filter.`;
      return trim(`${header}\n\n${rows.map(fmtLead).join('\n')}`);
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const qualifyLeadTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'qualify_lead',
      description:
        'Qualify a lead: mark it qualified, set a 0–100 score (budget/intent/fit) and note why. ' +
        'This is the gate into the counted funnel (qualified → visit → booking).',
      parameters: {
        type: 'object',
        properties: {
          lead: { type: 'string', description: 'Lead id or name.' },
          score: { type: 'number', description: 'Lead score 0–100 (higher = hotter).' },
          notes: { type: 'string', description: 'Why they qualify (budget, timeline, fit).' },
        },
        required: ['lead'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const l = await findLead(String(args.lead));
      if (!l) return `No lead matching "${String(args.lead)}".`;
      const score =
        args.score !== undefined && args.score !== null ? Number(args.score) : undefined;
      if (score !== undefined && Number.isNaN(score)) {
        return 'Score must be a number between 0 and 100.';
      }
      const updated = await qualifyLead(
        l.id,
        score,
        args.notes ? String(args.notes) : undefined,
      );
      if (!updated) return `Couldn't qualify lead #${l.id}.`;
      audit(ctx.actor, 'qualify_lead', `#${updated.id} score=${updated.score ?? '-'}`);
      return `Qualified ${fmtLead(updated)}.`;
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const assignLeadTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'assign_lead',
      description: 'Assign a lead to a founder (by name), so ownership of the relationship is clear.',
      parameters: {
        type: 'object',
        properties: {
          lead: { type: 'string', description: 'Lead id or name.' },
          founder: { type: 'string', description: 'Founder to own this lead (by name).' },
        },
        required: ['lead', 'founder'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const l = await findLead(String(args.lead));
      if (!l) return `No lead matching "${String(args.lead)}".`;
      const wanted = String(args.founder).trim();
      if (!wanted) return 'Name the founder to assign this lead to.';
      // Resolve to a known founder's canonical name when the roster is configured.
      let assignee = wanted;
      if (founders.length) {
        const match = founders.find((f) => f.name.toLowerCase() === wanted.toLowerCase())
          ?? founders.find((f) => f.name.toLowerCase().includes(wanted.toLowerCase()));
        if (!match) {
          return `No founder named "${wanted}". Known founders: ${founders.map((f) => f.name).join(', ')}.`;
        }
        assignee = match.name;
      }
      const updated = await assignLead(l.id, assignee);
      if (!updated) return `Couldn't assign lead #${l.id}.`;
      audit(ctx.actor, 'assign_lead', `#${updated.id} → ${assignee}`);
      return `Assigned ${fmtLead(updated)}.`;
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const updateLeadTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_lead',
      description:
        'Move a lead to a new funnel stage: new, qualified, visit, booked or lost. ' +
        'Use visit when a site visit is set/done, booked when they book, lost when dead.',
      parameters: {
        type: 'object',
        properties: {
          lead: { type: 'string', description: 'Lead id or name.' },
          status: {
            type: 'string',
            enum: [...LEAD_STATUSES],
            description: 'New funnel status.',
          },
          notes: { type: 'string', description: 'Optional note about the move (e.g. visit date, why lost).' },
        },
        required: ['lead', 'status'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const status = String(args.status);
      if (!isLeadStatus(status)) {
        return `Unknown status "${status}". Use one of: ${LEAD_STATUSES.join(', ')}.`;
      }
      const l = await findLead(String(args.lead));
      if (!l) return `No lead matching "${String(args.lead)}".`;
      const updated = await updateLeadStatus(l.id, status);
      if (!updated) return `Couldn't update lead #${l.id}.`;
      if (args.notes && String(args.notes).trim()) {
        await addLeadNote(updated.id, String(args.notes));
      }
      audit(ctx.actor, 'update_lead', `#${updated.id} ${l.status}→${status}`);
      return `Moved ${fmtLead(updated)}.`;
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const leadFollowupTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'lead_followup',
      description:
        'Send a follow-up WhatsApp message to a lead (nudge a cold enquiry, confirm a visit, ' +
        'chase a booking). Paced to avoid bans. Founder/principal only.',
      parameters: {
        type: 'object',
        properties: {
          lead: { type: 'string', description: 'Lead id or name.' },
          message: { type: 'string', description: 'The message to send them.' },
        },
        required: ['lead', 'message'],
      },
    },
  },
  async run(args, ctx) {
    // Outbound to a lead: gate to the principal or a known founder.
    if (!ctx.isOperator && !founderByJid(ctx.actor)) {
      return '🔒 Only a founder or the principal can send lead follow-ups.';
    }
    const message = String(args.message ?? '').trim();
    if (!message) return 'Give me the message to send.';
    try {
      const l = await findLead(String(args.lead));
      if (!l) return `No lead matching "${String(args.lead)}".`;
      if (!l.phone) return `${l.name} has no phone on file — add one before following up.`;
      const to = toJid(l.phone);
      await enqueueSend(() => sendMessage(to, message));
      await addLeadNote(l.id, `[follow-up] ${message.slice(0, 200)}`);
      audit(ctx.actor, 'lead_followup', `#${l.id} ${l.name}`);
      return `Followed up with ${l.name} (#${l.id}). Logged it on the lead.`;
    } catch (e) {
      return storeErr(e);
    }
  },
};

/** All lead-pipeline tools, for registration in the agent tool index. */
export const leadTools: AgentTool[] = [
  addLeadTool,
  listLeadsTool,
  qualifyLeadTool,
  assignLeadTool,
  updateLeadTool,
  leadFollowupTool,
];
