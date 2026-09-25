import { createApp } from './app.js';
import { config } from './config/env.js';
import { prisma } from './core/database/prisma.js';
import { logger } from './core/logger/logger.js';
import { closeQueues } from './core/queue/queues.js';
import { closeGeneralRedis } from './core/queue/redis.js';
import { ensureStorageLayout } from './core/storage/storage.js';
import { startEmbeddedWorker } from './workers/embedded.js';

async function main() {
  await ensureStorageLayout();
  // Without Redis the API also runs the background jobs (video processing, notifications...).
  const embeddedWorker = config.queueDriver === 'memory' ? await startEmbeddedWorker() : null;
  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.env, jobs: config.queueDriver },
      `API listening on ${config.apiBaseUrl}`,
    );
  });
  // Chunk uploads on slow connections can take a while; keep sockets reasonably long-lived.
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 65 * 1000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down API');
    server.close(() => {
      void Promise.allSettled([embeddedWorker?.stop(), closeQueues(), closeGeneralRedis()])
        .then(() => prisma.$disconnect())
        .then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'API failed to start');
  process.exit(1);
});
