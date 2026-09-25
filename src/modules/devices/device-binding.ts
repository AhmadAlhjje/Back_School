import { z } from 'zod';
import type { Tx } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { sha256Hex } from '../../core/security/crypto.js';
import { Prisma } from '../../generated/prisma/client.js';
import { DevicePlatform } from '../../generated/prisma/enums.js';

/** Device information sent by the student app on login/registration. */
export const deviceInfoSchema = z.object({
  /** App-generated stable identifier (ANDROID_ID / Keychain UUID). Only its hash is stored. */
  identifier: z.string().trim().min(8).max(200),
  platform: z.enum(DevicePlatform),
  model: z.string().trim().max(120).optional(),
  osVersion: z.string().trim().max(60).optional(),
  appVersion: z.string().trim().max(30).optional(),
});

export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

export interface BindingResult {
  deviceId: string;
  newlyBound: boolean;
}

/**
 * Enforces "one account ↔ one device". The first successful login binds the device; later
 * logins must come from the same device. Only a super admin reset frees the binding.
 * The unique `active_student_id` column makes concurrent first-logins from two devices safe:
 * the loser of the race fails with a unique violation and is rejected.
 */
export async function bindOrVerifyDevice(
  tx: Tx,
  studentId: string,
  device: DeviceInfo,
  ip: string | null,
): Promise<BindingResult> {
  const identifierHash = sha256Hex(device.identifier);
  const active = await tx.device.findUnique({ where: { activeStudentId: studentId } });

  if (active) {
    if (active.identifierHash !== identifierHash) throw new AppError('DEVICE_ALREADY_BOUND');
    await tx.device.update({
      where: { id: active.id },
      data: {
        lastSeenAt: new Date(),
        lastIp: ip,
        appVersion: device.appVersion ?? active.appVersion,
        osVersion: device.osVersion ?? active.osVersion,
        model: device.model ?? active.model,
      },
    });
    return { deviceId: active.id, newlyBound: false };
  }

  try {
    const created = await tx.device.create({
      data: {
        studentId,
        activeStudentId: studentId,
        identifierHash,
        platform: device.platform,
        model: device.model ?? null,
        osVersion: device.osVersion ?? null,
        appVersion: device.appVersion ?? null,
        lastIp: ip,
      },
    });
    return { deviceId: created.id, newlyBound: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('DEVICE_ALREADY_BOUND');
    }
    throw error;
  }
}
