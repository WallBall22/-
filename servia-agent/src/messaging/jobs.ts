import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { jobs } from '../database/schema.js';

export interface ClaimedJob {
  id: number;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/** PostgreSQL-backed job queue (outbox). Safe for several workers: claims use FOR UPDATE SKIP LOCKED. */
export class JobQueue {
  constructor(private readonly db: Database) {}

  async claimNext(workerId: string): Promise<ClaimedJob | null> {
    const result = await this.db.execute<{
      id: string;
      type: string;
      payload: unknown;
      attempts: number;
      max_attempts: number;
    }>(sql`
      UPDATE jobs
         SET status = 'running', locked_at = now(), locked_by = ${workerId},
             attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
          WHERE status = 'pending' AND run_at <= now()
          ORDER BY run_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1)
      RETURNING id, type, payload, attempts, max_attempts
    `);
    const row = result.rows[0];
    if (!row) return null;
    return { id: Number(row.id), type: row.type, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts };
  }

  async complete(id: number): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'done', lockedAt: null, lockedBy: null, updatedAt: new Date() })
      .where(eq(jobs.id, id));
  }

  async fail(id: number, error: string): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'failed', lastError: error, lockedAt: null, lockedBy: null, updatedAt: new Date() })
      .where(eq(jobs.id, id));
  }

  /**
   * Puts a job back in the queue after `delayMs`. With `countAttempt: false` (e.g. the conversation
   * was busy) the claim does not use up one of the job's attempts.
   */
  async retryLater(id: number, delayMs: number, error: string | null, countAttempt = true): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: 'pending',
        runAt: sql`now() + make_interval(secs => ${delayMs / 1000})`,
        attempts: countAttempt ? sql`${jobs.attempts}` : sql`greatest(${jobs.attempts} - 1, 0)`,
        lastError: error,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, id));
  }

  /** Returns jobs stuck in `running` (worker crashed mid-job) to the queue. */
  async recoverStale(olderThanMs: number): Promise<number> {
    const rows = await this.db
      .update(jobs)
      .set({ status: 'pending', lockedAt: null, lockedBy: null, updatedAt: new Date() })
      .where(and(eq(jobs.status, 'running'), lt(jobs.lockedAt, sql`now() - make_interval(secs => ${olderThanMs / 1000})`)))
      .returning({ id: jobs.id });
    return rows.length;
  }
}

/** Exponential backoff with ±20% jitter, capped at 10 minutes. `attempt` starts at 1. */
export function backoffDelay(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const raw = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 600_000);
  return Math.round(raw * (0.8 + random() * 0.4));
}
