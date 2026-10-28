import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const channelEnum = pgEnum('channel', ['whatsapp', 'instagram', 'messenger']);
export const conversationStatusEnum = pgEnum('conversation_status', ['open', 'handoff', 'closed']);
export const directionEnum = pgEnum('message_direction', ['inbound', 'outbound']);
export const processingStatusEnum = pgEnum('processing_status', [
  'received',
  'queued',
  'processing',
  'replied',
  'skipped',
  'failed',
]);
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
  'simulated',
]);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'running', 'done', 'failed']);

export const channels = pgTable('channels', {
  id: channelEnum('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: createdAt(),
});

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: channelEnum('channel')
      .notNull()
      .references(() => channels.id),
    platformUserId: text('platform_user_id').notNull(),
    displayName: text('display_name'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('contacts_channel_platform_user_uq').on(t.channel, t.platformUserId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: channelEnum('channel').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** The business-side account that received the message: WhatsApp phone number ID, Page ID or Instagram account ID. */
    platformAccountId: text('platform_account_id').notNull(),
    isSimulated: boolean('is_simulated').notNull().default(false),
    status: conversationStatusEnum('status').notNull().default('open'),
    handoffReason: text('handoff_reason'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('conversations_identity_uq').on(t.channel, t.contactId, t.platformAccountId, t.isSimulated),
    index('conversations_status_idx').on(t.status),
    index('conversations_last_message_idx').on(t.lastMessageAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    channel: channelEnum('channel').notNull(),
    direction: directionEnum('direction').notNull(),
    platformMessageId: text('platform_message_id'),
    replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'cascade',
    }),
    contentType: text('content_type').notNull().default('text'),
    content: text('content').notNull(),
    processingStatus: processingStatusEnum('processing_status'),
    deliveryStatus: deliveryStatusEnum('delivery_status'),
    knowledgeSourceIds: text('knowledge_source_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    aiModel: text('ai_model'),
    /** How the reply was produced: answered, guarded, model_error, handoff_requested, … (outbound only). */
    aiOutcome: text('ai_outcome'),
    /** Why the reply is a fallback: a guard violation or model error kind (outbound only). */
    aiErrorCode: text('ai_error_code'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    platformTimestamp: timestamp('platform_timestamp', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('messages_channel_platform_id_uq').on(t.channel, t.platformMessageId),
    // At most one reply per inbound message, even across webhook retries and worker restarts.
    uniqueIndex('messages_reply_to_uq').on(t.replyToMessageId),
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: channelEnum('channel').notNull(),
    eventKey: text('event_key').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_events_channel_key_uq').on(t.channel, t.eventKey),
    index('webhook_events_received_idx').on(t.receivedAt),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    jobKey: text('job_key').notNull(),
    payload: jsonb('payload').notNull(),
    status: jobStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('jobs_job_key_uq').on(t.jobKey), index('jobs_status_run_at_idx').on(t.status, t.runAt)],
);

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  sourcePath: text('source_path').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    /** Stable, human-readable source identifier recorded on every answer: `<slug>#<index>`. */
    id: text('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    heading: text('heading').notNull(),
    content: text('content').notNull(),
    normalizedContent: text('normalized_content').notNull(),
    searchVector: tsvector('search_vector')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, normalized_content)`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('knowledge_chunks_doc_index_uq').on(t.documentId, t.chunkIndex),
    index('knowledge_chunks_search_idx').using('gin', t.searchVector),
  ],
);

export const agentSettings = pgTable('agent_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

export type Channel = (typeof channelEnum.enumValues)[number];
export const CHANNELS = channelEnum.enumValues;
