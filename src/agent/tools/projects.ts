/**
 * Project-intake tools — NEW-PROJECT INTAKE for the chief-of-staff brain.
 *
 * When a founder says "start a new project", Shivani captures what it is, its
 * goal, and (the crux of intake) WHERE and HOW to start, then keeps it: she can
 * list projects, open a project's full detail + plan, add milestones, and update
 * fields as the project moves. start_project also writes a company-memory note
 * so the long-term brain remembers the project exists.
 *
 * All tools here are 'public' tier (record/read coordination, no outbound to the
 * world) — register their names in src/agent/access.ts PUBLIC_TOOLS.
 */
import {
  add,
  list,
  get,
  updateDetails,
  addMilestone,
  listMilestones,
  type Project,
  type Milestone,
  type ProjectPatch,
} from '../../projects/store.js';
import { remember } from '../../memory/store.js';
import { founderByJid } from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

/** Statuses a project moves through (guidance for the model; store accepts any). */
const PROJECT_STATUSES = ['planning', 'active', 'paused', 'done', 'cancelled'] as const;

/** Turn a store error into a stable, human message (never throws). */
function storeErr(e: unknown): string {
  const msg = (e as Error)?.message ?? 'store unavailable';
  return /not configured/i.test(msg)
    ? 'Project store not configured: set DATABASE_URL.'
    : `Project store error (${msg}).`;
}

/** One-line rendering of a project for list output. */
function fmtProject(p: Project): string {
  const bits = [`#${p.id}`, `[${p.status}]`, p.name];
  if (p.kind) bits.push(`(${p.kind})`);
  if (p.owner) bits.push(`— owner ${p.owner}`);
  return bits.join(' ');
}

/** One-line rendering of a milestone for detail output. */
function fmtMilestone(m: Milestone): string {
  const bits = [`  · [${m.status}] ${m.title}`];
  if (m.due) bits.push(`(due ${m.due})`);
  if (m.detail) bits.push(`— ${m.detail}`);
  return bits.join(' ');
}

export const startProjectTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'start_project',
      description:
        'Start a new project when a founder wants to kick one off. Capture what it is, its goal, ' +
        'and — the point of intake — WHERE to start and HOW to start, plus any details. Kept for ' +
        "later so you can plan and track it. Also remembers the project in the company's long-term memory.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name of the project.' },
          kind: { type: 'string', description: 'What kind of project — e.g. product, marketing, ops, hiring.' },
          goal: { type: 'string', description: 'The outcome this project should achieve.' },
          where_to_start: {
            type: 'string',
            description: 'Where to begin — the first place/area to focus.',
          },
          how_to_start: {
            type: 'string',
            description: 'How to begin — the first concrete steps/approach.',
          },
          details: { type: 'string', description: 'Any other context worth keeping.' },
          owner: { type: 'string', description: 'Founder who owns this project (defaults to you when a founder).' },
        },
        required: ['name'],
      },
    },
  },
  async run(args, ctx) {
    const name = String(args.name ?? '').trim();
    if (!name) return 'Give the project a name to start it.';
    const owner = args.owner ? String(args.owner) : founderByJid(ctx.actor)?.name;
    try {
      const p = await add({
        name,
        kind: args.kind ? String(args.kind) : undefined,
        goal: args.goal ? String(args.goal) : undefined,
        where_to_start: args.where_to_start ? String(args.where_to_start) : undefined,
        how_to_start: args.how_to_start ? String(args.how_to_start) : undefined,
        details: args.details ? String(args.details) : undefined,
        owner: owner ?? undefined,
      });
      audit(ctx.actor, 'start_project', `#${p.id} ${p.name}`);
      // Persist to company long-term memory so the brain remembers the project.
      const note =
        `New project "${p.name}"${p.kind ? ` (${p.kind})` : ''}. ` +
        `Goal: ${p.goal ?? '—'}. Where to start: ${p.where_to_start ?? '—'}. ` +
        `How to start: ${p.how_to_start ?? '—'}.`;
      await remember(
        'project',
        note,
        { projectId: p.id, name: p.name, kind: p.kind, owner: p.owner },
        'company',
      );
      return (
        `Started project ${fmtProject(p)}.\n` +
        `Goal: ${p.goal ?? '—'}\nWhere to start: ${p.where_to_start ?? '—'}\n` +
        `How to start: ${p.how_to_start ?? '—'}\n` +
        'Add milestones with add_project_milestone as the plan takes shape.'
      );
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const listProjectsTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'List all projects and their status. Use project_detail to open one.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    try {
      const rows = await list();
      if (!rows.length) return 'No projects yet. Say "start a new project" to kick one off.';
      return trim(rows.map(fmtProject).join('\n'));
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const projectDetailTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'project_detail',
      description: 'Show a project in full — its goal, where/how to start, details, and milestones (the plan).',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project id or name.' },
        },
        required: ['project'],
      },
    },
  },
  async run(args) {
    try {
      const p = await get(String(args.project));
      if (!p) return `No project matching "${String(args.project)}".`;
      const milestones = await listMilestones(p.id);
      const lines = [
        fmtProject(p),
        `Goal: ${p.goal ?? '—'}`,
        `Where to start: ${p.where_to_start ?? '—'}`,
        `How to start: ${p.how_to_start ?? '—'}`,
      ];
      if (p.details) lines.push(`Details: ${p.details}`);
      lines.push(
        milestones.length
          ? `Milestones:\n${milestones.map(fmtMilestone).join('\n')}`
          : 'Milestones: none yet.',
      );
      return trim(lines.join('\n'));
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const addProjectMilestoneTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'add_project_milestone',
      description: 'Add a milestone (a plan step) to a project.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project id or name.' },
          title: { type: 'string', description: 'The milestone / plan step.' },
          detail: { type: 'string', description: 'Optional context for the milestone.' },
          due: { type: 'string', description: 'Optional target/date, free text (e.g. "end of Q1").' },
        },
        required: ['project', 'title'],
      },
    },
  },
  async run(args, ctx) {
    const title = String(args.title ?? '').trim();
    if (!title) return 'Give the milestone a title.';
    try {
      const p = await get(String(args.project));
      if (!p) return `No project matching "${String(args.project)}".`;
      const m = await addMilestone(p.id, {
        title,
        detail: args.detail ? String(args.detail) : undefined,
        due: args.due ? String(args.due) : undefined,
      });
      audit(ctx.actor, 'add_project_milestone', `#${p.id} m${m.id} ${title}`);
      return `Added milestone to ${p.name}: ${title}${m.due ? ` (due ${m.due})` : ''}.`;
    } catch (e) {
      return storeErr(e);
    }
  },
};

