import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { config } from '../config/env.js';
import { prisma } from '../core/database/prisma.js';
import { logger } from '../core/logger/logger.js';
import {
  closeQueues,
  getQueues,
  QUEUE_PREFIX,
  QueueName,
  type MaintenanceJobData,
  type NotificationJobData,
  type VideoJobData,
} from '../core/queue/queues.js';
import { createRedisConnection } from '../core/queue/redis.js';
import { ensureStorageLayout } from '../core/storage/storage.js';
import { PermanentVideoError, runNotificationJob, runVideoJob } from './handlers.js';
import { MAINTENANCE_SCHEDULE, runMaintenance } from './maintenance.js';

/**
 * Background worker process for production (REDIS_URL set), deployed next to the API:
 *   video-processing → chunks → FFmpeg → encrypted HLS → READY
 *   notifications    → audience fan-out
 *   maintenance      → scheduled cleanups
 * Without REDIS_URL the API runs these jobs itself (workers/embedded.ts).
 */

const shutdownController = new AbortController();

async function handleVideo(job: Job<VideoJobData>) {
  try {
    return await runVideoJob(job.data.uploadJobId, {
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? 1,
      signal: shutdownController.signal,
      onProgress: (percent) => job.updateProgress(percent),
    });
  } catch (error) {
    if (error instanceof PermanentVideoError) throw new UnrecoverableError(error.message);
    throw error;
  }
}

async function main() {
  if (config.queueDriver !== 'redis') {
    logger.error('REDIS_URL is not set: background jobs already run inside the API process (npm run dev / npm start).');
    process.exit(1);
  }
  await ensureStorageLayout();
  const connection = createRedisConnection('worker');
  const common = { connection, prefix: QUEUE_PREFIX };

  const workers = [
    new Worker<VideoJobData>(QueueName.video, handleVideo, {
      ...common,
      concurrency: config.media.workerConcurrency,
      lockDuration: 120_000,
    }),
    new Worker<NotificationJobData>(QueueName.notifications, (job) => runNotificationJob(job.data), {
      ...common,
      concurrency: 2,
    }),
    new Worker<MaintenanceJobData>(QueueName.maintenance, (job) => runMaintenance(job.data.task), {
      ...common,
      concurrency: 1,
    }),
  ];

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      logger.error(
        { queue: worker.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: error },
        'Job failed',
      );
    });
    worker.on('completed', (job) => logger.info({ queue: worker.name, jobId: job.id }, 'Job completed'));
  }

  const { maintenance } = getQueues();
  for (const { task, everyMs } of MAINTENANCE_SCHEDULE) {
    await maintenance.upsertJobScheduler(`schedule-${task}`, { every: everyMs }, { name: task, data: { task } });
  }
  logger.info({ concurrency: config.media.workerConcurrency }, 'Worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker');
    shutdownController.abort();
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await Promise.allSettled([closeQueues(), connection.quit(), prisma.$disconnect()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Worker failed to start');
  process.exit(1);
});
