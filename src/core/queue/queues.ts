import { Queue, type JobsOptions } from 'bullmq';
import { config } from '../../config/env.js';
import { MemoryQueue } from './memory-queue.js';
import { createRedisConnection } from './redis.js';

/**
 * Background jobs, independent of where they run:
 * - `redis` driver (REDIS_URL set, production): BullMQ queues consumed by the worker process.
 * - `memory` driver (no REDIS_URL, local development): in-process queues consumed by the API
 *   itself (see workers/embedded.ts), so MySQL is the only service needed.
 */
export const QueueName = {
  video: 'video-processing',
  notifications: 'notifications',
  maintenance: 'maintenance',
} as const;

export const QUEUE_PREFIX = config.isTest ? 'edu-test' : 'edu';

export interface VideoJobData {
  uploadJobId: string;
}

export type NotificationAudience =
  | { kind: 'ALL_STUDENTS' }
  | { kind: 'GRADE'; gradeId: string }
  | { kind: 'SUBJECT'; subjectId: string }
  | { kind: 'SUBJECT_TEACHER'; subjectTeacherId: string }
  | { kind: 'STUDENTS'; studentIds: string[] };

export interface NotificationJobData {
  notificationId: string;
  audience: NotificationAudience;
}

export type MaintenanceTask = 'cleanup-auth' | 'cleanup-stale-uploads' | 'cleanup-offline-licenses';

export interface MaintenanceJobData {
  task: MaintenanceTask;
}

/** Retry policy per job type, shared by both drivers. */
export const JobPolicy = {
  video: { attempts: 2, backoffMs: 60_000 },
  notifications: { attempts: 5, backoffMs: 5_000 },
} as const;

// ─── Redis (BullMQ) ─────────────────────────────────────────────────────────

const defaultJobOptions: JobsOptions = {
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

let bullQueues: {
  video: Queue<VideoJobData>;
  notifications: Queue<NotificationJobData>;
  maintenance: Queue<MaintenanceJobData>;
} | null = null;

export function getQueues() {
  if (!bullQueues) {
    const connection = createRedisConnection('queue');
    const options = { connection, prefix: QUEUE_PREFIX, defaultJobOptions };
    bullQueues = {
      video: new Queue<VideoJobData>(QueueName.video, options),
      notifications: new Queue<NotificationJobData>(QueueName.notifications, options),
      maintenance: new Queue<MaintenanceJobData>(QueueName.maintenance, options),
    };
  }
  return bullQueues;
}

// ─── In-process ─────────────────────────────────────────────────────────────

let memoryQueues: {
  video: MemoryQueue<VideoJobData>;
  notifications: MemoryQueue<NotificationJobData>;
  maintenance: MemoryQueue<MaintenanceJobData>;
} | null = null;

export function getMemoryQueues() {
  memoryQueues ??= {
    video: new MemoryQueue<VideoJobData>(QueueName.video, config.media.workerConcurrency),
    notifications: new MemoryQueue<NotificationJobData>(QueueName.notifications, 2),
    maintenance: new MemoryQueue<MaintenanceJobData>(QueueName.maintenance, 1),
  };
  return memoryQueues;
}

// ─── Producers ──────────────────────────────────────────────────────────────

export async function enqueueVideoProcessing(data: VideoJobData): Promise<void> {
  // jobId = uploadJobId makes enqueueing idempotent (a double "complete" cannot start two encodes).
  if (config.queueDriver === 'memory') {
    getMemoryQueues().video.add(data.uploadJobId, data, JobPolicy.video);
    return;
  }
  await getQueues().video.add('process-video', data, {
    jobId: data.uploadJobId,
    attempts: JobPolicy.video.attempts,
    backoff: { type: 'exponential', delay: JobPolicy.video.backoffMs },
  });
}

export async function enqueueNotificationFanout(data: NotificationJobData): Promise<void> {
  const jobId = `fanout-${data.notificationId}`;
  if (config.queueDriver === 'memory') {
    getMemoryQueues().notifications.add(jobId, data, JobPolicy.notifications);
    return;
  }
  await getQueues().notifications.add('fanout', data, {
    jobId,
    attempts: JobPolicy.notifications.attempts,
    backoff: { type: 'exponential', delay: JobPolicy.notifications.backoffMs },
  });
}

export async function closeQueues(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (bullQueues) {
    const current = bullQueues;
    bullQueues = null;
    tasks.push(current.video.close(), current.notifications.close(), current.maintenance.close());
  }
  if (memoryQueues) {
    const current = memoryQueues;
    memoryQueues = null;
    tasks.push(current.video.close(), current.notifications.close(), current.maintenance.close());
  }
  await Promise.all(tasks);
}
