import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../core/database/prisma.js';
import { logger } from '../core/logger/logger.js';
import { enqueueVideoProcessing, type MaintenanceTask } from '../core/queue/queues.js';
import { removeStoragePath, resolveStorageKey, StorageArea, storageKey } from '../core/storage/storage.js';
import { cleanupExpiredLicenses } from '../modules/student-portal/offline.service.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Expired refresh tokens and long-dead sessions are technical data; everything else is kept. */
async function cleanupAuth() {
  const tokens = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - DAY_MS) } },
  });
  const sessions = await prisma.authSession.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(Date.now() - 30 * DAY_MS) } },
        { revokedAt: { lt: new Date(Date.now() - 30 * DAY_MS) } },
      ],
    },
  });
  return { refreshTokens: tokens.count, sessions: sessions.count };
}

/**
 * - Uploads abandoned for 3 days are cancelled and their chunks deleted.
 * - Jobs stuck in QUEUED (e.g. Redis was flushed) are re-enqueued (idempotent by job id).
 * - Orphaned multipart temp files older than a day are removed.
 */
async function cleanupStaleUploads() {
  const abandoned = await prisma.uploadJob.findMany({
    where: { status: 'UPLOADING', updatedAt: { lt: new Date(Date.now() - 3 * DAY_MS) } },
    select: { id: true, videoId: true },
  });
  for (const job of abandoned) {
    await prisma.$transaction([
      prisma.uploadJob.update({
        where: { id: job.id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      }),
      prisma.video.updateMany({
        where: { id: job.videoId, status: 'UPLOADING' },
        data: { status: 'FAILED' },
      }),
    ]);
    await removeStoragePath(storageKey(StorageArea.uploads, job.id));
  }

  const stuck = await prisma.uploadJob.findMany({
    where: { status: 'QUEUED', updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } },
    select: { id: true },
  });
  for (const job of stuck) await enqueueVideoProcessing({ uploadJobId: job.id });

  let orphans = 0;
  const uploadsDir = resolveStorageKey(StorageArea.uploads);
  const entries = await fs.readdir(uploadsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.upload')) continue;
    const fullPath = path.join(uploadsDir, entry.name);
    const stat = await fs.stat(fullPath);
    if (Date.now() - stat.mtimeMs > DAY_MS) {
      await fs.rm(fullPath, { force: true });
      orphans += 1;
    }
  }
  return { abandoned: abandoned.length, requeued: stuck.length, orphans };
}

export async function runMaintenance(task: MaintenanceTask) {
  const result =
    task === 'cleanup-auth'
      ? await cleanupAuth()
      : task === 'cleanup-stale-uploads'
        ? await cleanupStaleUploads()
        : { offlineLicenses: await cleanupExpiredLicenses() };
  logger.info({ task, result }, 'Maintenance task finished');
  return result;
}

export const MAINTENANCE_SCHEDULE: { task: MaintenanceTask; everyMs: number }[] = [
  { task: 'cleanup-auth', everyMs: 6 * HOUR_MS },
  { task: 'cleanup-stale-uploads', everyMs: HOUR_MS },
  { task: 'cleanup-offline-licenses', everyMs: 12 * HOUR_MS },
];
