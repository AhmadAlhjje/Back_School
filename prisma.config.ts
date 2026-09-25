import { defineConfig } from 'prisma/config';

// Prisma CLI does not read .env on its own; load it when present (local development).
// In production the variables come from the process environment.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file — rely on the environment
}

/** Same rules as src/config/database-url.ts (kept inline: this file is loaded by the Prisma CLI). */
function databaseUrl(): string {
  const user = encodeURIComponent(process.env.DB_USERNAME || 'root');
  const password = process.env.DB_PASSWORD ?? '';
  const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DB_PORT || '3306';
  return `mysql://${auth}@${host}:${port}/${process.env.DB_DATABASE ?? ''}`;
}

// Schema, migrations and seeders live in ./database (see docs/database.md).
export default defineConfig({
  schema: 'database/schema.prisma',
  migrations: {
    path: 'database/migrations',
    seed: 'tsx database/seeders/seed.ts',
  },
  datasource: {
    url: databaseUrl(),
  },
});
