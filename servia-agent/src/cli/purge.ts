/**
 * Data retention and deletion.
 *   npm run data:purge                          # delete conversations idle longer than RETENTION_DAYS
 *   npm run data:purge -- --days 90
 *   npm run data:purge -- --contact <uuid>      # delete one contact and all their messages
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/env.js';
import { ConversationRepository } from '../conversations/repository.js';
import { createDatabase } from '../database/client.js';

const { values } = parseArgs({ options: { days: { type: 'string' }, contact: { type: 'string' } } });
const config = loadConfig();
const database = createDatabase(config.database.url, 2);
const repository = new ConversationRepository(database.db);

try {
  if (values.contact) {
    const deleted = await repository.deleteContact(values.contact);
    console.log(deleted ? `Deleted contact ${values.contact} and all their data.` : 'Contact not found.');
  } else {
    const days = values.days ? Number(values.days) : config.conversation.retentionDays;
    if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
    const result = await repository.purgeOlderThan(days);
    console.log(`Purged data older than ${days} days:`, result);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.close();
}
