import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type pg from 'pg';
import type { Agent } from '../ai/agent.js';
import { fitToBytes, SendError, type ChannelSender } from '../channels/types.js';
import type { ConversationRepository } from '../conversations/repository.js';
import type { Database } from '../database/client.js';
import { contacts, conversations, messages, type Channel } from '../database/schema.js';
import { safeErrorDetail, type Logger } from '../observability/logger.js';

export class ConversationBusyError extends Error {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} is being processed by another worker`);
    this.name = 'ConversationBusyError';
  }
}

export type ProcessStatus = 'replied' | 'simulated' | 'skipped' | 'already_done' | 'failed';

export interface ProcessResult {
  status: ProcessStatus;
  reason?: string;
  outboundMessageId?: string;
  replyText?: string;
  sourceIds?: string[];
  needsHuman?: boolean;
}

export interface ProcessorOptions {
  db: Database;
  pool: pg.Pool;
  repository: ConversationRepository;
  agent: Agent;
  senders: Map<Channel, ChannelSender>;
  logger: Logger;
  historyMessages: number;
}

const DEFAULT_MAX_BYTES = 4_096;
const DELIVERED = new Set(['sent', 'delivered', 'read', 'simulated']);

/**
 * Turns one stored inbound message into at most one outbound reply.
 * Re-running it for the same message (retries, crashes, duplicate jobs) never produces a second reply:
 * the outbound row is unique per inbound message and a retry resends the stored text.
 */
export class MessageProcessor {
  constructor(private readonly o: ProcessorOptions) {}

  async process(inboundMessageId: string): Promise<ProcessResult> {
    const initial = await this.load(inboundMessageId);
    if (!initial) return { status: 'skipped', reason: 'message_not_found' };

    const lockClient = await this.o.pool.connect();
    const lockKey = initial.conversation.id;
    let locked = false;
    try {
      const res = await lockClient.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
        [lockKey],
      );
      locked = res.rows[0]?.ok === true;
      if (!locked) throw new ConversationBusyError(lockKey);
      return await this.processLocked(inboundMessageId);
    } finally {
      if (locked) await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
      lockClient.release();
    }
  }

  /** Called by the worker when a retryable send failure has used up all attempts. */
  async markSendExhausted(inboundMessageId: string, detail: string): Promise<void> {
    const db = this.o.db;
    await db
      .update(messages)
      .set({ deliveryStatus: 'failed', errorCode: 'send_retries_exhausted', errorDetail: detail, updatedAt: new Date() })
      .where(and(eq(messages.replyToMessageId, inboundMessageId), eq(messages.deliveryStatus, 'pending')));
    await this.setInbound(inboundMessageId, 'failed', 'send_retries_exhausted');
  }

  private async processLocked(inboundMessageId: string): Promise<ProcessResult> {
    const { db, repository, agent, logger } = this.o;
    const row = await this.load(inboundMessageId);
    if (!row) return { status: 'skipped', reason: 'message_not_found' };
    const { message, conversation, contact } = row;

    let [outbound] = await db.select().from(messages).where(eq(messages.replyToMessageId, message.id)).limit(1);

    if (!outbound) {
      if (message.processingStatus === 'replied' || message.processingStatus === 'skipped' || message.processingStatus === 'failed') {
        return { status: 'already_done' };
      }
      if (conversation.status === 'handoff') {
        await this.setInbound(message.id, 'skipped', 'handoff');
        return { status: 'skipped', reason: 'handoff' };
      }
      // Several quick messages in a row: answer only the latest, which sees the earlier ones as history.
      // A newer message that is queued, being processed, or already answered makes this one redundant.
      const [newer] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            eq(messages.direction, 'inbound'),
            inArray(messages.processingStatus, ['queued', 'processing', 'replied']),
            ne(messages.id, message.id),
            // Compare in SQL: JS Dates drop the microseconds Postgres stores.
            gt(messages.createdAt, sql`(SELECT m.created_at FROM messages m WHERE m.id = ${message.id})`),
          ),
        )
        .limit(1);
      if (newer) {
        await this.setInbound(message.id, 'skipped', 'superseded');
        return { status: 'skipped', reason: 'superseded' };
      }

      await this.setInbound(message.id, 'processing', null);
      const history = await repository.history(conversation.id, message.id, this.o.historyMessages);
      const reply = await agent.reply({ text: message.contentType === 'text' ? message.content : null, history });
      const maxBytes = this.o.senders.get(message.channel)?.maxMessageBytes ?? DEFAULT_MAX_BYTES;

      const inserted = await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          channel: message.channel,
          direction: 'outbound',
          replyToMessageId: message.id,
          content: fitToBytes(reply.text, maxBytes),
          deliveryStatus: 'pending',
          knowledgeSourceIds: reply.sourceIds,
          aiModel: reply.model,
          aiOutcome: reply.outcome,
          aiErrorCode: reply.errorCode,
          inputTokens: reply.usage?.inputTokens ?? null,
          outputTokens: reply.usage?.outputTokens ?? null,
        })
        .onConflictDoNothing({ target: messages.replyToMessageId })
        .returning();
      outbound = inserted[0] ?? (await db.select().from(messages).where(eq(messages.replyToMessageId, message.id)).limit(1))[0];
      if (!outbound) throw new Error('outbound reply row missing after insert');

      if (reply.needsHuman) {
        await repository.setStatus(conversation.id, 'handoff', reply.errorCode ?? reply.outcome);
      }
      logger.info(
        {
          messageId: message.id,
          conversationId: conversation.id,
          outcome: reply.outcome,
          sources: reply.sourceIds,
          needsHuman: reply.needsHuman,
          inputTokens: reply.usage?.inputTokens,
          outputTokens: reply.usage?.outputTokens,
        },
        'reply generated',
      );
    }

    const result: ProcessResult = {
      status: 'replied',
      outboundMessageId: outbound.id,
      replyText: outbound.content,
      sourceIds: outbound.knowledgeSourceIds,
    };

    if (outbound.deliveryStatus && DELIVERED.has(outbound.deliveryStatus)) {
      await this.setInbound(message.id, 'replied', null);
      return { ...result, status: conversation.isSimulated ? 'simulated' : 'already_done' };
    }

    if (conversation.isSimulated) {
      await this.setOutbound(outbound.id, { deliveryStatus: 'simulated' });
      await this.setInbound(message.id, 'replied', null);
      return { ...result, status: 'simulated' };
    }

    const sender = this.o.senders.get(message.channel);
    if (!sender) {
      await this.setOutbound(outbound.id, { deliveryStatus: 'failed', errorCode: 'channel_disabled' });
      await this.setInbound(message.id, 'failed', 'channel_disabled');
      logger.error({ channel: message.channel, messageId: message.id }, 'no sender configured for channel');
      return { status: 'failed', reason: 'channel_disabled', outboundMessageId: outbound.id };
    }

    try {
      const sent = await sender.send(contact.platformUserId, outbound.content, {
        platformAccountId: conversation.platformAccountId,
      });
      // "sent" means the platform accepted the message; delivered/read arrive later as webhooks.
      await this.setOutbound(outbound.id, {
        deliveryStatus: 'sent',
        platformMessageId: sent.platformMessageId,
        errorCode: null,
        errorDetail: null,
      });
      await this.setInbound(message.id, 'replied', null);
      return result;
    } catch (error) {
      const sendError =
        error instanceof SendError ? error : new SendError(true, 'unexpected', safeErrorDetail(error), { cause: error });
      await this.setOutbound(outbound.id, { errorCode: sendError.code, errorDetail: safeErrorDetail(sendError) });
      if (sendError.retryable) throw sendError;
      await this.setOutbound(outbound.id, { deliveryStatus: 'failed' });
      await this.setInbound(message.id, 'failed', sendError.code);
      logger.error({ messageId: message.id, code: sendError.code }, 'reply delivery failed permanently');
      return { status: 'failed', reason: sendError.code, outboundMessageId: outbound.id };
    }
  }

  private async load(messageId: string) {
    const [row] = await this.o.db
      .select({ message: messages, conversation: conversations, contact: contacts })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(and(eq(messages.id, messageId), eq(messages.direction, 'inbound')))
      .limit(1);
    return row;
  }

  private async setInbound(
    id: string,
    status: 'processing' | 'replied' | 'skipped' | 'failed',
    errorCode: string | null,
  ): Promise<void> {
    await this.o.db
      .update(messages)
      .set({ processingStatus: status, ...(errorCode !== null ? { errorCode } : {}), updatedAt: new Date() })
      .where(eq(messages.id, id));
  }

  private async setOutbound(id: string, values: Partial<typeof messages.$inferInsert>): Promise<void> {
    await this.o.db.update(messages).set({ ...values, updatedAt: new Date() }).where(eq(messages.id, id));
  }
}
