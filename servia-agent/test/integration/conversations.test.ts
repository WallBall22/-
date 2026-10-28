import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AiError } from '../../src/ai/provider.js';
import { SendError } from '../../src/channels/types.js';
import { conversations, jobs, messages } from '../../src/database/schema.js';
import { backoffDelay } from '../../src/messaging/jobs.js';
import { ConversationBusyError } from '../../src/messaging/processor.js';
import { openTestDb, resetData } from '../helpers/db.js';
import { buildEngine, drain, FakeSender, inbound } from '../helpers/engine.js';
import { FakeKnowledge, FakeProvider, passage } from '../helpers/fakes.js';

const handle = openTestDb();
afterAll(() => handle.close());
beforeEach(() => resetData(handle));

const allMessages = () => handle.db.select().from(messages).orderBy(messages.createdAt);
const outbound = async () => (await allMessages()).filter((m) => m.direction === 'outbound');

describe('ingest', () => {
  it('stores contact, conversation and message and queues one job', async () => {
    const { ingest } = buildEngine(handle);
    const r = await ingest();
    expect(r.status).toBe('queued');
    const [msg] = await allMessages();
    expect(msg).toMatchObject({ direction: 'inbound', processingStatus: 'queued', channel: 'whatsapp' });
    expect(await handle.db.select().from(jobs)).toHaveLength(1);
  });

  it('treats a repeated platform message id (webhook retry) as a duplicate', async () => {
    const { ingest } = buildEngine(handle);
    const msg = inbound();
    expect((await ingest(msg)).status).toBe('queued');
    expect((await ingest(msg)).status).toBe('duplicate');
    expect(await allMessages()).toHaveLength(1);
    expect(await handle.db.select().from(jobs)).toHaveLength(1);
  });

  it('rate-limits a contact that sends too many messages', async () => {
    const engine = buildEngine(handle, { limits: { maxMessagesPerContactPerHour: 2, maxJobAttempts: 3 } });
    expect((await engine.ingest()).status).toBe('queued');
    expect((await engine.ingest()).status).toBe('queued');
    expect((await engine.ingest()).status).toBe('skipped_rate_limited');
  });
});

