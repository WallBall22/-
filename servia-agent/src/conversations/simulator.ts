import { randomUUID } from 'node:crypto';
import type { Channel } from '../database/schema.js';
import type { MessageProcessor } from '../messaging/processor.js';
import type { ConversationRepository } from './repository.js';

export interface SimulateInput {
  channel: Channel;
  senderId: string;
  text: string;
}

export interface SimulateResult {
  conversationId: string | null;
  status: string;
  reply: string | null;
  sourceIds: string[];
  handoff: boolean;
}

/**
 * Runs the full pipeline (storage, retrieval, model, guards) for a message without sending anything.
 * Simulated conversations are flagged `is_simulated` and their replies get delivery status `simulated`.
 */
export class Simulator {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly processor: MessageProcessor,
    private readonly limits: { maxMessagesPerContactPerHour: number; maxJobAttempts: number },
  ) {}

  async run(input: SimulateInput): Promise<SimulateResult> {
    const ingest = await this.repository.ingest(
      {
        channel: input.channel,
        platformAccountId: 'simulator',
        senderId: input.senderId,
        senderName: null,
        platformMessageId: `sim-${randomUUID()}`,
        text: input.text,
        contentType: 'text',
        timestamp: new Date(),
      },
      { simulated: true, enqueue: false, ...this.limits },
    );
    if (ingest.status !== 'stored' || !ingest.messageId) {
      return { conversationId: ingest.conversationId, status: ingest.status, reply: null, sourceIds: [], handoff: ingest.status === 'skipped_handoff' };
    }
    const result = await this.processor.process(ingest.messageId);
    const handoffNow = result.status === 'simulated' || result.status === 'replied' ? await this.isHandoff(ingest.conversationId) : false;
    return {
      conversationId: ingest.conversationId,
      status: result.status,
      reply: result.replyText ?? null,
      sourceIds: result.sourceIds ?? [],
      handoff: handoffNow,
    };
  }

  private async isHandoff(conversationId: string | null): Promise<boolean> {
    if (!conversationId) return false;
    const list = await this.repository.listByStatus('handoff', 500);
    return list.some((c) => c.id === conversationId);
  }
}
