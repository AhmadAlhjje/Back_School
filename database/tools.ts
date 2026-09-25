import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import mariadb from 'mariadb';
import { buildDatabaseUrl, DATABASE_NAME_PATTERN, type DatabaseSettings } from '../src/config/database-url.js';

/**
 * Database helpers used by the CLI (database/cli.ts) and the test setup. They read the DB_*
 * variables directly so they work before the rest of the configuration is valid.
 */

export function databaseSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseSettings {
  const name = env.DB_DATABASE ?? '';
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error('DB_DATABASE is missing or invalid in .env (letters, digits and _ only).');
  }
  return {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    name,
    user: env.DB_USERNAME || 'root',
    password: env.DB_PASSWORD ?? '',
  };
}

/** Connects to the server itself (no database selected) and explains the usual problems. */
async function serverConnection(settings: DatabaseSettings) {
  try {
    return await mariadb.createConnection({
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      connectTimeout: 5_000,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ECONNREFUSED' || code === 'ER_GET_CONNECTION_TIMEOUT' || code === 'ETIMEDOUT') {
      throw new Error(
        `MySQL is not reachable at ${settings.host}:${settings.port}. Start MySQL from the XAMPP Control Panel ` +
          '(or check DB_HOST / DB_PORT in .env).\n' +
          'لا يمكن الاتصال بقاعدة البيانات — شغّل MySQL من لوحة XAMPP.',
      );
    }
    if (code === 'ER_ACCESS_DENIED_ERROR') {
      throw new Error(`MySQL refused user "${settings.user}". Check DB_USERNAME / DB_PASSWORD in .env.`);
    }
    throw error;
  }
}

/** Creates the database (utf8mb4) if it does not exist yet. */
export async function ensureDatabase(settings: DatabaseSettings): Promise<'created' | 'exists'> {
  const connection = await serverConnection(settings);
  try {
    const rows = await connection.query<unknown[]>(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [settings.name],
    );
    if (rows.length > 0) return 'exists';
    await connection.query(
      `CREATE DATABASE \`${settings.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    return 'created';
  } finally {
    await connection.end();
  }
}

export async function dropDatabase(settings: DatabaseSettings): Promise<void> {
  const connection = await serverConnection(settings);
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${settings.name}\``);
  } finally {
    await connection.end();
  }
}

/**
 * Applies pending migrations from database/migrations (`prisma migrate deploy`) and returns the
 * names of the migrations applied now.
 */
export function applyMigrations(settings: DatabaseSettings): string[] {
  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    encoding: 'utf8',
    env: { ...process.env, DB_DATABASE: settings.name, DATABASE_URL: buildDatabaseUrl(settings) },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) throw new Error(`Migration failed:\n${output}`);
  return [...output.matchAll(/└─ (\d{14}_[^/\s]+)\//g)].map((match) => match[1]!);
}