export const updateProjectTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_project',
      description:
        'Update a project — its status, details, goal, the where/how of starting, owner, kind or name. ' +
        'Only the fields you pass are changed.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project id or name.' },
          name: { type: 'string', description: 'Rename the project.' },
          kind: { type: 'string' },
          goal: { type: 'string' },
          where_to_start: { type: 'string' },
          how_to_start: { type: 'string' },
          details: { type: 'string' },
          owner: { type: 'string', description: 'Founder who owns this project.' },
          status: {
            type: 'string',
            enum: [...PROJECT_STATUSES],
            description: 'New project status.',
          },
        },
        required: ['project'],
      },
    },
  },
  async run(args, ctx) {
    try {
      const p = await get(String(args.project));
      if (!p) return `No project matching "${String(args.project)}".`;
      const patch: ProjectPatch = {};
      if (args.name !== undefined) patch.name = String(args.name);
      if (args.kind !== undefined) patch.kind = String(args.kind);
      if (args.goal !== undefined) patch.goal = String(args.goal);
      if (args.where_to_start !== undefined) patch.where_to_start = String(args.where_to_start);
      if (args.how_to_start !== undefined) patch.how_to_start = String(args.how_to_start);
      if (args.details !== undefined) patch.details = String(args.details);
      if (args.owner !== undefined) patch.owner = String(args.owner);
      if (args.status !== undefined) patch.status = String(args.status);
      if (Object.keys(patch).length === 0) {
        return 'Nothing to update — pass at least one field (status, details, goal, where/how, owner, kind or name).';
      }
      const updated = await updateDetails(p.id, patch);
      if (!updated) return `Couldn't update project #${p.id}.`;
      audit(ctx.actor, 'update_project', `#${updated.id} ${Object.keys(patch).join(',')}`);
      return `Updated ${fmtProject(updated)}.`;
    } catch (e) {
      return storeErr(e);
    }
  },
};

/** All project-intake tools, for registration in the agent tool index. */
export const projectTools: AgentTool[] = [
  startProjectTool,
  listProjectsTool,
  projectDetailTool,
  addProjectMilestoneTool,
  updateProjectTool,
];
