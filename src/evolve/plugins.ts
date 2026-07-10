/**
 * Dynamic plugin loader — add new agent tools WITHOUT rebuilding the core.
 *
 * Drop a compiled `*.plugin.js` file into the ./plugins folder. Each module must
 * expose one or more AgentTool values, as either:
 *   • a `default` export that is an AgentTool or AgentTool[], or
 *   • a named `tools` export that is an AgentTool[], or
 *   • individual named exports that are AgentTool values.
 * loadPlugins() imports them all, validates their shape, de-dupes by tool name,
 * and returns the tools so the registry can include them at boot.
 *
 * Safe by construction: a broken (or hostile-looking) plugin is caught, logged,
 * and skipped — it can never crash the boot. With no ./plugins folder, returns
 * an empty result.
 */
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger.js';
import { type AgentTool } from '../agent/tools/types.js';

const PLUGINS_DIR = resolve(
  process.env.REPO_ROOT ?? process.cwd(),
  process.env.PLUGINS_DIR ?? 'plugins',
);

function isAgentTool(v: unknown): v is AgentTool {
  if (!v || typeof v !== 'object') return false;
  const t = v as { definition?: { function?: { name?: unknown } }; run?: unknown };
  return typeof t.run === 'function' && typeof t.definition?.function?.name === 'string';
}

/** Pull every AgentTool out of a loaded module, tolerant of how it's exported. */
function collectTools(mod: Record<string, unknown>): AgentTool[] {
  const found: AgentTool[] = [];
  const push = (candidate: unknown): void => {
    if (Array.isArray(candidate)) candidate.forEach(push);
    else if (isAgentTool(candidate)) found.push(candidate);
  };
  if ('default' in mod) push(mod.default);
  if ('tools' in mod) push(mod.tools);
  for (const [key, val] of Object.entries(mod)) {
    if (key === 'default' || key === 'tools') continue;
    push(val);
  }
  // De-dupe by tool name (a module might surface the same tool twice).
  const byName = new Map<string, AgentTool>();
  for (const t of found) byName.set(t.definition.function.name, t);
  return [...byName.values()];
}

export interface LoadPluginsResult {
  tools: AgentTool[];
  loaded: string[];
  failed: { file: string; error: string }[];
}

/**
 * Scan ./plugins for `*.plugin.js` and return every AgentTool they export.
 *
 * @param opts.fresh append a cache-busting query so a re-scan picks up a plugin
 *   that was just written during this process's lifetime (ESM caches modules by
 *   URL, so without this a re-import returns the stale copy).
 */
export async function loadPlugins(opts: { fresh?: boolean } = {}): Promise<LoadPluginsResult> {
  const result: LoadPluginsResult = { tools: [], loaded: [], failed: [] };

  let files: string[];
  try {
    const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.plugin.js'))
      .map((e) => e.name)
      .sort();
  } catch {
    return result; // no ./plugins folder → nothing to load
  }

  const seen = new Set<string>();
  for (const file of files) {
    const abs = resolve(PLUGINS_DIR, file);
    const href = pathToFileURL(abs).href + (opts.fresh ? `?t=${Date.now()}` : '');
    try {
      const mod = (await import(href)) as Record<string, unknown>;
      const tools = collectTools(mod);
      if (!tools.length) {
        result.failed.push({ file, error: 'no AgentTool exported' });
        logger.warn(`plugin ${file}: no AgentTool exported; skipped`);
        continue;
      }
      for (const t of tools) {
        const name = t.definition.function.name;
        if (seen.has(name)) {
          logger.warn(`plugin ${file}: duplicate tool name "${name}" ignored`);
          continue;
        }
        seen.add(name);
        result.tools.push(t);
      }
      result.loaded.push(file);
      logger.info(`plugin ${file}: loaded ${tools.length} tool(s)`);
    } catch (err) {
      const error = (err as Error)?.message ?? String(err);
      logger.error(err, `plugin load failed: ${file}`);
      result.failed.push({ file, error });
    }
  }
  return result;
}
