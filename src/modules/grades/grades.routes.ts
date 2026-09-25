import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { route, type ApiModule } from '../../core/http/route.js';
import {
  idParams,
  lifecycleFilter,
  name,
  optionalText,
  reorderBody,
  searchTerm,
} from '../../core/http/schemas.js';
import { STAFF_ROLES } from '../users/roles.js';
import {
  archiveGrade,
  createGrade,
  getGrade,
  listGrades,
  reorderGrades,
  restoreGrade,
  updateGrade,
} from './grades.service.js';

const gradeBody = z.object({ name: name(120), description: optionalText(500) });

export const gradesModule: ApiModule = {
  prefix: '/grades',
  tag: 'Grades',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List grades',
      roles: STAFF_ROLES,
      query: z.object({ status: lifecycleFilter, search: searchTerm }),
      handler: ({ query }) => listGrades(query),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a grade',
      roles: STAFF_ROLES,
      body: gradeBody,
      successStatus: 201,
      handler: ({ req, body }) => createGrade(body, actorFromRequest(req)),
    }),
    route({
      method: 'put',
      path: '/reorder',
      summary: 'Reorder active grades',
      roles: STAFF_ROLES,
      body: reorderBody,
      handler: async ({ req, body }) => {
        await reorderGrades(body.ids, actorFromRequest(req));
        return { reordered: true };
      },
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Get a grade with its subjects',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ params }) => getGrade(params.id),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: 'Update a grade',
      roles: STAFF_ROLES,
      params: idParams,
      body: gradeBody.partial(),
      handler: ({ req, params, body }) => updateGrade(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Archive a grade (soft delete)',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await archiveGrade(params.id, actorFromRequest(req));
        return getGrade(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore an archived grade',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await restoreGrade(params.id, actorFromRequest(req));
        return getGrade(params.id);
      },
    }),
  ],
};
