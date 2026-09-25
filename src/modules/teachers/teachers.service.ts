import { randomBytes } from 'node:crypto';
import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { paginated, skipTake, type PaginationQuery } from '../../core/http/pagination.js';
import { archivedWhere, type LifecycleFilter } from '../../core/http/schemas.js';
import { commitReceivedFile, discardReceivedFile, type ReceivedFile } from '../../core/storage/multipart.js';
import { removeStoragePath, StorageArea, storageKey } from '../../core/storage/storage.js';
import type { Teacher } from '../../generated/prisma/client.js';
import { archiveEntity, changedFields, restoreEntity } from '../catalog/lifecycle.js';

export interface TeacherInput {
  name: string;
  phone: string | null;
  description: string | null;
}

/** Teacher as returned to dashboards. The storage key never leaves the server. */
export function toTeacherDto(teacher: Teacher) {
  const { imageKey, ...rest } = teacher;
  return {
    ...rest,
    hasImage: imageKey !== null,
    imageUrl: imageKey ? `/api/v1/media/teachers/${teacher.id}/image?v=${teacher.updatedAt.getTime()}` : null,
  };
}

export async function listTeachers(filter: PaginationQuery & { status: LifecycleFilter; search?: string }) {
  const where = {
    ...archivedWhere(filter.status),
    ...(filter.search
      ? { OR: [{ name: { contains: filter.search } }, { phone: { contains: filter.search } }] }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.teacher.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      include: {
        subjects: {
          where: { archivedAt: null },
          include: { subject: { select: { id: true, name: true, grade: { select: { name: true } } } } },
        },
      },
      ...skipTake(filter),
    }),
    prisma.teacher.count({ where }),
  ]);
  return paginated(
    items.map(({ subjects, ...teacher }) => ({
      ...toTeacherDto(teacher),
      subjects: subjects.map((assignment) => ({
        subjectTeacherId: assignment.id,
        subjectId: assignment.subject.id,
        subjectName: assignment.subject.name,
        gradeName: assignment.subject.grade.name,
      })),
    })),
    total,
    filter,
  );
}

export async function getTeacher(id: string) {
  const teacher = await prisma.teacher.findUnique({
    where: { id },
    include: {
      subjects: {
        orderBy: { createdAt: 'asc' },
        include: {
          subject: {
            select: { id: true, name: true, archivedAt: true, grade: { select: { id: true, name: true } } },
          },
          _count: { select: { topics: { where: { archivedAt: null } } } },
        },
      },
    },
  });
  if (!teacher) throw notFound('teacher');
  const { subjects, ...rest } = teacher;
  return {
    ...toTeacherDto(rest),
    subjects: subjects.map(({ _count, ...assignment }) => ({ ...assignment, topicsCount: _count.topics })),
  };
}

/** Creates a teacher and (optionally) assigns subjects — one transaction with its audit entries. */
export async function createTeacher(input: TeacherInput & { subjectIds: string[] }, actor: AuditActor) {
  const { subjectIds, ...data } = input;
  const uniqueSubjectIds = [...new Set(subjectIds)];
  const teacher = await prisma.$transaction(async (tx) => {
    const subjects = await tx.subject.findMany({ where: { id: { in: uniqueSubjectIds } } });
    if (subjects.length !== uniqueSubjectIds.length) throw notFound('subject');
    if (subjects.some((subject) => subject.archivedAt)) throw new AppError('PARENT_ARCHIVED');

    const created = await tx.teacher.create({ data });
    for (const subject of subjects) {
      const order = await tx.subjectTeacher.aggregate({
        where: { subjectId: subject.id },
        _max: { sortOrder: true },
      });
      await tx.subjectTeacher.create({
        data: { subjectId: subject.id, teacherId: created.id, sortOrder: (order._max.sortOrder ?? 0) + 1 },
      });
    }
    await writeAudit(tx, actor, {
      action: AuditAction.CREATE_TEACHER,
      entityType: 'teacher',
      entityId: created.id,
      metadata: { name: created.name, subjectIds: uniqueSubjectIds },
    });
    return created;
  });
  return getTeacher(teacher.id);
}

export async function updateTeacher(id: string, patch: Partial<TeacherInput>, actor: AuditActor) {
  const teacher = await prisma.teacher.findUnique({ where: { id } });
  if (!teacher) throw notFound('teacher');
  await prisma.$transaction(async (tx) => {
    await tx.teacher.update({ where: { id }, data: patch });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_TEACHER,
      entityType: 'teacher',
      entityId: id,
      metadata: changedFields(teacher, patch) as never,
    });
  });
  return getTeacher(id);
}

export function archiveTeacher(id: string, actor: AuditActor) {
  return archiveEntity({
    entityType: 'teacher',
    id,
    actor,
    load: (tx) => tx.teacher.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.teacher.update({ where: { id }, data: { archivedAt } }),
  });
}

export function restoreTeacher(id: string, actor: AuditActor) {
  return restoreEntity({
    entityType: 'teacher',
    id,
    actor,
    load: (tx) => tx.teacher.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.teacher.update({ where: { id }, data: { archivedAt } }),
  });
}

export async function setTeacherImage(id: string, file: ReceivedFile, actor: AuditActor) {
  const teacher = await prisma.teacher.findUnique({ where: { id } });
  if (!teacher) {
    await discardReceivedFile(file);
    throw notFound('teacher');
  }
  // Random suffix: a replaced photo gets a new key, so stale caches can never show the old one.
  const key = storageKey(
    StorageArea.teacherImages,
    `${id}-${randomBytes(6).toString('hex')}.${file.extension}`,
  );
  await commitReceivedFile(file, key);
  await prisma.$transaction(async (tx) => {
    await tx.teacher.update({ where: { id }, data: { imageKey: key } });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_TEACHER,
      entityType: 'teacher',
      entityId: id,
      metadata: { image: 'updated' },
    });
  });
  if (teacher.imageKey) await removeStoragePath(teacher.imageKey);
  return getTeacher(id);
}

export async function removeTeacherImage(id: string, actor: AuditActor) {
  const teacher = await prisma.teacher.findUnique({ where: { id } });
  if (!teacher) throw notFound('teacher');
  if (!teacher.imageKey) return getTeacher(id);
  await prisma.$transaction(async (tx) => {
    await tx.teacher.update({ where: { id }, data: { imageKey: null } });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_TEACHER,
      entityType: 'teacher',
      entityId: id,
      metadata: { image: 'removed' },
    });
  });
  await removeStoragePath(teacher.imageKey);
  return getTeacher(id);
}
