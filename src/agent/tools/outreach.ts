import {
  addCustomer,
  listCustomers,
  findCustomer,
  addCustomerNote,
  setCustomerStatus,
} from '../../outreach.js';
import { sendMessage } from '../../whatsapp/gateway.js';
import { enqueueSend } from '../../whatsapp/pacing.js';
import { toJid, founderByJid } from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

export const addCustomerTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'add_customer',
      description:
        'Record a customer/prospect a founder points you at — capture who they are, what they ' +
        'want, and the context (why they would buy). Do this before reaching out.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          whatsapp: { type: 'string', description: "Their number/JID (for outreach)." },
          company: { type: 'string' },
          needs: { type: 'string', description: 'What they want.' },
          context: { type: 'string', description: 'Who/why — the founder\'s context on them.' },
          owner: { type: 'string', description: 'The founder who owns this relationship.' },
        },
        required: ['name'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const c = await addCustomer({
        name: String(args.name),
        whatsapp: args.whatsapp ? String(args.whatsapp) : undefined,
        company: args.company ? String(args.company) : undefined,
        needs: args.needs ? String(args.needs) : undefined,
        context: args.context ? String(args.context) : undefined,
        owner: args.owner ? String(args.owner) : undefined,
      });
      audit(ctx.actor, 'add_customer', `#${c.id} ${c.name}`);
      return `Added customer #${c.id} (${c.name}). Ask me to contact them when you're ready.`;
    } catch (e) {
      return `Couldn't save the customer (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};

export const listCustomersTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_customers',
      description: 'List known customers/prospects and their status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    try {
      const rows = await listCustomers();
      if (!rows.length) return 'No customers yet.';
      return trim(
        rows
          .map((c) => `#${c.id} [${c.status}] ${c.name}${c.company ? ` (${c.company})` : ''}${c.needs ? ` — ${c.needs}` : ''}`)
          .join('\n'),
      );
    } catch (e) {
      return `Customer store unavailable (${(e as Error)?.message ?? 'not configured'}).`;
    }
  },
};

export const customerNoteTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'customer_note',
      description: 'Append a note to a customer (what you learned about their requirements).',
      parameters: {
        type: 'object',
        properties: {
          customer: { type: 'string', description: 'Customer id or name.' },
          note: { type: 'string' },
        },
        required: ['customer', 'note'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const c = await findCustomer(String(args.customer));
      if (!c) return `No customer matching "${String(args.customer)}".`;
      await addCustomerNote(c.id, String(args.note));
      audit(ctx.actor, 'customer_note', `#${c.id}`);
      return `Noted on ${c.name}.`;
    } catch (e) {
      return `Couldn't save the note (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
  },
};

export const contactCustomerTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'contact_customer',
      description:
        'Reach out to a known customer on WhatsApp with your composed opening message and ' +
        'start a conversation to gather their requirements. Paced to avoid bans. Report the ' +
        'result to the owning founder afterward.',
      parameters: {
        type: 'object',
        properties: {
          customer: { type: 'string', description: 'Customer id or name.' },
          message: { type: 'string', description: 'Your opening message to them.' },
        },
        required: ['customer', 'message'],
      },
    },
  },
  async run(args, ctx) {
    // Only the principal or a known founder may trigger outbound to a customer.
    if (!ctx.isOperator && !founderByJid(ctx.actor)) {
      return '🔒 Only a founder or the principal can start customer outreach.';
    }
    try {
      const c = await findCustomer(String(args.customer));
      if (!c) return `No customer matching "${String(args.customer)}".`;
      if (!c.whatsapp) return `${c.name} has no WhatsApp number on file — add one first.`;
      const to = toJid(c.whatsapp);
      await enqueueSend(() => sendMessage(to, String(args.message)));
      await setCustomerStatus(c.id, 'contacted');
      await addCustomerNote(c.id, `[outreach] ${String(args.message).slice(0, 200)}`);
      audit(ctx.actor, 'contact_customer', `#${c.id} ${c.name}`);
      return `Messaged ${c.name}. I'll converse from here and report back what they need.`;
    } catch (e) {
      return `Couldn't reach the customer (${(e as Error)?.message ?? 'store/socket unavailable'}).`;
    }
  },
};