describe('processing and delivery', () => {
  it('generates one grounded reply, sends it on the same channel and records sources and tokens', async () => {
    const knowledge = new FakeKnowledge([passage('services#0', 'SERVIA builds AI receptionists for clinics.')]);
    const provider = FakeProvider.replying('SERVIA builds AI receptionists for clinics.', { sourceIds: ['services#0'] });
    const engine = buildEngine(handle, { knowledge, provider });
    await engine.ingest(inbound({ senderId: '2010', platformAccountId: 'PHONE_X' }));
    await drain(engine.worker);

    expect(engine.sender.sent).toEqual([
      { recipientId: '2010', text: 'SERVIA builds AI receptionists for clinics.', context: { platformAccountId: 'PHONE_X' } },
    ]);
    const [out] = await outbound();
    expect(out).toMatchObject({
      deliveryStatus: 'sent',
      platformMessageId: 'wamid.out-1',
      knowledgeSourceIds: ['services#0'],
      aiModel: 'fake-model',
      inputTokens: 120,
      outputTokens: 30,
    });
    const inMsg = (await allMessages()).find((m) => m.direction === 'inbound');
    expect(inMsg?.processingStatus).toBe('replied');
    expect((await handle.db.select().from(jobs))[0]?.status).toBe('done');
  });

  it('never sends two replies for the same inbound message', async () => {
    const engine = buildEngine(handle);
    const msg = inbound();
    const { messageId } = await engine.ingest(msg);
    await drain(engine.worker);
    await engine.ingest(msg); // webhook retry after processing
    await engine.processor.process(messageId!); // a duplicate job or a crash-recovery rerun
    await drain(engine.worker);
    expect(engine.sender.sent).toHaveLength(1);
    expect(await outbound()).toHaveLength(1);
    expect(engine.provider instanceof FakeProvider && engine.provider.requests).toHaveLength(1);
  });

  it('retries a transient send failure by resending the same text, without regenerating', async () => {
    const sender = new FakeSender().failNext(new SendError(true, 'http_503', 'unavailable'));
    const engine = buildEngine(handle, { sender });
    await engine.ingest();
    await drain(engine.worker);
    expect(sender.attempts).toBe(2);
    expect(sender.sent).toHaveLength(1);
    expect((engine.provider as FakeProvider).requests).toHaveLength(1);
    const [out] = await outbound();
    expect(out).toMatchObject({ deliveryStatus: 'sent', errorCode: null });
  });

  it('marks the reply failed after exhausting retries', async () => {
    const err = () => new SendError(true, 'http_500', 'boom');
    const sender = new FakeSender().failNext(err(), err(), err(), err());
    const engine = buildEngine(handle, { sender });
    await engine.ingest();
    await drain(engine.worker);
    expect(sender.attempts).toBe(3); // maxJobAttempts
    const [out] = await outbound();
    expect(out).toMatchObject({ deliveryStatus: 'failed', errorCode: 'send_retries_exhausted' });
    expect((await handle.db.select().from(jobs))[0]).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('does not retry permanent send errors', async () => {
    const sender = new FakeSender().failNext(new SendError(false, 'http_400_131047', 're-engagement window closed'));
    const engine = buildEngine(handle, { sender });
    await engine.ingest();
    await drain(engine.worker);
    expect(sender.attempts).toBe(1);
    const [out] = await outbound();
    expect(out).toMatchObject({ deliveryStatus: 'failed', errorCode: 'http_400_131047' });
    const inMsg = (await allMessages()).find((m) => m.direction === 'inbound');
    expect(inMsg).toMatchObject({ processingStatus: 'failed' });
  });

  it('sends a safe fallback and hands off when the model is down', async () => {
    const provider = new FakeProvider(() => {
      throw new AiError('timeout', 'slow');
    });
    const engine = buildEngine(handle, { provider });
    const { conversationId } = await engine.ingest(inbound({ text: 'ايه خدماتكم؟' }));
    await drain(engine.worker);
    expect(engine.sender.sent[0]!.text).toMatch(/فريق سيرفيا/);
    const [out] = await outbound();
    expect(out).toMatchObject({ aiOutcome: 'model_error', aiErrorCode: 'timeout', deliveryStatus: 'sent', errorCode: null });
    const [conv] = await handle.db.select().from(conversations).where(eq(conversations.id, conversationId!));
    expect(conv).toMatchObject({ status: 'handoff', handoffReason: 'timeout' });
  });

  it('truncates replies to the channel byte limit', async () => {
    const sender = new FakeSender('whatsapp', 60);
    const engine = buildEngine(handle, { sender, provider: FakeProvider.replying('ع'.repeat(200)) });
    await engine.ingest();
    await drain(engine.worker);
    expect(Buffer.byteLength(sender.sent[0]!.text)).toBeLessThanOrEqual(60);
    expect(sender.sent[0]!.text.endsWith('…')).toBe(true);
  });
});

describe('concurrency within one conversation', () => {
  it('answers only the latest of several quick messages, with the earlier ones as history', async () => {
    const engine = buildEngine(handle);
    await engine.ingest(inbound({ text: 'hi' }));
    await engine.ingest(inbound({ text: 'I run a dental clinic' }));
    await engine.ingest(inbound({ text: 'what do you offer?' }));
    await Promise.all([engine.worker.runOnce('w1'), engine.worker.runOnce('w2'), engine.worker.runOnce('w3')]);
    await drain(engine.worker);

    expect(engine.sender.sent).toHaveLength(1);
    const req = (engine.provider as FakeProvider).requests[0]!;
    expect(req.customerMessage).toBe('what do you offer?');
    expect(req.history.map((t) => t.content)).toEqual(['hi', 'I run a dental clinic']);
    const inbound_ = (await allMessages()).filter((m) => m.direction === 'inbound');
    expect(inbound_.map((m) => [m.processingStatus, m.errorCode])).toEqual([
      ['skipped', 'superseded'],
      ['skipped', 'superseded'],
      ['replied', null],
    ]);
  });

  it('defers a job while another worker holds the conversation lock, without using an attempt', async () => {
    const engine = buildEngine(handle);
    const { conversationId, messageId } = await engine.ingest();
    const holder = await handle.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [conversationId]);
      await expect(engine.processor.process(messageId!)).rejects.toBeInstanceOf(ConversationBusyError);
      await engine.worker.runOnce();
      const [job] = await handle.db.select().from(jobs);
      expect(job).toMatchObject({ status: 'pending', attempts: 0 });
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [conversationId]);
      holder.release();
    }
    await drain(engine.worker);
    expect(engine.sender.sent).toHaveLength(1);
  });

  it('serializes two messages from different conversations independently', async () => {
    const engine = buildEngine(handle);
    await engine.ingest(inbound({ senderId: 'A' }));
    await engine.ingest(inbound({ senderId: 'B' }));
    await Promise.all([engine.worker.runOnce('w1'), engine.worker.runOnce('w2')]);
    await drain(engine.worker);
    expect(engine.sender.sent.map((s) => s.recipientId).sort()).toEqual(['A', 'B']);
  });
});

