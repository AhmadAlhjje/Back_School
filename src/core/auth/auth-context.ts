import type { ClientPortal, UserRole } from '../../generated/prisma/enums.js';

/** Identity attached to an authenticated request after token + session verification. */
export interface AuthContext {
  userId: string;
  role: UserRole;
  sessionId: string;
  portal: ClientPortal;
  /** Bound device row id (students only). */
  deviceId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export const PORTAL_FOR_ROLE: Record<UserRole, ClientPortal> = {
  SUPER_ADMIN: 'ADMIN_WEB',
  OWNER: 'OWNER_WEB',
  STUDENT: 'STUDENT_APP',
};
