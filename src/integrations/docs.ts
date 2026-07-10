import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { config } from '../config.js';

/**
 * Lightweight document drafting. Builds a .docx (via the `docx` package) or a
 * Markdown file under <DATA_DIR>/docs and returns the saved path — ready to hand
 * to the send_document tool so Shivani can deliver it over WhatsApp.
 */

export interface DocSection {
  /** Optional section heading. */
  heading?: string;
  /** Section prose; blank lines separate paragraphs. */
  body?: string;
  /** Optional bullet list. */
  bullets?: string[];
}

const DOCS_DIR = join(config.DATA_DIR, 'docs');

function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'document';
}

/** Filesystem-safe timestamp, e.g. 2026-07-10_14-05-33. */
function stamp(): string {
  return new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
}

function bodyToParagraphs(body: string): Paragraph[] {
  return body
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => new Paragraph({ children: [new TextRun(b)] }));
}

/** Draft a Word .docx and return the absolute file path. */
export async function draftDocx(title: string, sections: DocSection[]): Promise<string> {
  await mkdir(DOCS_DIR, { recursive: true });

  const children: Paragraph[] = [
    new Paragraph({ text: title || 'Untitled', heading: HeadingLevel.TITLE }),
  ];
  for (const section of sections ?? []) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    }
    if (section.body) children.push(...bodyToParagraphs(section.body));
    for (const bullet of section.bullets ?? []) {
      if (bullet) children.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const path = resolve(DOCS_DIR, `${slugify(title)}-${stamp()}.docx`);
  await writeFile(path, buffer);
  return path;
}

/** Draft a Markdown document and return the absolute file path. */
export async function draftMarkdown(title: string, sections: DocSection[]): Promise<string> {
  await mkdir(DOCS_DIR, { recursive: true });

  const lines: string[] = [`# ${title || 'Untitled'}`, ''];
  for (const section of sections ?? []) {
    if (section.heading) lines.push(`## ${section.heading}`, '');
    if (section.body) lines.push(section.body.trim(), '');
    const bullets = (section.bullets ?? []).filter(Boolean);
    if (bullets.length) {
      for (const bullet of bullets) lines.push(`- ${bullet}`);
      lines.push('');
    }
  }

  const path = resolve(DOCS_DIR, `${slugify(title)}-${stamp()}.md`);
  await writeFile(path, `${lines.join('\n').trimEnd()}\n`, 'utf8');
  return path;
}
