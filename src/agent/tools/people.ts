/**
 * People / Tasks / Reports tools — how Shivani runs the team as chief of staff.
 *
 * These let her keep a roster of founders/employees, hand out milestone-wise
 * targets with due dates, take daily/hourly reports, and see who is behind.
 *
 * Every tool degrades gracefully: if Postgres is not configured (or unreachable)
 * the underlying store throws a clear "not configured: set DATABASE_URL" error,
 * which is caught here and returned as a plain string rather than thrown.
 */
import { audit } from '../../control/audit.js';
import {
  addPerson,
  addReport,
  assignTask,
  findPerson,
  listPeople,
  listTasks,
  openTasksByPerson,
  updateTaskStatus,
  type TaskFilter,
} from '../../people/store.js';
import type { Task } from '../../db/types.js';
import { type AgentTool } from './types.js';

const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

function fmtTask(t: Task): string {
  const bits = [`#${t.id} [${t.status}] ${t.title}`];
  if (t.assignee) bits.push(`@${t.assignee}`);
  if (t.milestone) bits.push(`{${t.milestone}}`);
  if (t.due) bits.push(`(due ${t.due.slice(0, 16).replace('T', ' ')})`);
  return bits.join(' ');
}

export const addPersonTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'add_person',
      description:
        'Add a founder, employee or contact to the roster so tasks and reports can be tracked ' +
        'against them. Use their real name as the stable handle.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Full name (used as the handle for tasks/reports).' },
          role: { type: 'string', description: 'Role/title, e.g. "Co-founder", "Growth" (optional).' },
          whatsapp: { type: 'string', description: 'WhatsApp number or JID (optional).' },
          email: { type: 'string', description: 'Email (optional).' },
          notes: { type: 'string', description: 'Anything worth remembering (optional).' },
        },
        required: ['name'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const name = String(args.name).trim();
      if (!name) return 'Provide a name.';
      const person = await addPerson(
        name,
        args.role ? String(args.role) : undefined,
        args.whatsapp ? String(args.whatsapp) : undefined,
        args.email ? String(args.email) : undefined,
        args.notes ? String(args.notes) : undefined,
      );
      audit(ctx.actor, 'add_person', `#${person.id} ${person.name}`);
      return `Added ${person.name} (#${person.id})${person.role ? `, ${person.role}` : ''}.`;
    } catch (e) {
      return errText(e);
    }
  },
};

export const listPeopleTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_people',
      description: 'List everyone on the roster (founders, employees, contacts).',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    try {
      const rows = await listPeople();
      if (!rows.length) return 'No people on record. Add someone with add_person.';
      return rows
        .map(
          (p) =>
            `#${p.id} ${p.name}${p.role ? ` — ${p.role}` : ''}${p.whatsapp ? ` · ${p.whatsapp}` : ''}`,
        )
        .join('\n');
    } catch (e) {
      return errText(e);
    }
  },
};

export const assignTaskTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'assign_task',
      description:
        'Give someone a milestone-wise target/task with an optional due date. This is how ' +
        'Shivani sets targets for founders/employees. The assignee should match a roster name.',
      parameters: {
        type: 'object',
        properties: {
          assignee: { type: 'string', description: 'Who owns this (roster name).' },
          title: { type: 'string', description: 'Short target/task, e.g. "Ship onboarding v2".' },
          detail: { type: 'string', description: 'Fuller description / acceptance criteria (optional).' },
          milestone: { type: 'string', description: 'Milestone this rolls up to, e.g. "Q3 launch" (optional).' },
          due: { type: 'string', description: 'Due date/time — ISO or a clear date (optional).' },
        },
        required: ['assignee', 'title'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const assignee = String(args.assignee).trim();
      const title = String(args.title).trim();
      if (!title) return 'Provide a task title.';

      let resolved = assignee;
      if (assignee) {
        const person = await findPerson(assignee);
        if (person) resolved = person.name;
      }

      const task = await assignTask(
        resolved || null,
        title,
        args.detail ? String(args.detail) : undefined,
        args.milestone ? String(args.milestone) : undefined,
        args.due ? String(args.due) : undefined,
      );
      audit(ctx.actor, 'assign_task', `#${task.id} ${resolved || '(unassigned)'}: ${title}`);

      const dueNote = args.due && !task.due ? ` (could not parse due "${String(args.due)}" — left unset)` : '';
      return `Assigned task #${task.id} to ${task.assignee ?? '(unassigned)'}: ${title}${dueNote}`;
    } catch (e) {
      return errText(e);
    }
  },
};

