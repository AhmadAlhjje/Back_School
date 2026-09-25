import { z } from 'zod';
import { AuditAction } from '../../core/audit/audit.js';
import { prisma } from '../../core/database/prisma.js';
import { paginated, paginationQuery, skipTake } from '../../core/http/pagination.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { uuid } from '../../core/http/schemas.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ADMIN_ONLY } from '../users/roles.js';

/**
 * Audit log viewer (spec §55, §93). Read-only by construction: this module exposes no write
 * route, and no code path anywhere updates or deletes audit rows.
 */
const auditQuery = paginationQuery.extend({
  action: z.enum(Object.values(AuditAction) as [string, ...string[]]).optional(),
  actorId: uuid.optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const auditModule: ApiModule = {
  prefix: '/audit-logs',
  tag: 'Audit logs',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'Search audit logs',
      roles: ADMIN_ONLY,
      query: auditQuery,
      handler: async ({ query }) => {
        const where: Prisma.AuditLogWhereInput = {
          ...(query.action ? { action: query.action } : {}),
          ...(query.actorId ? { actorId: query.actorId } : {}),
          ...(query.entityType ? { entityType: query.entityType } : {}),
          ...(query.entityId ? { entityId: query.entityId } : {}),
          ...(query.from || query.to
            ? {
                createdAt: {
                  ...(query.from ? { gte: query.from } : {}),
                  ...(query.to ? { lte: query.to } : {}),
                },
              }
            : {}),
        };
        const [items, total] = await Promise.all([
          prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: { actor: { select: { id: true, name: true, phone: true, role: true } } },
            ...skipTake(query),
          }),
          prisma.auditLog.count({ where }),
        ]);
        return paginated(items, total, query);
      },
    }),
    route({
      method: 'get',
      path: '/actions',
      summary: 'All audit action names (for filters)',
      roles: ADMIN_ONLY,
      handler: () => Promise.resolve(Object.values(AuditAction)),
    }),
  ],
};
