/**
 * acred OS (Supabase) READ tools — real operational numbers for Shivani.
 *
 * Tier: operator (internal financials). These expose live bookings/pace and the
 * inventory-spine, so they are gated to the principal (operator) or a known
 * founder; everyone else gets a clear lock message. Reads only — no writes.
 * Access is audited because the data is sensitive internal financials.
 */
import { bookingsSummary, inventoryByState, safeRead } from '../../integrations/acredos.js';
import { founderByJid } from '../../config.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, type ToolContext, trim } from './types.js';

const LOCKED = '🔒 acred OS numbers are operator/founder-only (internal financials).';

/** Only the principal or a known founder may read internal acred OS data. */
function allowed(ctx: ToolContext): boolean {
  return ctx.isOperator || Boolean(founderByJid(ctx.actor));
}

export const acredosBookingsTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'acredos_bookings',
      description:
        'Read REAL booking numbers from acred OS (Supabase): total bookings and bookings so far ' +
        'this month, to report actual pace against the ~4/month target instead of a self-report. ' +
        'Operator/founder only.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run(_args, ctx) {
    if (!allowed(ctx)) return LOCKED;
    audit(ctx.actor, 'acredos_bookings', 'read bookings summary');
    return trim(await bookingsSummary());
  },
};

export const acredosInventoryTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'acredos_inventory',
      description:
        'Read the acred OS inventory-spine: a live count of units grouped by their state/status ' +
        '(the CRM is units-with-states, not a lead funnel). Operator/founder only.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run(_args, ctx) {
    if (!allowed(ctx)) return LOCKED;
    audit(ctx.actor, 'acredos_inventory', 'read inventory by state');
    return trim(await inventoryByState());
  },
};

export const acredosQueryTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'acredos_query',
      description:
        'Read-only query against an acred OS (Supabase) table: SELECT a table with optional simple ' +
        'equality filters. No writes are possible. Returns matching rows as JSON. Use for ad-hoc ' +
        'operational numbers (bookings, units, leads, cash). Operator/founder only.',
      parameters: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: 'Table to read, e.g. bookings, units, leads.',
          },
          filters: {
            type: 'object',
            description:
              'Optional column→value equality filters, all ANDed. e.g. {"status":"booked"}.',
          },
          columns: {
            type: 'string',
            description: 'Optional comma-separated columns to return (default all: *).',
          },
          limit: { type: 'number', description: 'Max rows to return (1-100, default 20).' },
        },
        required: ['table'],
      },
    },
  },
  async run(args, ctx) {
    if (!allowed(ctx)) return LOCKED;
    const table = String(args.table ?? '').trim();
    if (!table) return 'Give me a table name to read.';
    const filters =
      args.filters && typeof args.filters === 'object' && !Array.isArray(args.filters)
        ? (args.filters as Record<string, unknown>)
        : undefined;
    audit(
      ctx.actor,
      'acredos_query',
      `${table}${filters ? ` ${JSON.stringify(filters)}` : ''}`,
    );
    return trim(
      await safeRead({
        table,
        filters,
        columns: args.columns ? String(args.columns) : undefined,
        limit: args.limit != null ? Number(args.limit) : undefined,
      }),
    );
  },
};
