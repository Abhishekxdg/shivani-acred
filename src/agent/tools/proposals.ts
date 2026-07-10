import { generateProposal, type ProposalSection } from '../../integrations/proposals.js';
import { audit } from '../../control/audit.js';
import { type AgentTool } from './types.js';

/** Coerce the model's loosely-typed `sections` arg into ProposalSection[]. */
function coerceSections(raw: unknown): ProposalSection[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposalSection[] = [];
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

export const generateProposalTool: AgentTool = {
  definition: {
    type: 'function',
    function: {
      name: 'generate_proposal',
      description:
        'Generate a premium, branded ACRED proposal as a Word .docx (Fraunces/Manrope type, ' +
        'brand palette, positioning line) and save it under ./data/proposals. Returns the file ' +
        'path — pass it to send_document to deliver the proposal over WhatsApp.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Proposal title, e.g. "Design-Build Proposal — Villa at Devanahalli".',
          },
          client: {
            type: 'string',
            description: 'Who the proposal is prepared for (person or company).',
          },
          sections: {
            type: 'array',
            description: 'Ordered proposal sections.',
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
          price_note: {
            type: 'string',
            description: 'Optional commercials/pricing note, highlighted in its own block.',
          },
        },
        required: ['title', 'client', 'sections'],
      },
    },
  },
  async run(args, ctx) {
    const title = String(args.title ?? '').trim() || 'Proposal';
    const client = String(args.client ?? '').trim() || 'Valued Client';
    const sections = coerceSections(args.sections);
    if (!sections.length) {
      return 'Provide at least one section ({heading, body, bullets}) to generate a proposal.';
    }
    const priceNote =
      typeof args.price_note === 'string'
        ? args.price_note
        : typeof args.priceNote === 'string'
          ? args.priceNote
          : undefined;
    audit(ctx.actor, 'generate_proposal', `${title} → ${client}`);
    try {
      const path = await generateProposal({ title, client, sections, priceNote });
      return `Proposal saved to ${path} — deliver it with send_document.`;
    } catch (e) {
      return `generate_proposal failed: ${(e as Error)?.message ?? String(e)}`;
    }
  },
};
