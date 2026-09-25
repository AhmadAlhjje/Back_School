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
import { toStaffFileDto } from '../files/files.dto.js';
import { toStaffVideoDto } from '../videos/videos.dto.js';

export interface SessionInput {
  title: string;
  description: string | null;
}

export async function listSessions(topicId: string, status: LifecycleFilter) {
  return prisma.session.findMany({
    where: { topicId, ...archivedWhere(status) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Session with its videos and files (all lifecycle states unless filtered). */
export async function getSession(id: string, contentStatus: LifecycleFilter = 'all') {
  const session = await prisma.session.findUnique({
    where: { id },
    include: {
      topic: {
        include: {
          subjectTeacher: {
            include: {
              subject: { select: { id: true, name: true, gradeId: true } },
              teacher: { select: { id: true, name: true } },
            },
          },
        },
      },
      videos: {
        where: archivedWhere(contentStatus),
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { uploadJobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
      files: { where: archivedWhere(contentStatus), orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
    },
  });
  if (!session) throw notFound('session');
  return {
    ...session,
    videos: session.videos.map(toStaffVideoDto),
    files: session.files.map(toStaffFileDto),
  };
}

export async function createSession(input: SessionInput & { topicId: string }, actor: AuditActor) {
  const topic = await prisma.topic.findUnique({ where: { id: input.topicId } });
  if (!topic) throw notFound('topic');
  if (topic.archivedAt) throw new AppError('PARENT_ARCHIVED');
  return prisma.$transaction(async (tx) => {
    const order = await tx.session.aggregate({
      where: { topicId: input.topicId },
      _max: { sortOrder: true },
    });
    const session = await tx.session.create({ data: { ...input, sortOrder: nextSortOrder(order) } });
    await writeAudit(tx, actor, {
      action: AuditAction.CREATE_SESSION,
      entityType: 'session',
      entityId: session.id,
      metadata: { title: session.title, topicId: session.topicId },
    });
    return session;
  });
}

export async function updateSession(id: string, patch: Partial<SessionInput>, actor: AuditActor) {
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) throw notFound('session');
  return prisma.$transaction(async (tx) => {
    const updated = await tx.session.update({ where: { id }, data: patch });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_SESSION,
      entityType: 'session',
      entityId: id,
      metadata: changedFields(session, patch) as never,
    });
    return updated;
  });
}

export function archiveSession(id: string, actor: AuditActor) {
  return archiveEntity({
    entityType: 'session',
    id,
    actor,
    load: (tx) => tx.session.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.session.update({ where: { id }, data: { archivedAt } }),
  });
}

export function restoreSession(id: string, actor: AuditActor) {
  return restoreEntity({
    entityType: 'session',
    id,
    actor,
    load: (tx) => tx.session.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.session.update({ where: { id }, data: { archivedAt } }),
    parentIsActive: async (tx) => {
      const session = await tx.session.findUniqueOrThrow({ where: { id }, include: { topic: true } });
      return session.topic.archivedAt === null;
    },
  });
}

export function reorderSessions(topicId: string, ids: string[], actor: AuditActor) {
  return reorderEntities({
    entityType: 'session',
    ids,
    actor,
    parentId: topicId,
    siblingIds: async (tx) =>
      (await tx.session.findMany({ where: { topicId, archivedAt: null }, select: { id: true } })).map(
        (s) => s.id,
      ),
    setOrder: (tx, id, sortOrder) => tx.session.update({ where: { id }, data: { sortOrder } }),
  });
}
