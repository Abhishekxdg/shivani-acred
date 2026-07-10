import { gmailSearch, gmailRead, gmailDraft, gmailSend } from '../../integrations/gmail.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

export const gmailSearchTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'gmail_search',
      description:
        'Search Gmail (or list the recent inbox when no query is given). Uses Gmail search ' +
        'syntax, e.g. "from:acme.com newer_than:7d", "is:unread", "subject:invoice". Returns a ' +
        'summary per message including the id to pass to gmail_read.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query. Omit to list recent inbox.' },
          max: { type: 'number', description: 'Max messages (1-50, default 10).' },
        },
      },
    },
  },
  async run(args) {
    const out = await gmailSearch(
      args.query ? String(args.query) : undefined,
      args.max ? Number(args.max) : undefined,
    );
    return trim(out);
  },
};

export const gmailReadTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'gmail_read',
      description: 'Read one Gmail message in full (headers + plain-text body) by its message id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The Gmail message id (from gmail_search).' },
        },
        required: ['id'],
      },
    },
  },
  async run(args) {
    const out = await gmailRead(String(args.id));
    return trim(out);
  },
};

export const gmailDraftTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'gmail_draft',
      description:
        'Create a Gmail draft (saved, NOT sent). Use this for anything the operator should ' +
        'review before it goes out.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address(es), comma-separated.' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain-text body.' },
          cc: { type: 'string', description: 'Cc address(es), comma-separated (optional).' },
          bcc: { type: 'string', description: 'Bcc address(es), comma-separated (optional).' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  async run(args, ctx) {
    audit(ctx.actor, 'gmail_draft', `to ${String(args.to)}: ${String(args.subject)}`);
    return gmailDraft({
      to: String(args.to),
      subject: String(args.subject),
      body: String(args.body),
      cc: args.cc ? String(args.cc) : undefined,
      bcc: args.bcc ? String(args.bcc) : undefined,
    });
  },
};

export const gmailSendTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'gmail_send',
      description:
        'Send an email immediately via Gmail. This is an irreversible external action — prefer ' +
        'gmail_draft unless the operator explicitly asked to send.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address(es), comma-separated.' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain-text body.' },
          cc: { type: 'string', description: 'Cc address(es), comma-separated (optional).' },
          bcc: { type: 'string', description: 'Bcc address(es), comma-separated (optional).' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  async run(args, ctx) {
    audit(ctx.actor, 'gmail_send', `to ${String(args.to)}: ${String(args.subject)}`);
    return gmailSend({
      to: String(args.to),
      subject: String(args.subject),
      body: String(args.body),
      cc: args.cc ? String(args.cc) : undefined,
      bcc: args.bcc ? String(args.bcc) : undefined,
    });
  },
};
