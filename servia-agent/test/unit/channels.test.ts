import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InstagramAdapter } from '../../src/channels/instagram/adapter.js';
import { graphPost, verifyHubChallenge, verifyHubSignature, type FetchLike } from '../../src/channels/meta.js';
import { MessengerAdapter } from '../../src/channels/messenger/adapter.js';
import { fitToBytes, SendError } from '../../src/channels/types.js';
import { WhatsAppAdapter } from '../../src/channels/whatsapp/adapter.js';
import { igPayload, messengerPayload, waPayload } from '../helpers/payloads.js';

const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('Meta webhook security', () => {
  const body = JSON.stringify({ object: 'page', entry: [{ text: 'é ü 😀' }] });

  it('accepts a correct X-Hub-Signature-256 over the raw bytes', () => {
    expect(verifyHubSignature(Buffer.from(body), sign(body, 'app-secret'), 'app-secret')).toBe(true);
  });

  it('rejects wrong secrets, tampered bodies, malformed or missing headers', () => {
    const raw = Buffer.from(body);
    expect(verifyHubSignature(raw, sign(body, 'other'), 'app-secret')).toBe(false);
    expect(verifyHubSignature(Buffer.from(`${body} `), sign(body, 'app-secret'), 'app-secret')).toBe(false);
    expect(verifyHubSignature(raw, sign(body, 'app-secret').replace('sha256=', 'sha1='), 'app-secret')).toBe(false);
    expect(verifyHubSignature(raw, 'sha256=zz', 'app-secret')).toBe(false);
    expect(verifyHubSignature(raw, undefined, 'app-secret')).toBe(false);
    expect(verifyHubSignature(raw, sign(body, 'app-secret'), undefined)).toBe(false);
  });

  it('echoes the challenge only for subscribe + matching verify token', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '12345' };
    expect(verifyHubChallenge(q, 'tok')).toBe('12345');
    expect(verifyHubChallenge({ ...q, 'hub.verify_token': 'nope' }, 'tok')).toBeNull();
    expect(verifyHubChallenge({ ...q, 'hub.mode': 'unsubscribe' }, 'tok')).toBeNull();
    expect(verifyHubChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok' }, 'tok')).toBeNull();
    expect(verifyHubChallenge(q, undefined)).toBeNull();
  });
});

const graph = { graphBaseUrl: 'https://graph.example', graphVersion: 'v25.0', sendTimeoutMs: 1000 };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

describe('WhatsAppAdapter', () => {
  const config = { appSecret: 's', verifyToken: 'v', accessToken: 'WA_TOKEN', phoneNumberId: 'PN1', ...graph };
  const adapter = new WhatsAppAdapter(config);

  it('normalizes text, button and interactive replies, and keeps non-text as unreadable', () => {
    const parsed = adapter.parse(
      waPayload('PN1', [
        { from: '2011', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'بكام؟' } },
        { from: '2011', id: 'wamid.2', type: 'button', button: { text: 'Pricing' } },
        { from: '2011', id: 'wamid.3', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'x', title: 'Services' } } },
        { from: '2011', id: 'wamid.4', type: 'image', image: { id: 'media' } },
        { from: '2011', id: 'wamid.5', type: 'reaction', reaction: { emoji: '👍' } },
      ]),
    );
    expect(parsed.messages.map((m) => [m.platformMessageId, m.text, m.contentType])).toEqual([
      ['wamid.1', 'بكام؟', 'text'],
      ['wamid.2', 'Pricing', 'text'],
      ['wamid.3', 'Services', 'text'],
      ['wamid.4', null, 'image'],
    ]);
    expect(parsed.messages[0]).toMatchObject({
      channel: 'whatsapp',
      platformAccountId: 'PN1',
      senderId: '2011',
      senderName: 'Customer',
      timestamp: new Date(1_700_000_000_000),
    });
    expect(parsed.ignored).toBe(1);
  });

  it('parses delivery statuses with error codes', () => {
    const parsed = adapter.parse(
      waPayload('PN1', [], [
        { id: 'wamid.out', status: 'delivered' },
        { id: 'wamid.out2', status: 'failed', errors: [{ code: 131047 }] },
      ]),
    );
    expect(parsed.statuses).toEqual([
      { channel: 'whatsapp', platformMessageId: 'wamid.out', status: 'delivered', errorCode: null },
      { channel: 'whatsapp', platformMessageId: 'wamid.out2', status: 'failed', errorCode: 'wa_131047' },
    ]);
  });

  it('ignores events for another phone number and malformed payloads', () => {
    expect(adapter.parse(waPayload('OTHER', [{ from: '1', id: 'x', type: 'text', text: { body: 'hi' } }])).messages).toEqual([]);
    expect(adapter.parse({ object: 'page' })).toEqual({ messages: [], statuses: [], ignored: 1 });
    expect(adapter.parse('garbage')).toEqual({ messages: [], statuses: [], ignored: 1 });
  });

  it('sends a text message through the Cloud API with a bearer token', async () => {
    const fetch = fakeFetch(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.sent' }] });
    const result = await new WhatsAppAdapter(config, fetch.impl).send('2011', 'hello', { platformAccountId: 'PN1' });
    expect(result).toEqual({ platformMessageId: 'wamid.sent' });
    const call = fetch.calls[0]!;
    expect(call.url).toBe('https://graph.example/v25.0/PN1/messages');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer WA_TOKEN');
    expect(call.url).not.toContain('WA_TOKEN');
    expect(JSON.parse(call.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '2011',
      type: 'text',
      text: { preview_url: false, body: 'hello' },
    });
  });
});

