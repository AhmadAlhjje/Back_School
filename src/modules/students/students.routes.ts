import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { AppError } from '../../core/errors/app-error.js';
import { paginationQuery } from '../../core/http/pagination.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { idParams, name, optionalText, searchTerm, uuid } from '../../core/http/schemas.js';
import { PASSWORD_MAX_LENGTH } from '../../core/security/password.js';
import { phoneSchema } from '../../core/security/phone.js';
import { prisma } from '../../core/database/prisma.js';
import { resetDevice } from '../devices/devices.service.js';
import {
  resetAccountPassword,
  setAccountArchived,
  setAccountStatus,
} from '../users/account-admin.service.js';
import { ADMIN_ONLY, STAFF_ROLES } from '../users/roles.js';
import {
  createStudent,
  getStudent,
  getStudentActivity,
  listStudents,
  updateStudent,
} from './students.service.js';

const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const studentBody = z.object({
  name: name(120),
  phone: phoneSchema,
  gradeId: uuid.nullish().transform((value) => value ?? null),
  notes: optionalText(500),
});

export const studentsModule: ApiModule = {
  prefix: '/students',
  tag: 'Students',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List students (search by name/phone, filter by status/grade, sort, paginate)',
      roles: STAFF_ROLES,
      query: paginationQuery.extend({
        search: searchTerm,
        accountStatus: z.enum(['ACTIVE', 'DISABLED', 'all']).default('all'),
        lifecycle: z.enum(['active', 'archived', 'all']).default('active'),
        gradeId: uuid.optional(),
        sort: z.enum(['createdAt', 'name', 'lastLoginAt']).default('createdAt'),
        order: z.enum(['asc', 'desc']).default('desc'),
      }),
      handler: ({ query }) => listStudents(query),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a student account',
      roles: STAFF_ROLES,
      body: studentBody.extend({ password }),
      successStatus: 201,
      handler: ({ req, body }) => createStudent(body, actorFromRequest(req)),
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Student profile: account, device, opened subjects and teachers',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ params }) => getStudent(params.id),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: 'Update a student',
      roles: STAFF_ROLES,
      params: idParams,
      body: studentBody.partial(),
      handler: ({ req, params, body }) => updateStudent(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/disable',
      summary: 'Disable a student (ends all sessions)',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await setAccountStatus(params.id, 'STUDENT', 'DISABLED', actorFromRequest(req));
        return getStudent(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/enable',
      summary: 'Activate a disabled student',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await setAccountStatus(params.id, 'STUDENT', 'ACTIVE', actorFromRequest(req));
        return getStudent(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Archive a student (soft delete, ends all sessions)',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await setAccountArchived(params.id, 'STUDENT', true, actorFromRequest(req));
        return getStudent(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore an archived student',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await setAccountArchived(params.id, 'STUDENT', false, actorFromRequest(req));
        return getStudent(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/reset-password',
      summary: 'Set a new password for a student (ends all sessions)',
      roles: STAFF_ROLES,
      params: idParams,
      body: z.object({ newPassword: password }),
      handler: async ({ req, params, body }) => {
        await resetAccountPassword(params.id, 'STUDENT', body.newPassword, actorFromRequest(req));
        return { reset: true };
      },
    }),
    route({
      method: 'post',
      path: '/:id/device/reset',
      summary: "Reset the student's bound device (super admin only)",
      description:
        'Revokes the device sessions and offline licenses; the student can then log in from a new device.',
      roles: ADMIN_ONLY,
      params: idParams,
      handler: async ({ req, params }) => {
        const device = await prisma.device.findUnique({ where: { activeStudentId: params.id } });
        if (!device) throw new AppError('NOT_FOUND', { details: { entity: 'device' } });
        await resetDevice(device.id, actorFromRequest(req));
        return getStudent(params.id);
      },
    }),
    route({
      method: 'get',
      path: '/:id/activity',
      summary: 'Login history and audit events of a student (super admin only)',
      roles: ADMIN_ONLY,
      params: idParams,
      handler: ({ params }) => getStudentActivity(params.id),
    }),
  ],
};
