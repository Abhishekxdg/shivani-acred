import { store } from '../../store/db.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

export const logCommitmentTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'log_commitment',
      description:
        'Record a commitment a founder made (who owns it, what, by when). Track these and ' +
        'chase them; they feed the weekly CEO digest.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Founder/person responsible.' },
          text: { type: 'string', description: 'What they committed to.' },
          due: { type: 'string', description: 'Due date/time in words or ISO (optional).' },
          source: { type: 'string', description: 'Where it was said (optional).' },
        },
        required: ['owner', 'text'],
      },
    },
  },
  async run(args, ctx) {
    const owner = String(args.owner);
    const text = String(args.text);
    const id = store.addCommitment(
      owner,
      text,
      args.due ? String(args.due) : undefined,
      args.source ? String(args.source) : undefined,
    );
    audit(ctx.actor, 'log_commitment', `#${id} ${owner}: ${text}`);
    return `Logged commitment #${id} for ${owner}.`;
  },
};

export const listCommitmentsTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_commitments',
      description: 'List commitments, optionally filtered by status (open/done/dropped).',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'done', 'dropped'] },
        },
      },
    },
  },
  async run(args) {
    const rows = store.listCommitments(args.status ? String(args.status) : undefined);
    if (!rows.length) return 'No commitments.';
    return rows
      .map(
        (c) =>
          `#${c.id} [${c.status}] ${c.owner}: ${c.text}${c.due ? ` (due ${c.due})` : ''}`,
      )
      .join('\n');
  },
};

export const closeCommitmentTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'close_commitment',
      description: 'Mark a commitment done or dropped by its id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: { type: 'string', enum: ['done', 'dropped'], description: 'Default done.' },
        },
        required: ['id'],
      },
    },
  },
  async run(args, ctx) {
    const id = Number(args.id);
    const status = args.status ? String(args.status) : 'done';
    const ok = store.updateCommitment(id, status);
    audit(ctx.actor, 'close_commitment', `#${id} -> ${status}`);
    return ok ? `Commitment #${id} marked ${status}.` : `No commitment #${id}.`;
  },
};
