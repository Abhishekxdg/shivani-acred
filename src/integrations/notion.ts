/**
 * Notion integration (credential-gated).
 *
 * Degrades gracefully: the integration token is read from the `connectors` table
 * (name='notion') when Postgres is configured, else from the `NOTION_TOKEN` env
 * var. When neither yields a token, every function returns a clear
 * "Notion not connected: run the setup in docs/integrations-setup.md" string
 * rather than throwing — so the base app boots fine with nothing configured.
 *
 * Each exported function returns a ready-to-send human string (result, the
 * not-connected notice, or a "Notion error: ..." message). The tool layer stays
 * a thin wrapper that only adds arg parsing + audit.
 */
import { Client, isFullPage, isFullBlock } from '@notionhq/client';
import { getPool, query } from '../db/pg.js';
import { type Connector } from '../db/types.js';
import { logger } from '../logger.js';

export const NOTION_NOT_CONNECTED =
  'Notion not connected: run the setup in docs/integrations-setup.md';

/** Minimal shapes we read out of Notion responses (narrowed via contained casts). */
interface NotionRichText {
  plain_text?: string;
}
interface NotionTitleProp {
  type?: string;
  title?: NotionRichText[];
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function clampMax(n: number | undefined, dflt = 10): number {
  if (!Number.isFinite(n) || !n) return dflt;
  return Math.min(50, Math.max(1, Math.floor(n as number)));
}

async function connectorTokens(name: string): Promise<Record<string, unknown> | null> {
  if (!getPool()) return null; // Postgres not configured — fall back to env.
  try {
    const rows = await query<Connector>('SELECT tokens FROM connectors WHERE name = $1 LIMIT 1', [
      name,
    ]);
    return rows[0]?.tokens ?? null;
  } catch (err) {
    logger.warn(err, `notion connector lookup failed for '${name}'`);
    return null;
  }
}

/** Build a Notion client from connector-table token or NOTION_TOKEN; null when absent. */
async function notionClient(): Promise<Client | null> {
  const t = (await connectorTokens('notion')) ?? {};
  const token = str(t.token) ?? str(t.access_token) ?? str(process.env.NOTION_TOKEN);
  if (!token) return null;
  return new Client({ auth: token });
}

function notionError(err: unknown): string {
  logger.error(err, 'notion api error');
  return `Notion error: ${(err as Error)?.message ?? String(err)}`;
}

/** Extract a page's display title from its `title`-typed property. */
function pageTitle(page: { properties?: Record<string, NotionTitleProp> }): string {
  const props = page.properties ?? {};
  for (const prop of Object.values(props)) {
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text ?? '').join('');
      if (text) return text;
    }
  }
  return 'Untitled';
}

/** Pull the rich_text out of whatever block type this is, as plain text. */
function blockText(block: { type: string }): string {
  const bag = block as unknown as Record<string, { rich_text?: NotionRichText[] }>;
  const rt = bag[block.type]?.rich_text;
  if (!Array.isArray(rt)) return '';
  return rt.map((t) => t.plain_text ?? '').join('');
}

/** A Notion paragraph block wrapping a single line of text. */
function paragraph(text: string) {
  return {
    object: 'block' as const,
    type: 'paragraph' as const,
    paragraph: { rich_text: [{ type: 'text' as const, text: { content: text } }] },
  };
}

/** Split a body string into one paragraph block per non-empty line. */
function toParagraphs(content: string) {
  const lines = content.split('\n').map((l) => l.trimEnd());
  const blocks = lines.filter((l) => l.length > 0).map(paragraph);
  return blocks.length ? blocks : [paragraph(content)];
}

/** Search pages the integration can see. Returns id + title + url per hit. */
export async function notionSearch(queryStr: string | undefined, max?: number): Promise<string> {
  const notion = await notionClient();
  if (!notion) return NOTION_NOT_CONNECTED;
  try {
    const res = await notion.search({
      query: str(queryStr) ?? '',
      filter: { property: 'object', value: 'page' },
      page_size: clampMax(max),
    });
    const pages = res.results.filter(isFullPage);
    if (!pages.length) return 'No Notion pages matched.';
    return pages
      .map((p) => `id: ${p.id}\ntitle: ${pageTitle(p)}\nurl: ${p.url}`)
      .join('\n\n');
  } catch (err) {
    return notionError(err);
  }
}

/** Read a page's text: its title plus the plain text of its top-level blocks. */
export async function notionRead(pageId: string): Promise<string> {
  const notion = await notionClient();
  if (!notion) return NOTION_NOT_CONNECTED;
  const id = str(pageId);
  if (!id) return 'Notion error: a page id is required.';
  try {
    const lines: string[] = [];
    let cursor: string | undefined;
    // Paginate through the page's children (Notion caps at 100 blocks/request).
    do {
      const res = await notion.blocks.children.list({
        block_id: id,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of res.results) {
        if (!isFullBlock(block)) continue;
        const text = blockText(block);
        if (text) lines.push(text);
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);

    let title = 'Untitled';
    try {
      const page = await notion.pages.retrieve({ page_id: id });
      if (isFullPage(page)) title = pageTitle(page);
    } catch {
      // Retrieving the page object is best-effort; the block text is the point.
    }

    const body = lines.length ? lines.join('\n') : '(no readable text blocks)';
    return `title: ${title}\nid: ${id}\n\n${body}`;
  } catch (err) {
    return notionError(err);
  }
}

/**
 * Write to Notion. Two modes, chosen by whether `title` is provided:
 *  - with `title`: create a NEW child page under `parentId` (a page id), with
 *    `content` as its body paragraphs.
 *  - without `title`: APPEND `content` as paragraphs to the page `parentId`.
 */
export async function notionWrite(opts: {
  parentId: string;
  content: string;
  title?: string;
}): Promise<string> {
  const notion = await notionClient();
  if (!notion) return NOTION_NOT_CONNECTED;
  const parentId = str(opts.parentId);
  if (!parentId) return 'Notion error: a parent/page id is required.';
  const content = opts.content ?? '';
  const title = str(opts.title);
  try {
    if (title) {
      const page = await notion.pages.create({
        parent: { type: 'page_id', page_id: parentId },
        properties: {
          title: { title: [{ type: 'text', text: { content: title } }] },
        },
        children: toParagraphs(content),
      });
      const url = isFullPage(page) ? page.url : '';
      return `Created page "${title}" (id: ${page.id})${url ? ` — ${url}` : ''}.`;
    }
    const blocks = toParagraphs(content);
    await notion.blocks.children.append({ block_id: parentId, children: blocks });
    return `Appended ${blocks.length} paragraph(s) to page ${parentId}.`;
  } catch (err) {
    return notionError(err);
  }
}
