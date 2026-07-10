import { addJob, removeJob, listJobs } from '../../scheduler/scheduler.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

export const scheduleTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        'Schedule a recurring proactive task with a cron expression. When it fires you will ' +
        'be asked to perform the instruction, and the result is sent to the operator on ' +
        'WhatsApp. Example: a daily 8am briefing.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique id for this schedule (used to cancel).' },
          cron: {
            type: 'string',
            description: 'Standard 5-field cron expression, e.g. "0 8 * * *" for 08:00 daily.',
          },
          instruction: { type: 'string', description: 'What to do when it fires.' },
        },
        required: ['id', 'cron', 'instruction'],
      },
    },
  },
  async run(args, ctx) {
    const id = String(args.id);
    const cronExpr = String(args.cron);
    const instruction = String(args.instruction);
    addJob(id, cronExpr, instruction);
    audit(ctx.actor, 'schedule_task', `${id} @ ${cronExpr}`);
    return `Scheduled "${id}" at cron "${cronExpr}".`;
  },
};

export const listSchedulesTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_schedules',
      description: 'List all active scheduled tasks.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    const jobs = listJobs();
    return jobs.length ? JSON.stringify(jobs, null, 2) : 'No scheduled tasks.';
  },
};

export const cancelScheduleTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'cancel_schedule',
      description: 'Cancel a scheduled task by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  async run(args, ctx) {
    const id = String(args.id);
    removeJob(id);
    audit(ctx.actor, 'cancel_schedule', id);
    return `Cancelled schedule "${id}".`;
  },
};
