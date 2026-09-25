/** Connection settings as written in `.env` (DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD). */
export interface DatabaseSettings {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

/** Database names are used in `CREATE DATABASE`, so only safe identifiers are accepted. */
export const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

/** `mysql://user:password@host:port/name` (no password part when the password is empty, as in XAMPP). */
export function buildDatabaseUrl(
  settings: DatabaseSettings,
  database: string | null = settings.name,
): string {
  const user = encodeURIComponent(settings.user);
  const auth = settings.password ? `${user}:${encodeURIComponent(settings.password)}` : user;
  return `mysql://${auth}@${settings.host}:${settings.port}/${database ?? ''}`;
}
