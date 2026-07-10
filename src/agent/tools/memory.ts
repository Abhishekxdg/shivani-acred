import { store } from '../../store/db.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

export const rememberTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Store a durable fact in long-term memory (survives restarts). Use for standing ' +
        'preferences, company facts, and ongoing goals. Overwrites an existing key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
  },
  async run(args, ctx) {
    const key = String(args.key);
    const value = String(args.value);
    store.setMemory(key, value);
    audit(ctx.actor, 'remember', key);
    return `Remembered "${key}".`;
  },
};

export const recallTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'recall',
      description: 'List all durable facts currently in long-term memory.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    const all = store.allMemory();
    return all.length ? all.map((m) => `${m.key}: ${m.value}`).join('\n') : '(memory is empty)';
  },
};
