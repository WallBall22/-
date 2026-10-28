import { Agent } from './ai/agent.js';
import { OfflineProvider } from './ai/offline-provider.js';
import { createOpenAiClient, OpenAiProvider } from './ai/openai-provider.js';
import type { AiProvider } from './ai/provider.js';
import type { FetchLike } from './channels/meta.js';
import { createChannelAdapters } from './channels/registry.js';
import type { ChannelAdapter, ChannelSender } from './channels/types.js';
import type { AppConfig } from './config/env.js';
import { ConversationRepository } from './conversations/repository.js';
import { Simulator } from './conversations/simulator.js';
import type { DatabaseHandle } from './database/client.js';
import type { Channel } from './database/schema.js';
import { PgKnowledgeSearch, type KnowledgeSearch } from './knowledge/repository.js';
import { JobQueue } from './messaging/jobs.js';
import { MessageProcessor } from './messaging/processor.js';
import { Worker } from './messaging/worker.js';
import type { Logger } from './observability/logger.js';

export interface ServiceOverrides {
  provider?: AiProvider;
  knowledge?: KnowledgeSearch;
  adapters?: Map<Channel, ChannelAdapter>;
  fetchImpl?: FetchLike;
}

export type Services = ReturnType<typeof createServices>;

export function createAiProvider(config: AppConfig): AiProvider {
  if (config.ai.provider === 'offline') return new OfflineProvider();
  const options = { model: config.ai.model!, timeoutMs: config.ai.timeoutMs, maxRetries: config.ai.maxRetries };
  return new OpenAiProvider(createOpenAiClient(config.ai.apiKey!, options), options);
}

/** Wires every service from configuration. External clients can be overridden for tests. */
export function createServices(config: AppConfig, database: DatabaseHandle, logger: Logger, overrides: ServiceOverrides = {}) {
  const repository = new ConversationRepository(database.db);
  const knowledge = overrides.knowledge ?? new PgKnowledgeSearch(database.db);
  const provider = overrides.provider ?? createAiProvider(config);
  const adapters = overrides.adapters ?? createChannelAdapters(config, overrides.fetchImpl);
  const senders = new Map<Channel, ChannelSender>(adapters);

  const agent = new Agent({
    provider,
    knowledge,
    logger,
    topK: config.knowledge.topK,
    minRank: config.knowledge.minRank,
    maxOutputTokens: config.ai.maxOutputTokens,
    maxInboundChars: config.conversation.maxInboundChars,
    humanFollowupTimeframe: config.conversation.humanFollowupTimeframe,
  });
  const processor = new MessageProcessor({
    db: database.db,
    pool: database.pool,
    repository,
    agent,
    senders,
    logger,
    historyMessages: config.ai.historyMessages,
  });
  const queue = new JobQueue(database.db);
  const worker = new Worker({
    queue,
    processor,
    logger,
    pollIntervalMs: config.worker.pollIntervalMs,
    backoffBaseMs: config.worker.backoffBaseMs,
    lockRetryMs: config.worker.lockRetryMs,
    concurrency: config.worker.concurrency,
  });
  const limits = {
    maxMessagesPerContactPerHour: config.conversation.maxMessagesPerContactPerHour,
    maxJobAttempts: config.worker.maxAttempts,
  };
  const simulator = new Simulator(repository, processor, limits);

  return { config, database, logger, repository, knowledge, provider, adapters, agent, processor, queue, worker, simulator, limits };
}
