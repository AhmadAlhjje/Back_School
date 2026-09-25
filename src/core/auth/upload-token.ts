import jwt from 'jsonwebtoken';
import { config } from '../../config/env.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';
import type { AuthContext } from './auth-context.js';

/**
 * Upload tokens let an upload go on without the 15-minute access token: the dashboards hand
 * the upload to the browser (Background Fetch), which keeps sending after the site is closed.
 * A token covers one target — a video's chunks and completion (`video:<id>`), or new files in
 * one place (`files:<scope>:<parentId>`) — for one user and one auth session: signing out,
 * disabling the account or revoking the session stops it (checked on every request).
 */
export const UPLOAD_TOKEN_HEADER = 'x-upload-token';
export const UPLOAD_TOKEN_TTL_SECONDS = 72 * 60 * 60;

const ISSUER = 'edu-platform';
const AUDIENCE = 'edu-upload';

export interface UploadClaims {
  target: string;
  sub: string;
  role: UserRole;
  sid: string;
}

export function signUploadToken(
  target: string,
  auth: AuthContext,
): { uploadToken: string; uploadTokenExpiresAt: Date } {
  const uploadToken = jwt.sign({ target, role: auth.role, sid: auth.sessionId }, config.media.tokenSecret, {
    algorithm: 'HS256',
    subject: auth.userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: UPLOAD_TOKEN_TTL_SECONDS,
  });
  return { uploadToken, uploadTokenExpiresAt: new Date(Date.now() + UPLOAD_TOKEN_TTL_SECONDS * 1000) };
}

export function verifyUploadToken(token: string, target: string): UploadClaims {
  let payload: jwt.JwtPayload | string;
  try {
    payload = jwt.verify(token, config.media.tokenSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch {
    throw new AppError('TOKEN_INVALID');
  }
  if (
    typeof payload === 'string' ||
    payload.target !== target ||
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string'
  ) {
    throw new AppError('TOKEN_INVALID');
  }
  return { target, sub: payload.sub, role: payload.role as UserRole, sid: payload.sid };
}

export const videoUploadTarget = (videoId: string) => `video:${videoId}`;
export const filesUploadTarget = (scope: string, parentId: string) => `files:${scope}:${parentId}`;
