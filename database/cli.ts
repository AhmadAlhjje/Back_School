/**
 * Database commands (see package.json):
 *
 *   npm run db:migrate   create the database named in DB_DATABASE if needed, apply migrations
 *   npm run db:seed      run the seeders (super admin + demo data when SEED_DEMO_DATA=true)
 *   npm run db:fresh     drop the database, recreate it, migrate and seed (development only)
 *   setup                used automatically before `npm run dev`: migrate, and seed if empty
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyMigrations, databaseSettingsFromEnv, dropDatabase, ensureDatabase } from './tools.js';

type Command = 'setup' | 'migrate' | 'seed' | 'fresh';

// Keep the command output readable: application logs only for warnings (LOG_LEVEL=debug keeps all).
if (process.env.LOG_LEVEL !== 'debug' && process.env.LOG_LEVEL !== 'trace') process.env.LOG_LEVEL = 'warn';

const log = (line: string) => process.stdout.write(`${line}\n`);

/** First run on a fresh copy: create .env from .env.example with new random secrets. */
async function ensureEnvFile(): Promise<void> {
  try {
    await fs.access('.env');
    return;
  } catch {
    // no .env yet
  }
  const example = await fs.readFile('.env.example', 'utf8');
  const filled = example
    .replace(/^JWT_ACCESS_SECRET=CHANGE_ME$/m, `JWT_ACCESS_SECRET=${randomBytes(32).toString('hex')}`)
    .replace(/^MEDIA_TOKEN_SECRET=CHANGE_ME$/m, `MEDIA_TOKEN_SECRET=${randomBytes(32).toString('hex')}`)
    .replace(
      /^MEDIA_KEY_ENCRYPTION_KEY=CHANGE_ME$/m,
      `MEDIA_KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    );
  await fs.writeFile('.env', filled, 'utf8');
  process.loadEnvFile('.env');
  log('✓ .env created from .env.example (new random secrets)');
}

async function migrate(): Promise<void> {
  const settings = databaseSettingsFromEnv();
  const created = await ensureDatabase(settings);
  if (created === 'created') log(`✓ Database "${settings.name}" created`);
  const applied = applyMigrations(settings);
  log(
    applied.length > 0
      ? `✓ Migrations applied: ${applied.join(', ')}`
      : `✓ Database "${settings.name}" is up to date`,
  );
}

/** Seeders import the app (Prisma client, config), so they are loaded only when needed. */
async function seed(): Promise<void> {
  const { runSeeders } = await import('./seeders/seed.js');
  const { prisma } = await import('../src/core/database/prisma.js');
  try {
    await runSeeders(log);
  } finally {
    await prisma.$disconnect();
  }
}

async function isEmpty(): Promise<boolean> {
  const { prisma } = await import('../src/core/database/prisma.js');
  try {
    return (await prisma.user.count()) === 0;
  } finally {
    await prisma.$disconnect();
  }
}

function checkFfmpeg(): void {
  const binary = process.env.FFMPEG_PATH || 'ffmpeg';
  const result = spawnSync(binary, ['-version'], { stdio: 'ignore', windowsHide: true });
  if (result.status !== 0) {
    log(
      `! FFmpeg not found ("${binary}"): uploads work, but videos cannot be processed until FFmpeg is installed.`,
    );
  }
}

async function fresh(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('db:fresh is disabled in production.');
  const settings = databaseSettingsFromEnv();
  await dropDatabase(settings);
  log(`✓ Database "${settings.name}" dropped`);
  // Media of the old data would be orphaned: clear the development storage folder too.
  const storage = path.resolve(process.env.STORAGE_PATH || './storage');
  for (const area of ['videos', 'files', 'images', 'originals', 'tmp']) {
    await fs.rm(path.join(storage, area), { recursive: true, force: true });
  }
  await migrate();
  await seed();
}

async function main(command: Command): Promise<void> {
  switch (command) {
    case 'setup':
      await ensureEnvFile();
      await migrate();
      if (await isEmpty()) {
        log('Empty database: running the seeders…');
        await seed();
      }
      checkFfmpeg();
      return;
    case 'migrate':
      return migrate();
    case 'seed':
      return seed();
    case 'fresh':
      return fresh();
  }
}

const command = process.argv[2] as Command | undefined;
if (!command || !['setup', 'migrate', 'seed', 'fresh'].includes(command)) {
  process.stderr.write('Usage: tsx database/cli.ts <setup|migrate|seed|fresh>\n');
  process.exit(2);
}

main(command).catch((error: unknown) => {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
