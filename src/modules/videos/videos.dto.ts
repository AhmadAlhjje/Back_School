import type { UploadJob, Video } from '../../generated/prisma/client.js';

/**
 * What dashboard users see. `displayStatus` is the only state the UI renders
 * (جاري الرفع / جاهز / فشل): internal processing stages are folded into UPLOADING.
 */
export type VideoDisplayStatus = 'UPLOADING' | 'READY' | 'FAILED';

export function displayStatus(video: Pick<Video, 'status'>): VideoDisplayStatus {
  if (video.status === 'READY') return 'READY';
  if (video.status === 'FAILED') return 'FAILED';
  return 'UPLOADING';
}

export function toStaffVideoDto(video: Video & { uploadJobs?: UploadJob[] }) {
  const latestJob = video.uploadJobs?.[0] ?? null;
  return {
    id: video.id,
    sessionId: video.sessionId,
    title: video.title,
    description: video.description,
    sortOrder: video.sortOrder,
    status: video.status,
    displayStatus: displayStatus(video),
    durationSeconds: video.durationSeconds,
    readyAt: video.readyAt,
    archivedAt: video.archivedAt,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt,
    upload: latestJob
      ? {
          id: latestJob.id,
          status: latestJob.status,
          originalFileName: latestJob.originalFileName,
          sizeBytes: latestJob.sizeBytes,
          chunkSize: latestJob.chunkSize,
          totalChunks: latestJob.totalChunks,
        }
      : null,
  };
}
