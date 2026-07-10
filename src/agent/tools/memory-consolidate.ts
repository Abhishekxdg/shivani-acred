/**
 * Operator tool: run memory consolidation to keep super-memory premium —
 * dedup near-duplicates, fold large clusters into summaries, and decay stale
 * low-value entries. Thin wrapper over memory/consolidate.ts, which degrades to
 * a clear "not configured" string when Postgres is absent and never throws.
 *
 * Tier: 'operator' — mutating maintenance over shared memory, so only the
 * principal (operator) may trigger it. Also intended to run weekly on a
 * schedule (see the cron instruction that ships with this file).
 */
import { consolidateMemory } from '../../memory/consolidate.js';
import { audit } from '../../control/audit.js';
import { numberFromJid } from '../../config.js';
import { type AgentTool, trim } from './types.js';

/** The caller's default memory scope: the shared company brain for the
 *  operator, otherwise their private profile space. */
function scopeFor(actor: string, isOperator: boolean): string {
  return isOperator ? 'company' : `profile:${numberFromJid(actor) ?? actor}`;
}

/** Parse an optional boolean flag: undefined when the arg was not supplied, so
 *  consolidateMemory() keeps its own default. */
function parseFlag(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}

export const consolidateMemoryTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'consolidate_memory',
      description:
        'Consolidate long-term (super) memory to keep it premium: remove exact/near-duplicate ' +
        'notes, fold large clusters of related notes into compact summaries, and decay very old, ' +
        'never-recalled entries. Operates within one memory scope. Operator-only; also runs ' +
        'weekly on a schedule.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description:
              "Which memory namespace to consolidate. Omit for the caller's default scope " +
              "('company' for the operator). Pass 'all' to sweep every scope.",
          },
          summarize: {
            type: 'boolean',
            description: 'Fold large same-kind clusters into LLM summaries (default true).',
          },
          decay: {
            type: 'boolean',
            description: 'Mark stale / delete very old, never-recalled memories (default true).',
          },
        },
      },
    },
  },
  async run(args, ctx) {
    // Operator tier: only the principal may run destructive memory maintenance.
    if (!ctx.isOperator) {
      return '🔒 Only the principal can consolidate memory.';
    }

    const raw = typeof args.scope === 'string' ? args.scope.trim() : '';
    let scope: string | undefined;
    if (!raw) scope = scopeFor(ctx.actor, ctx.isOperator); // default: company brain
    else if (raw.toLowerCase() === 'all') scope = undefined; // every scope
    else scope = raw; // explicit namespace

    const result = await consolidateMemory(scope, {
      summarize: parseFlag(args.summarize),
      decay: parseFlag(args.decay),
    });

    audit(ctx.actor, 'consolidate_memory', `scope=${scope ?? 'all'}`);
    return trim(result);
  },
};
