import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  TabStopPosition,
  TabStopType,
  TextRun,
} from 'docx';
import { config } from '../config.js';

/**
 * Branded, client-facing proposal generation. Builds a premium .docx styled with
 * the ACRED brand system (from the KB) and returns the saved path — ready for the
 * send_document tool so Shivani can deliver it over WhatsApp.
 *
 * Brand system (KB §19):
 *   Palette — Paper #EDE9E1, Ink #1C1B18, Concrete #87827A, Line #D8D2C8, Clay #9A4A30
 *             (with a warm gold accent used in documents).
 *   Type    — Fraunces (display) + Manrope (body).
 *   Line    — "One firm for the entire life of a property."
 */

// ── Brand tokens (docx wants bare hex, no leading '#') ──────────────────────────
const PAPER = 'EDE9E1';
const INK = '1C1B18';
const CONCRETE = '87827A';
const LINE = 'D8D2C8';
const CLAY = '9A4A30';
const GOLD = 'B0894A'; // warm gold accent used sparingly on the commercials block
const CLAY_TINT = 'F2E7E1'; // pale clay wash behind the investment note

const DISPLAY_FONT = 'Fraunces';
const BODY_FONT = 'Manrope';

const POSITIONING_LINE = 'One firm for the entire life of a property.';
const VERTICALS_LINE = 'Architecture · Construction · Real Estate · Engineering · Development';

const PROPOSALS_DIR = join(config.DATA_DIR, 'proposals');

export interface ProposalSection {
  /** Optional section heading (rendered in Fraunces / Clay). */
  heading?: string;
  /** Section prose; blank lines separate paragraphs. */
  body?: string;
  /** Optional bullet list. */
  bullets?: string[];
}

export interface ProposalInput {
  /** Proposal title, e.g. "Design-Build Proposal — Villa at Devanahalli". */
  title: string;
  /** Who the proposal is prepared for (person or company). */
  client: string;
  /** Ordered content sections. */
  sections: ProposalSection[];
  /** Optional commercials/pricing note, highlighted in its own block. */
  priceNote?: string;
}

function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return s || 'proposal';
}

/** Filesystem-safe timestamp, e.g. 2026-07-10_14-05-33. */
function stamp(): string {
  return new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
}

/** Long, human date for the cover, e.g. "10 July 2026". */
function coverDate(): string {
  try {
    return new Date().toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: config.TZ,
    });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Body prose → Manrope paragraphs; blank lines split paragraphs. */
function bodyToParagraphs(body: string): Paragraph[] {
  return body
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map(
      (b) =>
        new Paragraph({
          spacing: { after: 160, line: 300 },
          children: [new TextRun({ text: b, font: BODY_FONT, size: 22, color: INK })],
        }),
    );
}

/** A Clay accent bullet (Manrope body, Clay marker). */
function bulletParagraph(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80, line: 288 },
    children: [new TextRun({ text, font: BODY_FONT, size: 22, color: INK })],
  });
}

/** Section heading — Fraunces in Clay with a thin Line underline. */
function headingParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 360, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 6 } },
    children: [new TextRun({ text, font: DISPLAY_FONT, size: 30, color: CLAY, bold: true })],
  });
}

/** The commercials block: gold-edged, pale-clay wash, Fraunces label. */
function priceBlock(priceNote: string): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({
      spacing: { before: 400, after: 0 },
      shading: { type: ShadingType.SOLID, color: 'auto', fill: CLAY_TINT },
      border: { left: { style: BorderStyle.SINGLE, size: 24, color: GOLD, space: 12 } },
      children: [
        new TextRun({
          text: 'Investment',
          font: DISPLAY_FONT,
          size: 26,
          color: CLAY,
          bold: true,
        }),
      ],
    }),
  ];
  const parts = priceNote
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const body = parts.length ? parts : [priceNote.trim()];
  for (const p of body) {
    out.push(
      new Paragraph({
        spacing: { after: 120, line: 300 },
        shading: { type: ShadingType.SOLID, color: 'auto', fill: CLAY_TINT },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: GOLD, space: 12 } },
        children: [new TextRun({ text: p, font: BODY_FONT, size: 22, color: INK })],
      }),
    );
  }
  return out;
}

/** Cover header: wordmark, positioning + verticals lines, Clay rule, then title block. */
function coverBlock(title: string, client: string): Paragraph[] {
  return [
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: 'ACRED',
          font: DISPLAY_FONT,
          size: 44,
          color: CLAY,
          bold: true,
          characterSpacing: 60,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 20 },
      children: [
        new TextRun({
          text: POSITIONING_LINE,
          font: BODY_FONT,
          size: 20,
          color: CONCRETE,
          italics: true,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: CLAY, space: 10 } },
      children: [
        new TextRun({ text: VERTICALS_LINE, font: BODY_FONT, size: 15, color: CONCRETE }),
      ],
    }),
    new Paragraph({
      spacing: { before: 320, after: 60 },
      children: [
        new TextRun({
          text: 'PROPOSAL',
          font: BODY_FONT,
          size: 18,
          color: CLAY,
          bold: true,
          characterSpacing: 80,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 160 },
      children: [
        new TextRun({ text: title, font: DISPLAY_FONT, size: 52, color: INK, bold: true }),
      ],
    }),
    new Paragraph({
      spacing: { after: 20 },
      children: [
        new TextRun({ text: 'Prepared for ', font: BODY_FONT, size: 24, color: CONCRETE }),
        new TextRun({ text: client, font: BODY_FONT, size: 24, color: INK, bold: true }),
      ],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: coverDate(), font: BODY_FONT, size: 20, color: CONCRETE })],
    }),
  ];
}

/** Page footer: positioning line left, page number + acred.in right, over a Line rule. */
function brandFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 8 } },
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          new TextRun({ text: POSITIONING_LINE, font: BODY_FONT, size: 16, color: CONCRETE }),
          new TextRun({ text: '\tacred.in · ', font: BODY_FONT, size: 16, color: CLAY }),
          new TextRun({ children: [PageNumber.CURRENT], font: BODY_FONT, size: 16, color: CONCRETE }),
        ],
      }),
    ],
  });
}

/**
 * Build a branded ACRED proposal .docx and return the absolute file path.
 * Falls back gracefully on missing fields; never throws on empty sections.
 */
export async function generateProposal(input: ProposalInput): Promise<string> {
  await mkdir(PROPOSALS_DIR, { recursive: true });

  const title = (input.title ?? '').trim() || 'Proposal';
  const client = (input.client ?? '').trim() || 'Valued Client';
  const sections = Array.isArray(input.sections) ? input.sections : [];

  const children: Paragraph[] = [...coverBlock(title, client)];

  for (const section of sections) {
    if (section?.heading) children.push(headingParagraph(section.heading));
    if (section?.body) children.push(...bodyToParagraphs(section.body));
    for (const bullet of section?.bullets ?? []) {
      if (bullet) children.push(bulletParagraph(bullet));
    }
  }

  const priceNote = (input.priceNote ?? '').trim();
  if (priceNote) children.push(...priceBlock(priceNote));

  const doc = new Document({
    creator: 'ACRED',
    title,
    description: `Proposal prepared for ${client}`,
    background: { color: PAPER },
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 22, color: INK } },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1440, right: 1080, bottom: 1440, left: 1080 } },
        },
        footers: { default: brandFooter() },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const path = resolve(PROPOSALS_DIR, `${slugify(title)}-${slugify(client)}-${stamp()}.docx`);
  await writeFile(path, buffer);
  return path;
}
