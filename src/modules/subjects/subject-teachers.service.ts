import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { archivedWhere, type LifecycleFilter } from '../../core/http/schemas.js';

/** A teacher's content space inside one subject ("Ahmad — Mathematics"). */
export async function getSubjectTeacher(id: string, topicStatus: LifecycleFilter = 'all') {
  const assignment = await prisma.subjectTeacher.findUnique({
    where: { id },
    include: {
      subject: { include: { grade: { select: { id: true, name: true, archivedAt: true } } } },
      teacher: { select: { id: true, name: true, phone: true, imageKey: true, archivedAt: true } },
      topics: {
        where: archivedWhere(topicStatus),
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { _count: { select: { sessions: { where: { archivedAt: null } } } } },
      },
    },
  });
  if (!assignment) throw notFound('subject_teacher');
  const { teacher, topics, ...rest } = assignment;
  return {
    ...rest,
    teacher: {
      id: teacher.id,
      name: teacher.name,
      phone: teacher.phone,
      hasImage: teacher.imageKey !== null,
      archivedAt: teacher.archivedAt,
    },
    topics: topics.map(({ _count, ...topic }) => ({ ...topic, sessionsCount: _count.sessions })),
  };
}

/** Unassigns a teacher from a subject. The content space is archived, never deleted. */
export async function unassignTeacher(id: string, actor: AuditActor) {
  await prisma.$transaction(async (tx) => {
    const assignment = await tx.subjectTeacher.findUnique({ where: { id } });
    if (!assignment) throw notFound('subject_teacher');
    if (assignment.archivedAt) return;
    await tx.subjectTeacher.update({ where: { id }, data: { archivedAt: new Date() } });
    await writeAudit(tx, actor, {
      action: AuditAction.UNASSIGN_TEACHER,
      entityType: 'subject_teacher',
      entityId: id,
      metadata: { subjectId: assignment.subjectId, teacherId: assignment.teacherId },
    });
  });
}

export async function restoreAssignment(id: string, actor: AuditActor) {
  await prisma.$transaction(async (tx) => {
    const assignment = await tx.subjectTeacher.findUnique({
      where: { id },
      include: { subject: true, teacher: true },
    });
    if (!assignment) throw notFound('subject_teacher');
    if (!assignment.archivedAt) return;
    if (assignment.subject.archivedAt || assignment.teacher.archivedAt) throw new AppError('PARENT_ARCHIVED');
    await tx.subjectTeacher.update({ where: { id }, data: { archivedAt: null } });
    await writeAudit(tx, actor, {
      action: AuditAction.ASSIGN_TEACHER,
      entityType: 'subject_teacher',
      entityId: id,
      metadata: { subjectId: assignment.subjectId, teacherId: assignment.teacherId, restored: true },
    });
  });
}
