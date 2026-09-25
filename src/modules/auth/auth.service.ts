import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import type { AuthContext } from '../../core/auth/auth-context.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { securityLogger } from '../../core/logger/logger.js';
import {
  assertStrongPassword,
  burnPasswordCheck,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../core/security/password.js';
import { Prisma, type User } from '../../generated/prisma/client.js';
import type { ClientPortal, UserRole } from '../../generated/prisma/enums.js';
import { bindOrVerifyDevice, type DeviceInfo } from '../devices/device-binding.js';
import { getSettings } from '../settings/settings.service.js';
import { toAccountDto } from '../users/user.dto.js';
import {
  createSession,
  revokeSessionById,
  revokeUserSessions,
  type IssuedTokens,
} from './session.service.js';

type RequestMeta = Pick<AuditActor, 'ip' | 'userAgent'>;

/**
 * Verifies phone + password for an account of the expected role.
 * Unknown phone, wrong role, archived account and wrong password all produce the same
 * INVALID_CREDENTIALS response with the same timing. The disabled state is only revealed
 * after a correct password.
 */
async function verifyCredentials(
  phone: string,
  password: string,
  role: UserRole,
  meta: RequestMeta,
): Promise<User> {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || user.role !== role || user.archivedAt) {
    await burnPasswordCheck(password);
    securityLogger.info({ role, reason: 'unknown_account' }, 'Login failed');
    throw new AppError('INVALID_CREDENTIALS');
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    await writeAudit(
      prisma,
      { userId: null, role: null, ...meta },
      {
        action: AuditAction.LOGIN_FAILED,
        entityType: 'user',
        entityId: user.id,
      },
    );
    securityLogger.info({ userId: user.id, reason: 'bad_password' }, 'Login failed');
    throw new AppError('INVALID_CREDENTIALS');
  }
  if (user.status === 'DISABLED') throw new AppError('ACCOUNT_DISABLED');
  if (needsRehash(user.passwordHash)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    });
  }
  return user;
}

export interface LoginResult {
  tokens: IssuedTokens;
  user: ReturnType<typeof toAccountDto>;
}

/** Super admin / owner login (web portals). */
export async function loginStaff(
  role: Extract<UserRole, 'SUPER_ADMIN' | 'OWNER'>,
  input: { phone: string; password: string },
  meta: RequestMeta,
): Promise<LoginResult> {
  const user = await verifyCredentials(input.phone, input.password, role, meta);
  const portal: ClientPortal = role === 'SUPER_ADMIN' ? 'ADMIN_WEB' : 'OWNER_WEB';
  const tokens = await prisma.$transaction(async (tx) => {
    const issued = await createSession(tx, {
      userId: user.id,
      role: user.role,
      portal,
      deviceId: null,
      ...meta,
    });
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await writeAudit(
      tx,
      { userId: user.id, role: user.role, ...meta },
      {
        action: AuditAction.LOGIN,
        entityType: 'user',
        entityId: user.id,
        metadata: { portal },
      },
    );
    return issued;
  });
  return { tokens, user: toAccountDto(user) };
}

async function auditDeviceRejection(user: User, device: DeviceInfo, meta: RequestMeta): Promise<void> {
  securityLogger.warn(
    { userId: user.id, platform: device.platform },
    'Login rejected: account bound to another device',
  );
  await writeAudit(
    prisma,
    { userId: user.id, role: user.role, ...meta },
    {
      action: AuditAction.LOGIN_DEVICE_REJECTED,
      entityType: 'user',
      entityId: user.id,
      metadata: { platform: device.platform, model: device.model ?? null },
    },
  );
}

