import { loadConfig } from '../config/env.js';
import { createDatabase } from '../database/client.js';
import { reloadKnowledge } from '../knowledge/reload.js';
import { createLogger } from '../observability/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const handle = createDatabase(config.database.url, 2);

try {
  const result = await reloadKnowledge(handle.db, config.knowledge.dir, logger);
  console.log(
    `Knowledge reloaded: ${result.documents} documents, ${result.chunks} passages ` +
      `(${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.removed.length} removed).`,
  );
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
} catch (error) {
  logger.error({ err: error }, 'knowledge reload failed');
  process.exitCode = 1;
} finally {
  await handle.close();
}
