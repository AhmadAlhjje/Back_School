import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../../config/env.js';
import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { logger } from '../../core/logger/logger.js';
import { enqueueVideoProcessing } from '../../core/queue/queues.js';
import { fileExtension, VIDEO_EXTENSIONS } from '../../core/storage/file-types.js';
import {
  ensureStorageDir,
  removeStoragePath,
  resolveStorageKey,
  StorageArea,
  storageKey,
} from '../../core/storage/storage.js';
import type { UploadJob } from '../../generated/prisma/client.js';
import { nextSortOrder } from '../catalog/lifecycle.js';
import { toStaffVideoDto } from './videos.dto.js';

/**
 * Chunked, resumable video upload.
 *
 *   POST   /videos                          → video (UPLOADING) + upload job + chunk plan
 *   PUT    /videos/:id/upload/chunks/:index → raw bytes of one chunk (idempotent, retryable)
 *   GET    /videos/:id/upload               → which chunks the server already has (resume)
 *   POST   /videos/:id/upload/complete      → verify, then queue background processing
 *
 * Chunks stream to disk; a multi-hour, multi-GB video never sits in memory or in one request.
 */

export interface UploadPlanInput {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

function planUpload(input: UploadPlanInput) {
  const extension = fileExtension(input.fileName);
  if (!VIDEO_EXTENSIONS.has(extension)) throw new AppError('INVALID_FILE_TYPE', { details: { extension } });
  if (input.fileSize > config.media.maxVideoSizeBytes) {
    throw new AppError('FILE_TOO_LARGE', { details: { maxBytes: config.media.maxVideoSizeBytes } });
  }
  const chunkSize = config.media.chunkSizeBytes;
  return {
    originalFileName: input.fileName.slice(0, 255),
    mimeType: input.mimeType.slice(0, 100) || 'application/octet-stream',
    sizeBytes: BigInt(input.fileSize),
    chunkSize,
    totalChunks: Math.max(1, Math.ceil(input.fileSize / chunkSize)),
  };
}

const chunkDir = (jobId: string) => storageKey(StorageArea.uploads, jobId);
const chunkKey = (jobId: string, index: number) => storageKey(chunkDir(jobId), `${index}.part`);

function expectedChunkSize(job: UploadJob, index: number): number {
  if (index < job.totalChunks - 1) return job.chunkSize;
  return Number(job.sizeBytes) - job.chunkSize * (job.totalChunks - 1);
}

export async function receivedChunkIndexes(jobId: string): Promise<number[]> {
  try {
    const names = await fs.readdir(resolveStorageKey(chunkDir(jobId)));
    return names
      .map((name) => /^(\d+)\.part$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function uploadPlanDto(job: UploadJob, receivedChunks: number[]) {
  return {
    id: job.id,
    status: job.status,
    chunkSize: job.chunkSize,
    totalChunks: job.totalChunks,
    sizeBytes: job.sizeBytes,
    receivedChunks,
  };
}

export async function createVideoUpload(
  input: UploadPlanInput & { sessionId: string; title: string; description: string | null },
  actor: AuditActor,
) {
  const plan = planUpload(input);
  const session = await prisma.session.findUnique({ where: { id: input.sessionId } });
  if (!session) throw notFound('session');
  if (session.archivedAt) throw new AppError('PARENT_ARCHIVED');

  const { video, job } = await prisma.$transaction(async (tx) => {
    const order = await tx.video.aggregate({
      where: { sessionId: input.sessionId },
      _max: { sortOrder: true },
    });
    const createdVideo = await tx.video.create({
      data: {
        sessionId: input.sessionId,
        title: input.title,
        description: input.description,
        sortOrder: nextSortOrder(order),
        status: 'UPLOADING',
      },
    });
    const createdJob = await tx.uploadJob.create({ data: { videoId: createdVideo.id, ...plan } });
    await writeAudit(tx, actor, {
      action: AuditAction.UPLOAD_VIDEO,
      entityType: 'video',
      entityId: createdVideo.id,
      metadata: { title: createdVideo.title, fileName: plan.originalFileName, sizeBytes: input.fileSize },
    });
    return { video: createdVideo, job: createdJob };
  });
  await ensureStorageDir(chunkDir(job.id));
  return { video: toStaffVideoDto({ ...video, uploadJobs: [job] }), upload: uploadPlanDto(job, []) };
}

async function activeUploadJob(videoId: string): Promise<UploadJob> {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: { uploadJobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!video) throw notFound('video');
  const job = video.uploadJobs[0];
  if (!job || job.status !== 'UPLOADING') throw new AppError('INVALID_UPLOAD_STATE');
  return job;
}

export async function getUploadStatus(videoId: string) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: { uploadJobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!video) throw notFound('video');
  const job = video.uploadJobs[0];
  if (!job) throw new AppError('INVALID_UPLOAD_STATE');
  const received = job.status === 'UPLOADING' ? await receivedChunkIndexes(job.id) : [];
  return { video: toStaffVideoDto(video), upload: uploadPlanDto(job, received) };
}

/**
 * Streams one chunk to disk, enforcing its exact expected size. `source` is the request body
 * (or any stream, e.g. the demo seeder); `declaredLength` is the Content-Length when known.
 */
export async function receiveChunk(
  videoId: string,
  index: number,
  source: Readable,
  declaredLength?: number,
) {
  const job = await activeUploadJob(videoId);
  if (!Number.isInteger(index) || index < 0 || index >= job.totalChunks) {
    throw new AppError('VALIDATION_ERROR', { details: { reason: 'CHUNK_INDEX_OUT_OF_RANGE' } });
  }
  const expected = expectedChunkSize(job, index);
  const declared = declaredLength ?? Number.NaN;
  if (Number.isFinite(declared) && declared !== expected) {
    throw new AppError('VALIDATION_ERROR', { details: { reason: 'CHUNK_SIZE_MISMATCH', expected } });
  }

  const finalPath = resolveStorageKey(chunkKey(job.id, index));
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  let received = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > expected) callback(new AppError('FILE_TOO_LARGE', { details: { expected } }));
      else callback(null, chunk);
    },
  });

  await ensureStorageDir(chunkDir(job.id));
  try {
    await pipeline(source, guard, createWriteStream(tempPath));
    if (received !== expected) {
      throw new AppError('UPLOAD_FAILED', { details: { reason: 'CHUNK_SIZE_MISMATCH', expected, received } });
    }
    // Atomic publish: a chunk file either exists complete or not at all.
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if (error instanceof AppError) throw error;
    throw new AppError('UPLOAD_FAILED', { cause: error, details: { reason: 'STREAM_ERROR' } });
  }
  return { index, sizeBytes: received };
}

