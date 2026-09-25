import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../../config/env.js';
import { prisma } from '../../core/database/prisma.js';
import { logger } from '../../core/logger/logger.js';
import { sealSecret } from '../../core/security/crypto.js';
import { fileExtension } from '../../core/storage/file-types.js';
import {
  directorySize,
  ensureStorageDir,
  removeStoragePath,
  resolveStorageKey,
  StorageArea,
  storageKey,
} from '../../core/storage/storage.js';
import { publishNotificationSafely } from '../../modules/notifications/notify.js';
import { copyableRendition, planRenditions, probeVideo, transcodeToHls } from './ffmpeg.js';

/** A failure that retrying cannot fix (e.g. the upload is not a video). */
export class PermanentVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentVideoError';
  }
}

const chunkDirKey = (jobId: string) => storageKey(StorageArea.uploads, jobId);
const workDirKey = (jobId: string) => storageKey(StorageArea.work, jobId);

/** Concatenates the uploaded chunks, in order, into one source file (streaming). */
async function assembleSource(jobId: string, totalChunks: number, expectedBytes: number, targetPath: string) {
  try {
    const existing = await fs.stat(targetPath);
    if (existing.size === expectedBytes) return; // assembled by a previous attempt
  } catch {
    // not assembled yet
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const partial = `${targetPath}.partial`;
  const out = createWriteStream(partial);
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const chunkPath = resolveStorageKey(storageKey(chunkDirKey(jobId), `${index}.part`));
      await pipeline(createReadStream(chunkPath), out, { end: false });
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
  }
  const size = (await fs.stat(partial)).size;
  if (size !== expectedBytes) {
    await fs.rm(partial, { force: true });
    throw new PermanentVideoError(`Assembled size ${size} does not match declared size ${expectedBytes}`);
  }
  await fs.rename(partial, targetPath);
}

export interface ProcessOptions {
  onProgress?: (percent: number) => Promise<void> | void;
  signal?: AbortSignal;
}

/**
 * Upload → HLS pipeline for one upload job. Idempotent and retry-safe:
 * chunks are only deleted after the video is READY, and output is published atomically.
 */
