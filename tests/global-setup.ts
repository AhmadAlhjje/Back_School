import fs from 'node:fs/promises';
import path from 'node:path';
import { applyMigrations, databaseSettingsFromEnv, ensureDatabase } from '../database/tools.js';

/** Creates the test database if needed and applies all migrations once per run (as `npm run dev` does). */
export default async function setup() {
  const settings = databaseSettingsFromEnv();
  if (!settings.name.includes('test')) {
    throw new Error('Refusing to run tests: DB_DATABASE must point at a *test* database.');
  }
  await ensureDatabase(settings);
  applyMigrations(settings);
  await fs.rm(path.resolve(process.env.STORAGE_PATH ?? './storage-test'), { recursive: true, force: true });
}
