import { runSubagent } from '../subagents.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

export const spawnSubagentTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description:
        'Spin up a focused sub-agent to do a self-contained task in one shot (research a ' +
        'client, dig through data, draft something) and return its result. It runs at your ' +
        'own permission tier. Use it to parallelize or offload well-scoped work.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear, self-contained task with all the context the worker needs.',
          },
        },
        required: ['task'],
      },
    },
  },
  async run(args, ctx) {
    const task = String(args.task ?? '').trim();
    if (!task) return 'Provide a "task" for the sub-agent.';
    audit(ctx.actor, 'spawn_subagent', task.slice(0, 120));
    return await runSubagent(task, {
      isOperator: ctx.isOperator,
      actor: ctx.actor,
      chatJid: ctx.chatJid,
    });
  },
};
