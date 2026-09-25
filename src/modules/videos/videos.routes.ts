import type { Request } from 'express';
import { z } from 'zod';
import { actorFromRequest } from '../../core/audit/audit.js';
import type { AuthContext } from '../../core/auth/auth-context.js';
import { signUploadToken, videoUploadTarget } from '../../core/auth/upload-token.js';
import { route, type ApiModule } from '../../core/http/route.js';
import { idParams, lifecycleFilter, name, optionalText, reorderBody, uuid } from '../../core/http/schemas.js';
import { issueStaffPreview } from '../media/playback.service.js';
import { STAFF_ROLES } from '../users/roles.js';
import {
  completeUpload,
  createVideoUpload,
  getUploadStatus,
  receiveChunk,
  restartUpload,
} from './video-upload.service.js';
import {
  archiveVideo,
  getVideo,
  listVideos,
  reorderVideos,
  restoreVideo,
  updateVideo,
} from './videos.service.js';

/** Upload plans carry an upload token, so the dashboard can finish the upload in the background. */
function withUploadToken<T extends { video: { id: string } }>(plan: T, auth: AuthContext) {
  return { ...plan, ...signUploadToken(videoUploadTarget(plan.video.id), auth) };
}

const uploadTarget = (req: Request) => videoUploadTarget(String(req.params.id));

const uploadPlan = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().positive(),
  mimeType: z.string().trim().max(100).default('application/octet-stream'),
});

export const videosModule: ApiModule = {
  prefix: '/videos',
  tag: 'Videos',
  routes: [
    route({
      method: 'get',
      path: '/',
      summary: 'List the videos of a session',
      roles: STAFF_ROLES,
      query: z.object({ sessionId: uuid, status: lifecycleFilter }),
      handler: ({ query }) => listVideos(query.sessionId, query.status),
    }),
    route({
      method: 'post',
      path: '/',
      summary: 'Create a video and start a chunked upload',
      description:
        'Returns the chunk plan (`chunkSize`, `totalChunks`) and an `uploadToken`. Upload each chunk with PUT .../upload/chunks/:index, then POST .../upload/complete — with the bearer token, or with the upload token in `X-Upload-Token` (background uploads).',
      roles: STAFF_ROLES,
      body: uploadPlan.extend({ sessionId: uuid, title: name(200), description: optionalText(5000) }),
      successStatus: 201,
      handler: async ({ req, auth, body }) =>
        withUploadToken(await createVideoUpload(body, actorFromRequest(req)), auth),
    }),
    route({
      method: 'put',
      path: '/reorder',
      summary: 'Reorder the videos of a session',
      roles: STAFF_ROLES,
      body: reorderBody.extend({ sessionId: uuid }),
      handler: async ({ req, body }) => {
        await reorderVideos(body.sessionId, body.ids, actorFromRequest(req));
        return { reordered: true };
      },
    }),
    route({
      method: 'get',
      path: '/:id',
      summary: 'Get a video',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ params }) => getVideo(params.id),
    }),
    route({
      method: 'patch',
      path: '/:id',
      summary: 'Rename / update a video',
      roles: STAFF_ROLES,
      params: idParams,
      body: z.object({ title: name(200), description: optionalText(5000) }).partial(),
      handler: ({ req, params, body }) => updateVideo(params.id, body, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/archive',
      summary: 'Archive a video',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await archiveVideo(params.id, actorFromRequest(req));
        return getVideo(params.id);
      },
    }),
    route({
      method: 'post',
      path: '/:id/restore',
      summary: 'Restore a video',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ req, params }) => {
        await restoreVideo(params.id, actorFromRequest(req));
        return getVideo(params.id);
      },
    }),
    route({
      method: 'get',
      path: '/:id/upload',
      summary: 'Upload status and received chunk indexes (for resuming)',
      roles: STAFF_ROLES,
      params: idParams,
      handler: async ({ auth, params }) => withUploadToken(await getUploadStatus(params.id), auth),
    }),
    route({
      method: 'put',
      path: '/:id/upload/chunks/:index',
      summary: 'Upload one chunk (raw bytes, application/octet-stream)',
      roles: STAFF_ROLES,
      uploadTarget,
      params: idParams.extend({ index: z.coerce.number().int().min(0) }),
      bodyKind: 'binary',
      handler: ({ req, params }) =>
        receiveChunk(params.id, params.index, req, Number(req.headers['content-length'] ?? Number.NaN)),
    }),
    route({
      method: 'post',
      path: '/:id/upload/complete',
      summary: 'Finish the upload and queue processing',
      roles: STAFF_ROLES,
      uploadTarget,
      params: idParams,
      handler: ({ req, params }) => completeUpload(params.id, actorFromRequest(req)),
    }),
    route({
      method: 'post',
      path: '/:id/upload/restart',
      summary: 'Start a new upload for a failed or abandoned video',
      roles: STAFF_ROLES,
      params: idParams,
      body: uploadPlan,
      handler: async ({ req, auth, params, body }) =>
        withUploadToken(await restartUpload(params.id, body, actorFromRequest(req)), auth),
    }),
    route({
      method: 'post',
      path: '/:id/preview',
      summary: 'Temporary playback URL for staff preview',
      roles: STAFF_ROLES,
      params: idParams,
      handler: ({ auth, params }) => issueStaffPreview(auth, params.id),
    }),
  ],
};
