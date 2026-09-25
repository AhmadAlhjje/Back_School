import type { Prisma } from '../../generated/prisma/client.js';
import type { NotificationType } from '../../generated/prisma/enums.js';
import { prisma } from '../../core/database/prisma.js';
import { logger } from '../../core/logger/logger.js';
import { enqueueNotificationFanout, type NotificationAudience } from '../../core/queue/queues.js';

export interface NotificationDraft {
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
  audience: NotificationAudience;
  createdById?: string | null;
}

/**
 * Creates a notification and queues its fan-out to recipients (done by the worker, so large
 * audiences never slow down the request). Automatic notifications are best-effort: a failure
 * is logged and never fails the operation that triggered it.
 */
export async function publishNotification(draft: NotificationDraft): Promise<string> {
  const notification = await prisma.notification.create({
    data: {
      type: draft.type,
      title: draft.title,
      body: draft.body,
      data: draft.data ?? undefined,
      createdById: draft.createdById ?? null,
    },
  });
  await enqueueNotificationFanout({ notificationId: notification.id, audience: draft.audience });
  return notification.id;
}

export async function publishNotificationSafely(draft: NotificationDraft): Promise<void> {
  try {
    await publishNotification(draft);
  } catch (error) {
    logger.warn({ err: error, type: draft.type }, 'Automatic notification could not be published');
  }
}
