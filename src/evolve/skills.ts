/**
 * Skills registry — Shivani's runtime-growable behaviors.
 *
 * A "skill" is a markdown/spec (optionally with a code snippet) that extends
 * Shivani's behavior by being injected into her system prompt. Skills are
 * persisted two ways so they survive with OR without a database:
 *   1. The Postgres `skills` table (see ../db/schema.ts) — the shared source of
 *      truth when Postgres is configured.
 *   2. A local ./skills folder of `<name>.md` files — the always-available
 *      fallback so skills work even with no database at all.
 *
 * Degrades gracefully: with no Postgres configured (DATABASE_URL unset) or the
 * DB unreachable, everything still works off the ./skills folder. The database
 * is treated as best-effort and never throws out of these functions.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getPool, query } from '../db/pg.js';
import { logger } from '../logger.js';

export interface Skill {
  name: string;
  kind: string;
  /** Markdown/spec injected into the prompt. */
  spec: string;
  /** Optional code snippet the spec refers to (stored, not executed here). */
  code: string | null;
  enabled: boolean;
  /** Where this copy was loaded from. */
  source: 'db' | 'file';
}

const SKILLS_DIR = resolve(
  process.env.REPO_ROOT ?? process.cwd(),
  process.env.SKILLS_DIR ?? 'skills',
);

/** Make a filesystem- and DB-safe skill name. */
function safeName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  );
}

interface SkillRow {
  name: string;
  kind: string;
  spec: string | null;
  code: string | null;
  enabled: boolean;
}

async function loadDbSkills(): Promise<Skill[]> {
  if (!getPool()) return []; // Postgres not configured — silent, folder is the fallback.
  try {
    const rows = await query<SkillRow>(
      'SELECT name, kind, spec, code, enabled FROM skills ORDER BY name',
    );
    return rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      spec: r.spec ?? '',
      code: r.code,
      enabled: r.enabled,
      source: 'db' as const,
    }));
  } catch (err) {
    logger.warn(err, 'skills: Postgres read failed; falling back to ./skills folder');
    return [];
  }
}

async function loadFileSkills(): Promise<Skill[]> {
  let names: string[];
  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  } catch {
    return []; // no ./skills folder yet
  }
  const out: Skill[] = [];
  for (const fname of names) {
    try {
      const spec = await readFile(join(SKILLS_DIR, fname), 'utf8');
      out.push({
        name: fname.replace(/\.md$/, ''),
        kind: 'markdown',
        spec,
        code: null,
        enabled: true, // a file present on disk is an active skill
        source: 'file',
      });
    } catch (err) {
      logger.warn(err, `skills: could not read ${fname}`);
    }
  }
  return out;
}

/**
 * Load all skills. A DB skill overrides a same-named file skill. Only enabled
 * skills are returned by default (file skills are always considered enabled).
 */
export async function loadSkills(opts: { includeDisabled?: boolean } = {}): Promise<Skill[]> {
  const [dbSkills, fileSkills] = await Promise.all([loadDbSkills(), loadFileSkills()]);
  const byName = new Map<string, Skill>();
  for (const s of fileSkills) byName.set(s.name, s);
  for (const s of dbSkills) byName.set(s.name, s); // DB wins over file
  const all = [...byName.values()];
  return opts.includeDisabled ? all : all.filter((s) => s.enabled);
}

/**
 * Add (or overwrite) a skill. Always writes the `<name>.md` file first so the
 * skill survives without a database; then best-effort upserts into Postgres when
 * configured. New/updated DB skills are stored enabled so they take effect on the
 * next prompt rebuild.
 */
export async function addSkill(
  name: string,
  kind: string,
  spec: string,
  code?: string | null,
): Promise<Skill> {
  const clean = safeName(name);
  await mkdir(SKILLS_DIR, { recursive: true });
  const body = code && code.trim() ? `${spec}\n\n\`\`\`\n${code}\n\`\`\`\n` : `${spec}\n`;
  await writeFile(join(SKILLS_DIR, `${clean}.md`), body, 'utf8');

  let source: Skill['source'] = 'file';
  if (getPool()) {
    try {
      await query(
        `INSERT INTO skills (name, kind, spec, code, enabled) VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (name) DO UPDATE
           SET kind = EXCLUDED.kind, spec = EXCLUDED.spec, code = EXCLUDED.code, enabled = true`,
        [clean, kind, spec, code ?? null],
      );
      source = 'db';
    } catch (err) {
      logger.warn(err, 'skills: Postgres upsert failed; skill saved to ./skills folder only');
    }
  }
  const skill: Skill = { name: clean, kind, spec, code: code ?? null, enabled: true, source };
  await refreshSkillsCache().catch(() => {}); // keep the injected prompt current
  return skill;
}

/** List every skill (including disabled ones) for inspection. */
export async function listSkills(): Promise<Skill[]> {
  return loadSkills({ includeDisabled: true });
}

// ---------------------------------------------------------------------------
// Synchronous cache — so the (synchronous) persona/systemPrompt() can inject
// skills without doing async work on every turn. Wire it as:
//   • boot:            await refreshSkillsCache();
//   • systemPrompt():  append skillsSection();
// The cache is also refreshed automatically whenever addSkill() runs.
// ---------------------------------------------------------------------------
let cache: Skill[] = [];

/** Reload skills from DB + folder into the in-memory cache. Call at boot. */
export async function refreshSkillsCache(): Promise<Skill[]> {
  cache = await loadSkills();
  return cache;
}

/** The cached, ready-to-inject prompt section (empty until first refresh). */
export function skillsSection(): string {
  return renderSkillsSection(cache);
}

/**
 * Render enabled skills as a prompt section to inject into Shivani's persona.
 * Returns '' when there are no enabled skills, so a caller can append it
 * unconditionally to the system prompt.
 */
export function renderSkillsSection(skills: Skill[]): string {
  const enabled = skills.filter((s) => s.enabled && s.spec.trim());
  if (!enabled.length) return '';
  const blocks = enabled
    .map((s) => `### Skill: ${s.name} (${s.kind})\n${s.spec.trim()}`)
    .join('\n\n');
  return `\n========================= LEARNED SKILLS =========================\n${blocks}\n`;
}
