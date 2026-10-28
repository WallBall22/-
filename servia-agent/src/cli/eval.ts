/**
 * Runs the evaluation dataset against the agent with the configured provider and knowledge base.
 *   AI_PROVIDER=offline npm run eval          # retrieval and policy checks, no credentials
 *   AI_PROVIDER=openai  npm run eval          # the real model (uses API credits)
 *   npm run eval -- --verbose                 # print every reply
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { createDatabase, runMigrations } from '../database/client.js';
import { loadEvalCases, runEval } from '../eval/runner.js';
import { reloadKnowledge } from '../knowledge/reload.js';
import { createLogger } from '../observability/logger.js';

const { values } = parseArgs({
  options: { dataset: { type: 'string', default: join('eval', 'dataset.json') }, verbose: { type: 'boolean', default: false } },
});
const config = loadConfig();
const logger = createLogger(process.env.LOG_LEVEL ?? 'warn');
const database = createDatabase(config.database.url, 2);

try {
  await runMigrations(database.db);
  await reloadKnowledge(database.db, config.knowledge.dir, logger);
  const services = createServices(config, database, logger, { adapters: new Map() });
  const results = await runEval(services.agent, await loadEvalCases(values.dataset!));
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id}${r.passed ? '' : `\n      - ${r.failures.join('\n      - ')}`}`);
    if (values.verbose || !r.passed) {
      console.log(`      reply: ${r.reply.text.replace(/\n/g, ' ')}\n      sources: ${r.reply.sourceIds.join(', ') || '-'}`);
    }
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} passed (provider: ${config.ai.provider})`);
  if (passed !== results.length) process.exitCode = 1;
} finally {
  await database.close();
}
