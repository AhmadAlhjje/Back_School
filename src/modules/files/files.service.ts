import { randomUUID } from 'node:crypto';
import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError, notFound } from '../../core/errors/app-error.js';
import { archivedWhere, type LifecycleFilter } from '../../core/http/schemas.js';
import { discardReceivedFile, commitReceivedFile, type ReceivedFile } from '../../core/storage/multipart.js';
import { removeStoragePath, StorageArea, storageKey } from '../../core/storage/storage.js';
import type { FileKind, FileScope } from '../../generated/prisma/enums.js';
import { changedFields, nextSortOrder, reorderEntities } from '../catalog/lifecycle.js';
import { publishNotificationSafely } from '../notifications/notify.js';
import type { NotificationAudience } from '../../core/queue/queues.js';
import { toStaffFileDto } from './files.dto.js';

/** Maps a scope to the column holding its parent id. */
const PARENT_COLUMN = {
  SUBJECT: 'subjectId',
  TEACHER: 'subjectTeacherId',
  TOPIC: 'topicId',
  SESSION: 'sessionId',
} as const satisfies Record<FileScope, string>;

export function parentWhere(scope: FileScope, parentId: string) {
  return { scope, [PARENT_COLUMN[scope]]: parentId };
}

interface ParentInfo {
  subjectTeacherId: string | null;
  subjectId: string;
  label: string;
}

/** Validates the parent exists and is active; returns who should be notified. */
async function resolveParent(scope: FileScope, parentId: string): Promise<ParentInfo> {
  switch (scope) {
    case 'SUBJECT': {
      const subject = await prisma.subject.findUnique({ where: { id: parentId } });
      if (!subject) throw notFound('subject');
      if (subject.archivedAt) throw new AppError('PARENT_ARCHIVED');
      return { subjectTeacherId: null, subjectId: subject.id, label: subject.name };
    }
    case 'TEACHER': {
      const assignment = await prisma.subjectTeacher.findUnique({
        where: { id: parentId },
        include: { subject: true, teacher: true },
      });
      if (!assignment) throw notFound('subject_teacher');
      if (assignment.archivedAt) throw new AppError('PARENT_ARCHIVED');
      return {
        subjectTeacherId: assignment.id,
        subjectId: assignment.subjectId,
        label: `${assignment.subject.name} — ${assignment.teacher.name}`,
      };
    }
    case 'TOPIC': {
      const topic = await prisma.topic.findUnique({
        where: { id: parentId },
        include: { subjectTeacher: true },
      });
      if (!topic) throw notFound('topic');
      if (topic.archivedAt) throw new AppError('PARENT_ARCHIVED');
      return {
        subjectTeacherId: topic.subjectTeacherId,
        subjectId: topic.subjectTeacher.subjectId,
        label: topic.title,
      };
    }
    case 'SESSION': {
      const session = await prisma.session.findUnique({
        where: { id: parentId },
        include: { topic: { include: { subjectTeacher: true } } },
      });
      if (!session) throw notFound('session');
      if (session.archivedAt) throw new AppError('PARENT_ARCHIVED');
      return {
        subjectTeacherId: session.topic.subjectTeacherId,
        subjectId: session.topic.subjectTeacher.subjectId,
        label: session.title,
      };
    }
  }
}

