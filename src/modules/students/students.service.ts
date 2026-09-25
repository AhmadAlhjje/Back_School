import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { paginated } from '../../core/http/pagination.js';
import { assertStrongPassword, hashPassword } from '../../core/security/password.js';
import { changedFields } from '../catalog/lifecycle.js';
import { isUniquePhoneViolation } from '../users/account-admin.service.js';
import { findStudentDetails, findStudentsPage, type StudentListFilter } from './students.repository.js';

export interface StudentInput {
  name: string;
  phone: string;
  gradeId: string | null;
  notes: string | null;
}

async function assertGrade(gradeId: string | null | undefined) {
  if (!gradeId) return;
  const grade = await prisma.grade.findUnique({ where: { id: gradeId }, select: { archivedAt: true } });
  if (!grade) throw notFound('grade');
  if (grade.archivedAt) throw new AppError('PARENT_ARCHIVED');
}

export async function listStudents(filter: StudentListFilter) {
  const { rows, total } = await findStudentsPage(filter);
  const items = rows.map((user) => ({
    id: user.id,
    name: user.name,
    phone: user.phone,
    status: user.status,
    archived: user.archivedAt !== null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    grade: user.studentProfile?.grade ?? null,
    source: user.studentProfile?.source ?? 'STAFF_CREATED',
    device: user.devices[0] ?? null,
    openSubjectsCount: user._count.subjectAccess,
    openTeachersCount: user._count.teacherAccess,
  }));
  return paginated(items, total, filter);
}

/** Student page (spec §42): account, device, opened subjects and teachers. */
export async function getStudent(id: string) {
  const user = await findStudentDetails(id);
  if (!user) throw notFound('student');
  const activeDevice = user.devices.find((device) => device.status === 'ACTIVE') ?? null;
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    status: user.status,
    archived: user.archivedAt !== null,
    archivedAt: user.archivedAt,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    passwordChangedAt: user.passwordChangedAt,
    grade: user.studentProfile?.grade ?? null,
    notes: user.studentProfile?.notes ?? null,
    source: user.studentProfile?.source ?? 'STAFF_CREATED',
    activeSessions: user._count.authSessions,
    device: activeDevice
      ? {
          id: activeDevice.id,
          platform: activeDevice.platform,
          model: activeDevice.model,
          osVersion: activeDevice.osVersion,
          appVersion: activeDevice.appVersion,
          firstSeenAt: activeDevice.firstSeenAt,
          lastSeenAt: activeDevice.lastSeenAt,
        }
      : null,
    deviceHistory: user.devices.map((device) => ({
      id: device.id,
      platform: device.platform,
      model: device.model,
      status: device.status,
      firstSeenAt: device.firstSeenAt,
      lastSeenAt: device.lastSeenAt,
      resetAt: device.resetAt,
    })),
    openedSubjects: user.subjectAccess.map((grant) => ({
      subjectId: grant.subject.id,
      name: grant.subject.name,
      gradeName: grant.subject.grade.name,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
    })),
    openedTeachers: user.teacherAccess.map((grant) => ({
      subjectTeacherId: grant.subjectTeacher.id,
      subjectId: grant.subjectTeacher.subject.id,
      subjectName: grant.subjectTeacher.subject.name,
      teacherId: grant.subjectTeacher.teacher.id,
      teacherName: grant.subjectTeacher.teacher.name,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
    })),
  };
}

/** Staff-created student account (spec §14, option A). */
export async function createStudent(input: StudentInput & { password: string }, actor: AuditActor) {
  assertStrongPassword(input.password);
  await assertGrade(input.gradeId);
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          role: 'STUDENT',
          name: input.name,
          phone: input.phone,
          passwordHash,
          passwordChangedAt: new Date(),
          studentProfile: { create: { source: 'STAFF_CREATED', gradeId: input.gradeId, notes: input.notes } },
        },
      });
      await writeAudit(tx, actor, {
        action: AuditAction.CREATE_STUDENT,
        entityType: 'user',
        entityId: created.id,
        metadata: { name: created.name, phone: created.phone },
      });
      return created;
    });
    return getStudent(user.id);
  } catch (error) {
    if (isUniquePhoneViolation(error)) throw new AppError('PHONE_ALREADY_EXISTS');
    throw error;
  }
}

export async function updateStudent(id: string, patch: Partial<StudentInput>, actor: AuditActor) {
  const user = await prisma.user.findFirst({
    where: { id, role: 'STUDENT' },
    include: { studentProfile: true },
  });
  if (!user) throw notFound('student');
  if (patch.gradeId !== undefined) await assertGrade(patch.gradeId);
  const { gradeId, notes, ...account } = patch;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: account });
      if (gradeId !== undefined || notes !== undefined) {
        await tx.studentProfile.upsert({
          where: { userId: id },
          create: { userId: id, gradeId: gradeId ?? null, notes: notes ?? null },
          update: {
            ...(gradeId !== undefined ? { gradeId } : {}),
            ...(notes !== undefined ? { notes } : {}),
          },
        });
      }
      await writeAudit(tx, actor, {
        action: AuditAction.UPDATE_STUDENT,
        entityType: 'user',
        entityId: id,
        metadata: {
          ...changedFields(user, account),
          ...(gradeId !== undefined
            ? changedFields(user.studentProfile ?? { gradeId: null }, { gradeId })
            : {}),
        } as never,
      });
    });
  } catch (error) {
    if (isUniquePhoneViolation(error)) throw new AppError('PHONE_ALREADY_EXISTS');
    throw error;
  }
  return getStudent(id);
}

/** Login history and audit trail for one student (super admin). */
export async function getStudentActivity(id: string) {
  const student = await prisma.user.findFirst({ where: { id, role: 'STUDENT' }, select: { id: true } });
  if (!student) throw notFound('student');
  const [sessions, events] = await Promise.all([
    prisma.authSession.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        portal: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        revokeReason: true,
      },
    }),
    prisma.auditLog.findMany({
      where: { OR: [{ actorId: id }, { entityId: id }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { actor: { select: { id: true, name: true, role: true } } },
    }),
  ]);
  return { sessions, events };
}