describe('handoff', () => {
  it('stops replying once a conversation is handed off, and resumes when reopened', async () => {
    const engine = buildEngine(handle, { provider: FakeProvider.replying('Passing you to the team.', { needsHuman: true }) });
    const first = await engine.ingest(inbound({ text: 'I want a quote' }));
    await drain(engine.worker);
    expect(engine.sender.sent).toHaveLength(1);

    expect((await engine.ingest(inbound({ text: 'hello?' }))).status).toBe('skipped_handoff');
    await drain(engine.worker);
    expect(engine.sender.sent).toHaveLength(1);

    await engine.repository.setStatus(first.conversationId!, 'open', null);
    expect((await engine.ingest(inbound({ text: 'back again' }))).status).toBe('queued');
  });
});

describe('delivery receipts', () => {
  it('moves forward only and ignores duplicates', async () => {
    const engine = buildEngine(handle);
    await engine.ingest();
    await drain(engine.worker);
    const id = 'wamid.out-1';
    const apply = (status: 'delivered' | 'read' | 'failed') =>
      engine.repository.applyDeliveryStatus({ channel: 'whatsapp', platformMessageId: id, status, errorCode: null });
    expect(await apply('read')).toBe(true);
    expect(await apply('delivered')).toBe(false); // would regress
    expect(await apply('read')).toBe(false); // duplicate event
    const [out] = await outbound();
    expect(out!.deliveryStatus).toBe('read');
  });
});

describe('simulator', () => {
  it('returns the proposed reply and never sends anything', async () => {
    const engine = buildEngine(handle);
    const r = await engine.simulator.run({ channel: 'instagram', senderId: 'tester', text: 'What does SERVIA do?' });
    expect(r).toMatchObject({ status: 'simulated', reply: 'SERVIA builds AI receptionists for clinics.', handoff: false });
    expect(engine.sender.attempts).toBe(0);
    const [out] = await outbound();
    expect(out!.deliveryStatus).toBe('simulated');
    const [conv] = await handle.db.select().from(conversations);
    expect(conv!.isSimulated).toBe(true);
    expect(await handle.db.select().from(jobs)).toHaveLength(0);
  });
});

describe('retention and deletion', () => {
  it('deletes a contact with all their data', async () => {
    const engine = buildEngine(handle);
    await engine.ingest();
    await drain(engine.worker);
    const [conv] = await handle.db.select().from(conversations);
    expect(await engine.repository.deleteContact(conv!.contactId)).toBe(true);
    expect(await allMessages()).toHaveLength(0);
    expect(await handle.db.select().from(conversations)).toHaveLength(0);
  });

  it('purges conversations idle longer than the retention period', async () => {
    const engine = buildEngine(handle);
    await engine.ingest(inbound({ senderId: 'old' }));
    await engine.ingest(inbound({ senderId: 'new' }));
    await handle.db.execute(sql`
      UPDATE conversations SET last_message_at = now() - interval '200 days'
      WHERE contact_id = (SELECT id FROM contacts WHERE platform_user_id = 'old')
    `);
    const result = await engine.repository.purgeOlderThan(180);
    expect(result).toMatchObject({ conversations: 1, contacts: 1 });
    expect((await handle.db.select().from(conversations)).length).toBe(1);
  });
});

describe('job queue', () => {
  it('recovers jobs abandoned by a crashed worker', async () => {
    const engine = buildEngine(handle);
    await engine.ingest();
    await engine.queue.claimNext('crashed-worker');
    await handle.db.execute(sql`UPDATE jobs SET locked_at = now() - interval '10 minutes'`);
    expect(await engine.queue.recoverStale(60_000)).toBe(1);
    await drain(engine.worker);
    expect(engine.sender.sent).toHaveLength(1);
  });

  it('computes bounded exponential backoff', () => {
    const fixed = () => 0.5;
    expect(backoffDelay(1, 1000, fixed)).toBe(1000);
    expect(backoffDelay(3, 1000, fixed)).toBe(4000);
    expect(backoffDelay(30, 1000, fixed)).toBe(600_000);
  });
});
