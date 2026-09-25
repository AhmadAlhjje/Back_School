import type { ApiModule } from '../core/http/route.js';
import { accessModule } from '../modules/access/access.routes.js';
import { auditModule } from '../modules/audit/audit.routes.js';
import { authModule } from '../modules/auth/auth.routes.js';
import { dashboardModule } from '../modules/dashboard/dashboard.routes.js';
import { devicesModule } from '../modules/devices/devices.routes.js';
import { filesModule } from '../modules/files/files.routes.js';
import { gradesModule } from '../modules/grades/grades.routes.js';
import { mediaModule } from '../modules/media/media.routes.js';
import { notificationsModule } from '../modules/notifications/notifications.routes.js';
import { ownersModule } from '../modules/owners/owners.routes.js';
import { sessionsModule } from '../modules/sessions/sessions.routes.js';
import { publicModule, settingsModule } from '../modules/settings/settings.routes.js';
import { studentModule } from '../modules/student-portal/student.routes.js';
import { studentsModule } from '../modules/students/students.routes.js';
import { subjectsModule, subjectTeachersModule } from '../modules/subjects/subjects.routes.js';
import { teachersModule } from '../modules/teachers/teachers.routes.js';
import { topicsModule } from '../modules/topics/topics.routes.js';
import { videosModule } from '../modules/videos/videos.routes.js';

/** Every API module mounted under /api/v1. */
export const apiModules: ApiModule[] = [
  authModule,
  publicModule,
  // Super admin
  settingsModule,
  ownersModule,
  devicesModule,
  auditModule,
  // Staff (super admin + owner)
  dashboardModule,
  studentsModule,
  teachersModule,
  gradesModule,
  subjectsModule,
  subjectTeachersModule,
  topicsModule,
  sessionsModule,
  videosModule,
  filesModule,
  accessModule,
  notificationsModule,
  // Student app
  studentModule,
  // Signed media delivery
  mediaModule,
];
