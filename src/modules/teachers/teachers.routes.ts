import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { paginationQuery } from '../../core/http/pagination.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { idParams, lifecycleFilter, name, optionalText, searchTerm, uuid } from '../../core/http/schemas.js';
import { phoneSchema } from '../../core/security/phone.js';
import { TEACHER_IMAGE_TYPES } from '../../core/storage/file-types.js';
import { receiveSingleFile } from '../../core/storage/multipart.js';
import { STAFF_ROLES } from '../users/roles.js';
import {
  archiveTeacher,
  createTeacher,
  getTeacher,
  listTeachers,
  removeTeacherImage,
  restoreTeacher,
  setTeacherImage,
  updateTeacher,
} from './teachers.service.js';

const MAX_TEACHER_IMAGE_BYTES = 5 * 1024 * 1024;

const teacherBody = z.object({
  name: name(120),
  phone: z
    .union([phoneSchema, z.literal('')])
    .nullish()
    .transform((value) => value || null),
  description: optionalText(5000),
});

export const teachersModule: ApiModule = {
  prefix: '/teachers',
  tag: 'Teachers',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List teachers (search by name or phone)',
      roles: STAFF_ROLES,
      query: paginationQuery.extend({ status: lifecycleFilter, search: searchTerm }),
      handler: ({ query }) => listTeachers(query),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a teacher and optionally assign subjects (single transaction)',
      roles: STAFF_ROLES,
      body: teacherBody.extend({ subjectIds: z.array(uuid).max(50).default([]) }),
      successStatus: 201,
      handler: ({ req, body }) => createTeacher(body, actorFromRequest(req)),
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Get a teacher with subject assignments',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ params }) => getTeacher(params.id),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: 'Update a teacher',
      roles: STAFF_ROLES,
      params: idParams,
      body: teacherBody.partial(),
      handler: ({ req, params, body }) => updateTeacher(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Archive a teacher',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await archiveTeacher(params.id, actorFromRequest(req));
        return getTeacher(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore a teacher',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await restoreTeacher(params.id, actorFromRequest(req));
        return getTeacher(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/image',
      summary: 'Upload or replace the teacher photo (PNG/JPEG/WebP, max 5 MB)',
      roles: STAFF_ROLES,
      params: idParams,
      bodyKind: 'multipart',
      handler: async ({ req, params }) => {
        const { file } = await receiveSingleFile(req, {
          maxBytes: MAX_TEACHER_IMAGE_BYTES,
          allowed: TEACHER_IMAGE_TYPES,
        });
        return setTeacherImage(params.id, file, actorFromRequest(req));
      },
    }),
    route({
      method: 'delete',
      path: '/:id/image',
      summary: 'Remove the teacher photo',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ req, params }) => removeTeacherImage(params.id, actorFromRequest(req)),
    }),
  ],
};
