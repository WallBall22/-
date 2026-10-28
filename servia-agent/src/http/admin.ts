import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from '../container.js';
import { CHANNELS } from '../database/schema.js';
import { reloadKnowledge } from '../knowledge/reload.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Bearer-token check in constant time (both sides hashed to equal length first). */
export function makeAdminAuth(token: string) {
  const expected = digest(token);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!supplied || !timingSafeEqual(digest(supplied), expected)) {
      request.log.warn('admin authentication failed');
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

const idParams = z.object({ id: z.uuid() });
const statusQuery = z.object({ status: z.enum(['open', 'handoff', 'closed']).default('handoff') });
const statusBody = z.object({ status: z.enum(['open', 'handoff', 'closed']), reason: z.string().max(200).optional() });
const purgeBody = z.object({ days: z.number().int().min(1).max(3650).optional() }).default({});
const simulateBody = z.object({
  channel: z.enum(CHANNELS),
  senderId: z.string().min(1).max(64),
  message: z.string().max(5_000),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({ error: 'invalid_request', issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  return null;
}

/**
 * Administrative endpoints. Registered only when ADMIN_API_TOKEN is set; every route requires it.
 * The simulator additionally requires SIMULATOR_ENABLED=true.
 */
export async function registerAdminRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { config, repository, database, simulator, logger } = services;
  if (!config.admin.token) return;
  const auth = makeAdminAuth(config.admin.token);

  await app.register(async (admin) => {
    admin.addHook('onRequest', auth);

    admin.post('/admin/knowledge/reload', async () => {
      const result = await reloadKnowledge(database.db, config.knowledge.dir, logger);
      return result;
    });

    admin.get('/admin/conversations', async (request, reply) => {
      const q = parse(statusQuery, request.query, reply);
      if (!q) return reply;
      return { conversations: await repository.listByStatus(q.status) };
    });

    admin.get('/admin/conversations/:id/messages', async (request, reply) => {
      const p = parse(idParams, request.params, reply);
      if (!p) return reply;
      return { messages: await repository.transcript(p.id) };
    });

    admin.post('/admin/conversations/:id/status', async (request, reply) => {
      const p = parse(idParams, request.params, reply);
      const b = p && parse(statusBody, request.body, reply);
      if (!p || !b) return reply;
      const ok = await repository.setStatus(p.id, b.status, b.reason ?? 'admin');
      return ok ? { id: p.id, status: b.status } : reply.code(404).send({ error: 'not_found' });
    });

    admin.delete('/admin/contacts/:id', async (request, reply) => {
      const p = parse(idParams, request.params, reply);
      if (!p) return reply;
      return (await repository.deleteContact(p.id)) ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
    });

    admin.post('/admin/retention/purge', async (request, reply) => {
      const b = parse(purgeBody, request.body ?? {}, reply);
      if (!b) return reply;
      return repository.purgeOlderThan(b.days ?? config.conversation.retentionDays);
    });

    admin.get('/admin/stats', async () => {
      const rows = await database.db.execute<{ metric: string; value: number }>(sql`
        SELECT 'jobs_pending' AS metric, count(*)::int AS value FROM jobs WHERE status = 'pending'
        UNION ALL SELECT 'jobs_failed', count(*)::int FROM jobs WHERE status = 'failed'
        UNION ALL SELECT 'handoff_conversations', count(*)::int FROM conversations WHERE status = 'handoff'
        UNION ALL SELECT 'replies_failed_24h', count(*)::int FROM messages
          WHERE direction = 'outbound' AND delivery_status = 'failed' AND created_at > now() - interval '24 hours'
        UNION ALL SELECT 'input_tokens_24h', coalesce(sum(input_tokens), 0)::int FROM messages WHERE created_at > now() - interval '24 hours'
        UNION ALL SELECT 'output_tokens_24h', coalesce(sum(output_tokens), 0)::int FROM messages WHERE created_at > now() - interval '24 hours'
      `);
      return Object.fromEntries(rows.rows.map((r) => [r.metric, r.value]));
    });

    if (config.admin.simulatorEnabled) {
      admin.post('/simulate', async (request, reply) => {
        const b = parse(simulateBody, request.body, reply);
        if (!b) return reply;
        return simulator.run({ channel: b.channel, senderId: b.senderId, text: b.message });
      });
    }
  });
}
