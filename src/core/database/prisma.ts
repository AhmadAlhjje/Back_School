import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { config } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Single Prisma client per process. The MariaDB driver adapter speaks the MySQL protocol and
 * works with both MySQL 8 (production) and MariaDB (local development).
 */
function createPrismaClient() {
  const adapter = new PrismaMariaDb(config.databaseUrl);
  return new PrismaClient({ adapter });
}

export const prisma = createPrismaClient();

export type Db = typeof prisma;
/** A transaction client, as received inside `prisma.$transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];
/** Anything that can run queries: the root client or a transaction client. */
export type DbClient = Db | Tx;
