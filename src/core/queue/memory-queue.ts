import { logger } from '../logger/logger.js';

export interface JobContext {
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
}

export type JobHandler<T> = (data: T, context: JobContext) => Promise<unknown>;

export interface MemoryJobOptions {
  attempts: number;
  /** Delay before the 2nd attempt; doubles for each later attempt. */
  backoffMs: number;
}

/** Thrown by a handler when retrying cannot help (the job fails immediately). */
export class NonRetryableJobError extends Error {}

interface QueuedJob<T> {
  id: string;
  data: T;
  options: MemoryJobOptions;
  attempt: number;
}

/**
 * In-process job queue, used when no Redis is configured (local development with only MySQL).
 * Jobs run inside the API process with bounded concurrency, exponential-backoff retries and
 * de-duplication by job id — the same guarantees the code relies on with BullMQ. Anything that
 * must survive a restart is tracked in the database (e.g. upload jobs are resumed on startup).
 */
export class MemoryQueue<T> {
  private handler: JobHandler<T> | null = null;
  private readonly waiting: QueuedJob<T>[] = [];
  /** Ids that are waiting, running or scheduled for a retry. */
  private readonly known = new Set<string>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private readonly idleWaiters: (() => void)[] = [];
  private closed = false;

  constructor(
    readonly name: string,
    private readonly concurrency: number,
  ) {}

  /** Starts consuming jobs with `handler` (until then, jobs only accumulate). */
  process(handler: JobHandler<T>): void {
    this.handler = handler;
    this.pump();
  }

  /** Adds a job; returns false when a job with the same id is already pending. */
  add(id: string, data: T, options: MemoryJobOptions): boolean {
    if (this.closed || this.known.has(id)) return false;
    this.known.add(id);
    this.waiting.push({ id, data, options, attempt: 1 });
    this.pump();
    return true;
  }

  /** Data of a job that has not started yet (used by tests and diagnostics). */
  getWaiting(id: string): T | undefined {
    return this.waiting.find((job) => job.id === id)?.data;
  }

  get pendingCount(): number {
    return this.known.size;
  }

  /** Resolves once no job is waiting, running or scheduled for a retry. */
  onIdle(): Promise<void> {
    if (this.known.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.waiting.length = 0;
    await Promise.allSettled([...this.running]);
    this.known.clear();
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  private pump(): void {
    while (this.handler && !this.closed && this.running.size < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      const run: Promise<void> = this.execute(job).finally(() => {
        this.running.delete(run);
        this.pump();
        if (this.known.size === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
      });
      this.running.add(run);
    }
  }

  private async execute(job: QueuedJob<T>): Promise<void> {
    const context = {
      attempt: job.attempt,
      maxAttempts: job.options.attempts,
      signal: this.controller.signal,
    };
    try {
      await this.handler!(job.data, context);
      this.known.delete(job.id);
      logger.info({ queue: this.name, jobId: job.id }, 'Job completed');
    } catch (error) {
      const retry =
        !this.closed && !(error instanceof NonRetryableJobError) && job.attempt < job.options.attempts;
      if (!retry) {
        this.known.delete(job.id);
        if (!this.closed)
          logger.error({ queue: this.name, jobId: job.id, attempt: job.attempt, err: error }, 'Job failed');
        return;
      }
      const delay = job.options.backoffMs * 2 ** (job.attempt - 1);
      logger.warn(
        { queue: this.name, jobId: job.id, attempt: job.attempt, retryInMs: delay, err: error },
        'Job failed, retrying',
      );
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.waiting.push({ ...job, attempt: job.attempt + 1 });
        this.pump();
      }, delay);
      this.retryTimers.add(timer);
    }
  }
}
