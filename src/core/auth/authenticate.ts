import type { Request, RequestHandler } from 'express';
import type { UserRole } from '../../generated/prisma/enums.js';
import { prisma } from '../database/prisma.js';
import { AppError } from '../errors/app-error.js';
import { securityLogger } from '../logger/logger.js';
import { sha256Hex } from '../security/crypto.js';
import { PORTAL_FOR_ROLE, type AuthContext } from './auth-context.js';
import { verifyAccessToken } from './jwt.js';

export const DEVICE_HEADER = 'x-device-id';
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

function bearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED');
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new AppError('UNAUTHENTICATED');
  return token;
}

/**
 * Resolves the caller's identity. A valid JWT is not enough: the auth session must still be
 * live, the account active, the portal must match the role, and — for students — the bound
 * device must be active and match the X-Device-Id header of this request.
 */
export async function resolveAuth(req: Request): Promise<AuthContext> {
  const claims = verifyAccessToken(bearerToken(req));

  const session = await prisma.authSession.findUnique({
    where: { id: claims.sid },
    select: {
      id: true,
      userId: true,
      portal: true,
      deviceId: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      user: { select: { role: true, status: true, archivedAt: true } },
      device: { select: { status: true, identifierHash: true } },
    },
  });

  const now = new Date();
  if (!session || session.revokedAt || session.expiresAt <= now || session.userId !== claims.sub) {
    throw new AppError('SESSION_REVOKED');
  }
  if (session.user.archivedAt) throw new AppError('SESSION_REVOKED');
  if (session.user.status === 'DISABLED') throw new AppError('ACCOUNT_DISABLED');
  if (session.user.role !== claims.role || PORTAL_FOR_ROLE[claims.role] !== session.portal) {
    throw new AppError('TOKEN_INVALID');
  }

  if (session.portal === 'STUDENT_APP') {
    const deviceHeader = req.header(DEVICE_HEADER);
    if (!session.device || session.device.status !== 'ACTIVE' || session.deviceId !== claims.did) {
      throw new AppError('SESSION_REVOKED');
    }
    if (!deviceHeader || sha256Hex(deviceHeader) !== session.device.identifierHash) {
      securityLogger.warn(
        { userId: session.userId, sessionId: session.id },
        'Device header mismatch on request',
      );
      throw new AppError('DEVICE_MISMATCH');
    }
  }

  if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
    // Best-effort activity tracking; never blocks or fails the request.
    prisma.authSession
      .update({ where: { id: session.id }, data: { lastSeenAt: now } })
      .catch((error: unknown) => securityLogger.debug({ err: error }, 'Failed to update session lastSeenAt'));
  }

  return {
    userId: session.userId,
    role: session.user.role,
    sessionId: session.id,
    portal: session.portal,
    deviceId: session.deviceId,
  };
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  req.auth = await resolveAuth(req);
  next();
};

/** Role gate. Must run after `authenticate`. */
export function authorize(roles: readonly UserRole[]): RequestHandler {
  const allowed = new Set(roles);
  return (req, _res, next) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED');
    if (!allowed.has(req.auth.role)) {
      securityLogger.warn(
        { userId: req.auth.userId, role: req.auth.role, path: req.path, method: req.method },
        'Forbidden role access attempt',
      );
      throw new AppError('FORBIDDEN');
    }
    next();
  };
}
