import { Router } from 'express';
import { config } from '../config/env.js';
import { prisma } from '../core/database/prisma.js';
import { getGeneralRedis } from '../core/queue/redis.js';

/** Liveness (`/health`) and readiness (`/health/ready`) probes for Docker/Nginx/monitoring. */
export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

healthRouter.get('/ready', async (_req, res) => {
  // `redis` is "not-used" when background jobs run inside the API (no REDIS_URL).
  const checks: { database: boolean; redis: boolean | 'not-used' } = {
    database: false,
    redis: config.queueDriver === 'redis' ? false : 'not-used',
  };
  await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => (checks.database = true)).catch(() => undefined),
    config.queueDriver === 'redis'
      ? getGeneralRedis()
          .ping()
          .then(() => (checks.redis = true))
          .catch(() => undefined)
      : undefined,
  ]);
  const ready = checks.database && checks.redis !== false;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks });
});
