import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { idParams, lifecycleFilter, name, optionalText, reorderBody, uuid } from '../../core/http/schemas.js';
import { STAFF_ROLES } from '../users/roles.js';
import {
  archiveTopic,
  createTopic,
  getTopic,
  listTopics,
  reorderTopics,
  restoreTopic,
  updateTopic,
} from './topics.service.js';

const topicBody = z.object({ title: name(200), description: optionalText(5000) });

export const topicsModule: ApiModule = {
  prefix: '/topics',
  tag: 'Topics',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: "List the topics of a teacher's content space",
      roles: STAFF_ROLES,
      query: z.object({ subjectTeacherId: uuid, status: lifecycleFilter }),
      handler: ({ query }) => listTopics(query.subjectTeacherId, query.status),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a topic (research) under a teacher in a subject',
      roles: STAFF_ROLES,
      body: topicBody.extend({ subjectTeacherId: uuid }),
      successStatus: 201,
      handler: ({ req, body }) => createTopic(body, actorFromRequest(req)),
    }),
    route({
      method: 'put',
      path: '/reorder',
      summary: 'Reorder topics',
      roles: STAFF_ROLES,
      body: reorderBody.extend({ subjectTeacherId: uuid }),
      handler: async ({ req, body }) => {
        await reorderTopics(body.subjectTeacherId, body.ids, actorFromRequest(req));
        return { reordered: true };
      },
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Get a topic with its sessions',
      roles: STAFF_ROLES,
      params: idParams,
      query: z.object({ status: lifecycleFilter.default('all') }),
      handler: ({ params, query }) => getTopic(params.id, query.status),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: 'Rename / update a topic',
      roles: STAFF_ROLES,
      params: idParams,
      body: topicBody.partial(),
      handler: ({ req, params, body }) => updateTopic(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Archive a topic',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await archiveTopic(params.id, actorFromRequest(req));
        return getTopic(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore a topic',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await restoreTopic(params.id, actorFromRequest(req));
        return getTopic(params.id);
      },
    }),
  ],
};
