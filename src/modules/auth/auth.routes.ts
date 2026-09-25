import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { requestMeta } from '../../core/audit/audit.js';
import { DEVICE_HEADER } from '../../core/auth/authenticate.js';
import { AppError } from '../../core/errors/app-error.js';
import { openRoute, route, type ApiModule } from '../../core/http/route.js';
import { name, uuid } from '../../core/http/schemas.js';
import { PASSWORD_MAX_LENGTH } from '../../core/security/password.js';
import { phoneSchema } from '../../core/security/phone.js';
import { rateLimiters } from '../../core/security/rate-limit.js';
import { deviceInfoSchema } from '../devices/device-binding.js';
import {
  changePassword,
  getCurrentAccount,
  loginStaff,
  loginStudent,
  logout,
  registerStudent,
} from './auth.service.js';
import { rotateRefreshToken, type IssuedTokens } from './session.service.js';

/** Web portals keep the refresh token in an httpOnly cookie — one cookie name per portal. */
const WEB_PORTALS = ['ADMIN_WEB', 'OWNER_WEB'] as const;
type WebPortal = (typeof WEB_PORTALS)[number];
const REFRESH_COOKIE: Record<WebPortal, string> = { ADMIN_WEB: 'edu_admin_rt', OWNER_WEB: 'edu_owner_rt' };
const COOKIE_PATH = '/api/v1/auth';

function setRefreshCookie(res: Response, portal: WebPortal, tokens: IssuedTokens) {
  res.cookie(REFRESH_COOKIE[portal], tokens.refreshToken, {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires: tokens.refreshTokenExpiresAt,
  });
}

function clearRefreshCookie(res: Response, portal: WebPortal) {
  res.clearCookie(REFRESH_COOKIE[portal], {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
}

function readCookie(req: Request, cookieName: string): string | null {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[cookieName];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const credentials = z.object({ phone: phoneSchema, password });

/** Access token response for web portals (refresh token travels only in the cookie). */
function webSession(tokens: IssuedTokens) {
  return { accessToken: tokens.accessToken, expiresIn: tokens.accessTokenExpiresIn };
}

/** Mobile response: the app stores the refresh token in Keychain/Keystore. */
function appSession(tokens: IssuedTokens) {
  return {
    accessToken: tokens.accessToken,
    expiresIn: tokens.accessTokenExpiresIn,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  };
}

const loginLimiters = [rateLimiters.loginPerIp, rateLimiters.loginPerAccount];

export const authModule: ApiModule = {
  prefix: '/auth',
  tag: 'Auth',
  routes: [
    openRoute({
      method: 'post',
      path: '/admin/login',
      summary: 'Super admin login (sets the admin refresh cookie)',
      access: 'public',
      body: credentials,
      middleware: loginLimiters,
      handler: async ({ req, res, body }) => {
        const result = await loginStaff('SUPER_ADMIN', body, requestMeta(req));
        setRefreshCookie(res, 'ADMIN_WEB', result.tokens);
        return { ...webSession(result.tokens), user: result.user };
      },
    }),
    openRoute({
      method: 'post',
      path: '/owner/login',
      summary: 'Institute owner login (sets the owner refresh cookie)',
      access: 'public',
      body: credentials,
      middleware: loginLimiters,
      handler: async ({ req, res, body }) => {
        const result = await loginStaff('OWNER', body, requestMeta(req));
        setRefreshCookie(res, 'OWNER_WEB', result.tokens);
        return { ...webSession(result.tokens), user: result.user };
      },
    }),
    openRoute({
      method: 'post',
      path: '/student/login',
      summary: 'Student login from the app; binds the device on first login',
      description: 'Fails with DEVICE_ALREADY_BOUND when the account is bound to a different device.',
      access: 'public',
      body: credentials.extend({ device: deviceInfoSchema }),
      middleware: loginLimiters,
      handler: async ({ req, body }) => {
        const result = await loginStudent(body, requestMeta(req));
        return { ...appSession(result.tokens), user: result.user };
      },
    }),
    openRoute({
      method: 'post',
      path: '/student/register',
      summary: 'Student self-registration (only when enabled in system settings)',
      description: '`gradeId`: the grade the student chose (from GET /public/grades).',
      access: 'public',
      body: z.object({
        name: name(120),
        phone: phoneSchema,
        password,
        gradeId: uuid.optional(),
        device: deviceInfoSchema,
      }),
      middleware: [rateLimiters.register],
      successStatus: 201,
      handler: async ({ req, body }) => {
        const result = await registerStudent(body, requestMeta(req));
        return { ...appSession(result.tokens), user: result.user };
      },
    }),
    openRoute({
      method: 'post',
      path: '/refresh',
      summary: 'Rotate the refresh token and get a new access token',
      description:
        'App: send `refreshToken` in the body plus the X-Device-Id header. Web: send `portal` and the refresh cookie.',
      access: 'public',
      body: z.union([
        z.object({ refreshToken: z.string().min(20).max(200) }),
        z.object({ portal: z.enum(WEB_PORTALS) }),
      ]),
      middleware: [rateLimiters.refresh],
      handler: async ({ req, res, body }) => {
        const meta = requestMeta(req);
        if ('refreshToken' in body) {
          const tokens = await rotateRefreshToken({
            rawToken: body.refreshToken,
            expectedPortal: 'STUDENT_APP',
            deviceIdentifier: req.header(DEVICE_HEADER) ?? null,
            actor: meta,
          });
          return appSession(tokens);
        }
        const raw = readCookie(req, REFRESH_COOKIE[body.portal]);
        if (!raw) throw new AppError('REFRESH_TOKEN_INVALID');
        try {
          const tokens = await rotateRefreshToken({
            rawToken: raw,
            expectedPortal: body.portal,
            deviceIdentifier: null,
            actor: meta,
          });
          setRefreshCookie(res, body.portal, tokens);
          return webSession(tokens);
        } catch (error) {
          clearRefreshCookie(res, body.portal);
          throw error;
        }
      },
    }),
    route({
      method: 'post',
      path: '/logout',
      summary: 'Revoke the current session',
      roles: ['SUPER_ADMIN', 'OWNER', 'STUDENT'],
      handler: async ({ req, res, auth }) => {
        await logout(auth, requestMeta(req));
        if (auth.portal !== 'STUDENT_APP') clearRefreshCookie(res, auth.portal);
        return { loggedOut: true };
      },
    }),
    route({
      method: 'get',
      path: '/me',
      summary: 'Current account',
      roles: ['SUPER_ADMIN', 'OWNER', 'STUDENT'],
      handler: ({ auth }) => getCurrentAccount(auth),
    }),
    route({
      method: 'post',
      path: '/change-password',
      summary: 'Change own password (revokes all other sessions)',
      roles: ['SUPER_ADMIN', 'OWNER', 'STUDENT'],
      body: z.object({ currentPassword: password, newPassword: password, confirmPassword: password }),
      middleware: [rateLimiters.passwordChange],
      handler: ({ req, auth, body }) => changePassword(auth, body, requestMeta(req)),
    }),
  ],
};
