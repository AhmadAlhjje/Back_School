import { actorFromRequest } from '../../core/audit/audit.js';
import { openRoute, route, type ApiModule } from '../../core/http/route.js';
import { listGradeOptions } from '../grades/grades.service.js';
import { getPublicConfig, getSettings, settingsUpdateSchema, updateSettings } from './settings.service.js';

export const settingsModule: ApiModule = {
  prefix: '/admin/settings',
  tag: 'System settings',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'Get system settings',
      roles: ['SUPER_ADMIN'],
      handler: () => getSettings(),
    }),
    route({
      method: 'patch',
      path: '/',
      summary: 'Update system settings',
      roles: ['SUPER_ADMIN'],
      body: settingsUpdateSchema.strict(),
      handler: ({ req, body }) => updateSettings(body, actorFromRequest(req)),
    }),
  ],
};

export const publicModule: ApiModule = {
  prefix: '/public',
  tag: 'Public',
  routes: [
    openRoute({
      method: 'get',
      path: '/config',
      summary: 'Public client configuration (institute name, registration availability)',
      access: 'public',
      handler: () => getPublicConfig(),
    }),
    openRoute({
      method: 'get',
      path: '/grades',
      summary: 'Active grades (id, name), for the grade choice when a student creates an account',
      access: 'public',
      handler: () => listGradeOptions(),
    }),
  ],
};
