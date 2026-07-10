/**
 * Self-evolution tools — how Shivani grows herself at runtime.
 *
 *   write_skill    — teach herself a durable playbook/spec (prompt-injected).
 *   list_skills    — inspect the skills she has learned.
 *   install_plugin — add a brand-new tool WITHOUT a rebuild (a *.plugin.js).
 *   self_deploy    — ship her own code changes behind a typecheck gate; the
 *                    watchdog restarts her and auto-rolls-back on failure.
 *   self_diagnose  — read her recent audit trail, git/deploy state and process
 *                    stats to reason about her own health.
 *
 * Every tool degrades gracefully — a missing backend yields a clear message, not
 * a throw — matching the rest of the toolbox.
 */
import { exec } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import db from '../../store/db.js';
import { config } from '../../config.js';
import { audit } from '../../control/audit.js';
import { addSkill, listSkills } from '../../evolve/skills.js';
import { loadPlugins } from '../../evolve/plugins.js';
import { selfDeploy } from '../../evolve/deploy.js';
import { type AgentTool, trim } from './types.js';

const pexec = promisify(exec);
const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const DATA_DIR = resolve(REPO_ROOT, config.DATA_DIR);
const PLUGINS_DIR = resolve(REPO_ROOT, process.env.PLUGINS_DIR ?? 'plugins');

export const writeSkillTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_skill',
      description:
        'Create or update a SKILL — a markdown spec (optionally with a code snippet) that ' +
        'permanently extends your behavior by being injected into your system prompt on future ' +
        'turns. Use it to teach yourself a durable procedure, checklist, or playbook so it ' +
        'survives restarts. Overwrites a skill of the same name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short unique skill name, e.g. "weekly-digest".' },
          kind: {
            type: 'string',
            description: 'Skill kind: "markdown" (a playbook/spec) or "code" (a snippet + notes).',
          },
          spec: { type: 'string', description: 'The markdown instructions injected into your prompt.' },
          code: { type: 'string', description: 'Optional code snippet the spec refers to.' },
        },
        required: ['name', 'spec'],
      },
    },
  },
  async run(args, ctx) {
    const name = String(args.name ?? '').trim();
    if (!name) return 'write_skill needs a non-empty "name".';
    const kind = String(args.kind ?? 'markdown');
    const spec = String(args.spec ?? '');
    const code = args.code != null && String(args.code).trim() ? String(args.code) : null;
    audit(ctx.actor, 'write_skill', name);
    const skill = await addSkill(name, kind, spec, code);
    const where = skill.source === 'db' ? 'Postgres + ./skills folder' : './skills folder';
    return `Saved skill "${skill.name}" (${skill.kind}), persisted to ${where}. It takes effect once your persona reloads skills (next boot, or next turn if wired).`;
  },
};

export const listSkillsTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List all learned skills (name, kind, enabled state, and where each is stored).',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run() {
    const skills = await listSkills();
    if (!skills.length) return 'No skills yet. Use write_skill to teach yourself one.';
    return skills
      .map((s) => `- ${s.name} [${s.kind}] ${s.enabled ? 'enabled' : 'disabled'} (${s.source})`)
      .join('\n');
  },
};

export const installPluginTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'install_plugin',
      description:
        'Install a NEW tool at runtime WITHOUT a rebuild by writing a compiled *.plugin.js module ' +
        'into the ./plugins folder. The code MUST be plain JavaScript (ESM) exporting an array of ' +
        'AgentTool as its default export — each tool is ' +
        '{ definition: { type: "function", function: { name, description, parameters } }, ' +
        'async run(args, ctx) { return "..."; } }. The plugin is validated immediately on write; ' +
        'it becomes callable after the plugin registry reloads (next boot).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin base name, e.g. "weather" -> weather.plugin.js.' },
          code: { type: 'string', description: 'The full JavaScript (ESM) source of the plugin module.' },
        },
        required: ['name', 'code'],
      },
    },
  },
  async run(args, ctx) {
    const rawName = String(args.name ?? '').trim();
    const code = String(args.code ?? '');
    if (!rawName) return 'install_plugin needs a "name".';
    if (!code.trim()) return 'install_plugin needs non-empty "code".';
    const base =
      rawName
        .replace(/\.plugin\.js$/, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'plugin';
    const file = `${base}.plugin.js`;
    await mkdir(PLUGINS_DIR, { recursive: true });
    const target = join(PLUGINS_DIR, file);
    audit(ctx.actor, 'install_plugin', file);
    await writeFile(target, code, 'utf8');

    // Validate by loading fresh; report what it exposed (or why it failed).
    const res = await loadPlugins({ fresh: true });
    const failure = res.failed.find((f) => f.file === file);
    if (failure) {
      return `Wrote ${file} but it FAILED to load: ${failure.error}. Fix the code and re-install — it will NOT be registered until it loads cleanly.`;
    }
    const names = res.tools.map((t) => t.definition.function.name);
    return `Installed ${file}. Plugins now expose ${res.tools.length} tool(s): ${
      names.join(', ') || '(none)'
    }. Available after the plugin registry reloads (next boot).`;
  },
};

