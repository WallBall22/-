import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/channels/meta.js';
import { loadConfig } from '../../src/config/env.js';
import { createServices, type Services } from '../../src/container.js';
import { messages } from '../../src/database/schema.js';
import { buildApp } from '../../src/http/app.js';
import { reloadKnowledge } from '../../src/knowledge/reload.js';
import { openTestDb, resetData, TEST_DATABASE_URL } from '../helpers/db.js';
import { drain } from '../helpers/engine.js';
import { FakeProvider, silentLogger } from '../helpers/fakes.js';
import { igPayload, messengerPayload, waPayload } from '../helpers/payloads.js';

const ADMIN = 'a'.repeat(40);
const APP_SECRET = 'meta-app-secret';
const IG_SECRET = 'ig-app-secret';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  AI_PROVIDER: 'offline',
  KNOWLEDGE_DIR: join(import.meta.dirname, '..', '..', 'knowledge'),
  ADMIN_API_TOKEN: ADMIN,
  SIMULATOR_ENABLED: 'true',
  META_APP_SECRET: APP_SECRET,
  META_GRAPH_BASE_URL: 'https://graph.test',
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_VERIFY_TOKEN: 'wa-verify',
  WHATSAPP_ACCESS_TOKEN: 'wa-token',
  WHATSAPP_PHONE_NUMBER_ID: 'PN1',
  MESSENGER_ENABLED: 'true',
  MESSENGER_VERIFY_TOKEN: 'fb-verify',
  MESSENGER_PAGE_ACCESS_TOKEN: 'page-token',
  INSTAGRAM_ENABLED: 'true',
  INSTAGRAM_APP_SECRET: IG_SECRET,
  INSTAGRAM_VERIFY_TOKEN: 'ig-verify',
  INSTAGRAM_ACCESS_TOKEN: 'ig-token',
  INSTAGRAM_GRAPH_BASE_URL: 'https://graph.instagram.test',
  REQUEST_BODY_LIMIT_BYTES: '4096',
  RATE_LIMIT_MAX: '1000',
};

const handle = openTestDb();
const sentRequests: { url: string; body: unknown; auth: string }[] = [];
const fetchImpl: FetchLike = async (url, init) => {
  sentRequests.push({ url, body: JSON.parse(init.body as string), auth: String((init.headers as Record<string, string>).authorization) });
  const id = `out-${sentRequests.length}`;
  const body = url.includes('/PN1/') ? { messages: [{ id }] } : { recipient_id: 'r', message_id: id };
  return new Response(JSON.stringify(body), { status: 200 });
};

let app: FastifyInstance;
let services: Services;

beforeAll(async () => {
  await resetData(handle);
  const config = loadConfig(env);
  await reloadKnowledge(handle.db, config.knowledge.dir);
  services = createServices(config, handle, silentLogger, {
    fetchImpl,
    provider: FakeProvider.replying('SERVIA builds AI receptionists for clinics.'),
  });
  app = await buildApp(services);
});
afterAll(async () => {
  await app.close();
  await handle.close();
});
beforeEach(async () => {
  sentRequests.length = 0;
  await handle.db.delete(messages);
});

const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function post(path: string, payload: unknown, secret = APP_SECRET, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: path,
    payload: body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, secret), ...headers },
  });
}

const waText = (id: string, text: string) => waPayload('PN1', [{ from: '2011', id, timestamp: '1700000000', type: 'text', text: { body: text } }]);

