import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { config } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Single Prisma client per process, through the MariaDB driver adapter: MariaDB in production
 * (Docker) and in local development (XAMPP); the MySQL protocol also works with MySQL 8.
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
