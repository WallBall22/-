import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { parseMarkdown, sectionsFromText, type KnowledgeSection } from './chunker.js';

export interface LoadedDocument {
  slug: string;
  title: string;
  sourcePath: string;
  contentHash: string;
  sections: KnowledgeSection[];
}

export interface LoadResult {
  documents: LoadedDocument[];
  warnings: string[];
}

const SUPPORTED = new Set(['.md', '.pdf']);

/** `07-pricing-and-commercial-policies.md` → `pricing-and-commercial-policies`. */
export function slugFromFilename(file: string): string {
  return basename(file, extname(file))
    .toLowerCase()
    .replace(/^\d+[-_ ]*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isIgnored(file: string): boolean {
  return file.startsWith('_') || file.startsWith('.') || file.toLowerCase() === 'readme.md';
}

async function extractPdfPages(buffer: Buffer): Promise<{ num: number; text: string }[]> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.pages.map((p) => ({ num: p.num, text: p.text }));
  } finally {
    await parser.destroy();
  }
}

/** Reads every supported file in the knowledge directory and parses it into passages. */
export async function loadKnowledgeDirectory(dir: string): Promise<LoadResult> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && SUPPORTED.has(extname(e.name).toLowerCase()) && !isIgnored(e.name))
    .map((e) => e.name)
    .sort();

  const documents: LoadedDocument[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const path = join(dir, file);
    const slug = slugFromFilename(file);
    if (!slug) {
      warnings.push(`${file}: cannot derive a document id from the file name; skipped`);
      continue;
    }
    if (seen.has(slug)) {
      warnings.push(`${file}: duplicate document id "${slug}"; skipped`);
      continue;
    }
    seen.add(slug);
    const buffer = await readFile(path);
    const contentHash = createHash('sha256').update(buffer).digest('hex');

    if (extname(file).toLowerCase() === '.md') {
      const parsed = parseMarkdown(buffer.toString('utf8'), slug);
      if (parsed.sections.length === 0) warnings.push(`${file}: no content after removing owner notes`);
      documents.push({ slug, title: parsed.title, sourcePath: file, contentHash, sections: parsed.sections });
      continue;
    }

    try {
      const pages = await extractPdfPages(buffer);
      const title = basename(file, extname(file));
      const sections: KnowledgeSection[] = [];
      for (const page of pages) {
        if (page.text.trim().length < 20) {
          warnings.push(`${file}: page ${page.num} has no extractable text (scanned image?)`);
          continue;
        }
        sections.push(...sectionsFromText(page.text, `${title} (page ${page.num})`));
      }
      documents.push({ slug, title, sourcePath: file, contentHash, sections });
    } catch (error) {
      warnings.push(`${file}: could not read PDF (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return { documents, warnings };
}
