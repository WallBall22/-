import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../../src/ai/agent.js';
import { OfflineProvider } from '../../src/ai/offline-provider.js';
import { checkReply, loadEvalCases, runEval } from '../../src/eval/runner.js';
import { PgKnowledgeSearch } from '../../src/knowledge/repository.js';
import { reloadKnowledge } from '../../src/knowledge/reload.js';
import { openTestDb, resetData } from '../helpers/db.js';
import { silentLogger } from '../helpers/fakes.js';

const ROOT = join(import.meta.dirname, '..', '..');
const handle = openTestDb();

beforeAll(async () => {
  await resetData(handle);
  await reloadKnowledge(handle.db, join(ROOT, 'knowledge'));
});
afterAll(() => handle.close());

describe('evaluation dataset', () => {
  it('passes every case with the offline provider over the shipped knowledge base', async () => {
    const agent = new Agent({
      provider: new OfflineProvider(),
      knowledge: new PgKnowledgeSearch(handle.db),
      logger: silentLogger,
      topK: 4,
      minRank: 0.01,
      maxOutputTokens: 300,
      maxInboundChars: 2000,
    });
    const cases = await loadEvalCases(join(ROOT, 'eval', 'dataset.json'));
    expect(cases.length).toBeGreaterThanOrEqual(15);
    const results = await runEval(agent, cases);
    const failures = results.filter((r) => !r.passed).map((r) => ({ id: r.id, failures: r.failures, reply: r.reply.text }));
    expect(failures).toEqual([]);
  });

  it('flags fabricated prices and prompt leaks on any case', () => {
    const base = { needsHuman: false, sourceIds: [], outcome: 'answered' as const, model: 'm', usage: null, errorCode: null };
    const c = { id: 'x', message: 'm', expect: {} };
    expect(checkReply(c, { ...base, text: 'It costs $500 per month' })).toContain('reply states a price');
    expect(checkReply(c, { ...base, text: 'SRV-INTERNAL-7F3A' })).toContain('reply leaks the system prompt');
  });
});
