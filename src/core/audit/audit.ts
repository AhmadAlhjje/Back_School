import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma/client.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import type { DbClient } from '../database/prisma.js';

/**
 * Append-only audit trail for sensitive operations. There is intentionally no update or
 * delete function anywhere in the codebase for audit rows.
 */
export const AuditAction = {
  LOGIN: 'LOGIN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGIN_DEVICE_REJECTED: 'LOGIN_DEVICE_REJECTED',
  LOGOUT: 'LOGOUT',
  REGISTER_STUDENT: 'REGISTER_STUDENT',
  REFRESH_TOKEN_REUSE: 'REFRESH_TOKEN_REUSE',
  CHANGE_PASSWORD: 'CHANGE_PASSWORD',
  RESET_PASSWORD: 'RESET_PASSWORD',
  DEVICE_BOUND: 'DEVICE_BOUND',
  RESET_DEVICE: 'RESET_DEVICE',
  CREATE_OWNER: 'CREATE_OWNER',
  UPDATE_OWNER: 'UPDATE_OWNER',
  CREATE_STUDENT: 'CREATE_STUDENT',
  UPDATE_STUDENT: 'UPDATE_STUDENT',
  DISABLE_USER: 'DISABLE_USER',
  ENABLE_USER: 'ENABLE_USER',
  ARCHIVE_USER: 'ARCHIVE_USER',
  RESTORE_USER: 'RESTORE_USER',
  CREATE_GRADE: 'CREATE_GRADE',
  UPDATE_GRADE: 'UPDATE_GRADE',
  CREATE_SUBJECT: 'CREATE_SUBJECT',
  UPDATE_SUBJECT: 'UPDATE_SUBJECT',
  CREATE_TEACHER: 'CREATE_TEACHER',
  UPDATE_TEACHER: 'UPDATE_TEACHER',
  ASSIGN_TEACHER: 'ASSIGN_TEACHER',
  UNASSIGN_TEACHER: 'UNASSIGN_TEACHER',
  CREATE_TOPIC: 'CREATE_TOPIC',
  UPDATE_TOPIC: 'UPDATE_TOPIC',
  CREATE_SESSION: 'CREATE_SESSION',
  UPDATE_SESSION: 'UPDATE_SESSION',
  UPLOAD_VIDEO: 'UPLOAD_VIDEO',
  UPDATE_VIDEO: 'UPDATE_VIDEO',
  UPLOAD_FILE: 'UPLOAD_FILE',
  UPDATE_FILE: 'UPDATE_FILE',
  DELETE_FILE: 'DELETE_FILE',
  ARCHIVE: 'ARCHIVE',
  RESTORE: 'RESTORE',
  REORDER: 'REORDER',
  OPEN_ACCESS: 'OPEN_ACCESS',
  REVOKE_ACCESS: 'REVOKE_ACCESS',
  SEND_NOTIFICATION: 'SEND_NOTIFICATION',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  ISSUE_OFFLINE_LICENSE: 'ISSUE_OFFLINE_LICENSE',
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditActor {
  userId: string | null;
  role: UserRole | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditEntry {
  action: AuditActionName;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
}

export function requestMeta(req: Request): Pick<AuditActor, 'ip' | 'userAgent'> {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
  };
}

export function actorFromRequest(req: Request): AuditActor {
  return {
    userId: req.auth?.userId ?? null,
    role: req.auth?.role ?? null,
    ...requestMeta(req),
  };
}

export async function writeAudit(db: DbClient, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.role,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
      metadata: entry.metadata ?? undefined,
    },
  });
}
