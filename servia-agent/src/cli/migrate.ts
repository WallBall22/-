import { loadConfig } from '../config/env.js';
import { createDatabase, runMigrations } from '../database/client.js';
import { createLogger } from '../observability/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const handle = createDatabase(config.database.url, 2);

try {
  await runMigrations(handle.db);
  logger.info('migrations applied');
} catch (error) {
  logger.error({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await handle.close();
}
