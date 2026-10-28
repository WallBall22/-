import type { FastifyInstance } from 'fastify';
import type { Services } from '../container.js';

/**
 * Registers GET (subscription handshake) and POST (events) for each enabled channel.
 * Disabled channels have no routes and answer 404.
 */
export function registerWebhookRoutes(app: FastifyInstance, services: Services): void {
  const { adapters, repository, limits } = services;

  for (const [channel, adapter] of adapters) {
    const path = `/webhooks/${channel}`;

    app.get(path, async (request, reply) => {
      const challenge = adapter.verifySubscription(request.query as Record<string, unknown>);
      if (challenge === null) {
        request.log.warn({ channel }, 'webhook verification rejected');
        return reply.code(403).send({ error: 'verification_failed' });
      }
      // Meta expects the raw challenge value as the body, not JSON.
      return reply.code(200).type('text/plain').send(challenge);
    });

    app.post(path, async (request, reply) => {
      const raw = request.rawBody;
      if (!raw || !adapter.verifySignature(raw, request.headers['x-hub-signature-256'] as string | undefined)) {
        request.log.warn({ channel }, 'webhook signature rejected');
        return reply.code(401).send({ error: 'invalid_signature' });
      }

      const parsed = adapter.parse(request.body);
      const outcomes: Record<string, number> = {};
      // Stored before acknowledging: if this throws, the 5xx makes Meta retry and dedupe absorbs repeats.
      for (const message of parsed.messages) {
        const result = await repository.ingest(message, limits);
        outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
      }
      let statuses = 0;
      for (const status of parsed.statuses) {
        if (await repository.applyDeliveryStatus(status)) statuses += 1;
      }
      request.log.info(
        { channel, messages: parsed.messages.length, outcomes, statuses, ignored: parsed.ignored },
        'webhook processed',
      );
      return reply.code(200).type('text/plain').send('EVENT_RECEIVED');
    });
  }
}
