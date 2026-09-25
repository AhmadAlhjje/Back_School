import { prisma } from '../core/database/prisma.js';
import { logger } from '../core/logger/logger.js';
import { NonRetryableJobError } from '../core/queue/memory-queue.js';
import { enqueueVideoProcessing, getMemoryQueues } from '../core/queue/queues.js';
import { PermanentVideoError, runNotificationJob, runVideoJob } from './handlers.js';
import { MAINTENANCE_SCHEDULE, runMaintenance } from './maintenance.js';

/**
 * Runs the background jobs inside the API process when no Redis is configured
 * (`npm run dev` with only MySQL). Same handlers as the Redis worker (workers/index.ts).
 */
export async function startEmbeddedWorker(): Promise<{ stop: () => Promise<void> }> {
  const queues = getMemoryQueues();

  queues.video.process(async (data, context) => {
    try {
      return await runVideoJob(data.uploadJobId, context);
    } catch (error) {
      if (error instanceof PermanentVideoError) throw new NonRetryableJobError(error.message);
      throw error;
    }
  });
  queues.notifications.process((data) => runNotificationJob(data));
  queues.maintenance.process((data) => runMaintenance(data.task));

  const timers = MAINTENANCE_SCHEDULE.map(({ task, everyMs }) =>
    setInterval(
      () => queues.maintenance.add(`${task}-${Date.now()}`, { task }, { attempts: 1, backoffMs: 0 }),
      everyMs,
    ),
  );

  // Uploads that were queued or being processed when the process stopped are resumed now.
  const pending = await prisma.uploadJob.findMany({
    where: { status: { in: ['QUEUED', 'PROCESSING'] } },
    select: { id: true },
  });
  for (const job of pending) await enqueueVideoProcessing({ uploadJobId: job.id });

  logger.info({ resumedUploads: pending.length }, 'Background jobs run inside the API (no REDIS_URL)');

  return {
    stop: async () => {
      for (const timer of timers) clearInterval(timer);
      await Promise.all([queues.video.close(), queues.notifications.close(), queues.maintenance.close()]);
    },
  };
}
