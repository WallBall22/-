import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SendError } from '../channels/types.js';
import { PROCESS_INBOUND_JOB } from '../conversations/repository.js';
import { safeErrorDetail, type Logger } from '../observability/logger.js';
import { backoffDelay, type ClaimedJob, type JobQueue } from './jobs.js';
import { ConversationBusyError, type MessageProcessor } from './processor.js';

export interface WorkerOptions {
  queue: JobQueue;
  processor: MessageProcessor;
  logger: Logger;
  pollIntervalMs: number;
  backoffBaseMs: number;
  lockRetryMs: number;
  concurrency?: number;
  /** Jobs left `running` longer than this are assumed abandoned by a crashed worker. */
  staleAfterMs?: number;
}

const inboundPayload = z.object({ messageId: z.uuid() });

export class Worker {
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private lastRecovery = 0;

  constructor(private readonly o: WorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const n = this.o.concurrency ?? 2;
    this.loops = Array.from({ length: n }, (_, i) => this.loop(`${this.id}-${i}`));
    this.o.logger.info({ worker: this.id, concurrency: n }, 'worker started');
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
  }

  /** Claims and handles one job. Returns false when the queue is empty. Exposed for tests and CLIs. */
  async runOnce(workerId = this.id): Promise<boolean> {
    const job = await this.o.queue.claimNext(workerId);
    if (!job) return false;
    await this.handle(job);
    return true;
  }

  private async loop(workerId: string): Promise<void> {
    while (this.running) {
      try {
        await this.maybeRecover();
        const worked = await this.runOnce(workerId);
        if (!worked) await sleep(this.o.pollIntervalMs);
      } catch (error) {
        this.o.logger.error({ err: error, worker: workerId }, 'worker loop error');
        await sleep(this.o.pollIntervalMs);
      }
    }
  }

  private async maybeRecover(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecovery < 60_000) return;
    this.lastRecovery = now;
    const recovered = await this.o.queue.recoverStale(this.o.staleAfterMs ?? 300_000);
    if (recovered > 0) this.o.logger.warn({ recovered }, 'recovered stale jobs');
  }

  private async handle(job: ClaimedJob): Promise<void> {
    const { queue, processor, logger } = this.o;
    if (job.type !== PROCESS_INBOUND_JOB) {
      await queue.fail(job.id, `unknown job type ${job.type}`);
      return;
    }
    const payload = inboundPayload.safeParse(job.payload);
    if (!payload.success) {
      await queue.fail(job.id, 'invalid job payload');
      return;
    }
    const { messageId } = payload.data;

    try {
      const result = await processor.process(messageId);
      if (result.status === 'failed') await queue.fail(job.id, result.reason ?? 'failed');
      else await queue.complete(job.id);
      logger.info({ jobId: job.id, messageId, status: result.status, reason: result.reason }, 'job finished');
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        await queue.retryLater(job.id, this.o.lockRetryMs, null, false);
        return;
      }
      const detail = safeErrorDetail(error);
      const retryable = !(error instanceof SendError) || error.retryable;
      if (retryable && job.attempts < job.maxAttempts) {
        const delay = backoffDelay(job.attempts, this.o.backoffBaseMs);
        await queue.retryLater(job.id, delay, detail);
        logger.warn({ jobId: job.id, messageId, attempt: job.attempts, delayMs: delay, detail }, 'job will retry');
        return;
      }
      await processor.markSendExhausted(messageId, detail).catch(() => undefined);
      await queue.fail(job.id, detail);
      logger.error({ jobId: job.id, messageId, attempts: job.attempts, detail }, 'job failed permanently');
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
