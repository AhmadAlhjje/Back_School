import { config } from '../../config/env.js';
import type { AuthContext } from '../../core/auth/auth-context.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { assertFileAccess, assertVideoAccess } from '../access/access-policy.js';
import { FILE_TOKEN_TTL_SECONDS, playbackTtlSeconds, signMediaToken } from './media-token.js';

const MEDIA_PATH = '/api/v1/media';
const MEDIA_BASE = `${config.apiBaseUrl}${MEDIA_PATH}`;

function manifestUrl(base: string, videoId: string, token: string) {
  return `${base}/videos/${videoId}/master.m3u8?token=${encodeURIComponent(token)}`;
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
    manifestUrl: manifestUrl(MEDIA_BASE, video.id, token),
    expiresAt,
  };
}

/**
 * Owner/admin preview of any processed video (including archived ones). The manifest URL is
 * relative to the API: each dashboard resolves it against the address it calls the API on (in
 * Docker that is the dashboard's own site, whose Nginx forwards /api to the backend).
 */
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
    manifestUrl: manifestUrl(MEDIA_PATH, video.id, token),
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
