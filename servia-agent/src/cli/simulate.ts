/**
 * Local simulator: runs a message through the full pipeline and prints the proposed reply. Never sends anything.
 *
 *   npm run simulate -- --channel whatsapp --sender test-1 "بكام الخدمة؟"
 *   npm run simulate -- --channel instagram            # interactive mode
 *
 * Works without any external credentials when AI_PROVIDER=offline.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { createDatabase, runMigrations } from '../database/client.js';
import { CHANNELS, type Channel } from '../database/schema.js';
import { reloadKnowledge } from '../knowledge/reload.js';
import { createLogger } from '../observability/logger.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: 'string', default: 'whatsapp' },
    sender: { type: 'string', default: `simulator-${process.pid}` },
  },
});
const channel = values.channel as Channel;
if (!CHANNELS.includes(channel)) {
  console.error(`--channel must be one of: ${CHANNELS.join(', ')}`);
  process.exit(2);
}

const config = loadConfig();
const logger = createLogger(process.env.LOG_LEVEL ?? 'warn');
const database = createDatabase(config.database.url, 2);
// The simulator never sends: no channel adapters are created.
const services = createServices(config, database, logger, { adapters: new Map() });

async function ask(text: string): Promise<void> {
  const result = await services.simulator.run({ channel, senderId: values.sender!, text });
  console.log(`\nSERVIA (${result.status}${result.handoff ? ', handed off to team' : ''}):\n${result.reply ?? '(no reply)'}`);
  if (result.sourceIds.length) console.log(`sources: ${result.sourceIds.join(', ')}`);
}

try {
  await runMigrations(database.db);
  await reloadKnowledge(database.db, config.knowledge.dir, logger);
  console.log(`Simulator — channel=${channel} sender=${values.sender} provider=${config.ai.provider}. Nothing is sent.`);
  if (positionals.length > 0) {
    await ask(positionals.join(' '));
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = await rl.question('\nYou: ').catch(() => null);
      if (line === null || line.trim() === '/exit') break;
      await ask(line);
    }
    rl.close();
  }
} finally {
  await database.close();
}
