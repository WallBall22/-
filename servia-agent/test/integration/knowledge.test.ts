import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgKnowledgeSearch } from '../../src/knowledge/repository.js';
import { reloadKnowledge } from '../../src/knowledge/reload.js';
import { openTestDb, resetData } from '../helpers/db.js';

const handle = openTestDb();
const search = new PgKnowledgeSearch(handle.db);
const opts = { topK: 4, minRank: 0.01 };
const KNOWLEDGE_DIR = join(import.meta.dirname, '..', '..', 'knowledge');

beforeAll(async () => {
  await resetData(handle);
  await reloadKnowledge(handle.db, KNOWLEDGE_DIR);
});
afterAll(() => handle.close());

const topDocs = async (q: string) => (await search.search(q, opts)).map((p) => p.documentSlug);

describe('full-text retrieval over the shipped SERVIA knowledge base', () => {
  it('finds the pricing policy for English and Arabic price questions', async () => {
    expect((await topDocs('How much does it cost?'))[0]).toBe('pricing-and-commercial-policies');
    expect((await topDocs('What are your prices?'))[0]).toBe('pricing-and-commercial-policies');
    expect((await topDocs('بكام الخدمة؟'))[0]).toBe('pricing-and-commercial-policies');
    expect((await topDocs('الأسعار كام'))[0]).toBe('pricing-and-commercial-policies');
  });

  it('finds the AI receptionist service', async () => {
    const docs = await topDocs('What is the AI receptionist?');
    expect(docs.slice(0, 2)).toEqual(expect.arrayContaining(['services']));
    const ar = await topDocs('ايه هو موظف الاستقبال الذكي؟');
    expect(ar).toContain('services');
  });

  it('finds contact information', async () => {
    expect((await topDocs('what is your website'))[0]).toBe('contact');
    expect(await topDocs('الموقع الإلكتروني')).toContain('contact');
  });

  it('finds the medical advice policy', async () => {
    expect(await topDocs('can you give me medical advice?')).toContain('faq');
  });

  it('returns nothing for greetings and unrelated questions', async () => {
    expect(await search.search('hi', opts)).toEqual([]);
    expect(await search.search('اهلا', opts)).toEqual([]);
    expect(await search.search('weather forecast tomorrow in Paris', opts)).toEqual([]);
  });

  it('never returns owner notes or keyword lines', async () => {
    const all = await handle.db.execute<{ content: string }>(sql`SELECT content FROM knowledge_chunks`);
    for (const row of all.rows) {
      expect(row.content).not.toMatch(/OWNER TODO/);
      expect(row.content).not.toMatch(/Keywords:|كلمات مفتاحية/);
    }
  });

  it('respects topK and the rank threshold', async () => {
    expect((await search.search('SERVIA clinics', { topK: 2, minRank: 0 })).length).toBe(2);
    expect(await search.search('SERVIA clinics', { topK: 4, minRank: 1_000 })).toEqual([]);
  });

  it('records stable passage ids', async () => {
    const [first] = await search.search('pricing', opts);
    expect(first!.id).toMatch(/^pricing-and-commercial-policies#\d+$/);
  });
});

describe('reloadKnowledge', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    await resetData(handle);
  });

  it('updates changed files, keeps unchanged ones, removes deleted ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'servia-reload-'));
    dirs.push(dir);
    await writeFile(join(dir, 'a.md'), '# A\n\n## One\n\nalpha content');
    await writeFile(join(dir, 'b.md'), '# B\n\n## One\n\nbravo content');
    const first = await reloadKnowledge(handle.db, dir);
    expect(first.removed.length).toBeGreaterThan(0); // the shipped documents from the previous suite
    expect(first.updated.sort()).toEqual(['a', 'b']);

    await writeFile(join(dir, 'a.md'), '# A\n\n## One\n\nalpha changed content');
    await rm(join(dir, 'b.md'));
    const second = await reloadKnowledge(handle.db, dir);
    expect(second).toMatchObject({ updated: ['a'], unchanged: [], removed: ['b'] });
    expect(await topDocs('changed')).toEqual(['a']);
    expect(await search.search('bravo', opts)).toEqual([]);
  });

  it('refuses to wipe the knowledge base when the directory is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'servia-reload-'));
    dirs.push(dir);
    await expect(reloadKnowledge(handle.db, dir)).rejects.toThrow(/refusing/);
    expect((await topDocs('alpha')).length).toBe(1);
  });
});
