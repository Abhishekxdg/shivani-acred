/**
 * Advanced (super-memory) tools: semantic write + recall over Postgres/pgvector.
 *
 * These sit alongside the simple key/value `remember`/`recall` tools in
 * ./memory.ts (left untouched). They degrade gracefully: when Postgres is not
 * configured/reachable they return a clear "not configured" message rather than
 * throwing.
 */
import { remember, recall } from '../../memory/store.js';
import { isReady } from '../../db/pg.js';
import { audit } from '../../control/audit.js';
import { numberFromJid } from '../../config.js';
import { type AgentTool, trim } from './types.js';

/** Memory scope for the current actor: the company brain, or their private space. */
function scopeFor(actor: string, isOperator: boolean): string {
  return isOperator ? 'company' : `profile:${numberFromJid(actor) ?? actor}`;
}

const NOT_CONFIGURED =
  'Super-memory not configured: set DATABASE_URL (Postgres with the pgvector ' +
  'extension). Falling back to the simple remember/recall tools until then.';

export const rememberFactTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        'Save a fact, observation, or episode to super-memory. It is embedded so it ' +
        'can later be recalled by meaning (not just exact words) via search_memory. Use ' +
        'for durable knowledge worth surfacing in future conversations.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact/observation text to store.' },
          kind: {
            type: 'string',
            description:
              "Category label, e.g. 'fact', 'preference', 'episode', 'decision'. Default 'fact'.",
          },
          share_to_company: {
            type: 'boolean',
            description:
              'If true, also store this in the shared company memory (sync up). Use for ' +
              'company-relevant facts; leave false for a person\'s private notes.',
          },
        },
        required: ['content'],
      },
    },
  },
  async run(args, ctx) {
    const content = String(args.content ?? '').trim();
    if (!content) return 'Nothing to remember: provide "content".';
    const kind = String(args.kind ?? 'fact').trim() || 'fact';

    if (!(await isReady())) return NOT_CONFIGURED;

    const scope = scopeFor(ctx.actor, ctx.isOperator);
    await remember(kind, content, { actor: ctx.actor }, scope);

    const share =
      args.share_to_company === true || String(args.share_to_company).toLowerCase() === 'true';
    if (share && scope !== 'company') {
      await remember(kind, content, { actor: ctx.actor, shared: true }, 'company');
    }

    audit(ctx.actor, 'remember_fact', `${kind}: ${content.slice(0, 160)}`);
    const where = scope === 'company' ? 'company memory' : share ? 'your space + company' : 'your private space';
    return `Saved to super-memory (${kind}) → ${where}.`;
  },
};

export const searchMemoryTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_memory',
      description:
        'Semantically search super-memory for facts/episodes relevant to a query. Returns ' +
        'the closest matches by meaning (vector similarity when available, else keyword). ' +
        'Use before answering when past context might help.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for.' },
          limit: {
            type: 'number',
            description: 'Max results to return (default 8, max 20).',
          },
        },
        required: ['query'],
      },
    },
  },
  async run(args, ctx) {
    const q = String(args.query ?? '').trim();
    if (!q) return 'Provide a "query" to search memory.';

    const rawLimit = Number(args.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(20, Math.max(1, Math.trunc(rawLimit))) : 8;

    if (!(await isReady())) return NOT_CONFIGURED;

    const scope = scopeFor(ctx.actor, ctx.isOperator);
    const scopes = scope === 'company' ? ['company'] : ['company', scope];
    const hits = await recall(q, limit, scopes);
    if (hits.length === 0) return `No memories match "${q}".`;

    const out = hits
      .map((m) => {
        const when = (m.created_at ?? '').slice(0, 10);
        const tag = when ? `${m.kind} · ${when}` : m.kind;
        return `- [${tag}] ${m.content}`;
      })
      .join('\n');
    return trim(out);
  },
};
