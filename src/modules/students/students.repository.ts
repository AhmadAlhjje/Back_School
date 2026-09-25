import { prisma } from '../../core/database/prisma.js';
import { skipTake, type PaginationQuery } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { activeGrantWhere } from '../access/access-policy.js';

export interface StudentListFilter extends PaginationQuery {
  search?: string;
  accountStatus: 'ACTIVE' | 'DISABLED' | 'all';
  lifecycle: 'active' | 'archived' | 'all';
  gradeId?: string;
  sort: 'createdAt' | 'name' | 'lastLoginAt';
  order: 'asc' | 'desc';
}

function listWhere(filter: StudentListFilter): Prisma.UserWhereInput {
  return {
    role: 'STUDENT',
    ...(filter.lifecycle === 'active' ? { archivedAt: null } : {}),
    ...(filter.lifecycle === 'archived' ? { archivedAt: { not: null } } : {}),
    ...(filter.accountStatus !== 'all' ? { status: filter.accountStatus } : {}),
    ...(filter.gradeId ? { studentProfile: { gradeId: filter.gradeId } } : {}),
    ...(filter.search
      ? { OR: [{ name: { contains: filter.search } }, { phone: { contains: filter.search } }] }
      : {}),
  };
}

/** One page of students with grade, bound device and grant counts — no N+1 queries. */
export async function findStudentsPage(filter: StudentListFilter) {
  const where = listWhere(filter);
  const now = new Date();
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ [filter.sort]: filter.order }, { id: 'asc' }],
      include: {
        studentProfile: { include: { grade: { select: { id: true, name: true } } } },
        devices: {
          where: { status: 'ACTIVE' },
          select: { id: true, platform: true, model: true, lastSeenAt: true },
        },
        _count: {
          select: {
            subjectAccess: { where: activeGrantWhere(now) },
            teacherAccess: { where: activeGrantWhere(now) },
          },
        },
      },
      ...skipTake(filter),
    }),
    prisma.user.count({ where }),
  ]);
  return { rows, total };
}

export async function findStudentDetails(id: string) {
  const now = new Date();
  return prisma.user.findFirst({
    where: { id, role: 'STUDENT' },
    include: {
      studentProfile: { include: { grade: { select: { id: true, name: true } } } },
      devices: { orderBy: { firstSeenAt: 'desc' }, take: 10 },
      subjectAccess: {
        where: activeGrantWhere(now),
        include: { subject: { select: { id: true, name: true, grade: { select: { name: true } } } } },
      },
      teacherAccess: {
        where: activeGrantWhere(now),
        include: {
          subjectTeacher: {
            select: {
              id: true,
              subject: { select: { id: true, name: true } },
              teacher: { select: { id: true, name: true } },
            },
          },
        },
      },
      _count: { select: { authSessions: { where: { revokedAt: null, expiresAt: { gt: now } } } } },
    },
  });
}
