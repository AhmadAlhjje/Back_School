import jwt from 'jsonwebtoken';
import { config } from '../../config/env.js';
import { AppError } from '../../core/errors/app-error.js';
import type { UserRole } from '../../generated/prisma/enums.js';

/**
 * Signed, expiring media tokens. They travel in URLs (players cannot attach headers to every
 * segment request), so they are bound to one resource, one user, one auth session and — for
 * students — one device. A copied URL stops working when it expires, when the session ends,
 * when the device is reset, or when access is revoked.
 */
export type MediaKind = 'video' | 'file' | 'offline';

export interface MediaClaims {
  kind: MediaKind;
  /** Resource id (video or file). */
  rid: string;
  sub: string;
  role: UserRole;
  sid: string;
  did: string | null;
}

const ISSUER = 'edu-platform';
const AUDIENCE = 'edu-media';

export function signMediaToken(claims: MediaClaims, ttlSeconds: number): { token: string; expiresAt: Date } {
  const { sub, ...rest } = claims;
  const token = jwt.sign(rest, config.media.tokenSecret, {
    algorithm: 'HS256',
    subject: sub,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ttlSeconds,
  });
  return { token, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
}

export function verifyMediaToken(
  token: string | undefined,
  kind: MediaKind,
  resourceId: string,
): MediaClaims {
  if (!token) throw new AppError('MEDIA_TOKEN_INVALID');
  let payload: jwt.JwtPayload | string;
  try {
    payload = jwt.verify(token, config.media.tokenSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch {
    throw new AppError('MEDIA_TOKEN_INVALID');
  }
  if (
    typeof payload === 'string' ||
    payload.kind !== kind ||
    payload.rid !== resourceId ||
    typeof payload.sub !== 'string'
  ) {
    throw new AppError('MEDIA_TOKEN_INVALID');
  }
  return {
    kind,
    rid: resourceId,
    sub: payload.sub,
    role: payload.role as UserRole,
    sid: String(payload.sid),
    did: typeof payload.did === 'string' ? payload.did : null,
  };
}

const MINUTE = 60;

/**
 * Lifetime of a playback URL. Long enough to watch the whole video with pauses, short enough
 * that a shared link is useless later: 2× duration + 30 min, between 30 min and 12 h.
 */
export function playbackTtlSeconds(durationSeconds: number | null): number {
  const duration = durationSeconds ?? 60 * MINUTE;
  return Math.min(12 * 60 * MINUTE, Math.max(30 * MINUTE, duration * 2 + 30 * MINUTE));
}

export const FILE_TOKEN_TTL_SECONDS = 5 * MINUTE;
