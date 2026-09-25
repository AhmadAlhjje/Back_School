import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { idParams, name } from '../../core/http/schemas.js';
import { PASSWORD_MAX_LENGTH } from '../../core/security/password.js';
import { phoneSchema } from '../../core/security/phone.js';
import {
  resetAccountPassword,
  setAccountArchived,
  setAccountStatus,
} from '../users/account-admin.service.js';
import { ADMIN_ONLY } from '../users/roles.js';
import { assertOwnerRestorable, createOwner, getOwner, listOwners, updateOwner } from './owners.service.js';

const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);

export const ownersModule: ApiModule = {
  prefix: '/admin/owners',
  tag: 'Institute owner',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List owner accounts',
      roles: ADMIN_ONLY,
      handler: () => listOwners(),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create the institute owner account',
      roles: ADMIN_ONLY,
      body: z.object({ name: name(120), phone: phoneSchema, password }),
      successStatus: 201,
      handler: ({ req, body }) => createOwner(body, actorFromRequest(req)),
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Get the owner account',
      roles: ADMIN_ONLY,
      params: idParams,
      handler: ({ params }) => getOwner(params.id),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: "Change the owner's name or phone (owners cannot do this themselves)",
      roles: ADMIN_ONLY,
      params: idParams,
      body: z.object({ name: name(120), phone: phoneSchema }).partial(),
      handler: ({ req, params, body }) => updateOwner(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/reset-password',
      summary: "Set a new password for the owner (ends the owner's sessions)",
      roles: ADMIN_ONLY,
      params: idParams,
      body: z.object({ newPassword: password }),
      handler: async ({ req, params, body }) => {
        await resetAccountPassword(params.id, 'OWNER', body.newPassword, actorFromRequest(req));
        return { reset: true };
      },
    }),
    route({
      method: 'post',
      path: '/:id/disable',
      summary: 'Disable the owner account',
      roles: ADMIN_ONLY,
      params: idParams,
      handler: async ({ req, params }) => {
        await setAccountStatus(params.id, 'OWNER', 'DISABLED', actorFromRequest(req));
        return getOwner(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/enable',
      summary: 'Enable the owner account',
      roles: ADMIN_ONLY,
      params: idParams,
      handler: async ({ req, params }) => {
        await setAccountStatus(params.id, 'OWNER', 'ACTIVE', actorFromRequest(req));
        return getOwner(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Archive the owner account',
      roles: ADMIN_ONLY,
      params: idParams,
      handler: async ({ req, params }) => {
        await setAccountArchived(params.id, 'OWNER', true, actorFromRequest(req));
        return getOwner(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore an archived owner account (only if no other active owner exists)',
      roles: ADMIN_ONLY,
      params: idParams,
      handler: async ({ req, params }) => {
        await assertOwnerRestorable(params.id);
        await setAccountArchived(params.id, 'OWNER', false, actorFromRequest(req));
        return getOwner(params.id);
      },
    }),
  ],
};
