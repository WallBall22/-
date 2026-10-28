import pg from 'pg';
import { createDatabase, runMigrations } from '../../src/database/client.js';
import { TEST_DATABASE_URL } from './db.js';

/**
 * Rebuilds the test database from a clean schema and applies every migration,
 * which also proves migrations work from scratch.
 */
export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${TEST_DATABASE_URL.replace(/:[^:@/]+@/, ':****@')}. ` +
        'Start it with `docker compose up -d db` (see README) or set TEST_DATABASE_URL.',
      { cause: error },
    );
  }
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  await client.end();

  const handle = createDatabase(TEST_DATABASE_URL, 2);
  try {
    await runMigrations(handle.db);
  } finally {
    await handle.close();
  }
}
