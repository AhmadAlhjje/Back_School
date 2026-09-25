import type { UserRole } from '../../generated/prisma/enums.js';

/** Roles that manage the institute (content, students, access). */
export const STAFF_ROLES = ['SUPER_ADMIN', 'OWNER'] as const satisfies readonly UserRole[];

/** System administration only. */
export const ADMIN_ONLY = ['SUPER_ADMIN'] as const satisfies readonly UserRole[];

export const STUDENT_ONLY = ['STUDENT'] as const satisfies readonly UserRole[];