export async function listFiles(scope: FileScope, parentId: string, status: LifecycleFilter) {
  const files = await prisma.contentFile.findMany({
    where: { ...parentWhere(scope, parentId), ...archivedWhere(status) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return files.map(toStaffFileDto);
}

export async function getFile(id: string) {
  const file = await prisma.contentFile.findUnique({ where: { id } });
  if (!file) throw notFound('file');
  return file;
}

export async function uploadFile(
  input: { scope: FileScope; parentId: string; title: string | null; file: ReceivedFile },
  actor: AuditActor,
) {
  let parent: ParentInfo;
  try {
    parent = await resolveParent(input.scope, input.parentId);
  } catch (error) {
    await discardReceivedFile(input.file);
    throw error;
  }
  const now = new Date();
  const title = (input.title ?? input.file.originalFileName.replace(/\.[^.]+$/, '')).slice(0, 200) || 'ملف';

  // Random storage name (not the row id) so the bytes can be placed before the row exists;
  // if the transaction fails the file is removed again.
  const key = storageKey(
    StorageArea.files,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    `${randomUUID()}.${input.file.extension}`,
  );
  await commitReceivedFile(input.file, key);

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const order = await tx.contentFile.aggregate({
        where: parentWhere(input.scope, input.parentId),
        _max: { sortOrder: true },
      });
      const record = await tx.contentFile.create({
        data: {
          scope: input.scope,
          [PARENT_COLUMN[input.scope]]: input.parentId,
          title,
          kind: input.file.kind as FileKind,
          originalFileName: input.file.originalFileName,
          mimeType: input.file.mimeType,
          extension: input.file.extension,
          sizeBytes: BigInt(input.file.sizeBytes),
          sha256: input.file.sha256,
          sortOrder: nextSortOrder(order),
          storageKey: key,
        },
      });
      await writeAudit(tx, actor, {
        action: AuditAction.UPLOAD_FILE,
        entityType: 'file',
        entityId: record.id,
        metadata: { title, scope: input.scope, parentId: input.parentId, sizeBytes: input.file.sizeBytes },
      });
      return record;
    });
  } catch (error) {
    await removeStoragePath(key);
    throw error;
  }

  const audience: NotificationAudience = parent.subjectTeacherId
    ? { kind: 'SUBJECT_TEACHER', subjectTeacherId: parent.subjectTeacherId }
    : { kind: 'SUBJECT', subjectId: parent.subjectId };
  await publishNotificationSafely({
    type: 'NEW_FILE',
    title: 'ملف جديد',
    body: `${created.title} — ${parent.label}`,
    data: { fileId: created.id, scope: created.scope, parentId: input.parentId },
    audience,
    createdById: actor.userId,
  });
  return toStaffFileDto(created);
}

export async function updateFile(id: string, patch: { title?: string }, actor: AuditActor) {
  const file = await getFile(id);
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.contentFile.update({ where: { id }, data: patch });
    await writeAudit(tx, actor, {
      action: AuditAction.UPDATE_FILE,
      entityType: 'file',
      entityId: id,
      metadata: changedFields(file, patch) as never,
    });
    return saved;
  });
  return toStaffFileDto(updated);
}

/** "Delete" for files is an archive: bytes and metadata are kept and restorable. */
export async function archiveFile(id: string, actor: AuditActor) {
  const file = await getFile(id);
  if (file.archivedAt) return toStaffFileDto(file);
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.contentFile.update({ where: { id }, data: { archivedAt: new Date() } });
    await writeAudit(tx, actor, {
      action: AuditAction.DELETE_FILE,
      entityType: 'file',
      entityId: id,
      metadata: { archived: true },
    });
    return saved;
  });
  return toStaffFileDto(updated);
}

export async function restoreFile(id: string, actor: AuditActor) {
  const file = await getFile(id);
  if (!file.archivedAt) return toStaffFileDto(file);
  const parentId = file.subjectId ?? file.subjectTeacherId ?? file.topicId ?? file.sessionId;
  await resolveParent(file.scope, parentId!);
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.contentFile.update({ where: { id }, data: { archivedAt: null } });
    await writeAudit(tx, actor, { action: AuditAction.RESTORE, entityType: 'file', entityId: id });
    return saved;
  });
  return toStaffFileDto(updated);
}

export function reorderFiles(scope: FileScope, parentId: string, ids: string[], actor: AuditActor) {
  return reorderEntities({
    entityType: 'file',
    ids,
    actor,
    parentId,
    siblingIds: async (tx) =>
      (
        await tx.contentFile.findMany({
          where: { ...parentWhere(scope, parentId), archivedAt: null },
          select: { id: true },
        })
      ).map((f) => f.id),
    setOrder: (tx, id, sortOrder) => tx.contentFile.update({ where: { id }, data: { sortOrder } }),
  });
}