export const listTasksTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_tasks',
      description:
        'List tasks, optionally filtered by status, assignee or milestone. Use open_only to ' +
        'hide done/cancelled work.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: [...TASK_STATUSES] },
          assignee: { type: 'string', description: 'Filter to one person (partial match ok).' },
          milestone: { type: 'string', description: 'Filter to one milestone (partial match ok).' },
          open_only: { type: 'boolean', description: 'Exclude done/cancelled (default false).' },
        },
      },
    },
  },
  async run(args) {
    try {
      const filter: TaskFilter = {
        status: args.status ? String(args.status) : undefined,
        assignee: args.assignee ? String(args.assignee) : undefined,
        milestone: args.milestone ? String(args.milestone) : undefined,
        openOnly: Boolean(args.open_only),
      };
      const rows = await listTasks(filter);
      if (!rows.length) return 'No matching tasks.';
      return rows.map(fmtTask).join('\n');
    } catch (e) {
      return errText(e);
    }
  },
};

export const updateTaskTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Move a task to a new status (open, in_progress, blocked, done, cancelled) by id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Task id.' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
        },
        required: ['id', 'status'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const id = Number(args.id);
      if (!Number.isInteger(id)) return 'Provide a numeric task id.';
      const status = String(args.status);
      const task = await updateTaskStatus(id, status);
      if (!task) return `No task #${id}.`;
      audit(ctx.actor, 'update_task', `#${id} -> ${status}`);
      return `Task #${id} is now ${task.status}.`;
    } catch (e) {
      return errText(e);
    }
  },
};

export const recordReportTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'record_report',
      description:
        'Record a report/update from a person for a period (daily/hourly/weekly). Feeds report ' +
        'chasing and the CEO digest.',
      parameters: {
        type: 'object',
        properties: {
          person: { type: 'string', description: 'Who is reporting (roster name).' },
          period: {
            type: 'string',
            description: 'Period label, e.g. "2026-07-10", "2026-07-10T14", "week-28".',
          },
          content: { type: 'string', description: 'The report text / what they did.' },
        },
        required: ['person', 'content'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const content = String(args.content).trim();
      if (!content) return 'Provide the report content.';
      const personArg = args.person ? String(args.person).trim() : '';
      let person = personArg || null;
      if (personArg) {
        const found = await findPerson(personArg);
        if (found) person = found.name;
      }
      const period = args.period ? String(args.period) : null;
      const report = await addReport(person, period, content);
      audit(ctx.actor, 'record_report', `#${report.id} ${person ?? '(unknown)'} [${period ?? '—'}]`);
      return `Recorded report #${report.id} from ${person ?? '(unknown)'}${period ? ` for ${period}` : ''}.`;
    } catch (e) {
      return errText(e);
    }
  },
};

export const whoIsBehindTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'who_is_behind',
      description:
        'Show who is behind: people with overdue or open tasks, ranked by overdue count. This is ' +
        "Shivani's at-a-glance accountability view.",
      parameters: {
        type: 'object',
        properties: {
          overdue_only: { type: 'boolean', description: 'Only list people with overdue tasks (default false).' },
        },
      },
    },
  },
  async run(args) {
    try {
      const groups = await openTasksByPerson();
      const overdueOnly = Boolean(args.overdue_only);
      const filtered = overdueOnly ? groups.filter((g) => g.overdue > 0) : groups;
      if (!filtered.length) {
        return overdueOnly ? 'Nobody is overdue. 🎉' : 'No open tasks — everyone is clear.';
      }
      return filtered
        .map((g) => {
          const head = `${g.assignee}: ${g.count} open${g.overdue ? `, ${g.overdue} overdue` : ''}`;
          const overdueTasks = g.tasks
            .filter((t) => t.due && Date.parse(t.due) < Date.now())
            .map((t) => `   ↳ ${fmtTask(t)}`);
          return [head, ...overdueTasks].join('\n');
        })
        .join('\n');
    } catch (e) {
      return errText(e);
    }
  },
};
