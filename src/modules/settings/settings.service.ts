import { z } from 'zod';
import { writeAudit, AuditAction, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';

/**
 * System settings, managed by the super admin. Stored as one row per key in `system_settings`;
 * the schema (and defaults) live here so the database never holds unknown or malformed values.
 */
export const settingsSchema = z.object({
  instituteName: z.string().trim().min(1).max(120).default('المعهد التعليمي'),
  institutePhone: z.string().trim().max(20).nullable().default(null),
  // Students can create their own account from the app (the super admin can turn it off).
  studentSelfRegistration: z.boolean().default(true),
  offlineDownloadsEnabled: z.boolean().default(true),
  // How long a downloaded video stays playable offline (renewed by downloading again).
  offlineLicenseDays: z.number().int().min(1).max(365).default(365),
});

export type SystemSettings = z.infer<typeof settingsSchema>;
export const settingsUpdateSchema = settingsSchema.partial();
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

const CACHE_TTL_MS = 30_000;
let cache: { value: SystemSettings; expiresAt: number } | null = null;

export async function getSettings(): Promise<SystemSettings> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const rows = await prisma.systemSetting.findMany();
  const raw: Record<string, unknown> = {};
  for (const row of rows) raw[row.key] = row.value;
  // Unknown or invalid stored values fall back to defaults instead of breaking the app.
  const known = settingsSchema.keyof().options as readonly string[];
  const merged: Record<string, unknown> = {};
  for (const key of known) {
    const field = settingsSchema.shape[key as keyof SystemSettings];
    const parsed = field.safeParse(raw[key]);
    merged[key] = parsed.success ? parsed.data : field.parse(undefined);
  }
  const value = settingsSchema.parse(merged);
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

export async function updateSettings(update: SettingsUpdate, actor: AuditActor): Promise<SystemSettings> {
  const entries = Object.entries(update).filter(([, value]) => value !== undefined);
  await prisma.$transaction(async (tx) => {
    for (const [key, value] of entries) {
      await tx.systemSetting.upsert({
        where: { key },
        create: { key, value: value as never },
        update: { value: value as never },
      });
    }
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_SETTINGS,
      entityType: 'system_settings',
      metadata: Object.fromEntries(entries),
    });
  });
  invalidateSettingsCache();
  return getSettings();
}

/** Subset safe to expose without authentication (login/registration screens). */
export async function getPublicConfig() {
  const settings = await getSettings();
  return {
    instituteName: settings.instituteName,
    institutePhone: settings.institutePhone,
    studentSelfRegistration: settings.studentSelfRegistration,
  };
}
