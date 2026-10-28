import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { openTestDb } from '../helpers/db.js';

const handle = openTestDb();
afterAll(() => handle.close());

describe('migrations from a clean database', () => {
  it('creates every table and seeds the three channels', async () => {
    const tables = await handle.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
    `);
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'agent_settings',
      'channels',
      'contacts',
      'conversations',
      'jobs',
      'knowledge_chunks',
      'knowledge_documents',
      'messages',
      'webhook_events',
    ]);
    const channels = await handle.db.execute<{ id: string }>(sql`SELECT id FROM channels ORDER BY id::text`);
    expect(channels.rows.map((r) => r.id)).toEqual(['instagram', 'messenger', 'whatsapp']);
  });

  it('generates the full-text search vector from normalized content', async () => {
    const doc = await handle.db.execute<{ id: string }>(sql`
      INSERT INTO knowledge_documents (slug, title, source_path, content_hash)
      VALUES ('t', 'T', 't.md', 'h') RETURNING id
    `);
    const docId = doc.rows[0]!.id;
    await handle.db.execute(sql`
      INSERT INTO knowledge_chunks (id, document_id, chunk_index, heading, content, normalized_content)
      VALUES ('t#0', ${docId}, 0, 'h', 'raw', 'clinic receptionist')
    `);
    const hit = await handle.db.execute<{ id: string }>(sql`
      SELECT id FROM knowledge_chunks WHERE search_vector @@ to_tsquery('simple', 'receptionist')
    `);
    expect(hit.rows).toEqual([{ id: 't#0' }]);
    await handle.db.execute(sql`DELETE FROM knowledge_documents WHERE slug = 't'`);
  });
});