describe('health and readiness', () => {
  it('reports health, readiness and enabled channels, with a request id', async () => {
    const health = await app.inject({ url: '/health', headers: { 'x-request-id': 'req-123' } });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-request-id']).toBe('req-123');
    const ready = await app.inject({ url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', database: true, channels: ['whatsapp', 'messenger', 'instagram'] });
    expect(ready.json().knowledgePassages).toBeGreaterThan(5);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await app.inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('webhook verification handshake', () => {
  it('echoes the challenge as plain text for a valid verify token', async () => {
    const res = await app.inject({
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=987654',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('987654');
  });

  it('rejects a wrong verify token', async () => {
    const res = await app.inject({ url: '/webhooks/messenger?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1' });
    expect(res.statusCode).toBe(403);
  });
});

describe('WhatsApp end to end', () => {
  it('stores, answers, and sends one reply even when Meta retries the webhook', async () => {
    const payload = waText('wamid.e2e1', 'What does SERVIA do?');
    expect((await post('/webhooks/whatsapp', payload)).statusCode).toBe(200);
    expect((await post('/webhooks/whatsapp', payload)).statusCode).toBe(200); // retry
    await drain(services.worker);
    expect((await post('/webhooks/whatsapp', payload)).statusCode).toBe(200); // late retry
    await drain(services.worker);

    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toMatchObject({
      url: 'https://graph.test/v25.0/PN1/messages',
      auth: 'Bearer wa-token',
      body: { to: '2011', type: 'text', text: { body: 'SERVIA builds AI receptionists for clinics.' } },
    });
    const rows = await handle.db.select().from(messages);
    expect(rows.filter((m) => m.direction === 'inbound')).toHaveLength(1);
    expect(rows.find((m) => m.direction === 'outbound')).toMatchObject({ deliveryStatus: 'sent', platformMessageId: 'out-1' });
  });

  it('applies delivery receipts from status webhooks', async () => {
    await post('/webhooks/whatsapp', waText('wamid.e2e2', 'hello SERVIA'));
    await drain(services.worker);
    const outId = sentRequests.length ? `out-${sentRequests.length}` : '';
    await post('/webhooks/whatsapp', waPayload('PN1', [], [{ id: outId, status: 'read' }]));
    const out = (await handle.db.select().from(messages)).find((m) => m.direction === 'outbound');
    expect(out?.deliveryStatus).toBe('read');
  });

  it('rejects invalid signatures and stores nothing', async () => {
    const res = await post('/webhooks/whatsapp', waText('wamid.bad', 'hi'), 'wrong-secret');
    expect(res.statusCode).toBe(401);
    const unsigned = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: JSON.stringify(waText('wamid.bad2', 'hi')),
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.statusCode).toBe(401);
    expect(await handle.db.select().from(messages)).toHaveLength(0);
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: '{not json',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('{not json') },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_json' });
    const big = await post('/webhooks/whatsapp', waText('wamid.big', 'x'.repeat(10_000)));
    expect(big.statusCode).toBe(413);
  });

  it('acknowledges valid but irrelevant events without storing anything', async () => {
    const res = await post('/webhooks/whatsapp', { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'account_update', value: {} }] }] });
    expect(res.statusCode).toBe(200);
    expect(await handle.db.select().from(messages)).toHaveLength(0);
  });
});

describe('Messenger and Instagram end to end', () => {
  it('answers a Messenger message through the Send API', async () => {
    const payload = messengerPayload('PAGE1', [
      { sender: { id: 'PSID9' }, recipient: { id: 'PAGE1' }, timestamp: Date.now(), message: { mid: 'm.e2e', text: 'services?' } },
    ]);
    expect((await post('/webhooks/messenger', payload)).statusCode).toBe(200);
    await drain(services.worker);
    expect(sentRequests[0]).toMatchObject({
      url: 'https://graph.test/v25.0/me/messages',
      auth: 'Bearer page-token',
      body: { recipient: { id: 'PSID9' }, messaging_type: 'RESPONSE' },
    });
  });

  it('answers an Instagram message using the Instagram app secret and host', async () => {
    const payload = igPayload('IG1', [
      { sender: { id: 'IGSID9' }, recipient: { id: 'IG1' }, timestamp: Date.now(), message: { mid: 'ig.e2e', text: 'مرحبا' } },
    ]);
    expect((await post('/webhooks/instagram', payload, APP_SECRET)).statusCode).toBe(401);
    expect((await post('/webhooks/instagram', payload, IG_SECRET)).statusCode).toBe(200);
    await drain(services.worker);
    expect(sentRequests[0]).toMatchObject({ url: 'https://graph.instagram.test/v25.0/me/messages', auth: 'Bearer ig-token' });
  });
});

describe('admin API', () => {
  const auth = { authorization: `Bearer ${ADMIN}` };

  it('requires the admin token', async () => {
    expect((await app.inject({ url: '/admin/conversations' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/admin/conversations', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/admin/conversations', headers: auth })).statusCode).toBe(200);
  });

  it('simulates a conversation without sending anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/simulate',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { channel: 'whatsapp', senderId: 'sim-user', message: 'What does SERVIA do?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'simulated', reply: 'SERVIA builds AI receptionists for clinics.' });
    expect(sentRequests).toHaveLength(0);
  });

  it('validates admin input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/simulate',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { channel: 'telegram', senderId: '', message: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ url: '/admin/conversations/not-a-uuid/messages', headers: auth })).statusCode).toBe(400);
  });

  it('lists, reopens and deletes conversations', async () => {
    await app.inject({
      method: 'POST',
      url: '/simulate',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { channel: 'whatsapp', senderId: 'handoff-user', message: 'I want to talk to a human' },
    });
    const list = await app.inject({ url: '/admin/conversations?status=handoff', headers: auth });
    const conv = list.json().conversations.find((c: { isSimulated: boolean }) => c.isSimulated);
    expect(conv).toBeDefined();

    const transcript = await app.inject({ url: `/admin/conversations/${conv.id}/messages`, headers: auth });
    expect(transcript.json().messages).toHaveLength(2);

    const reopen = await app.inject({
      method: 'POST',
      url: `/admin/conversations/${conv.id}/status`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { status: 'open' },
    });
    expect(reopen.json()).toEqual({ id: conv.id, status: 'open' });

    const del = await app.inject({ method: 'DELETE', url: `/admin/contacts/${conv.contactId}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/admin/contacts/${conv.contactId}`, headers: auth })).statusCode).toBe(404);
  });

  it('reports stats and reloads knowledge', async () => {
    expect((await app.inject({ url: '/admin/stats', headers: auth })).json()).toHaveProperty('jobs_pending');
    const reload = await app.inject({ method: 'POST', url: '/admin/knowledge/reload', headers: auth });
    expect(reload.statusCode).toBe(200);
    expect(reload.json().documents).toBeGreaterThan(5);
  });
});

describe('route availability depends on configuration', () => {
  it('has no routes for disabled channels, no admin without a token, and rate limits', async () => {
    const config = loadConfig({
      ...env,
      MESSENGER_ENABLED: 'false',
      INSTAGRAM_ENABLED: 'false',
      ADMIN_API_TOKEN: '',
      SIMULATOR_ENABLED: 'false',
      RATE_LIMIT_MAX: '3',
    });
    const limited = await buildApp(createServices(config, handle, silentLogger, { fetchImpl }));
    try {
      expect((await limited.inject({ url: '/webhooks/messenger' })).statusCode).toBe(404);
      expect((await limited.inject({ url: '/admin/conversations' })).statusCode).toBe(404);
      expect((await limited.inject({ method: 'POST', url: '/simulate' })).statusCode).toBe(404);
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) codes.push((await limited.inject({ url: '/webhooks/whatsapp' })).statusCode);
      expect(codes).toContain(429);
    } finally {
      await limited.close();
    }
  });
});