/** Student login from the mobile app: credentials → device binding → session. */
export async function loginStudent(
  input: { phone: string; password: string; device: DeviceInfo },
  meta: RequestMeta,
): Promise<LoginResult> {
  const user = await verifyCredentials(input.phone, input.password, 'STUDENT', meta);
  try {
    const tokens = await prisma.$transaction(async (tx) => {
      const binding = await bindOrVerifyDevice(tx, user.id, input.device, meta.ip);
      const issued = await createSession(tx, {
        userId: user.id,
        role: 'STUDENT',
        portal: 'STUDENT_APP',
        deviceId: binding.deviceId,
        ...meta,
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      const actor = { userId: user.id, role: user.role, ...meta };
      if (binding.newlyBound) {
        await writeAudit(tx, actor, {
          action: AuditAction.DEVICE_BOUND,
          entityType: 'device',
          entityId: binding.deviceId,
          metadata: { platform: input.device.platform, model: input.device.model ?? null },
        });
      }
      await writeAudit(tx, actor, {
        action: AuditAction.LOGIN,
        entityType: 'user',
        entityId: user.id,
        metadata: { portal: 'STUDENT_APP' },
      });
      return issued;
    });
    return { tokens, user: toAccountDto(user) };
  } catch (error) {
    if (error instanceof AppError && error.code === 'DEVICE_ALREADY_BOUND') {
      await auditDeviceRejection(user, input.device, meta);
    }
    throw error;
  }
}

/** Optional self-registration (controlled by the `studentSelfRegistration` system setting). */
export async function registerStudent(
  input: { name: string; phone: string; password: string; device: DeviceInfo },
  meta: RequestMeta,
): Promise<LoginResult> {
  const settings = await getSettings();
  if (!settings.studentSelfRegistration) throw new AppError('REGISTRATION_DISABLED');
  assertStrongPassword(input.password);
  const passwordHash = await hashPassword(input.password);

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          role: 'STUDENT',
          name: input.name,
          phone: input.phone,
          passwordHash,
          passwordChangedAt: new Date(),
          lastLoginAt: new Date(),
          studentProfile: { create: { source: 'SELF_REGISTERED' } },
        },
      });
      const binding = await bindOrVerifyDevice(tx, user.id, input.device, meta.ip);
      const tokens = await createSession(tx, {
        userId: user.id,
        role: 'STUDENT',
        portal: 'STUDENT_APP',
        deviceId: binding.deviceId,
        ...meta,
      });
      const actor = { userId: user.id, role: user.role, ...meta };
      await writeAudit(tx, actor, {
        action: AuditAction.REGISTER_STUDENT,
        entityType: 'user',
        entityId: user.id,
      });
      await writeAudit(tx, actor, {
        action: AuditAction.DEVICE_BOUND,
        entityType: 'device',
        entityId: binding.deviceId,
        metadata: { platform: input.device.platform, model: input.device.model ?? null },
      });
      return { tokens, user: toAccountDto(user) };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('PHONE_ALREADY_EXISTS');
    }
    throw error;
  }
}

export async function logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await revokeSessionById(tx, auth.sessionId, 'LOGOUT');
    await writeAudit(
      tx,
      { userId: auth.userId, role: auth.role, ...meta },
      {
        action: AuditAction.LOGOUT,
        entityType: 'auth_session',
        entityId: auth.sessionId,
      },
    );
  });
}

/**
 * Self-service password change for every role. Requires the current password; all other
 * sessions of the account are revoked so a leaked password stops working everywhere else.
 */
export async function changePassword(
  auth: AuthContext,
  input: { currentPassword: string; newPassword: string; confirmPassword: string },
  meta: RequestMeta,
): Promise<{ revokedSessions: number }> {
  if (input.newPassword !== input.confirmPassword) throw new AppError('PASSWORD_CONFIRMATION_MISMATCH');
  assertStrongPassword(input.newPassword);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new AppError('INVALID_CURRENT_PASSWORD');
  }
  const passwordHash = await hashPassword(input.newPassword);
  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
    const revokedSessions = await revokeUserSessions(tx, user.id, 'PASSWORD_CHANGED', {
      exceptSessionId: auth.sessionId,
    });
    await writeAudit(
      tx,
      { userId: auth.userId, role: auth.role, ...meta },
      {
        action: AuditAction.CHANGE_PASSWORD,
        entityType: 'user',
        entityId: user.id,
        metadata: { revokedSessions },
      },
    );
    return { revokedSessions };
  });
}

/** Current account with role-specific details. */
export async function getCurrentAccount(auth: AuthContext) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.userId },
    include: {
      studentProfile: { include: { grade: { select: { id: true, name: true } } } },
    },
  });
  const device = auth.deviceId
    ? await prisma.device.findUnique({
        where: { id: auth.deviceId },
        select: { platform: true, model: true, firstSeenAt: true, appVersion: true },
      })
    : null;
  return {
    ...toAccountDto(user),
    grade: user.studentProfile?.grade ?? null,
    device: device ? { platform: device.platform, model: device.model, boundAt: device.firstSeenAt } : null,
  };
}
