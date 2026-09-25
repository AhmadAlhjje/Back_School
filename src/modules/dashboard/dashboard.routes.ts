import { route, type ApiModule } from '../../core/http/route.js';
import { ADMIN_ONLY, STAFF_ROLES } from '../users/roles.js';
import { getInstituteStats, getSystemStats } from './dashboard.service.js';

export const dashboardModule: ApiModule = {
  prefix: '/dashboard',
  tag: 'Dashboard',
  routes: [
    route({
      method: 'get',
      path: '/stats',
      summary: 'Institute statistics (counts, recent uploads, recent students)',
      roles: STAFF_ROLES,
      handler: () => getInstituteStats(),
    }),
    route({
      method: 'get',
      path: '/system',
      summary: 'System statistics: storage, devices, sessions, processing jobs, recent activity',
      roles: ADMIN_ONLY,
      handler: () => getSystemStats(),
    }),
  ],
};
