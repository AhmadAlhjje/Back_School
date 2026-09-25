import { prisma } from '../../src/core/database/prisma.js';

let tables: string[] | null = null;

/** Empties every application table (keeps the migrations table). */
export async function resetDatabase(): Promise<void> {
  tables ??= (
    await prisma.$queryRaw<{ name: string }[]>`
      SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '_prisma_migrations'`
  ).map((row) => row.name);

  // FOREIGN_KEY_CHECKS is per connection, so run everything inside one transaction/connection.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables ?? []) {
      // audit_logs refuses DELETE (append-only trigger); TRUNCATE does not fire row triggers
      // and needs the DROP privilege, which only the test/migration user has.
      const statement = table === 'audit_logs' ? 'TRUNCATE TABLE' : 'DELETE FROM';
      await tx.$executeRawUnsafe(`${statement} \`${table}\``);
    }
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  });
}
