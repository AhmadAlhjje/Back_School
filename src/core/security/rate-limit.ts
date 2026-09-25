import type { Request, RequestHandler } from 'express';
import { MemoryStore, rateLimit, type Store } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { config } from '../../config/env.js';
import { sendError } from '../errors/error-handler.js';
import { securityLogger } from '../logger/logger.js';
import { getGeneralRedis } from '../queue/redis.js';
import { normalizePhone } from './phone.js';

type KeyStrategy = 'ip' | 'ip+phone' | 'phone' | 'user';

interface LimiterOptions {
  name: string;
  windowMs: number;
  limit: number;
  key: KeyStrategy;
}

/** Memory stores created in test mode, so suites can reset counters between tests. */
const testStores: MemoryStore[] = [];

function createStore(prefix: string): Store {
  // Single API process without Redis (local development) or tests: counters in memory.
  if (config.isTest || config.queueDriver === 'memory') {
    const store = new MemoryStore();
    if (config.isTest) testStores.push(store);
    return store;
  }
  return new RedisStore({
    prefix: `edu:rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) =>
      getGeneralRedis().call(command, ...args) as Promise<RedisReply>,
  });
}

function phoneFromBody(req: Request): string {
  const body = req.body as { phone?: unknown } | undefined;
  return typeof body?.phone === 'string' ? normalizePhone(body.phone) : 'none';
}

function keyFor(strategy: KeyStrategy, req: Request): string {
  const ip = req.ip ?? 'unknown';
  switch (strategy) {
    case 'ip':
      return ip;
    case 'phone':
      return phoneFromBody(req);
    case 'ip+phone':
      return `${ip}|${phoneFromBody(req)}`;
    case 'user':
      return req.auth?.userId ?? ip;
  }
}

export function createRateLimiter(options: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: createStore(options.name),
    keyGenerator: (req) => keyFor(options.key, req),
    // Availability over strictness if Redis is briefly unreachable; the event is logged.
    passOnStoreError: true,
    handler: (req, res) => {
      securityLogger.warn({ limiter: options.name, ip: req.ip, path: req.path }, 'Rate limit exceeded');
      sendError(req, res, 'RATE_LIMITED');
    },
  });
}

const MINUTE = 60_000;

/** Named limiters for sensitive endpoints (spec §62). */
export const rateLimiters = {
  loginPerIp: createRateLimiter({ name: 'login-ip', windowMs: 15 * MINUTE, limit: 50, key: 'ip' }),
  loginPerAccount: createRateLimiter({
    name: 'login-account',
    windowMs: 15 * MINUTE,
    limit: 10,
    key: 'phone',
  }),
  register: createRateLimiter({ name: 'register', windowMs: 60 * MINUTE, limit: 10, key: 'ip' }),
  refresh: createRateLimiter({ name: 'refresh', windowMs: 15 * MINUTE, limit: 120, key: 'ip' }),
  passwordChange: createRateLimiter({ name: 'password', windowMs: 15 * MINUTE, limit: 10, key: 'user' }),
  videoAccess: createRateLimiter({ name: 'video-access', windowMs: MINUTE, limit: 30, key: 'user' }),
  fileAccess: createRateLimiter({ name: 'file-access', windowMs: MINUTE, limit: 60, key: 'user' }),
  mediaKey: createRateLimiter({ name: 'media-key', windowMs: MINUTE, limit: 60, key: 'ip' }),
};

export async function resetRateLimitsForTests(): Promise<void> {
  await Promise.all(testStores.map((store) => store.resetAll()));
}
