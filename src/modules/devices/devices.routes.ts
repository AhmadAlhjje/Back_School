import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { paginationQuery } from '../../core/http/pagination.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { idParams, searchTerm } from '../../core/http/schemas.js';
import { ADMIN_ONLY } from '../users/roles.js';
import { listDevices, resetDevice } from './devices.service.js';

export const devicesModule: ApiModule = {
  prefix: '/devices',
  tag: 'Devices',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List device bindings',
      roles: ADMIN_ONLY,
      query: paginationQuery.extend({
        status: z.enum(['ACTIVE', 'RESET', 'all']).default('ACTIVE'),
        search: searchTerm,
      }),
      handler: ({ query }) => listDevices(query),
    }),
    route({
      method: 'post',
      path: '/:id/reset',
      summary: 'Reset a device binding (revokes its sessions and offline licenses)',
      roles: ADMIN_ONLY,
      params: idParams,
      handler: ({ req, params }) => resetDevice(params.id, actorFromRequest(req)),
    }),
  ],
};
