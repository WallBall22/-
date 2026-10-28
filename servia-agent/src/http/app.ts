import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Services } from '../container.js';
import { pingDatabase } from '../database/client.js';
import { registerWebhookRoutes } from '../webhooks/routes.js';
import { registerAdminRoutes } from './admin.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { config, logger, database } = services;

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Fastify's default request log includes the query string, which carries hub.verify_token. We log our own.
    disableRequestLogging: true,
    bodyLimit: config.http.bodyLimit,
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  // Keep the exact bytes for webhook signature checks, then parse JSON ourselves.
  app.decorateRequest('rawBody', undefined);
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;
    if (buffer.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch {
      const error = new Error('Request body is not valid JSON') as FastifyError;
      error.statusCode = 400;
      error.code = 'invalid_json';
      done(error, undefined);
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: config.http.rateLimitMax,
    timeWindow: config.http.rateLimitWindowMs,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { method: request.method, path: request.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request completed',
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    void reply.code(status).send(
      status >= 500
        ? { error: 'internal_error', requestId: request.id }
        : { error: error.code ?? 'bad_request', message: error.message, requestId: request.id },
    );
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ error: 'not_found', requestId: request.id });
  });

  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const db = await pingDatabase(database.pool);
    let knowledgePassages = 0;
    if (db) {
      const rows = await database.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM knowledge_chunks`);
      knowledgePassages = rows.rows[0]?.n ?? 0;
    }
    const ready = db && knowledgePassages > 0;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      database: db,
      knowledgePassages,
      channels: [...services.adapters.keys()],
    });
  });

  registerWebhookRoutes(app, services);
  await registerAdminRoutes(app, services);
  return app;
}
