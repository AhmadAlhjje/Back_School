import { config } from '../../config/env.js';
import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { signAccessToken } from '../../core/auth/jwt.js';
import { prisma, type DbClient } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { securityLogger } from '../../core/logger/logger.js';
import { randomToken, sha256Hex } from '../../core/security/crypto.js';
import type { ClientPortal, UserRole } from '../../generated/prisma/enums.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A rotated token presented again within this window is treated as a client race, not theft. */
const REUSE_GRACE_MS = 20_000;

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

interface SessionSubject {
  userId: string;
  role: UserRole;
  portal: ClientPortal;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
}

function refreshExpiry(sessionExpiresAt: Date): Date {
  const byTtl = new Date(Date.now() + config.auth.refreshTtlDays * DAY_MS);
  return byTtl < sessionExpiresAt ? byTtl : sessionExpiresAt;
}

function accessTokenFor(
  subject: Pick<SessionSubject, 'userId' | 'role' | 'portal' | 'deviceId'>,
  sessionId: string,
) {
  return signAccessToken({
    sub: subject.userId,
    role: subject.role,
    portal: subject.portal,
    sid: sessionId,
    did: subject.deviceId,
  });
}

/** Creates an auth session with its first refresh token. Call inside the login transaction. */
export async function createSession(db: DbClient, subject: SessionSubject): Promise<IssuedTokens> {
  const expiresAt = new Date(Date.now() + config.auth.sessionMaxAgeDays * DAY_MS);
  const session = await db.authSession.create({
    data: {
      userId: subject.userId,
      deviceId: subject.deviceId,
      portal: subject.portal,
      ipAddress: subject.ip,
      userAgent: subject.userAgent,
      expiresAt,
    },
  });
  const refreshToken = randomToken();
  const refreshTokenExpiresAt = refreshExpiry(expiresAt);
  await db.refreshToken.create({
    data: { sessionId: session.id, tokenHash: sha256Hex(refreshToken), expiresAt: refreshTokenExpiresAt },
  });
  return {
    accessToken: accessTokenFor(subject, session.id),
    accessTokenExpiresIn: config.auth.accessTtlSeconds,
    refreshToken,
    refreshTokenExpiresAt,
    sessionId: session.id,
  };
}

interface RotateOptions {
  rawToken: string;
  expectedPortal: ClientPortal;
  /** Raw X-Device-Id header; required for the student app. */
  deviceIdentifier: string | null;
  actor: Pick<AuditActor, 'ip' | 'userAgent'>;
}

/**
 * Exchanges a refresh token for a new access + refresh token pair (rotation).
 * A token that was already rotated and shows up again after the grace window indicates it
 * was copied: the whole session is revoked and the event is audited.
 */
export async function rotateRefreshToken(options: RotateOptions): Promise<IssuedTokens & { userId: string }> {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256Hex(options.rawToken) },
    include: {
      session: {
        include: {
          user: { select: { id: true, role: true, status: true, archivedAt: true } },
          device: { select: { status: true, identifierHash: true } },
        },
      },
    },
  });
  if (!record) throw new AppError('REFRESH_TOKEN_INVALID');
  const { session } = record;
  const now = new Date();

  if (record.rotatedAt) {
    if (now.getTime() - record.rotatedAt.getTime() > REUSE_GRACE_MS && !session.revokedAt) {
      await prisma.$transaction(async (tx) => {
        await revokeSessionById(tx, session.id, 'REFRESH_REUSE');
        await writeAudit(
          tx,
          { userId: session.userId, role: session.user.role, ...options.actor },
          { action: AuditAction.REFRESH_TOKEN_REUSE, entityType: 'auth_session', entityId: session.id },
        );
      });
      securityLogger.warn({ sessionId: session.id, userId: session.userId }, 'Refresh token reuse detected');
    }
    throw new AppError('REFRESH_TOKEN_INVALID');
  }

  if (record.expiresAt <= now || session.revokedAt || session.expiresAt <= now) {
    throw new AppError('REFRESH_TOKEN_INVALID');
  }
  if (session.portal !== options.expectedPortal) throw new AppError('REFRESH_TOKEN_INVALID');
  if (session.user.archivedAt) throw new AppError('REFRESH_TOKEN_INVALID');
  if (session.user.status === 'DISABLED') throw new AppError('ACCOUNT_DISABLED');

  if (session.portal === 'STUDENT_APP') {
    if (!session.device || session.device.status !== 'ACTIVE') throw new AppError('REFRESH_TOKEN_INVALID');
    if (!options.deviceIdentifier || sha256Hex(options.deviceIdentifier) !== session.device.identifierHash) {
      throw new AppError('DEVICE_MISMATCH');
    }
  }

  const nextRaw = randomToken();
  const nextExpiresAt = refreshExpiry(session.expiresAt);
  await prisma.$transaction(async (tx) => {
    // Conditional update: only one concurrent request can rotate a given token.
    const rotated = await tx.refreshToken.updateMany({
      where: { id: record.id, rotatedAt: null },
      data: { rotatedAt: now },
    });
    if (rotated.count !== 1) throw new AppError('REFRESH_TOKEN_INVALID');
    await tx.refreshToken.create({
      data: { sessionId: session.id, tokenHash: sha256Hex(nextRaw), expiresAt: nextExpiresAt },
    });
    await tx.authSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  });

  return {
    userId: session.userId,
    sessionId: session.id,
    accessToken: accessTokenFor(
      { userId: session.userId, role: session.user.role, portal: session.portal, deviceId: session.deviceId },
      session.id,
    ),
    accessTokenExpiresIn: config.auth.accessTtlSeconds,
    refreshToken: nextRaw,
    refreshTokenExpiresAt: nextExpiresAt,
  };
}

export async function revokeSessionById(db: DbClient, sessionId: string, reason: string): Promise<void> {
  await db.authSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
}

/** Revokes every live session of a user, optionally keeping one (e.g. the caller's). */
export async function revokeUserSessions(
  db: DbClient,
  userId: string,
  reason: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const result = await db.authSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
  return result.count;
}

export async function revokeDeviceSessions(db: DbClient, deviceId: string, reason: string): Promise<number> {
  const result = await db.authSession.updateMany({
    where: { deviceId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
  return result.count;
}
