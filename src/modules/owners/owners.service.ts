import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { assertStrongPassword, hashPassword } from '../../core/security/password.js';
import { changedFields } from '../catalog/lifecycle.js';
import { isUniquePhoneViolation } from '../users/account-admin.service.js';
import { toAccountDto } from '../users/user.dto.js';

/**
 * The institute owner account. Single institute ⇒ at most one non-archived owner.
 * Only the super admin creates the owner and changes its name/phone (spec §45).
 */

export async function listOwners() {
  const owners = await prisma.user.findMany({ where: { role: 'OWNER' }, orderBy: { createdAt: 'desc' } });
  return owners.map(toAccountDto);
}

export async function getOwner(id: string) {
  const owner = await prisma.user.findFirst({ where: { id, role: 'OWNER' } });
  if (!owner) throw notFound('owner');
  const activeSessions = await prisma.authSession.count({
    where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
  });
  return { ...toAccountDto(owner), activeSessions };
}

async function assertNoOtherActiveOwner(exceptId?: string) {
  const existing = await prisma.user.findFirst({
    where: { role: 'OWNER', archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (existing) throw new AppError('OWNER_ALREADY_EXISTS');
}

export async function createOwner(
  input: { name: string; phone: string; password: string },
  actor: AuditActor,
) {
  assertStrongPassword(input.password);
  await assertNoOtherActiveOwner();
  const passwordHash = await hashPassword(input.password);
  try {
    const owner = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          role: 'OWNER',
          name: input.name,
          phone: input.phone,
          passwordHash,
          passwordChangedAt: new Date(),
        },
      });
      await writeAudit(tx, actor, {
        action: AuditAction.CREATE_OWNER,
        entityType: 'user',
        entityId: created.id,
        metadata: { name: created.name, phone: created.phone },
      });
      return created;
    });
    return getOwner(owner.id);
  } catch (error) {
    if (isUniquePhoneViolation(error)) throw new AppError('PHONE_ALREADY_EXISTS');
    throw error;
  }
}

export async function updateOwner(id: string, patch: { name?: string; phone?: string }, actor: AuditActor) {
  const owner = await prisma.user.findFirst({ where: { id, role: 'OWNER' } });
  if (!owner) throw notFound('owner');
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: patch });
      await writeAudit(tx, actor, {
        action: AuditAction.UPDATE_OWNER,
        entityType: 'user',
        entityId: id,
        metadata: changedFields(owner, patch) as never,
      });
    });
  } catch (error) {
    if (isUniquePhoneViolation(error)) throw new AppError('PHONE_ALREADY_EXISTS');
    throw error;
  }
  return getOwner(id);
}

export async function assertOwnerRestorable(id: string) {
  await assertNoOtherActiveOwner(id);
}
