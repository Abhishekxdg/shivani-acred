import { upsertProfile } from '../../profiles.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

export const setAgentNameTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'set_agent_name',
      description:
        'Save what the CURRENT person wants to call you, plus optionally their name/role/lane. ' +
        'This personalizes your future replies to them. Only affects the person you are ' +
        'talking to right now — use it during onboarding when they pick a name for you.',
      parameters: {
        type: 'object',
        properties: {
          agent_name: { type: 'string', description: 'The name they want to call you.' },
          owner_name: { type: 'string', description: 'Their own name (optional).' },
          role: { type: 'string', description: 'Their role (optional).' },
          lane: { type: 'string', description: 'Their lane at ACRED (optional).' },
        },
        required: ['agent_name'],
      },
    },
  },
  async run(args, ctx) {
    const agentName = String(args.agent_name ?? '').trim();
    if (!agentName) return 'Provide the name they want to call you.';
    try {
      await upsertProfile(ctx.actor, {
        agent_name: agentName,
        owner_name: args.owner_name ? String(args.owner_name) : undefined,
        role: args.role ? String(args.role) : undefined,
        lane: args.lane ? String(args.lane) : undefined,
        onboarded: true,
      });
    } catch (e) {
      return `Noted, but I can't save it yet (${(e as Error)?.message ?? 'store unavailable'}).`;
    }
    audit(ctx.actor, 'set_agent_name', agentName);
    return `Got it — I'll answer to "${agentName}" for you from now on.`;
  },
};
