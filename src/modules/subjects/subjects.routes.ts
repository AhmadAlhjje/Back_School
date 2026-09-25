import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { paginationQuery } from '../../core/http/pagination.js';
import { route, type ApiModule } from '../../core/http/route.js';
import {
  idParams,
  lifecycleFilter,
  name,
  optionalText,
  reorderBody,
  searchTerm,
  uuid,
} from '../../core/http/schemas.js';
import { STAFF_ROLES } from '../users/roles.js';
import { getSubjectTeacher, restoreAssignment, unassignTeacher } from './subject-teachers.service.js';
import {
  archiveSubject,
  assignTeacher,
  createSubject,
  getSubject,
  listSubjects,
  reorderSubjects,
  reorderSubjectTeachers,
  restoreSubject,
  updateSubject,
} from './subjects.service.js';

const subjectBody = z.object({ gradeId: uuid, name: name(120), description: optionalText(5000) });

export const subjectsModule: ApiModule = {
  prefix: '/subjects',
  tag: 'Subjects',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List subjects (search, grade filter, pagination)',
      roles: STAFF_ROLES,
      query: paginationQuery.extend({
        status: lifecycleFilter,
        search: searchTerm,
        gradeId: uuid.optional(),
      }),
      handler: ({ query }) => listSubjects(query),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a subject in a grade',
      roles: STAFF_ROLES,
      body: subjectBody,
      successStatus: 201,
      handler: ({ req, body }) => createSubject(body, actorFromRequest(req)),
    }),
    route({
      method: 'put',
      path: '/reorder',
      summary: 'Reorder the active subjects of a grade',
      roles: STAFF_ROLES,
      body: reorderBody.extend({ gradeId: uuid }),
      handler: async ({ req, body }) => {
        await reorderSubjects(body.gradeId, body.ids, actorFromRequest(req));
        return { reordered: true };
      },
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Get a subject with its teachers',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ params }) => getSubject(params.id),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: 'Update a subject',
      roles: STAFF_ROLES,
      params: idParams,
      body: subjectBody.partial(),
      handler: ({ req, params, body }) => updateSubject(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Archive a subject',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await archiveSubject(params.id, actorFromRequest(req));
        return getSubject(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore a subject',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await restoreSubject(params.id, actorFromRequest(req));
        return getSubject(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/teachers',
      summary: "Assign a teacher to the subject (creates the teacher's content space)",
      roles: STAFF_ROLES,
      params: idParams,
      body: z.object({ teacherId: uuid }),
      successStatus: 201,
      handler: ({ req, params, body }) => assignTeacher(params.id, body.teacherId, actorFromRequest(req)),
    }),
    route({
      method: 'put',
      path: '/:id/teachers/reorder',
      summary: 'Reorder the teachers of a subject',
      roles: STAFF_ROLES,
      params: idParams,
      body: reorderBody,
      handler: async ({ req, params, body }) => {
        await reorderSubjectTeachers(params.id, body.ids, actorFromRequest(req));
        return { reordered: true };
      },
    }),
  ],
};

export const subjectTeachersModule: ApiModule = {
  prefix: '/subject-teachers',
  tag: 'Subjects',
  routes: [
    route({
      method: 'get',
      path: '/:id',
      summary: "Get a teacher's content space in a subject (with topics)",
      roles: STAFF_ROLES,
      params: idParams,
      query: z.object({ status: lifecycleFilter }),
      handler: ({ params, query }) => getSubjectTeacher(params.id, query.status),
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Unassign the teacher from the subject (content is kept)',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await unassignTeacher(params.id, actorFromRequest(req));
        return getSubjectTeacher(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Re-assign a previously unassigned teacher',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await restoreAssignment(params.id, actorFromRequest(req));
        return getSubjectTeacher(params.id);
      },
    }),
  ],
};
