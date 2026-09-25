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

export interface TopicInput {
  title: string;
  description: string | null;
}

export async function listTopics(subjectTeacherId: string, status: LifecycleFilter) {
  const topics = await prisma.topic.findMany({
    where: { subjectTeacherId, ...archivedWhere(status) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { sessions: { where: { archivedAt: null } } } } },
  });
  return topics.map(({ _count, ...topic }) => ({ ...topic, sessionsCount: _count.sessions }));
}

export async function getTopic(id: string, sessionStatus: LifecycleFilter = 'all') {
  const topic = await prisma.topic.findUnique({
    where: { id },
    include: {
      subjectTeacher: {
        include: {
          subject: { select: { id: true, name: true, gradeId: true } },
          teacher: { select: { id: true, name: true } },
        },
      },
      sessions: {
        where: archivedWhere(sessionStatus),
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: {
          _count: {
            select: {
              videos: { where: { archivedAt: null } },
              files: { where: { archivedAt: null } },
            },
          },
        },
      },
    },
  });
  if (!topic) throw notFound('topic');
  return {
    ...topic,
    sessions: topic.sessions.map(({ _count, ...session }) => ({
      ...session,
      videosCount: _count.videos,
      filesCount: _count.files,
    })),
  };
}

export async function createTopic(input: TopicInput & { subjectTeacherId: string }, actor: AuditActor) {
  const parent = await prisma.subjectTeacher.findUnique({ where: { id: input.subjectTeacherId } });
  if (!parent) throw notFound('subject_teacher');
  if (parent.archivedAt) throw new AppError('PARENT_ARCHIVED');
  return prisma.$transaction(async (tx) => {
    const order = await tx.topic.aggregate({
      where: { subjectTeacherId: input.subjectTeacherId },
      _max: { sortOrder: true },
    });
    const topic = await tx.topic.create({ data: { ...input, sortOrder: nextSortOrder(order) } });
    await writeAudit(tx, actor, {
      action: AuditAction.CREATE_TOPIC,
      entityType: 'topic',
      entityId: topic.id,
      metadata: { title: topic.title, subjectTeacherId: topic.subjectTeacherId },
    });
    return topic;
  });
}

export async function updateTopic(id: string, patch: Partial<TopicInput>, actor: AuditActor) {
  const topic = await prisma.topic.findUnique({ where: { id } });
  if (!topic) throw notFound('topic');
  return prisma.$transaction(async (tx) => {
    const updated = await tx.topic.update({ where: { id }, data: patch });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_TOPIC,
      entityType: 'topic',
      entityId: id,
      metadata: changedFields(topic, patch) as never,
    });
    return updated;
  });
}

export function archiveTopic(id: string, actor: AuditActor) {
  return archiveEntity({
    entityType: 'topic',
    id,
    actor,
    load: (tx) => tx.topic.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.topic.update({ where: { id }, data: { archivedAt } }),
  });
}

export function restoreTopic(id: string, actor: AuditActor) {
  return restoreEntity({
    entityType: 'topic',
    id,
    actor,
    load: (tx) => tx.topic.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.topic.update({ where: { id }, data: { archivedAt } }),
    parentIsActive: async (tx) => {
      const topic = await tx.topic.findUniqueOrThrow({ where: { id }, include: { subjectTeacher: true } });
      return topic.subjectTeacher.archivedAt === null;
    },
  });
}

export function reorderTopics(subjectTeacherId: string, ids: string[], actor: AuditActor) {
  return reorderEntities({
    entityType: 'topic',
    ids,
    actor,
    parentId: subjectTeacherId,
    siblingIds: async (tx) =>
      (await tx.topic.findMany({ where: { subjectTeacherId, archivedAt: null }, select: { id: true } })).map(
        (t) => t.id,
      ),
    setOrder: (tx, id, sortOrder) => tx.topic.update({ where: { id }, data: { sortOrder } }),
  });
}
