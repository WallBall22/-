import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { ChatTurn } from '../ai/provider.js';
import type { DeliveryStatusUpdate, NormalizedInbound } from '../channels/types.js';
import type { Database } from '../database/client.js';
import { contacts, conversations, jobs, messages, webhookEvents } from '../database/schema.js';

export const PROCESS_INBOUND_JOB = 'process_inbound';

export type IngestStatus = 'queued' | 'duplicate' | 'skipped_handoff' | 'skipped_rate_limited' | 'stored';

export interface IngestResult {
  status: IngestStatus;
  messageId: string | null;
  conversationId: string | null;
}

export interface IngestOptions {
  simulated?: boolean;
  /** When false the caller processes the message itself (the simulator); no job is created. */
  enqueue?: boolean;
  maxMessagesPerContactPerHour: number;
  maxJobAttempts: number;
}

const DELIVERY_ORDER = { pending: 0, sent: 1, delivered: 2, read: 3 } as const;

export class ConversationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Stores an inbound message and, when it should be answered, queues a processing job, all in one
   * transaction. A message id seen before (webhook retry) is reported as a duplicate and creates nothing.
   */
  async ingest(inbound: NormalizedInbound, options: IngestOptions): Promise<IngestResult> {
    const simulated = options.simulated ?? false;
    return this.db.transaction(async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({ channel: inbound.channel, platformUserId: inbound.senderId, displayName: inbound.senderName })
        .onConflictDoUpdate({
          target: [contacts.channel, contacts.platformUserId],
          set: {
            displayName: sql`coalesce(excluded.display_name, ${contacts.displayName})`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: contacts.id });

      const [conversation] = await tx
        .insert(conversations)
        .values({
          channel: inbound.channel,
          contactId: contact!.id,
          platformAccountId: inbound.platformAccountId,
          isSimulated: simulated,
        })
        .onConflictDoUpdate({
          target: [conversations.channel, conversations.contactId, conversations.platformAccountId, conversations.isSimulated],
          set: { lastMessageAt: new Date(), updatedAt: new Date() },
        })
        .returning({ id: conversations.id, status: conversations.status });

      const [message] = await tx
        .insert(messages)
        .values({
          conversationId: conversation!.id,
          channel: inbound.channel,
          direction: 'inbound',
          platformMessageId: inbound.platformMessageId,
          contentType: inbound.contentType,
          content: inbound.text ?? '',
          processingStatus: 'received',
          platformTimestamp: inbound.timestamp,
        })
        .onConflictDoNothing({ target: [messages.channel, messages.platformMessageId] })
        .returning({ id: messages.id });

      await tx
        .insert(webhookEvents)
        .values({ channel: inbound.channel, eventKey: `message:${inbound.platformMessageId}`, eventType: 'message' })
        .onConflictDoNothing();

      if (!message) return { status: 'duplicate', messageId: null, conversationId: conversation!.id };

      const base = { messageId: message.id, conversationId: conversation!.id };

      if (conversation!.status === 'handoff') {
        await tx.update(messages).set({ processingStatus: 'skipped', errorCode: 'handoff' }).where(eq(messages.id, message.id));
        return { ...base, status: 'skipped_handoff' };
      }

      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.contactId, contact!.id),
            eq(messages.direction, 'inbound'),
            gt(messages.createdAt, sql`now() - interval '1 hour'`),
          ),
        );
      if (count > options.maxMessagesPerContactPerHour) {
        await tx
          .update(messages)
          .set({ processingStatus: 'skipped', errorCode: 'rate_limited' })
          .where(eq(messages.id, message.id));
        return { ...base, status: 'skipped_rate_limited' };
      }

      if (options.enqueue === false) return { ...base, status: 'stored' };

      await tx.insert(jobs).values({
        type: PROCESS_INBOUND_JOB,
        jobKey: `inbound:${message.id}`,
        payload: { messageId: message.id },
        maxAttempts: options.maxJobAttempts,
      });
      await tx.update(messages).set({ processingStatus: 'queued' }).where(eq(messages.id, message.id));
      return { ...base, status: 'queued' };
    });
  }

  /** Applies a delivery receipt. Status only moves forward (sent → delivered → read); failures always apply. */
  async applyDeliveryStatus(update: DeliveryStatusUpdate): Promise<boolean> {
    const inserted = await this.db
      .insert(webhookEvents)
      .values({
        channel: update.channel,
        eventKey: `status:${update.platformMessageId}:${update.status}`,
        eventType: 'status',
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (inserted.length === 0) return false;

    const allowedPrevious =
      update.status === 'failed'
        ? (['pending', 'sent', 'delivered'] as const)
        : (Object.keys(DELIVERY_ORDER) as (keyof typeof DELIVERY_ORDER)[]).filter(
            (s) => DELIVERY_ORDER[s] < DELIVERY_ORDER[update.status as keyof typeof DELIVERY_ORDER],
          );
    const result = await this.db
      .update(messages)
      .set({ deliveryStatus: update.status, errorCode: update.errorCode ?? undefined, updatedAt: new Date() })
      .where(
        and(
          eq(messages.channel, update.channel),
          eq(messages.platformMessageId, update.platformMessageId),
          eq(messages.direction, 'outbound'),
          inArray(messages.deliveryStatus, [...allowedPrevious]),
        ),
      )
      .returning({ id: messages.id });
    return result.length > 0;
  }

  /** Conversation turns before the given message, oldest first, for model context. */
  async history(conversationId: string, beforeMessageId: string, limit: number): Promise<ChatTurn[]> {
    if (limit === 0) return [];
    const rows = await this.db
      .select({ direction: messages.direction, content: messages.content, deliveryStatus: messages.deliveryStatus })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          // Compared in SQL to keep Postgres' microsecond precision.
          lt(messages.createdAt, sql`(SELECT m.created_at FROM messages m WHERE m.id = ${beforeMessageId})`),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows
      .reverse()
      .filter((r) => r.content.trim() !== '' && r.deliveryStatus !== 'failed')
      .map((r) => ({ role: r.direction === 'inbound' ? 'user' : 'assistant', content: r.content }));
  }

  async setStatus(conversationId: string, status: 'open' | 'handoff' | 'closed', reason: string | null): Promise<boolean> {
    const rows = await this.db
      .update(conversations)
      .set({ status, handoffReason: status === 'handoff' ? reason : null, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId))
      .returning({ id: conversations.id });
    return rows.length > 0;
  }

  async listByStatus(status: 'open' | 'handoff' | 'closed', limit = 50) {
    return this.db
      .select({
        id: conversations.id,
        channel: conversations.channel,
        status: conversations.status,
        handoffReason: conversations.handoffReason,
        lastMessageAt: conversations.lastMessageAt,
        contactId: conversations.contactId,
        isSimulated: conversations.isSimulated,
      })
      .from(conversations)
      .where(eq(conversations.status, status))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(limit);
  }

  async transcript(conversationId: string) {
    return this.db
      .select({
        id: messages.id,
        direction: messages.direction,
        content: messages.content,
        processingStatus: messages.processingStatus,
        deliveryStatus: messages.deliveryStatus,
        knowledgeSourceIds: messages.knowledgeSourceIds,
        errorCode: messages.errorCode,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
  }

  /** Deletes a contact and, by cascade, all their conversations and messages. */
  async deleteContact(contactId: string): Promise<boolean> {
    const rows = await this.db.delete(contacts).where(eq(contacts.id, contactId)).returning({ id: contacts.id });
    return rows.length > 0;
  }

  /** Retention: removes conversations idle longer than `days`, orphaned contacts, and old events and jobs. */
  async purgeOlderThan(days: number): Promise<{ conversations: number; contacts: number; events: number; jobs: number }> {
    return this.db.transaction(async (tx) => {
      const cutoff = sql`now() - make_interval(days => ${days})`;
      const conv = await tx.delete(conversations).where(lt(conversations.lastMessageAt, cutoff)).returning({ id: conversations.id });
      const orphans = await tx
        .delete(contacts)
        .where(sql`NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = ${contacts.id})`)
        .returning({ id: contacts.id });
      const events = await tx.delete(webhookEvents).where(lt(webhookEvents.receivedAt, cutoff)).returning({ id: webhookEvents.id });
      const oldJobs = await tx
        .delete(jobs)
        .where(and(inArray(jobs.status, ['done', 'failed']), lt(jobs.updatedAt, cutoff)))
        .returning({ id: jobs.id });
      return { conversations: conv.length, contacts: orphans.length, events: events.length, jobs: oldJobs.length };
    });
  }
}
