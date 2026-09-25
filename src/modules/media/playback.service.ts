import { config } from '../../config/env.js';
import type { AuthContext } from '../../core/auth/auth-context.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { assertFileAccess, assertVideoAccess } from '../access/access-policy.js';
import { FILE_TOKEN_TTL_SECONDS, playbackTtlSeconds, signMediaToken } from './media-token.js';

const MEDIA_BASE = `${config.apiBaseUrl}/api/v1/media`;

function manifestUrl(videoId: string, token: string) {
  return `${MEDIA_BASE}/videos/${videoId}/master.m3u8?token=${encodeURIComponent(token)}`;
}

/**
 * Student playback grant (spec §102): token → session → device → student → access → READY,
 * then a temporary, device-bound manifest URL.
 */
export async function issueStudentPlayback(auth: AuthContext, videoId: string) {
  const video = await assertVideoAccess(auth.userId, videoId);
  const { token, expiresAt } = signMediaToken(
    {
      kind: 'video',
      rid: video.id,
      sub: auth.userId,
      role: auth.role,
      sid: auth.sessionId,
      did: auth.deviceId,
    },
    playbackTtlSeconds(video.durationSeconds),
  );
  return {
    videoId: video.id,
    title: video.title,
    durationSeconds: video.durationSeconds,
    manifestUrl: manifestUrl(video.id, token),
    expiresAt,
  };
}

/** Owner/admin preview of any processed video (including archived ones). */
export async function issueStaffPreview(auth: AuthContext, videoId: string) {
  const video = await prisma.video.findUnique({ where: { id: videoId }, include: { asset: true } });
  if (!video) throw new AppError('VIDEO_NOT_FOUND');
  if (video.status !== 'READY' || !video.asset) throw new AppError('VIDEO_NOT_READY');
  const { token, expiresAt } = signMediaToken(
    { kind: 'video', rid: video.id, sub: auth.userId, role: auth.role, sid: auth.sessionId, did: null },
    playbackTtlSeconds(video.durationSeconds),
  );
  return {
    videoId: video.id,
    title: video.title,
    durationSeconds: video.durationSeconds,
    manifestUrl: manifestUrl(video.id, token),
    expiresAt,
  };
}

/** Student file download grant: 5-minute URL after a full access check (spec §40). */
export async function issueStudentFileAccess(auth: AuthContext, fileId: string) {
  const file = await assertFileAccess(auth.userId, fileId);
  const { token, expiresAt } = signMediaToken(
    {
      kind: 'file',
      rid: file.id,
      sub: auth.userId,
      role: auth.role,
      sid: auth.sessionId,
      did: auth.deviceId,
    },
    FILE_TOKEN_TTL_SECONDS,
  );
  return {
    fileId: file.id,
    title: file.title,
    kind: file.kind,
    extension: file.extension,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    url: `${MEDIA_BASE}/files/${file.id}?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}
