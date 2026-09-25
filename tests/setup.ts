import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/core/database/prisma.js';
import { closeQueues } from '../src/core/queue/queues.js';
import { closeGeneralRedis } from '../src/core/queue/redis.js';
import { resetRateLimitsForTests } from '../src/core/security/rate-limit.js';
import { invalidateSettingsCache } from '../src/modules/settings/settings.service.js';
import { resetDatabase } from './helpers/db.js';

beforeEach(async () => {
  await resetDatabase();
  await resetRateLimitsForTests();
  invalidateSettingsCache();
});

afterAll(async () => {
  await Promise.allSettled([prisma.$disconnect(), closeQueues(), closeGeneralRedis()]);
});
