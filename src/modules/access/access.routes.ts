import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { uuid } from '../../core/http/schemas.js';
import { STAFF_ROLES } from '../users/roles.js';
import { bulkSetAccess, getStudentAccessTree, setSubjectAccess, setTeacherAccess } from './access.service.js';

const openBody = z.object({ open: z.boolean() });

export const accessModule: ApiModule = {
  prefix: '/access',
  tag: 'Access',
  routes: [
    route({
      method: 'get',
      path: '/students/:studentId',
      summary: "A student's access tree: grades → subjects → teachers with open/locked state",
      roles: STAFF_ROLES,
      params: z.object({ studentId: uuid }),
      handler: ({ params }) => getStudentAccessTree(params.studentId),
    }),
    route({
      method: 'put',
      path: '/students/:studentId/subjects/:subjectId',
      summary: 'Open or close a subject for a student',
      roles: STAFF_ROLES,
      params: z.object({ studentId: uuid, subjectId: uuid }),
      body: openBody,
      handler: ({ req, params, body }) =>
        setSubjectAccess(params.studentId, params.subjectId, body.open, actorFromRequest(req)),
    }),
    route({
      method: 'put',
      path: '/students/:studentId/subject-teachers/:subjectTeacherId',
      summary: 'Open or close a teacher (within a subject) for a student',
      description:
        "Opening grants all of the teacher's current and future topics, sessions, videos and files in that subject. Opening also opens the subject when it is closed.",
      roles: STAFF_ROLES,
      params: z.object({ studentId: uuid, subjectTeacherId: uuid }),
      body: openBody,
      handler: ({ req, params, body }) =>
        setTeacherAccess(params.studentId, params.subjectTeacherId, body.open, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/bulk',
      summary: 'Open or close a subject / teacher for many students',
      roles: STAFF_ROLES,
      body: z.object({
        studentIds: z.array(uuid).min(1).max(500),
        target: z.discriminatedUnion('type', [
          z.object({ type: z.literal('SUBJECT'), id: uuid }),
          z.object({ type: z.literal('SUBJECT_TEACHER'), id: uuid }),
        ]),
        open: z.boolean(),
      }),
      handler: ({ req, body }) => bulkSetAccess(body, actorFromRequest(req)),
    }),
  ],
};
