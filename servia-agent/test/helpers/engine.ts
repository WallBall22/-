import { Agent } from '../../src/ai/agent.js';
import type { AiProvider } from '../../src/ai/provider.js';
import { SendError, type ChannelSender, type NormalizedInbound, type SendContext, type SendResult } from '../../src/channels/types.js';
import { ConversationRepository } from '../../src/conversations/repository.js';
import { Simulator } from '../../src/conversations/simulator.js';
import type { DatabaseHandle } from '../../src/database/client.js';
import type { Channel } from '../../src/database/schema.js';
import type { KnowledgeSearch } from '../../src/knowledge/repository.js';
import { JobQueue } from '../../src/messaging/jobs.js';
import { MessageProcessor } from '../../src/messaging/processor.js';
import { Worker } from '../../src/messaging/worker.js';
import { FakeKnowledge, FakeProvider, silentLogger } from './fakes.js';

export interface SentMessage {
  recipientId: string;
  text: string;
  context: SendContext;
}

/** Records sends; can be scripted to fail. Never talks to a network. */
export class FakeSender implements ChannelSender {
  sent: SentMessage[] = [];
  attempts = 0;
  failures: SendError[] = [];
  private counter = 0;

  constructor(
    readonly channel: Channel = 'whatsapp',
    readonly maxMessageBytes = 4_096,
  ) {}

  failNext(...errors: SendError[]): this {
    this.failures.push(...errors);
    return this;
  }

  async send(recipientId: string, text: string, context: SendContext): Promise<SendResult> {
    this.attempts += 1;
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push({ recipientId, text, context });
    this.counter += 1;
    return { platformMessageId: `wamid.out-${this.counter}` };
  }
}

export const LIMITS = { maxMessagesPerContactPerHour: 30, maxJobAttempts: 3 };

export function buildEngine(
  handle: DatabaseHandle,
  opts: { provider?: AiProvider; knowledge?: KnowledgeSearch; sender?: FakeSender; limits?: typeof LIMITS } = {},
) {
  const provider = opts.provider ?? FakeProvider.replying('SERVIA builds AI receptionists for clinics.', { sourceIds: [] });
  const knowledge = opts.knowledge ?? new FakeKnowledge([]);
  const sender = opts.sender ?? new FakeSender();
  const limits = opts.limits ?? LIMITS;
  const repository = new ConversationRepository(handle.db);
  const agent = new Agent({
    provider,
    knowledge,
    logger: silentLogger,
    topK: 4,
    minRank: 0.01,
    maxOutputTokens: 300,
    maxInboundChars: 2000,
  });
  const processor = new MessageProcessor({
    db: handle.db,
    pool: handle.pool,
    repository,
    agent,
    senders: new Map([[sender.channel, sender]]),
    logger: silentLogger,
    historyMessages: 10,
  });
  const queue = new JobQueue(handle.db);
  const worker = new Worker({
    queue,
    processor,
    logger: silentLogger,
    pollIntervalMs: 20,
    backoffBaseMs: 10,
    lockRetryMs: 10,
  });
  const simulator = new Simulator(repository, processor, limits);
  const ingest = (msg: Partial<NormalizedInbound> = {}) =>
    repository.ingest(inbound(msg), { ...limits, maxJobAttempts: limits.maxJobAttempts });
  return { repository, processor, queue, worker, simulator, sender, provider, ingest };
}

let seq = 0;
export function inbound(overrides: Partial<NormalizedInbound> = {}): NormalizedInbound {
  seq += 1;
  return {
    channel: 'whatsapp',
    platformAccountId: 'PHONE_ID_1',
    senderId: '201000000001',
    senderName: 'Dr. Test',
    platformMessageId: `wamid.in-${Date.now()}-${seq}`,
    text: 'What does SERVIA do?',
    contentType: 'text',
    timestamp: new Date(),
    ...overrides,
  };
}

/** Runs queued jobs until the queue is empty or a safety limit is reached, waiting for scheduled retries. */
export async function drain(worker: Worker, maxRounds = 50): Promise<void> {
  for (let i = 0; i < maxRounds; i += 1) {
    const worked = await worker.runOnce();
    if (!worked) {
      await new Promise((r) => setTimeout(r, 30));
      if (!(await worker.runOnce())) return;
    }
  }
}