export const selfDeployTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'self_deploy',
      description:
        'Ship your own code changes: runs typecheck (NEVER deploys if it fails), commits, ' +
        'rebuilds, and signals the watchdog to restart you on the new version — with automatic ' +
        'rollback if you fail to come up. Use after you have written/edited source files under ' +
        'src/ and want them to go live.',
      parameters: {
        type: 'object',
        properties: {
          change_description: {
            type: 'string',
            description: 'Short summary of what changed and why (used as the commit message).',
          },
        },
        required: ['change_description'],
      },
    },
  },
  async run(args, ctx) {
    const desc = String(args.change_description ?? '').trim();
    audit(ctx.actor, 'self_deploy.invoke', desc);
    return trim(await selfDeploy(desc));
  },
};

export const selfDiagnoseTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'self_diagnose',
      description:
        'Read your recent activity and errors to diagnose your own health: the latest audit ' +
        'trail, git commit + working-tree state, last-good commit, any pending redeploy, and ' +
        'process stats. Use before/after a self_deploy or when something seems wrong.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent audit entries to include (default 20).' },
        },
      },
    },
  },
  async run(args) {
    const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit ?? 20)) || 20));
    const lines: string[] = [];

    const git = async (cmd: string): Promise<string> => {
      try {
        const { stdout } = await pexec(cmd, { cwd: REPO_ROOT, timeout: 15_000, shell: '/bin/bash' });
        return stdout.trim();
      } catch (e) {
        return `(git error: ${(e as Error)?.message ?? String(e)})`;
      }
    };
    const branch = await git('git rev-parse --abbrev-ref HEAD');
    const head = await git('git rev-parse --short HEAD');
    const dirty = await git('git status --porcelain');
    const lastLog = await git('git log -1 --pretty=%h\\ %s');
    lines.push(`GIT: ${branch} @ ${head} — ${dirty ? 'DIRTY working tree' : 'clean'}`);
    lines.push(`LAST COMMIT: ${lastLog}`);

    let lastGood = '(none)';
    try {
      lastGood = (await readFile(join(DATA_DIR, 'last-good-commit'), 'utf8')).trim() || '(empty)';
    } catch {
      /* no marker yet */
    }
    lines.push(`LAST-GOOD: ${lastGood}`);

    let pending = false;
    try {
      await stat(join(DATA_DIR, 'redeploy.request'));
      pending = true;
    } catch {
      /* none pending */
    }
    lines.push(`PENDING REDEPLOY: ${pending ? 'yes (sentinel present)' : 'no'}`);

    const mem = process.memoryUsage();
    lines.push(
      `PROCESS: pid ${process.pid}, node ${process.version}, up ${Math.round(process.uptime())}s, ` +
        `rss ${Math.round(mem.rss / 1048576)}MB`,
    );

    interface AuditRow {
      actor: string;
      action: string;
      detail: string | null;
      created_at: string;
    }
    try {
      const rows = db
        .prepare('SELECT actor, action, detail, created_at FROM audit ORDER BY id DESC LIMIT ?')
        .all(limit) as AuditRow[];
      if (rows.length) {
        lines.push(`RECENT ACTIVITY (last ${rows.length}):`);
        for (const r of rows) {
          lines.push(`  ${r.created_at} ${r.actor} ${r.action}${r.detail ? ` — ${r.detail}` : ''}`);
        }
      } else {
        lines.push('RECENT ACTIVITY: (audit log empty)');
      }
    } catch (e) {
      lines.push(`AUDIT: (unavailable: ${(e as Error)?.message ?? String(e)})`);
    }

    // Optional: tail an on-disk log file if one is configured.
    const logFile = process.env.SHIVANI_LOG_FILE;
    if (logFile) {
      try {
        const txt = await readFile(logFile, 'utf8');
        lines.push(`LOG TAIL (${logFile}):\n${txt.split('\n').slice(-30).join('\n')}`);
      } catch (e) {
        lines.push(`LOG TAIL: (could not read ${logFile}: ${(e as Error)?.message ?? String(e)})`);
      }
    }

    return trim(lines.join('\n'));
  },
};

/** All self-evolution tools, for one-line registration in the tool registry. */
export const evolveTools: AgentTool[] = [
  writeSkillTool,
  listSkillsTool,
  installPluginTool,
  selfDeployTool,
  selfDiagnoseTool,
];
