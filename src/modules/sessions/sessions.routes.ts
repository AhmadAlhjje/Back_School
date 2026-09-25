import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { idParams, lifecycleFilter, name, optionalText, reorderBody, uuid } from '../../core/http/schemas.js';
import { STAFF_ROLES } from '../users/roles.js';
import {
  archiveSession,
  createSession,
  getSession,
  listSessions,
  reorderSessions,
  restoreSession,
  updateSession,
} from './sessions.service.js';

const sessionBody = z.object({ title: name(200), description: optionalText(5000) });

export const sessionsModule: ApiModule = {
  prefix: '/sessions',
  tag: 'Sessions',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List the sessions of a topic',
      roles: STAFF_ROLES,
      query: z.object({ topicId: uuid, status: lifecycleFilter }),
      handler: ({ query }) => listSessions(query.topicId, query.status),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a session in a topic',
      roles: STAFF_ROLES,
      body: sessionBody.extend({ topicId: uuid }),
      successStatus: 201,
      handler: ({ req, body }) => createSession(body, actorFromRequest(req)),
    }),
    route({
      method: 'put',
      path: '/reorder',
      summary: 'Reorder the sessions of a topic',
      roles: STAFF_ROLES,
      body: reorderBody.extend({ topicId: uuid }),
      handler: async ({ req, body }) => {
        await reorderSessions(body.topicId, body.ids, actorFromRequest(req));
        return { reordered: true };
      },
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Get a session with its videos and files',
      roles: STAFF_ROLES,
      params: idParams,
      query: z.object({ status: lifecycleFilter.default('all') }),
      handler: ({ params, query }) => getSession(params.id, query.status),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: 'Rename / update a session',
      roles: STAFF_ROLES,
      params: idParams,
      body: sessionBody.partial(),
      handler: ({ req, params, body }) => updateSession(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Archive a session',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await archiveSession(params.id, actorFromRequest(req));
        return getSession(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore a session',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await restoreSession(params.id, actorFromRequest(req));
        return getSession(params.id);
      },
    }),
  ],
};
