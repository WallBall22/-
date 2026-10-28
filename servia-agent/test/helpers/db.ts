import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '../../src/database/client.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://servia:servia@localhost:5432/servia_test';

/** Opens a handle to the migrated test database (migrations run once in global setup). */
export function openTestDb(): DatabaseHandle {
  return createDatabase(TEST_DATABASE_URL, 5);
}

/** Empties every data table but keeps the seeded `channels` rows. */
export async function resetData(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(sql`
    TRUNCATE messages, conversations, contacts, webhook_events, jobs,
             knowledge_chunks, knowledge_documents, agent_settings
    RESTART IDENTITY CASCADE
  `);
}