export async function processVideoJob(
  uploadJobId: string,
  options: ProcessOptions = {},
): Promise<'processed' | 'skipped'> {
  const job = await prisma.uploadJob.findUnique({ where: { id: uploadJobId }, include: { video: true } });
  if (!job || job.status === 'COMPLETED' || job.status === 'CANCELLED' || job.status === 'UPLOADING')
    return 'skipped';

  const log = logger.child({ uploadJobId, videoId: job.videoId });
  await prisma.uploadJob.update({
    where: { id: job.id },
    data: {
      status: 'PROCESSING',
      attempts: { increment: 1 },
      startedAt: new Date(),
      errorMessage: null,
      progressPercent: 0,
    },
  });
  // Progress for the queue and, every 2%, for the dashboard ("preparing the video X%").
  let savedPercent = 0;
  const progress = async (percent: number) => {
    await options.onProgress?.(percent);
    if (percent - savedPercent < 2) return;
    savedPercent = percent;
    await prisma.uploadJob
      .update({ where: { id: job.id }, data: { progressPercent: percent } })
      .catch((error: unknown) => log.debug({ err: error }, 'Could not save the progress'));
  };
  log.info('Video processing started');

  const extension = fileExtension(job.originalFileName) || 'mp4';
  const sourceKey = config.media.keepOriginalVideos
    ? storageKey(StorageArea.originals, job.videoId, `${job.id}.${extension}`)
    : storageKey(workDirKey(job.id), `source.${extension}`);
  const sourcePath = resolveStorageKey(sourceKey);
  const workDir = await ensureStorageDir(workDirKey(job.id));
  const outputDir = path.join(workDir, 'hls');
  await fs.rm(outputDir, { recursive: true, force: true });

  // 1. Assemble chunks.
  await assembleSource(job.id, job.totalChunks, Number(job.sizeBytes), sourcePath);
  await progress(2);

  // 2. Probe.
  let probe;
  try {
    probe = await probeVideo(sourcePath);
  } catch (error) {
    throw new PermanentVideoError(`ffprobe failed: ${(error as Error).message}`);
  }
  if (!probe || probe.durationSeconds <= 0)
    throw new PermanentVideoError('File has no playable video stream');

  // 3. Per-video AES-128 key. The key file exists only inside the private work dir.
  const key = randomBytes(16);
  const iv = randomBytes(16).toString('hex');
  const keyPath = path.join(workDir, 'enc.key');
  const keyInfoPath = path.join(workDir, 'enc.keyinfo');
  await fs.writeFile(keyPath, key, { mode: 0o600 });
  // Line 1 is a placeholder URI: the API rewrites it per request to the authorizing key endpoint.
  await fs.writeFile(keyInfoPath, `key\n${keyPath.replace(/\\/g, '/')}\n${iv}\n`, { mode: 0o600 });

  // 4. Transcode + segment + encrypt.
  const renditions = planRenditions(probe.height, config.media.renditionHeights);
  const copyIndex = copyableRendition(probe, renditions);
  log.info(
    {
      height: probe.height,
      codec: probe.videoCodec,
      kbps: probe.videoBitrateKbps,
      fps: probe.frameRate,
      copyIndex,
    },
    copyIndex >= 0 ? 'Largest rendition taken from the upload as it is' : 'All renditions encoded',
  );
  await fs.mkdir(outputDir, { recursive: true });
  await transcodeToHls({
    inputPath: sourcePath,
    outputDir: outputDir.replace(/\\/g, '/'),
    keyInfoPath,
    renditions,
    copyIndex,
    sourceFrameRate: probe.frameRate,
    hasAudio: probe.hasAudio,
    segmentSeconds: config.media.segmentSeconds,
    preset: config.media.ffmpegPreset,
    durationSeconds: probe.durationSeconds,
    onProgress: (percent) => void progress(Math.max(3, percent)),
    signal: options.signal,
  });
  await fs.rm(keyPath, { force: true });
  await fs.access(path.join(outputDir, 'master.m3u8'));

  // 5. Publish atomically into the video's directory.
  const assetKey = storageKey(StorageArea.videos, job.videoId, job.id);
  const assetPath = resolveStorageKey(assetKey);
  await fs.rm(assetPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
  await fs.rename(outputDir, assetPath);
  const sizeBytes = await directorySize(assetKey);

  const previous = await prisma.videoAsset.findUnique({ where: { videoId: job.videoId } });
  const renditionRecords = renditions.map((r) => ({
    name: r.name,
    height: r.height,
    bandwidth: (r.videoBitrateKbps + (probe.hasAudio ? r.audioBitrateKbps : 0)) * 1000,
  }));
  const assetData = {
    storageKey: assetKey,
    encryptedKey: sealSecret(key),
    renditions: renditionRecords,
    segmentDurationSeconds: config.media.segmentSeconds,
    sizeBytes: BigInt(sizeBytes),
    sourceWidth: probe.width,
    sourceHeight: probe.height,
  };
  const hadReadyVideos = await prisma.video.count({
    where: { sessionId: job.video.sessionId, status: 'READY', archivedAt: null, id: { not: job.videoId } },
  });
  await prisma.$transaction([
    prisma.videoAsset.upsert({
      where: { videoId: job.videoId },
      create: { videoId: job.videoId, ...assetData },
      update: assetData,
    }),
    prisma.video.update({
      where: { id: job.videoId },
      data: { status: 'READY', durationSeconds: Math.round(probe.durationSeconds), readyAt: new Date() },
    }),
    prisma.uploadJob.update({
      where: { id: job.id },
      data: { status: 'COMPLETED', finishedAt: new Date(), progressPercent: 100 },
    }),
  ]);
  await options.onProgress?.(100);
  log.info(
    { durationSeconds: probe.durationSeconds, renditions: renditions.length, sizeBytes },
    'Video ready',
  );

  // 6. Cleanup (only after success, so retries always have their inputs).
  if (previous && previous.storageKey !== assetKey) await removeStoragePath(previous.storageKey);
  await removeStoragePath(chunkDirKey(job.id));
  await removeStoragePath(workDirKey(job.id));

  // 7. Tell students who can open this teacher's content.
  await notifyStudents(job.videoId, hadReadyVideos === 0);
  return 'processed';
}

async function notifyStudents(videoId: string, firstInSession: boolean) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: {
      session: {
        include: {
          topic: { include: { subjectTeacher: { include: { subject: true, teacher: true } } } },
        },
      },
    },
  });
  if (!video || video.archivedAt) return;
  const { topic } = video.session;
  const { subjectTeacher } = topic;
  await publishNotificationSafely({
    type: firstInSession ? 'NEW_LESSON' : 'NEW_VIDEO',
    title: firstInSession ? 'درس جديد' : 'فيديو جديد',
    body: firstInSession
      ? `${video.session.title} — ${subjectTeacher.subject.name} / ${subjectTeacher.teacher.name}`
      : `${video.title} — ${video.session.title}`,
    data: {
      videoId: video.id,
      sessionId: video.sessionId,
      topicId: topic.id,
      subjectTeacherId: subjectTeacher.id,
      subjectId: subjectTeacher.subjectId,
    },
    audience: { kind: 'SUBJECT_TEACHER', subjectTeacherId: subjectTeacher.id },
  });
}

/** Records a terminal failure: the dashboard then shows "فشل" with a retry (re-upload) action. */
export async function markVideoFailed(uploadJobId: string, reason: string): Promise<void> {
  const job = await prisma.uploadJob.findUnique({ where: { id: uploadJobId } });
  if (!job) return;
  await prisma.$transaction([
    prisma.uploadJob.update({
      where: { id: uploadJobId },
      data: { status: 'FAILED', errorMessage: reason.slice(0, 1000), finishedAt: new Date() },
    }),
    prisma.video.update({ where: { id: job.videoId }, data: { status: 'FAILED' } }),
  ]);
  await removeStoragePath(workDirKey(uploadJobId));
  logger.warn({ uploadJobId, videoId: job.videoId, reason }, 'Video processing failed permanently');
}
