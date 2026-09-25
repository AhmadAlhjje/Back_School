import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { uuid } from '../../core/http/schemas.js';
import { rateLimiters } from '../../core/security/rate-limit.js';
import { issueStudentFileAccess, issueStudentPlayback } from '../media/playback.service.js';
import { listInbox, markAllRead, markRead, unreadCount } from '../notifications/notifications.service.js';
import { STUDENT_ONLY } from '../users/roles.js';
import { issueOfflineLicense, revokeOwnOfflineLicense, syncOfflineLicenses } from './offline.service.js';
import {
  getHome,
  getSessionForStudent,
  getStudentProfile,
  getSubjectForStudent,
  getTeacherSpace,
  getTopicForStudent,
  listGradeSubjects,
  listGrades,
  searchCatalog,
} from './student-catalog.service.js';

/** Student app API. Every route requires a STUDENT token + the bound device header. */
export const studentModule: ApiModule = {
  prefix: '/student',
  tag: 'Student app',
  routes: [
    route({
      method: 'get',
      path: '/home',
      summary: 'Home: greeting, subjects (with lock state), grades, unread notifications',
      roles: STUDENT_ONLY,
      handler: ({ auth }) => getHome(auth),
    }),
    route({
      method: 'get',
      path: '/profile',
      summary: 'Student profile with bound device',
      roles: STUDENT_ONLY,
      handler: ({ auth }) => getStudentProfile(auth),
    }),
    route({
      method: 'get',
      path: '/grades',
      summary: 'All grades',
      roles: STUDENT_ONLY,
      handler: () => listGrades(),
    }),
    route({
      method: 'get',
      path: '/grades/:gradeId/subjects',
      summary: 'Subjects of a grade with lock state',
      roles: STUDENT_ONLY,
      params: z.object({ gradeId: uuid }),
      handler: ({ auth, params }) => listGradeSubjects(auth.userId, params.gradeId),
    }),
    route({
      method: 'get',
      path: '/subjects/:subjectId',
      summary: 'Subject with its teachers (each with lock state) and subject files when open',
      roles: STUDENT_ONLY,
      params: z.object({ subjectId: uuid }),
      handler: ({ auth, params }) => getSubjectForStudent(auth.userId, params.subjectId),
    }),
    route({
      method: 'get',
      path: '/subject-teachers/:subjectTeacherId',
      summary: "A teacher's topics in a subject (403 ACCESS_DENIED when locked)",
      roles: STUDENT_ONLY,
      params: z.object({ subjectTeacherId: uuid }),
      handler: ({ auth, params }) => getTeacherSpace(auth.userId, params.subjectTeacherId),
    }),
    route({
      method: 'get',
      path: '/topics/:topicId',
      summary: 'Topic sessions (requires access)',
      roles: STUDENT_ONLY,
      params: z.object({ topicId: uuid }),
      handler: ({ auth, params }) => getTopicForStudent(auth.userId, params.topicId),
    }),
    route({
      method: 'get',
      path: '/sessions/:sessionId',
      summary: 'Session videos and files (requires access)',
      roles: STUDENT_ONLY,
      params: z.object({ sessionId: uuid }),
      handler: ({ auth, params }) => getSessionForStudent(auth.userId, params.sessionId),
    }),
    route({
      method: 'post',
      path: '/videos/:videoId/playback',
      summary: 'Get a temporary, device-bound HLS playback URL',
      description:
        'Validates token → session → device → student → access → video READY, then issues a signed manifest URL.',
      roles: STUDENT_ONLY,
      params: z.object({ videoId: uuid }),
      middleware: [rateLimiters.videoAccess],
      handler: ({ auth, params }) => issueStudentPlayback(auth, params.videoId),
    }),
    route({
      method: 'post',
      path: '/files/:fileId/access',
      summary: 'Get a 5-minute download URL for a file',
      roles: STUDENT_ONLY,
      params: z.object({ fileId: uuid }),
      middleware: [rateLimiters.fileAccess],
      handler: ({ auth, params }) => issueStudentFileAccess(auth, params.fileId),
    }),
    route({
      method: 'get',
      path: '/search',
      summary: 'Search subjects, teachers and (accessible) lessons',
      roles: STUDENT_ONLY,
      query: z.object({ q: z.string().trim().min(2).max(100) }),
      handler: ({ auth, query }) => searchCatalog(auth.userId, query.q),
    }),
    route({
      method: 'get',
      path: '/notifications',
      summary: 'Notification inbox',
      roles: STUDENT_ONLY,
      query: paginationQuery,
      handler: ({ auth, query }) => listInbox(auth.userId, query),
    }),
    route({
      method: 'get',
      path: '/notifications/unread-count',
      summary: 'Unread notifications count',
      roles: STUDENT_ONLY,
      handler: async ({ auth }) => ({ unread: await unreadCount(auth.userId) }),
    }),
    route({
      method: 'post',
      path: '/notifications/read-all',
      summary: 'Mark all notifications as read',
      roles: STUDENT_ONLY,
      handler: ({ auth }) => markAllRead(auth.userId),
    }),
    route({
      method: 'post',
      path: '/notifications/:notificationId/read',
      summary: 'Mark one notification as read',
      roles: STUDENT_ONLY,
      params: z.object({ notificationId: uuid }),
      handler: ({ auth, params }) => markRead(auth.userId, params.notificationId),
    }),
    route({
      method: 'post',
      path: '/videos/:videoId/offline-license',
      summary: 'Issue an offline license and download URLs for encrypted segments',
      roles: STUDENT_ONLY,
      params: z.object({ videoId: uuid }),
      middleware: [rateLimiters.videoAccess],
      handler: ({ auth, params }) => issueOfflineLicense(auth, params.videoId),
    }),
    route({
      method: 'get',
      path: '/offline-licenses',
      summary: 'Valid offline licenses of this device (the app purges anything not listed)',
      roles: STUDENT_ONLY,
      handler: ({ auth }) => syncOfflineLicenses(auth),
    }),
    route({
      method: 'delete',
      path: '/offline-licenses/:licenseId',
      summary: 'Delete an offline download',
      roles: STUDENT_ONLY,
      params: z.object({ licenseId: uuid }),
      handler: ({ auth, params }) => revokeOwnOfflineLicense(auth, params.licenseId),
    }),
  ],
};
