import { notionSearch, notionRead, notionWrite } from '../../integrations/notion.js';
import { audit } from '../../control/audit.js';
import { type AgentTool, trim } from './types.js';

export const notionSearchTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'notion_search',
      description:
        'Search Notion pages the integration can access. Returns id + title + url per hit; pass ' +
        'an id to notion_read to read the page.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search page titles/content for.' },
          max: { type: 'number', description: 'Max results (1-50, default 10).' },
        },
      },
    },
  },
  async run(args) {
    const out = await notionSearch(
      args.query ? String(args.query) : undefined,
      args.max ? Number(args.max) : undefined,
    );
    return trim(out);
  },
};

export const notionReadTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'notion_read',
      description: "Read a Notion page's text (title + the plain text of its blocks) by page id.",
      parameters: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'The Notion page id (from notion_search).' },
        },
        required: ['page_id'],
      },
    },
  },
  async run(args) {
    const out = await notionRead(String(args.page_id));
    return trim(out);
  },
};

export const notionWriteTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'notion_write',
      description:
        'Write to Notion. Provide a `title` to CREATE a new child page under `parent_id`; omit ' +
        '`title` to APPEND the content as paragraphs to the page `parent_id`. Content is split ' +
        'into one paragraph per line.',
      parameters: {
        type: 'object',
        properties: {
          parent_id: {
            type: 'string',
            description: 'Page id to create the new page under, or the page to append to.',
          },
          content: { type: 'string', description: 'Text body; each line becomes a paragraph.' },
          title: {
            type: 'string',
            description: 'If set, create a new page with this title; if omitted, append instead.',
          },
        },
        required: ['parent_id', 'content'],
      },
    },
  },
  async run(args, ctx) {
    const title = args.title ? String(args.title) : undefined;
    audit(
      ctx.actor,
      'notion_write',
      title ? `create "${title}" under ${String(args.parent_id)}` : `append to ${String(args.parent_id)}`,
    );
    return notionWrite({
      parentId: String(args.parent_id),
      content: String(args.content),
      title,
    });
  },
};
