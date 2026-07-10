import { webSearch, webFetch } from '../../integrations/web.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

export const webSearchTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live web with a real headless-Chromium browser (DuckDuckGo, Bing fallback) ' +
        '— no API key needed. Returns a ranked list of {title, url, snippet}. Use web_read to open a result.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'Max results, 1-15 (default 6).' },
        },
        required: ['query'],
      },
    },
  },
  async run(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) return 'Provide a "query" to search for.';
    const limit = args.limit ? Number(args.limit) : 6;
    audit(ctx.actor, 'web_search', query);
    try {
      const results = await webSearch(query, limit);
      if (!results.length) {
        return `No results for "${query}". The browser may be unavailable — check that Chromium is installed on the VM.`;
      }
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
        .join('\n\n');
    } catch (e) {
      return `web_search failed: ${(e as Error)?.message ?? String(e)}`;
    }
  },
};

export const webReadTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_read',
      description:
        'Fetch a URL and return its readable text (HTML tags stripped). Use after web_search, ' +
        'or on any known link, to read the actual content of a page.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The page URL to read.' } },
        required: ['url'],
      },
    },
  },
  async run(args, ctx) {
    const url = String(args.url ?? '').trim();
    if (!url) return 'Provide a "url" to read.';
    audit(ctx.actor, 'web_read', url);
    try {
      const text = await webFetch(url);
      return trim(text || '(empty page)', 15_000);
    } catch (e) {
      return `web_read failed for ${url}: ${(e as Error)?.message ?? String(e)}`;
    }
  },
};
