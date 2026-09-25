import { AuditAction, writeAudit, type AuditActor } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { notFound } from '../../core/errors/app-error.js';
import { paginated, skipTake, type PaginationQuery } from '../../core/http/pagination.js';
import type { NotificationAudience } from '../../core/queue/queues.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { activeGrantWhere } from '../access/access-policy.js';
import { publishNotification } from './notify.js';

/** Resolves an audience to active, non-archived student ids (used by the fan-out worker). */
export async function resolveAudience(audience: NotificationAudience): Promise<string[]> {
  const now = new Date();
  const base: Prisma.UserWhereInput = { role: 'STUDENT', archivedAt: null, status: 'ACTIVE' };
  let where: Prisma.UserWhereInput;
  switch (audience.kind) {
    case 'ALL_STUDENTS':
      where = base;
      break;
    case 'GRADE':
      where = { ...base, studentProfile: { gradeId: audience.gradeId } };
      break;
    case 'SUBJECT':
      where = {
        ...base,
        subjectAccess: { some: { subjectId: audience.subjectId, ...activeGrantWhere(now) } },
      };
      break;
    case 'SUBJECT_TEACHER': {
      const assignment = await prisma.subjectTeacher.findUnique({ where: { id: audience.subjectTeacherId } });
      if (!assignment) return [];
      where = {
        ...base,
        teacherAccess: { some: { subjectTeacherId: assignment.id, ...activeGrantWhere(now) } },
        subjectAccess: { some: { subjectId: assignment.subjectId, ...activeGrantWhere(now) } },
      };
      break;
    }
    case 'STUDENTS':
      where = { ...base, id: { in: audience.studentIds } };
      break;
  }
  const rows = await prisma.user.findMany({ where, select: { id: true } });
  return rows.map((row) => row.id);
}

/** Inserts recipient rows in batches; idempotent thanks to the unique (notification, user) key. */
export async function deliverNotification(
  notificationId: string,
  audience: NotificationAudience,
): Promise<number> {
  const studentIds = await resolveAudience(audience);
  const BATCH = 1000;
  let delivered = 0;
  for (let i = 0; i < studentIds.length; i += BATCH) {
    const result = await prisma.notificationRecipient.createMany({
      data: studentIds.slice(i, i + BATCH).map((userId) => ({ notificationId, userId })),
      skipDuplicates: true,
    });
    delivered += result.count;
  }
  return delivered;
}

/** Staff announcement. */
export async function sendAnnouncement(
  input: { title: string; body: string; audience: NotificationAudience },
  actor: AuditActor,
) {
  const id = await publishNotification({
    type: 'SYSTEM',
    title: input.title,
    body: input.body,
    audience: input.audience,
    createdById: actor.userId,
  });
  await writeAudit(prisma, actor, {
    action: AuditAction.SEND_NOTIFICATION,
    entityType: 'notification',
    entityId: id,
    metadata: { audience: input.audience as unknown as Prisma.InputJsonValue, title: input.title },
  });
  return { id };
}

export async function listSentNotifications(query: PaginationQuery) {
  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        _count: { select: { recipients: true } },
      },
      ...skipTake(query),
    }),
    prisma.notification.count(),
  ]);
  const readCounts = await prisma.notificationRecipient.groupBy({
    by: ['notificationId'],
    where: { notificationId: { in: items.map((item) => item.id) }, readAt: { not: null } },
    _count: { _all: true },
  });
  const readMap = new Map(readCounts.map((row) => [row.notificationId, row._count._all]));
  return paginated(
    items.map(({ _count, ...item }) => ({
      ...item,
      recipients: _count.recipients,
      reads: readMap.get(item.id) ?? 0,
    })),
    total,
    query,
  );
}

// ─── Student inbox ───

export async function listInbox(userId: string, query: PaginationQuery) {
  const where = { userId };
  const [rows, total] = await Promise.all([
    prisma.notificationRecipient.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { notification: true },
      ...skipTake(query),
    }),
    prisma.notificationRecipient.count({ where }),
  ]);
  return paginated(
    rows.map((row) => ({
      id: row.id,
      type: row.notification.type,
      title: row.notification.title,
      body: row.notification.body,
      data: row.notification.data,
      createdAt: row.notification.createdAt,
      readAt: row.readAt,
    })),
    total,
    query,
  );
}

export function unreadCount(userId: string) {
  return prisma.notificationRecipient.count({ where: { userId, readAt: null } });
}

export async function markRead(userId: string, recipientId: string) {
  const result = await prisma.notificationRecipient.updateMany({
    where: { id: recipientId, userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (result.count === 0) {
    const exists = await prisma.notificationRecipient.findFirst({ where: { id: recipientId, userId } });
    if (!exists) throw notFound('notification');
  }
  return { unread: await unreadCount(userId) };
}

export async function markAllRead(userId: string) {
  await prisma.notificationRecipient.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { unread: 0 };
}
