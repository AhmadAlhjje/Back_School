import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { notFound } from '../../core/errors/app-error.js';
import { paginated, skipTake, type PaginationQuery } from '../../core/http/pagination.js';
import { securityLogger } from '../../core/logger/logger.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { revokeDeviceSessions } from '../auth/session.service.js';

export async function listDevices(
  filter: PaginationQuery & { status: 'ACTIVE' | 'RESET' | 'all'; search?: string },
) {
  const where: Prisma.DeviceWhereInput = {
    ...(filter.status !== 'all' ? { status: filter.status } : {}),
    ...(filter.search
      ? { student: { OR: [{ name: { contains: filter.search } }, { phone: { contains: filter.search } }] } }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.device.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        platform: true,
        model: true,
        osVersion: true,
        appVersion: true,
        status: true,
        firstSeenAt: true,
        lastSeenAt: true,
        resetAt: true,
        student: { select: { id: true, name: true, phone: true, status: true } },
      },
      ...skipTake(filter),
    }),
    prisma.device.count({ where }),
  ]);
  return paginated(items, total, filter);
}

/**
 * Super-admin device reset (spec §17, §43, §106). In one transaction: the binding is released,
 * every session from that device is revoked, offline licenses on it are revoked, and the reset
 * is audited. The student can then log in from a new device.
 */
export async function resetDevice(deviceId: string, actor: AuditActor) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw notFound('device');
  if (device.status === 'RESET') return device;

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.device.update({
      where: { id: deviceId },
      data: { status: 'RESET', activeStudentId: null, resetAt: new Date() },
    });
    const revokedSessions = await revokeDeviceSessions(tx, deviceId, 'DEVICE_RESET');
    const revokedLicenses = await tx.offlineLicense.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit(tx, actor, {
      action: AuditAction.RESET_DEVICE,
      entityType: 'device',
      entityId: deviceId,
      metadata: {
        studentId: device.studentId,
        platform: device.platform,
        model: device.model,
        revokedSessions,
        revokedOfflineLicenses: revokedLicenses.count,
      },
    });
    return updated;
  });
  securityLogger.info({ deviceId, studentId: device.studentId, actor: actor.userId }, 'Device reset');
  return result;
}
