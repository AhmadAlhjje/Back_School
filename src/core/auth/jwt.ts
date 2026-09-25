import jwt from 'jsonwebtoken';
import { config } from '../../config/env.js';
import { ClientPortal, UserRole } from '../../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';

const ISSUER = 'edu-platform';
const ACCESS_AUDIENCE = 'edu-api';

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  sid: string;
  portal: ClientPortal;
  did: string | null;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  const { sub, ...rest } = claims;
  return jwt.sign(rest, config.auth.accessSecret, {
    algorithm: 'HS256',
    subject: sub,
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
    expiresIn: config.auth.accessTtlSeconds,
  });
}

const ROLES = new Set<string>(Object.values(UserRole));
const PORTALS = new Set<string>(Object.values(ClientPortal));

export function verifyAccessToken(token: string): AccessTokenClaims {
  let payload: jwt.JwtPayload | string;
  try {
    payload = jwt.verify(token, config.auth.accessSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) throw new AppError('TOKEN_EXPIRED');
    throw new AppError('TOKEN_INVALID');
  }
  if (
    typeof payload === 'string' ||
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    !ROLES.has(payload.role as string) ||
    !PORTALS.has(payload.portal as string)
  ) {
    throw new AppError('TOKEN_INVALID');
  }
  return {
    sub: payload.sub,
    sid: payload.sid,
    role: payload.role as UserRole,
    portal: payload.portal as ClientPortal,
    did: typeof payload.did === 'string' ? payload.did : null,
  };
}
