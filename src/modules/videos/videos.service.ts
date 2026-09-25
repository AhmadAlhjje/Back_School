import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { notFound } from '../../core/errors/app-error.js';
import { archivedWhere, type LifecycleFilter } from '../../core/http/schemas.js';
import { archiveEntity, changedFields, reorderEntities, restoreEntity } from '../catalog/lifecycle.js';
import { toStaffVideoDto } from './videos.dto.js';

const withLatestJob = { uploadJobs: { orderBy: { createdAt: 'desc' as const }, take: 1 } };

export async function listVideos(sessionId: string, status: LifecycleFilter) {
  const videos = await prisma.video.findMany({
    where: { sessionId, ...archivedWhere(status) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: withLatestJob,
  });
  return videos.map(toStaffVideoDto);
}

export async function getVideo(id: string) {
  const video = await prisma.video.findUnique({ where: { id }, include: withLatestJob });
  if (!video) throw notFound('video');
  return toStaffVideoDto(video);
}

export async function updateVideo(
  id: string,
  patch: { title?: string; description?: string | null },
  actor: AuditActor,
) {
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) throw notFound('video');
  await prisma.$transaction(async (tx) => {
    await tx.video.update({ where: { id }, data: patch });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_VIDEO,
      entityType: 'video',
      entityId: id,
      metadata: changedFields(video, patch) as never,
    });
  });
  return getVideo(id);
}

export function archiveVideo(id: string, actor: AuditActor) {
  return archiveEntity({
    entityType: 'video',
    id,
    actor,
    load: (tx) => tx.video.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.video.update({ where: { id }, data: { archivedAt } }),
  });
}

export function restoreVideo(id: string, actor: AuditActor) {
  return restoreEntity({
    entityType: 'video',
    id,
    actor,
    load: (tx) => tx.video.findUnique({ where: { id } }),
    save: (tx, archivedAt) => tx.video.update({ where: { id }, data: { archivedAt } }),
    parentIsActive: async (tx) => {
      const video = await tx.video.findUniqueOrThrow({ where: { id }, include: { session: true } });
      return video.session.archivedAt === null;
    },
  });
}

export function reorderVideos(sessionId: string, ids: string[], actor: AuditActor) {
  return reorderEntities({
    entityType: 'video',
    ids,
    actor,
    parentId: sessionId,
    siblingIds: async (tx) =>
      (await tx.video.findMany({ where: { sessionId, archivedAt: null }, select: { id: true } })).map(
        (v) => v.id,
      ),
    setOrder: (tx, id, sortOrder) => tx.video.update({ where: { id }, data: { sortOrder } }),
  });
}
