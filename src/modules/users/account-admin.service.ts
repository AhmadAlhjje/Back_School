import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { assertStrongPassword, hashPassword } from '../../core/security/password.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import { revokeUserSessions } from '../auth/session.service.js';

/**
 * Administrative operations on accounts of a given role (students by staff, owners by the
 * super admin). Each operation is transactional, audited, and revokes sessions when it
 * changes what the account may do.
 */

async function loadAccount(userId: string, role: UserRole) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== role) throw notFound(role === 'STUDENT' ? 'student' : 'account');
  return user;
}

export function isUniquePhoneViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function setAccountStatus(
  userId: string,
  role: UserRole,
  status: 'ACTIVE' | 'DISABLED',
  actor: AuditActor,
): Promise<void> {
  const user = await loadAccount(userId, role);
  if (user.status === status) return;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { status } });
    const revokedSessions =
      status === 'DISABLED' ? await revokeUserSessions(tx, userId, 'ACCOUNT_DISABLED') : 0;
    await writeAudit(tx, actor, {
      action: status === 'DISABLED' ? AuditAction.DISABLE_USER : AuditAction.ENABLE_USER,
      entityType: 'user',
      entityId: userId,
      metadata: { role, revokedSessions },
    });
  });
}

export async function setAccountArchived(
  userId: string,
  role: UserRole,
  archived: boolean,
  actor: AuditActor,
) {
  const user = await loadAccount(userId, role);
  if ((user.archivedAt !== null) === archived) return;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { archivedAt: archived ? new Date() : null } });
    const revokedSessions = archived ? await revokeUserSessions(tx, userId, 'ACCOUNT_ARCHIVED') : 0;
    await writeAudit(tx, actor, {
      action: archived ? AuditAction.ARCHIVE_USER : AuditAction.RESTORE_USER,
      entityType: 'user',
      entityId: userId,
      metadata: { role, revokedSessions },
    });
  });
}

/** Staff-initiated password reset: the new password is set directly and all sessions end. */
export async function resetAccountPassword(
  userId: string,
  role: UserRole,
  newPassword: string,
  actor: AuditActor,
) {
  assertStrongPassword(newPassword);
  await loadAccount(userId, role);
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: new Date() } });
    const revokedSessions = await revokeUserSessions(tx, userId, 'PASSWORD_RESET');
    await writeAudit(tx, actor, {
      action: AuditAction.RESET_PASSWORD,
      entityType: 'user',
      entityId: userId,
      metadata: { role, revokedSessions },
    });
  });
}

export { loadAccount };

export function assertNotArchived(user: { archivedAt: Date | null }) {
  if (user.archivedAt) throw new AppError('ITEM_ARCHIVED');
}
