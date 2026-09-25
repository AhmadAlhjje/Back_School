import { z } from 'zod';
import { config } from '../../config/env.js';
import { actorFromRequest } from '../../core/audit/audit.js';
import { RESPONSE_SENT, route, type ApiModule } from '../../core/http/route.js';
import { idParams, lifecycleFilter, name, reorderBody, uuid } from '../../core/http/schemas.js';
import { EDUCATIONAL_FILE_TYPES } from '../../core/storage/file-types.js';
import { receiveSingleFile } from '../../core/storage/multipart.js';
import { sendStorageFile } from '../../core/storage/send.js';
import { FileScope } from '../../generated/prisma/enums.js';
import { STAFF_ROLES } from '../users/roles.js';
import {
  archiveFile,
  getFile,
  listFiles,
  reorderFiles,
  restoreFile,
  updateFile,
  uploadFile,
} from './files.service.js';
import { toStaffFileDto } from './files.dto.js';

const parentQuery = z.object({ scope: z.enum(FileScope), parentId: uuid });

export const filesModule: ApiModule = {
  prefix: '/files',
  tag: 'Files',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List the files attached to a subject / teacher space / topic / session',
      roles: STAFF_ROLES,
      query: parentQuery.extend({ status: lifecycleFilter }),
      handler: ({ query }) => listFiles(query.scope, query.parentId, query.status),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Upload a file (multipart field `file`, optional field `title`)',
      description: `Allowed: ${Object.keys(EDUCATIONAL_FILE_TYPES).join(', ')}. Max ${config.media.maxFileSizeBytes / 1024 / 1024} MB. Content must match the extension.`,
      roles: STAFF_ROLES,
      query: parentQuery,
      bodyKind: 'multipart',
      successStatus: 201,
      handler: async ({ req, query }) => {
        const { fields, file } = await receiveSingleFile(req, {
          maxBytes: config.media.maxFileSizeBytes,
          allowed: EDUCATIONAL_FILE_TYPES,
        });
        const title = fields.title?.replace(/\s+/g, ' ').trim() || null;
        return uploadFile(
          { scope: query.scope, parentId: query.parentId, title, file },
          actorFromRequest(req),
        );
      },
    }),
    route({
      method: 'put',
      path: '/reorder',
      summary: 'Reorder files of one parent',
      roles: STAFF_ROLES,
      body: reorderBody.extend({ scope: z.enum(FileScope), parentId: uuid }),
      handler: async ({ req, body }) => {
        await reorderFiles(body.scope, body.parentId, body.ids, actorFromRequest(req));
        return { reordered: true };
      },
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Get file metadata',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ params }) => toStaffFileDto(await getFile(params.id)),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: 'Rename a file',
      roles: STAFF_ROLES,
      params: idParams,
      body: z.object({ title: name(200) }),
      handler: ({ req, params, body }) => updateFile(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Delete (archive) a file — recoverable',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ req, params }) => archiveFile(params.id, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore an archived file',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ req, params }) => restoreFile(params.id, actorFromRequest(req)),
    }),
    route({
      method: 'get',
      path: '/:id/download',
      summary: 'Download a file (staff)',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ res, params }) => {
        const file = await getFile(params.id);
        await sendStorageFile(res, file.storageKey, {
          contentType: file.mimeType,
          cacheControl: 'private, no-store',
          downloadName: `${file.title}.${file.extension}`,
        });
        return RESPONSE_SENT;
      },
    }),
  ],
};
