import { AuditAction, writeAudit } from '../../core/audit/audit.js';
import type { AuthContext } from '../../core/auth/auth-context.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { config } from '../../config/env.js';
import { assertVideoAccess } from '../access/access-policy.js';
import { signMediaToken } from '../media/media-token.js';
import { getSettings } from '../settings/settings.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Time allowed to download all segments of the chosen rendition. */
const DOWNLOAD_TOKEN_TTL_SECONDS = 6 * 60 * 60;

interface Rendition {
  name: string;
  height: number;
  bandwidth: number;
}

/**
 * Offline license (spec §37). Permits the bound device to keep the *encrypted* HLS segments in
 * app-private storage and the AES key in the OS keystore, until `expiresAt`. The app must sync
 * licenses when online and purge anything that is no longer listed (revoked, expired, access
 * closed, device reset). The segments are never stored decrypted.
 */
export async function issueOfflineLicense(auth: AuthContext, videoId: string) {
  const settings = await getSettings();
  if (!settings.offlineDownloadsEnabled) throw new AppError('OFFLINE_DISABLED');
  if (!auth.deviceId) throw new AppError('DEVICE_REQUIRED');
  const video = await assertVideoAccess(auth.userId, videoId);
  const expiresAt = new Date(Date.now() + settings.offlineLicenseDays * DAY_MS);

  const license = await prisma.$transaction(async (tx) => {
    await tx.offlineLicense.updateMany({
      where: { studentId: auth.userId, deviceId: auth.deviceId!, videoId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const created = await tx.offlineLicense.create({
      data: { studentId: auth.userId, deviceId: auth.deviceId!, videoId, expiresAt },
    });
    await writeAudit(
      tx,
      { userId: auth.userId, role: auth.role, ip: null, userAgent: null },
      {
        action: AuditAction.ISSUE_OFFLINE_LICENSE,
        entityType: 'video',
        entityId: videoId,
        metadata: { licenseId: created.id, expiresAt: expiresAt.toISOString() },
      },
    );
    return created;
  });

  const { token } = signMediaToken(
    {
      kind: 'video',
      rid: videoId,
      sub: auth.userId,
      role: auth.role,
      sid: auth.sessionId,
      did: auth.deviceId,
    },
    DOWNLOAD_TOKEN_TTL_SECONDS,
  );
  const renditions = (video.asset.renditions as unknown as Rendition[]).map((r) => ({
    name: r.name,
    height: r.height,
    bandwidth: r.bandwidth,
  }));
  const base = `${config.apiBaseUrl}/api/v1/media/videos/${videoId}`;
  return {
    licenseId: license.id,
    videoId,
    title: video.title,
    durationSeconds: video.durationSeconds,
    expiresAt,
    renditions: renditions.map((rendition) => ({
      ...rendition,
      playlistUrl: `${base}/${rendition.name}/index.m3u8?token=${encodeURIComponent(token)}`,
    })),
  };
}

/**
 * Licenses still valid for this device. Grants whose access was closed meanwhile are revoked
 * here, so the app deletes those downloads on its next sync.
 */
export async function syncOfflineLicenses(auth: AuthContext) {
  if (!auth.deviceId) return { licenses: [] };
  const now = new Date();
  const licenses = await prisma.offlineLicense.findMany({
    where: { studentId: auth.userId, deviceId: auth.deviceId, revokedAt: null, expiresAt: { gt: now } },
    include: { video: { select: { title: true, durationSeconds: true } } },
  });
  const valid = [];
  for (const license of licenses) {
    try {
      await assertVideoAccess(auth.userId, license.videoId);
      valid.push({
        licenseId: license.id,
        videoId: license.videoId,
        title: license.video.title,
        durationSeconds: license.video.durationSeconds,
        expiresAt: license.expiresAt,
      });
    } catch {
      await prisma.offlineLicense.update({ where: { id: license.id }, data: { revokedAt: now } });
    }
  }
  return { licenses: valid };
}

export async function revokeOwnOfflineLicense(auth: AuthContext, licenseId: string) {
  const license = await prisma.offlineLicense.findFirst({ where: { id: licenseId, studentId: auth.userId } });
  if (!license) throw notFound('offline_license');
  if (!license.revokedAt) {
    await prisma.offlineLicense.update({ where: { id: licenseId }, data: { revokedAt: new Date() } });
  }
  return { revoked: true };
}

export async function cleanupExpiredLicenses(): Promise<number> {
  const result = await prisma.offlineLicense.updateMany({
    where: { revokedAt: null, expiresAt: { lt: new Date(Date.now() - DAY_MS) } },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
