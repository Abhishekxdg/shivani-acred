import { draftDocx, draftMarkdown, type DocSection } from '../../integrations/docs.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

/** Coerce the model's loosely-typed `sections` arg into DocSection[]. */
function coerceSections(raw: unknown): DocSection[] {
  if (!Array.isArray(raw)) return [];
  const out: DocSection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const heading =
      typeof r.heading === 'string' ? r.heading : typeof r.title === 'string' ? r.title : undefined;
    const body =
      typeof r.body === 'string'
        ? r.body
        : typeof r.text === 'string'
          ? r.text
          : typeof r.content === 'string'
            ? r.content
            : undefined;
    const bullets = Array.isArray(r.bullets)
      ? r.bullets.map((b) => String(b)).filter(Boolean)
      : undefined;
    if (heading || body || (bullets && bullets.length)) out.push({ heading, body, bullets });
  }
  return out;
}

export const draftDocumentTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'draft_document',
      description:
        'Draft a document (Word .docx by default, or Markdown) and save it under ./data/docs. ' +
        'Returns the file path — pass it to send_document to deliver the file over WhatsApp.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          sections: {
            type: 'array',
            description: 'Ordered document sections.',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: 'Section heading (optional).' },
                body: {
                  type: 'string',
                  description: 'Section prose; blank lines separate paragraphs.',
                },
                bullets: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional bullet list.',
                },
              },
            },
          },
          format: {
            type: 'string',
            enum: ['docx', 'markdown'],
            description: 'Output format (default docx).',
          },
        },
        required: ['title', 'sections'],
      },
    },
  },
  async run(args, ctx) {
    const title = String(args.title ?? '').trim() || 'Untitled';
    const sections = coerceSections(args.sections);
    if (!sections.length) {
      return 'Provide at least one section ({heading, body, bullets}) to draft a document.';
    }
    const format = String(args.format ?? 'docx').toLowerCase();
    audit(ctx.actor, 'draft_document', `${format}: ${title}`);
    try {
      const path =
        format === 'markdown' || format === 'md'
          ? await draftMarkdown(title, sections)
          : await draftDocx(title, sections);
      return `Document saved to ${path}`;
    } catch (e) {
      return `draft_document failed: ${(e as Error)?.message ?? String(e)}`;
    }
  },
};