describe('MessengerAdapter', () => {
  const config = { appSecret: 's', verifyToken: 'v', pageAccessToken: 'PAGE_TOKEN', ...graph };
  const adapter = new MessengerAdapter(config);

  it('normalizes messages and delivery receipts, and ignores echoes and self messages', () => {
    const parsed = adapter.parse(
      messengerPayload('PAGE1', [
        { sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, timestamp: 1700000000000, message: { mid: 'm1', text: 'hello' } },
        { sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, message: { mid: 'm2', attachments: [{ type: 'image' }] } },
        { sender: { id: 'PAGE1' }, recipient: { id: 'PSID1' }, message: { mid: 'm3', text: 'our reply', is_echo: true } },
        { sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, delivery: { mids: ['out1'], watermark: 1 } },
        { sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, read: { watermark: 1 } },
      ]),
    );
    expect(parsed.messages.map((m) => [m.platformMessageId, m.text, m.contentType, m.senderId, m.platformAccountId])).toEqual([
      ['m1', 'hello', 'text', 'PSID1', 'PAGE1'],
      ['m2', null, 'image', 'PSID1', 'PAGE1'],
    ]);
    expect(parsed.statuses).toEqual([{ channel: 'messenger', platformMessageId: 'out1', status: 'delivered', errorCode: null }]);
    expect(parsed.ignored).toBe(2);
  });

  it('rejects an Instagram payload', () => {
    expect(adapter.parse(igPayload('IG1', [])).ignored).toBe(1);
  });

  it('sends with messaging_type RESPONSE to /me/messages', async () => {
    const fetch = fakeFetch(200, { recipient_id: 'PSID1', message_id: 'mid.sent' });
    const result = await new MessengerAdapter(config, fetch.impl).send('PSID1', 'hi', { platformAccountId: 'PAGE1' });
    expect(result).toEqual({ platformMessageId: 'mid.sent' });
    expect(fetch.calls[0]!.url).toBe('https://graph.example/v25.0/me/messages');
    expect(JSON.parse(fetch.calls[0]!.init.body as string)).toEqual({
      recipient: { id: 'PSID1' },
      messaging_type: 'RESPONSE',
      message: { text: 'hi' },
    });
  });
});

describe('InstagramAdapter', () => {
  const config = { appSecret: 's', verifyToken: 'v', accessToken: 'IG_TOKEN', ...graph, graphBaseUrl: 'https://graph.instagram.example' };
  const adapter = new InstagramAdapter(config);

  it('normalizes Instagram messages and ignores echoes', () => {
    const parsed = adapter.parse(
      igPayload('IG1', [
        { sender: { id: 'IGSID' }, recipient: { id: 'IG1' }, timestamp: 1700000000000, message: { mid: 'ig1', text: 'مرحبا' } },
        { sender: { id: 'IG1' }, recipient: { id: 'IGSID' }, message: { mid: 'ig2', text: 'echo', is_echo: true } },
      ]),
    );
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({ channel: 'instagram', senderId: 'IGSID', platformAccountId: 'IG1', text: 'مرحبا' });
  });

  it('sends to graph.instagram.com /me/messages', async () => {
    const fetch = fakeFetch(200, { recipient_id: 'IGSID', message_id: 'ig.sent' });
    await new InstagramAdapter(config, fetch.impl).send('IGSID', 'hi', { platformAccountId: 'IG1' });
    expect(fetch.calls[0]!.url).toBe('https://graph.instagram.example/v25.0/me/messages');
    expect(JSON.parse(fetch.calls[0]!.init.body as string)).toEqual({ recipient: { id: 'IGSID' }, message: { text: 'hi' } });
  });

  it('has the platform byte limit', () => {
    expect(adapter.maxMessageBytes).toBe(1000);
  });
});

describe('graphPost error classification', () => {
  const call = (status: number, body: unknown) => graphPost(fakeFetch(status, body).impl, 'https://x/y', 't', {}, 1000);

  it.each([
    [429, {}, true, 'http_429'],
    [500, {}, true, 'http_500'],
    [400, { error: { code: 4, message: 'Application request limit reached' } }, true, 'http_400_4'],
    [400, { error: { code: 131047, message: 'Re-engagement message' } }, false, 'http_400_131047'],
    [400, { error: { code: 10, message: 'Outside the allowed window' } }, false, 'http_400_10'],
    [401, { error: { code: 190, message: 'Invalid OAuth access token' } }, false, 'http_401_190'],
  ])('HTTP %i %j → retryable=%s code=%s', async (status, body, retryable, code) => {
    await expect(call(status, body)).rejects.toMatchObject({ name: 'SendError', retryable, code });
  });

  it('treats network errors and timeouts as retryable', async () => {
    const network: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(graphPost(network, 'https://x', 't', {}, 1000)).rejects.toMatchObject({ retryable: true, code: 'network' });
    const slow: FetchLike = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    await expect(graphPost(slow, 'https://x', 't', {}, 50)).rejects.toMatchObject({ retryable: true, code: 'timeout' });
  });

  it('never puts the token in the error message', async () => {
    const err = (await call(400, { error: { code: 100, message: 'bad param' } }).catch((e: unknown) => e)) as SendError;
    expect(err.message).not.toContain('Bearer');
  });
});

describe('fitToBytes', () => {
  it('cuts on character boundaries within the byte budget', () => {
    const out = fitToBytes('مرحبا '.repeat(300), 1000);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1000);
    expect(out.endsWith('…')).toBe(true);
    expect(fitToBytes('short', 1000)).toBe('short');
    const emoji = fitToBytes('😀'.repeat(10), 10);
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(10);
    expect(emoji).not.toContain('�');
  });
});
