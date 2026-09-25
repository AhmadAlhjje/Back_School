/**
 * Database seeders (run by `npm run db:seed`, `npm run db:fresh`, and automatically by
 * `npm run dev` when the database is empty).
 *
 *  1. Super admin from SEED_SUPER_ADMIN_* (never overwritten).
 *  2. When SEED_DEMO_DATA=true (never in production): demo catalog, accounts and media.
 */
import { config } from '../../src/config/env.js';
import { DEMO_ACCOUNTS, seedDemoData } from './demo-data.js';
import { seedDemoMedia } from './demo-media.js';
import { ensureSuperAdmin, superAdminFromEnv } from './super-admin.js';

export async function runSeeders(log: (line: string) => void): Promise<void> {
  const admin = superAdminFromEnv();
  const adminResult = await ensureSuperAdmin(admin);
  log(`Super admin ${admin.phone}: ${adminResult === 'created' ? 'created' : 'already exists'}`);

  if (process.env.SEED_DEMO_DATA !== 'true') return;
  if (config.isProduction) throw new Error('Refusing to load demo data in production.');

  const catalog = await seedDemoData();
  if (!catalog) {
    log('Demo data: already present (skipped)');
    return;
  }
  log('Demo data: grades, subjects, teachers, lessons and sessions');
  await seedDemoMedia(catalog, log);
  log(`  Owner    ${DEMO_ACCOUNTS.owner.phone} / ${DEMO_ACCOUNTS.owner.password}`);
  for (const student of DEMO_ACCOUNTS.students) {
    log(`  Student  ${student.phone} / ${student.password}`);
  }
}
