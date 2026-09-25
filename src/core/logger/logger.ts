import { pino } from 'pino';
import { config } from '../../config/env.js';

/**
 * Application logger. Secrets never reach log output:
 * - credential-bearing headers and body fields are redacted by path;
 * - signed media tokens in query strings are stripped by `redactUrl`.
 */
export const logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  base: { service: 'edu-backend' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-device-id"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.confirmPassword',
      '*.passwordHash',
      '*.refreshToken',
      '*.accessToken',
      '*.token',
      '*.encryptedKey',
    ],
    censor: '[REDACTED]',
  },
  ...(config.isProduction || config.isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }),
});

const SENSITIVE_QUERY_KEYS = ['token', 'refreshToken', 'accessToken'];

/** Removes token-bearing query parameters from a URL before it is logged. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  for (const key of SENSITIVE_QUERY_KEYS) {
    if (params.has(key)) params.set(key, 'REDACTED');
  }
  return `${url.slice(0, queryStart)}?${params.toString()}`;
}

/** Security-relevant events get a dedicated child logger so they can be filtered and alerted on. */
export const securityLogger = logger.child({ channel: 'security' });