/** Verifies every chunk arrived, then hands the video to the background worker. */
export async function completeUpload(videoId: string, actor: AuditActor) {
  const job = await activeUploadJob(videoId);
  const received = new Set(await receivedChunkIndexes(job.id));
  const missing: number[] = [];
  for (let i = 0; i < job.totalChunks && missing.length < 50; i += 1) {
    if (!received.has(i)) missing.push(i);
  }
  if (missing.length > 0) throw new AppError('UPLOAD_INCOMPLETE', { details: { missingChunks: missing } });

  await prisma.$transaction(async (tx) => {
    const updated = await tx.uploadJob.updateMany({
      where: { id: job.id, status: 'UPLOADING' },
      data: { status: 'QUEUED', uploadedAt: new Date() },
    });
    if (updated.count !== 1) throw new AppError('INVALID_UPLOAD_STATE');
    await tx.video.update({ where: { id: videoId }, data: { status: 'PROCESSING' } });
  });

  try {
    await enqueueVideoProcessing({ uploadJobId: job.id });
  } catch (error) {
    // Queue unavailable: roll the state back so the client can simply call complete again.
    logger.error({ err: error, uploadJobId: job.id }, 'Failed to enqueue video processing');
    await prisma.$transaction([
      prisma.uploadJob.update({ where: { id: job.id }, data: { status: 'UPLOADING', uploadedAt: null } }),
      prisma.video.update({ where: { id: videoId }, data: { status: 'UPLOADING' } }),
    ]);
    throw new AppError('SERVICE_UNAVAILABLE');
  }
  logger.info({ videoId, uploadJobId: job.id, actor: actor.userId }, 'Video upload completed and queued');
  return getUploadStatus(videoId);
}

/** Starts a fresh upload for a video whose previous upload failed or was abandoned. */
export async function restartUpload(videoId: string, input: UploadPlanInput, actor: AuditActor) {
  const plan = planUpload(input);
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: { uploadJobs: { where: { status: { in: ['UPLOADING', 'FAILED'] } } } },
  });
  if (!video) throw notFound('video');
  if (video.status === 'READY' || video.status === 'PROCESSING') throw new AppError('INVALID_UPLOAD_STATE');

  const job = await prisma.$transaction(async (tx) => {
    await tx.uploadJob.updateMany({
      where: { videoId, status: 'UPLOADING' },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    const created = await tx.uploadJob.create({ data: { videoId, ...plan } });
    await tx.video.update({ where: { id: videoId }, data: { status: 'UPLOADING' } });
    await writeAudit(tx, actor, {
      action: AuditAction.UPLOAD_VIDEO,
      entityType: 'video',
      entityId: videoId,
      metadata: { restarted: true, fileName: plan.originalFileName, sizeBytes: input.fileSize },
    });
    return created;
  });
  for (const previous of video.uploadJobs) await removeStoragePath(chunkDir(previous.id));
  await ensureStorageDir(chunkDir(job.id));
  return getUploadStatus(videoId);
}
