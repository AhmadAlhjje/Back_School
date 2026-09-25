import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { paginationQuery } from '../../core/http/pagination.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { name, uuid } from '../../core/http/schemas.js';
import { STAFF_ROLES } from '../users/roles.js';
import { listSentNotifications, sendAnnouncement } from './notifications.service.js';

const audienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALL_STUDENTS') }),
  z.object({ kind: z.literal('GRADE'), gradeId: uuid }),
  z.object({ kind: z.literal('SUBJECT'), subjectId: uuid }),
  z.object({ kind: z.literal('SUBJECT_TEACHER'), subjectTeacherId: uuid }),
  z.object({ kind: z.literal('STUDENTS'), studentIds: z.array(uuid).min(1).max(1000) }),
]);

export const notificationsModule: ApiModule = {
  prefix: '/notifications',
  tag: 'Notifications',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'Sent notifications with delivery and read counts',
      roles: STAFF_ROLES,
      query: paginationQuery,
      handler: ({ query }) => listSentNotifications(query),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Send an announcement to students (all, grade, subject, teacher, or selected students)',
      roles: STAFF_ROLES,
      body: z.object({
        title: name(200),
        body: z.string().trim().min(1).max(1000),
        audience: audienceSchema,
      }),
      successStatus: 201,
      handler: ({ req, body }) => sendAnnouncement(body, actorFromRequest(req)),
    }),
  ],
};
