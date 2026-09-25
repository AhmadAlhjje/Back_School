import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { paginated, skipTake, type PaginationQuery } from '../../core/http/pagination.js';
import { archivedWhere, type LifecycleFilter } from '../../core/http/schemas.js';
import {
  archiveEntity,
  changedFields,
  nextSortOrder,
  reorderEntities,
  restoreEntity,
} from '../catalog/lifecycle.js';

export interface SubjectInput {
  gradeId: string;
  name: string;
  description: string | null;
}

async function assertActiveGrade(gradeId: string) {
  const grade = await prisma.grade.findUnique({ where: { id: gradeId }, select: { archivedAt: true } });
  if (!grade) throw notFound('grade');
  if (grade.archivedAt) throw new AppError('PARENT_ARCHIVED');
}

async function assertUniqueName(gradeId: string, name: string, exceptId?: string) {
  const clash = await prisma.subject.findFirst({
    where: { gradeId, name, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new AppError('CONFLICT', { details: { field: 'name' } });
}

export async function listSubjects(
  filter: PaginationQuery & { status: LifecycleFilter; search?: string; gradeId?: string },
) {
  const where = {
    ...archivedWhere(filter.status),
    ...(filter.gradeId ? { gradeId: filter.gradeId } : {}),
    ...(filter.search ? { name: { contains: filter.search } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.subject.findMany({
      where,
      orderBy: [{ grade: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        grade: { select: { id: true, name: true, archivedAt: true } },
        _count: { select: { teachers: { where: { archivedAt: null } } } },
      },
      ...skipTake(filter),
    }),
    prisma.subject.count({ where }),
  ]);
  return paginated(
    items.map(({ _count, ...subject }) => ({ ...subject, teachersCount: _count.teachers })),
    total,
    filter,
  );
}

export async function getSubject(id: string) {
  const subject = await prisma.subject.findUnique({
    where: { id },
    include: {
      grade: { select: { id: true, name: true, archivedAt: true } },
      teachers: {
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: {
          teacher: { select: { id: true, name: true, imageKey: true, archivedAt: true } },
          _count: { select: { topics: { where: { archivedAt: null } } } },
        },
      },
    },
  });
  if (!subject) throw notFound('subject');
  return {
    ...subject,
    teachers: subject.teachers.map(({ _count, teacher, ...assignment }) => ({
      ...assignment,
      teacher: {
        id: teacher.id,
        name: teacher.name,
        hasImage: teacher.imageKey !== null,
        archivedAt: teacher.archivedAt,
      },
      topicsCount: _count.topics,
    })),
  };
}

export async function createSubject(input: SubjectInput, actor: AuditActor) {
  await assertActiveGrade(input.gradeId);
  await assertUniqueName(input.gradeId, input.name);
  return prisma.$transaction(async (tx) => {
    const order = await tx.subject.aggregate({
      where: { gradeId: input.gradeId },
      _max: { sortOrder: true },
    });
    const subject = await tx.subject.create({ data: { ...input, sortOrder: nextSortOrder(order) } });
    await writeAudit(tx, actor, {
      action: AuditAction.CREATE_SUBJECT,
      entityType: 'subject',
      entityId: subject.id,
      metadata: { name: subject.name, gradeId: subject.gradeId },
    });
    return subject;
  });
}

export async function updateSubject(id: string, patch: Partial<SubjectInput>, actor: AuditActor) {
  const subject = await prisma.subject.findUnique({ where: { id } });
  if (!subject) throw notFound('subject');
  if (patch.gradeId && patch.gradeId !== subject.gradeId) await assertActiveGrade(patch.gradeId);
  const gradeId = patch.gradeId ?? subject.gradeId;
  const nameValue = patch.name ?? subject.name;
  if (gradeId !== subject.gradeId || nameValue !== subject.name)
    await assertUniqueName(gradeId, nameValue, id);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.subject.update({ where: { id }, data: patch });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_SUBJECT,
      entityType: 'subject',
      entityId: id,
      metadata: changedFields(subject, patch) as never,
    });
    return updated;
  });
}

export function archiveSubject(id: string, actor: AuditActor) {
  return archiveEntity({
    entityType: 'subject',
    id,
    actor,
    load: (tx) => tx.subject.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.subject.update({ where: { id }, data: { archivedAt } }),
  });
}

export function restoreSubject(id: string, actor: AuditActor) {
  return restoreEntity({
    entityType: 'subject',
    id,
    actor,
    load: (tx) => tx.subject.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.subject.update({ where: { id }, data: { archivedAt } }),
    parentIsActive: async (tx) => {
      const subject = await tx.subject.findUniqueOrThrow({ where: { id }, include: { grade: true } });
      return subject.grade.archivedAt === null;
    },
  });
}

export function reorderSubjects(gradeId: string, ids: string[], actor: AuditActor) {
  return reorderEntities({
    entityType: 'subject',
    ids,
    actor,
    parentId: gradeId,
    siblingIds: async (tx) =>
      (await tx.subject.findMany({ where: { gradeId, archivedAt: null }, select: { id: true } })).map(
        (s) => s.id,
      ),
    setOrder: (tx, id, sortOrder) => tx.subject.update({ where: { id }, data: { sortOrder } }),
  });
}

/**
 * Assigns a teacher to a subject, creating the teacher's content space in that subject.
 * Re-assigning a previously unassigned teacher restores the same space with all its content.
 */
export async function assignTeacher(subjectId: string, teacherId: string, actor: AuditActor) {
  const [subject, teacher] = await Promise.all([
    prisma.subject.findUnique({ where: { id: subjectId } }),
    prisma.teacher.findUnique({ where: { id: teacherId } }),
  ]);
  if (!subject) throw notFound('subject');
  if (!teacher) throw notFound('teacher');
  if (subject.archivedAt || teacher.archivedAt) throw new AppError('PARENT_ARCHIVED');

  return prisma.$transaction(async (tx) => {
    const existing = await tx.subjectTeacher.findUnique({
      where: { subjectId_teacherId: { subjectId, teacherId } },
    });
    if (existing && !existing.archivedAt) return existing;
    const order = await tx.subjectTeacher.aggregate({ where: { subjectId }, _max: { sortOrder: true } });
    const assignment = existing
      ? await tx.subjectTeacher.update({
          where: { id: existing.id },
          data: { archivedAt: null, sortOrder: nextSortOrder(order) },
        })
      : await tx.subjectTeacher.create({ data: { subjectId, teacherId, sortOrder: nextSortOrder(order) } });
    await writeAudit(tx, actor, {
      action: AuditAction.ASSIGN_TEACHER,
      entityType: 'subject_teacher',
      entityId: assignment.id,
      metadata: { subjectId, teacherId, restored: Boolean(existing) },
    });
    return assignment;
  });
}

export function reorderSubjectTeachers(subjectId: string, ids: string[], actor: AuditActor) {
  return reorderEntities({
    entityType: 'subject_teacher',
    ids,
    actor,
    parentId: subjectId,
    siblingIds: async (tx) =>
      (
        await tx.subjectTeacher.findMany({ where: { subjectId, archivedAt: null }, select: { id: true } })
      ).map((s) => s.id),
    setOrder: (tx, id, sortOrder) => tx.subjectTeacher.update({ where: { id }, data: { sortOrder } }),
  });
}
