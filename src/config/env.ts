import path from 'node:path';
import { z } from 'zod';
import { buildDatabaseUrl, DATABASE_NAME_PATTERN, type DatabaseSettings } from './database-url.js';

/**
 * Environment configuration. This is the only module that reads `process.env`;
 * everything else imports the typed `config` object. Invalid configuration fails fast at boot.
 */

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const secret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine((value) => !value.startsWith('CHANGE_ME'), `${name} must be changed from the example value`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_BASE_URL: z.url().default('http://localhost:4000'),
  CORS_ORIGINS: csv.default([]),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_DATABASE: z.string().regex(DATABASE_NAME_PATTERN, 'DB_DATABASE may contain only letters, digits and _'),
  DB_USERNAME: z.string().min(1).default('root'),
  DB_PASSWORD: z.string().default(''),
  // Optional. Empty: background jobs run inside the API process (local development with only MySQL).
  REDIS_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(/^rediss?:\/\//, 'REDIS_URL must be a redis:// URL').optional(),
  ),

  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  MEDIA_TOKEN_SECRET: secret('MEDIA_TOKEN_SECRET'),
  MEDIA_KEY_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => Buffer.from(value, 'base64').length === 32,
      'MEDIA_KEY_ENCRYPTION_KEY must be 32 bytes, base64',
    ),
  COOKIE_SECURE: booleanFromString.default(false),

  STORAGE_PATH: z.string().default('./storage'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  UPLOAD_CHUNK_SIZE_MB: z.coerce.number().int().min(1).max(64).default(8),
  MAX_VIDEO_SIZE_GB: z.coerce.number().positive().max(200).default(20),
  MAX_FILE_SIZE_MB: z.coerce.number().int().min(1).max(4096).default(200),
  KEEP_ORIGINAL_VIDEOS: booleanFromString.default(false),
  HLS_RENDITIONS: csv
    .default(['360', '720', '1080'])
    .transform((values) => values.map(Number))
    .pipe(z.array(z.number().int().min(144).max(2160)).min(1)),
  HLS_SEGMENT_SECONDS: z.coerce.number().int().min(2).max(12).default(6),
  FFMPEG_PRESET: z
    .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'])
    .default('veryfast'),
  VIDEO_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  MEDIA_ACCEL_REDIRECT: booleanFromString.default(false),
  MEDIA_ACCEL_PREFIX: z.string().startsWith('/').default('/protected-media'),

  ENABLE_API_DOCS: booleanFromString.default(true),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    // Logger is not available yet (it depends on config); write directly and abort.
    process.stderr.write(`Invalid environment configuration:\n${issues.join('\n')}\n`);
    process.exit(1);
  }
  return parsed.data;
}

const env = loadEnv();

const database: DatabaseSettings = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  name: env.DB_DATABASE,
  user: env.DB_USERNAME,
  password: env.DB_PASSWORD,
};

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  apiBaseUrl: env.API_BASE_URL.replace(/\/+$/, ''),
  corsOrigins: env.CORS_ORIGINS,
  trustProxy: env.TRUST_PROXY,
  logLevel: env.LOG_LEVEL,
  database,
  databaseUrl: buildDatabaseUrl(database),
  redisUrl: env.REDIS_URL,
  /** `redis`: BullMQ + separate worker process. `memory`: jobs run inside the API process. */
  queueDriver: env.REDIS_URL ? ('redis' as const) : ('memory' as const),
  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    sessionMaxAgeDays: env.SESSION_MAX_AGE_DAYS,
    cookieSecure: env.COOKIE_SECURE,
  },
  media: {
    tokenSecret: env.MEDIA_TOKEN_SECRET,
    keyEncryptionKey: Buffer.from(env.MEDIA_KEY_ENCRYPTION_KEY, 'base64'),
    ffmpegPath: env.FFMPEG_PATH,
    ffprobePath: env.FFPROBE_PATH,
    chunkSizeBytes: env.UPLOAD_CHUNK_SIZE_MB * 1024 * 1024,
    maxVideoSizeBytes: Math.floor(env.MAX_VIDEO_SIZE_GB * 1024 * 1024 * 1024),
    maxFileSizeBytes: env.MAX_FILE_SIZE_MB * 1024 * 1024,
    keepOriginalVideos: env.KEEP_ORIGINAL_VIDEOS,
    renditionHeights: [...new Set(env.HLS_RENDITIONS)].sort((a, b) => a - b),
    segmentSeconds: env.HLS_SEGMENT_SECONDS,
    ffmpegPreset: env.FFMPEG_PRESET,
    workerConcurrency: env.VIDEO_WORKER_CONCURRENCY,
    accelRedirect: env.MEDIA_ACCEL_REDIRECT,
    accelPrefix: env.MEDIA_ACCEL_PREFIX.replace(/\/+$/, ''),
  },
  storageRoot: path.resolve(env.STORAGE_PATH),
  enableApiDocs: env.ENABLE_API_DOCS,
} as const;

export type AppConfig = typeof config;
