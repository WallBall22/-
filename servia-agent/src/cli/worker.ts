/** Runs only the background job worker (for deployments that split web and worker processes). */
import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { createDatabase } from '../database/client.js';
import { createLogger } from '../observability/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = createDatabase(config.database.url, config.database.poolMax);
const services = createServices(config, database, logger);

services.worker.start();
const stop = async () => {
  await services.worker.stop();
  await database.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
