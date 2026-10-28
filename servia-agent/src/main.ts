import { loadConfig } from './config/env.js';
import { createServices } from './container.js';
import { createDatabase, runMigrations } from './database/client.js';
import { buildApp } from './http/app.js';
import { reloadKnowledge } from './knowledge/reload.js';
import { createLogger } from './observability/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = createDatabase(config.database.url, config.database.poolMax);

if (config.startup.runMigrations) {
  await runMigrations(database.db);
  logger.info('database migrations applied');
}
if (config.startup.reloadKnowledge) {
  try {
    await reloadKnowledge(database.db, config.knowledge.dir, logger);
  } catch (error) {
    // Keep serving with the last stored knowledge; /ready reports if none exists.
    logger.error({ err: error }, 'knowledge reload at startup failed');
  }
}

const services = createServices(config, database, logger);
const app = await buildApp(services);

if (services.adapters.size === 0) logger.warn('no messaging channels are enabled; only the simulator and admin API will work');
if (config.worker.enabled) services.worker.start();

await app.listen({ host: config.host, port: config.port });
logger.info({ channels: [...services.adapters.keys()], aiProvider: config.ai.provider }, 'SERVIA agent started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), 25_000);
  try {
    await app.close();
    await services.worker.stop();
    await database.close();
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
