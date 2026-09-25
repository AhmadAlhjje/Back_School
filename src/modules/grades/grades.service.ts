import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { archivedWhere, type LifecycleFilter } from '../../core/http/schemas.js';
import {
  archiveEntity,
  changedFields,
  nextSortOrder,
  reorderEntities,
  restoreEntity,
} from '../catalog/lifecycle.js';

export interface GradeInput {
  name: string;
  description: string | null;
}

async function assertUniqueName(name: string, exceptId?: string) {
  const clash = await prisma.grade.findFirst({
    where: { name, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new AppError('CONFLICT', { details: { field: 'name' } });
}

/** Active grades as choices (student self-registration), in the owner's order. */
export async function listGradeOptions() {
  return prisma.grade.findMany({
    where: { archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true },
  });
}

export async function listGrades(filter: { status: LifecycleFilter; search?: string }) {
  const grades = await prisma.grade.findMany({
    where: {
      ...archivedWhere(filter.status),
      ...(filter.search ? { name: { contains: filter.search } } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { subjects: { where: { archivedAt: null } } } } },
  });
  return grades.map(({ _count, ...grade }) => ({ ...grade, subjectsCount: _count.subjects }));
}

export async function getGrade(id: string) {
  const grade = await prisma.grade.findUnique({
    where: { id },
    include: {
      subjects: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
    },
  });
  if (!grade) throw notFound('grade');
  return grade;
}

export async function createGrade(input: GradeInput, actor: AuditActor) {
  await assertUniqueName(input.name);
  return prisma.$transaction(async (tx) => {
    const order = await tx.grade.aggregate({ _max: { sortOrder: true } });
    const grade = await tx.grade.create({ data: { ...input, sortOrder: nextSortOrder(order) } });
    await writeAudit(tx, actor, {
      action: AuditAction.CREATE_GRADE,
      entityType: 'grade',
      entityId: grade.id,
      metadata: { name: grade.name },
    });
    return grade;
  });
}

export async function updateGrade(id: string, patch: Partial<GradeInput>, actor: AuditActor) {
  const grade = await prisma.grade.findUnique({ where: { id } });
  if (!grade) throw notFound('grade');
  if (patch.name && patch.name !== grade.name) await assertUniqueName(patch.name, id);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.grade.update({ where: { id }, data: patch });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_GRADE,
      entityType: 'grade',
      entityId: id,
      metadata: changedFields(grade, patch) as never,
    });
    return updated;
  });
}

export function archiveGrade(id: string, actor: AuditActor) {
  return archiveEntity({
    entityType: 'grade',
    id,
    actor,
    load: (tx) => tx.grade.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.grade.update({ where: { id }, data: { archivedAt } }),
  });
}

export async function restoreGrade(id: string, actor: AuditActor) {
  const grade = await prisma.grade.findUnique({ where: { id } });
  if (grade?.archivedAt) await assertUniqueName(grade.name, id);
  return restoreEntity({
    entityType: 'grade',
    id,
    actor,
    load: (tx) => tx.grade.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.grade.update({ where: { id }, data: { archivedAt } }),
  });
}

export function reorderGrades(ids: string[], actor: AuditActor) {
  return reorderEntities({
    entityType: 'grade',
    ids,
    actor,
    parentId: null,
    siblingIds: async (tx) =>
      (await tx.grade.findMany({ where: { archivedAt: null }, select: { id: true } })).map((g) => g.id),
    setOrder: (tx, id, sortOrder) => tx.grade.update({ where: { id }, data: { sortOrder } }),
  });
}
