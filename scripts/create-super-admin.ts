/**
 * Creates a super admin account from the environment (production bootstrap).
 *
 *   SEED_SUPER_ADMIN_NAME=... SEED_SUPER_ADMIN_PHONE=... SEED_SUPER_ADMIN_PASSWORD=... npm run admin:create
 *
 * Idempotent: an existing super admin with that phone is left untouched.
 */
import { prisma } from '../src/core/database/prisma.js';
import { ensureSuperAdmin, superAdminFromEnv } from '../database/seeders/super-admin.js';

try {
  const input = superAdminFromEnv();
  const result = await ensureSuperAdmin(input);
  process.stdout.write(`Super admin ${input.phone}: ${result}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
