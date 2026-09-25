import { prisma } from '../core/database/prisma.js';
import type { NotificationJobData } from '../core/queue/queues.js';
import { deliverNotification } from '../modules/notifications/notifications.service.js';
import { markVideoFailed, PermanentVideoError, processVideoJob } from './video/process-video.js';

/** Job handlers shared by the Redis worker process and the in-process (embedded) worker. */

export interface VideoJobContext {
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
  onProgress?: (percent: number) => Promise<void> | void;
}

/**
 * Processes one upload. Failure policy: a permanent error (not a video) fails the video at once;
 * other errors mark it FAILED only on the last attempt, otherwise put it back in QUEUED. A
 * shutdown leaves the job as it is so it is resumed after the restart.
 */
export async function runVideoJob(uploadJobId: string, context: VideoJobContext) {
  try {
    return await processVideoJob(uploadJobId, { onProgress: context.onProgress, signal: context.signal });
  } catch (error) {
    if (context.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PermanentVideoError) {
      await markVideoFailed(uploadJobId, message);
    } else if (context.attempt >= context.maxAttempts) {
      await markVideoFailed(uploadJobId, message);
    } else {
      await prisma.uploadJob.update({
        where: { id: uploadJobId },
        data: { status: 'QUEUED', errorMessage: message.slice(0, 1000) },
      });
    }
    throw error;
  }
}

export async function runNotificationJob(data: NotificationJobData) {
  return { delivered: await deliverNotification(data.notificationId, data.audience) };
}

export { PermanentVideoError };
