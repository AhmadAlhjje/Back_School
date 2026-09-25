import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { securityLogger } from '../../core/logger/logger.js';
import { assertFileAccess, assertVideoAccess } from '../access/access-policy.js';
import type { MediaClaims } from './media-token.js';

/**
 * Re-validates the identity behind a media token on every media request:
 * session live, account active, device still bound (students), and access still granted.
 *
 * Segment requests arrive every few seconds per viewer, so positive results are cached briefly
 * (per session + resource). Key requests and grants always bypass the cache.
 */
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 10_000;
const allowCache = new Map<string, number>();

function cacheKey(claims: MediaClaims) {
  return `${claims.sid}:${claims.kind}:${claims.rid}`;
}

async function assertSessionLive(claims: MediaClaims) {
  const session = await prisma.authSession.findUnique({
    where: { id: claims.sid },
    select: {
      userId: true,
      revokedAt: true,
      expiresAt: true,
      deviceId: true,
      user: { select: { status: true, archivedAt: true, role: true } },
      device: { select: { status: true } },
    },
  });
  const now = new Date();
  if (
    !session ||
    session.userId !== claims.sub ||
    session.revokedAt ||
    session.expiresAt <= now ||
    session.user.archivedAt ||
    session.user.status !== 'ACTIVE' ||
    session.user.role !== claims.role
  ) {
    throw new AppError('MEDIA_TOKEN_INVALID');
  }
  if (claims.role === 'STUDENT') {
    if (!session.device || session.device.status !== 'ACTIVE' || session.deviceId !== claims.did) {
      securityLogger.warn({ sessionId: claims.sid }, 'Media request from a reset or mismatched device');
      throw new AppError('MEDIA_TOKEN_INVALID');
    }
  }
}

export async function assertMediaAllowed(claims: MediaClaims, options: { fresh: boolean }): Promise<void> {
  const key = cacheKey(claims);
  if (!options.fresh) {
    const until = allowCache.get(key);
    if (until && until > Date.now()) return;
  }

  await assertSessionLive(claims);
  if (claims.role === 'STUDENT') {
    try {
      if (claims.kind === 'file') await assertFileAccess(claims.sub, claims.rid);
      else await assertVideoAccess(claims.sub, claims.rid);
    } catch (error) {
      allowCache.delete(key);
      if (error instanceof AppError)
        throw new AppError('MEDIA_TOKEN_INVALID', { details: { reason: error.code } });
      throw error;
    }
  }

  if (allowCache.size >= MAX_CACHE_ENTRIES) allowCache.clear();
  allowCache.set(key, Date.now() + CACHE_TTL_MS);
}

/** Test hook: forget cached decisions. */
export function clearMediaGuardCache(): void {
  allowCache.clear();
}
