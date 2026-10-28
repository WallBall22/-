import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMarkdown, stripOwnerNotes } from '../../src/knowledge/chunker.js';
import { loadKnowledgeDirectory, slugFromFilename } from '../../src/knowledge/loader.js';
import { buildTsQuery, detectLanguage, normalizeForIndex, tokenize } from '../../src/knowledge/normalize.js';
import { makePdf } from '../helpers/pdf.js';

describe('normalization', () => {
  it('removes diacritics, tatweel and unifies letter variants', () => {
    expect(tokenize('أَسْعَار')).toEqual(['اسعار']);
    expect(tokenize('ســعر')).toEqual(['سعر']);
    expect(tokenize('العيادة')).toEqual(tokenize('عياده'));
    expect(tokenize('مستشفى')).toEqual(['مستشفي']);
  });

  it('strips the Arabic definite article only when a stem remains', () => {
    expect(tokenize('الأسعار')).toEqual(['اسعار']);
    expect(tokenize('بالعيادات')).toEqual(['عيادات']);
    expect(tokenize('الى')).toEqual([]); // stopword
  });

  it('drops English and Egyptian stopwords and simple plurals', () => {
    expect(tokenize('What are your prices for clinics?')).toEqual(['price', 'clinic']);
    expect(tokenize('انا عايز اعرف السعر')).toEqual(['اعرف', 'سعر']);
  });

  it('converts Arabic-Indic digits', () => {
    expect(tokenize('٥٠٠ جنيه')).toEqual(['500', 'جنيه']);
  });

  it('builds a safe OR prefix query, or null for nothing searchable', () => {
    expect(buildTsQuery('AI receptionist price')).toBe('ai | receptionist:* | price:*');
    expect(buildTsQuery('hi, thanks!!')).toBeNull();
    expect(buildTsQuery("'); DROP TABLE x; --")).toBe('drop:* | table:*');
    expect(buildTsQuery('a:* & b | !c')).toBeNull();
  });

  it('indexes the same tokens the query uses', () => {
    expect(normalizeForIndex('The AI Receptionist')).toBe('ai receptionist');
  });

  it('detects Arabic vs English', () => {
    expect(detectLanguage('بكام الباقة؟')).toBe('ar');
    expect(detectLanguage('How much?')).toBe('en');
    expect(detectLanguage('عايز AI receptionist')).toBe('en');
    expect(detectLanguage('عايز اعرف عن ai')).toBe('ar');
  });
});

describe('markdown chunking', () => {
  it('uses the H1 as title and H2s as sections, and drops owner notes', () => {
    const doc = parseMarkdown(
      '# Pricing\n\nIntro text.\n\n## Prices\n\nNot published.\n> OWNER TODO: add prices\n<!-- secret note -->\n\n## Discounts\n\nTeam only.',
      'fallback',
    );
    expect(doc.title).toBe('Pricing');
    expect(doc.sections).toEqual([
      { heading: 'Pricing', content: 'Intro text.' },
      { heading: 'Prices', content: 'Not published.' },
      { heading: 'Discounts', content: 'Team only.' },
    ]);
  });

  it('splits long sections on paragraph boundaries', () => {
    const para = 'word '.repeat(200).trim();
    const doc = parseMarkdown(`# T\n\n## Long\n\n${para}\n\n${para}\n\n${para}`, 'f');
    expect(doc.sections.length).toBeGreaterThan(1);
    for (const s of doc.sections) {
      expect(s.heading).toBe('Long');
      expect(s.content.length).toBeLessThanOrEqual(1_500);
    }
  });

  it('indexes Keywords lines without showing them', () => {
    const doc = parseMarkdown('# P\n\n## Prices\n\nNot published.\n\nKeywords: price, cost\nكلمات مفتاحية: السعر، بكام', 'f');
    expect(doc.sections).toEqual([{ heading: 'Prices', content: 'Not published.', keywords: 'price, cost السعر، بكام' }]);
  });

  it('stripOwnerNotes keeps ordinary quotes', () => {
    expect(stripOwnerNotes('> a customer quote\n> OWNER: hidden')).toBe('> a customer quote');
  });
});

describe('loadKnowledgeDirectory', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('loads Markdown and PDF, ignores README/underscore files, and reports scanned pages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'servia-kb-'));
    dirs.push(dir);
    await writeFile(join(dir, '01-overview.md'), '# Overview\n\n## About\n\nSERVIA helps clinics.');
    await writeFile(join(dir, 'README.md'), '# ignored');
    await writeFile(join(dir, '_draft.md'), '# ignored');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    await writeFile(join(dir, 'brochure.pdf'), makePdf(['SERVIA brochure page one text', '']));

    const { documents, warnings } = await loadKnowledgeDirectory(dir);
    expect(documents.map((d) => d.slug)).toEqual(['overview', 'brochure']); // file-name order
    const pdf = documents[1]!;
    expect(pdf.sections).toHaveLength(1);
    expect(pdf.sections[0]!.heading).toBe('brochure (page 1)');
    expect(pdf.sections[0]!.content).toContain('SERVIA brochure page one');
    expect(warnings.some((w) => w.includes('brochure.pdf') && w.includes('page 2'))).toBe(true);
  });

  it('reports unreadable PDFs instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'servia-kb-'));
    dirs.push(dir);
    await writeFile(join(dir, 'broken.pdf'), 'not a pdf');
    await writeFile(join(dir, 'ok.md'), '# OK\n\ntext');
    const { documents, warnings } = await loadKnowledgeDirectory(dir);
    expect(documents.map((d) => d.slug)).toEqual(['ok']);
    expect(warnings.some((w) => w.startsWith('broken.pdf'))).toBe(true);
  });

  it('derives slugs from file names', () => {
    expect(slugFromFilename('07-pricing-and-commercial-policies.md')).toBe('pricing-and-commercial-policies');
    expect(slugFromFilename('My Brochure 2026.pdf')).toBe('my-brochure-2026');
  });
});
