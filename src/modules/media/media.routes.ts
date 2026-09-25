import fs from 'node:fs/promises';
import { z } from 'zod';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { openRoute, RESPONSE_SENT, type ApiModule } from '../../core/http/route.js';
import { uuid } from '../../core/http/schemas.js';
import { openSecret } from '../../core/security/crypto.js';
import { rateLimiters } from '../../core/security/rate-limit.js';
import { sendStorageFile } from '../../core/storage/send.js';
import { resolveStorageKey, storageKey } from '../../core/storage/storage.js';
import {
  rewriteMasterPlaylist,
  rewriteVariantPlaylist,
  SEGMENT_PATTERN,
  VARIANT_PATTERN,
} from './hls-playlist.js';
import { assertMediaAllowed } from './media-guard.js';
import { verifyMediaToken } from './media-token.js';

/**
 * Media gateway. No bearer token here: players cannot add headers to every request, so
 * authorization comes from the signed media token, re-validated against the live session,
 * device and access state on every request (see media-guard.ts).
 */

const tokenQuery = z.object({ token: z.string().min(20).max(2000).optional() });
const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';

async function readyAsset(videoId: string) {
  const asset = await prisma.videoAsset.findUnique({ where: { videoId } });
  if (!asset) throw new AppError('VIDEO_NOT_READY');
  return asset;
}

async function readPlaylist(key: string): Promise<string> {
  try {
    return await fs.readFile(resolveStorageKey(key), 'utf8');
  } catch {
    throw new AppError('VIDEO_NOT_FOUND');
  }
}

export const mediaModule: ApiModule = {
  prefix: '/media',
  tag: 'Media delivery',
  routes: [
    openRoute({
      method: 'get',
      path: '/videos/:videoId/master.m3u8',
      summary: 'HLS master playlist (rewritten with the caller token)',
      access: 'media-token',
      params: z.object({ videoId: uuid }),
      query: tokenQuery,
      handler: async ({ res, params, query }) => {
        const claims = verifyMediaToken(query.token, 'video', params.videoId);
        await assertMediaAllowed(claims, { fresh: false });
        const asset = await readyAsset(params.videoId);
        const playlist = await readPlaylist(storageKey(asset.storageKey, 'master.m3u8'));
        res.setHeader('Cache-Control', 'no-store');
        res.type(PLAYLIST_TYPE).send(rewriteMasterPlaylist(playlist, query.token!));
        return RESPONSE_SENT;
      },
    }),
    openRoute({
      method: 'get',
      path: '/videos/:videoId/key',
      summary: 'AES-128 content key (full authorization on every call)',
      access: 'media-token',
      params: z.object({ videoId: uuid }),
      query: tokenQuery,
      middleware: [rateLimiters.mediaKey],
      handler: async ({ res, params, query }) => {
        const claims = verifyMediaToken(query.token, 'video', params.videoId);
        await assertMediaAllowed(claims, { fresh: true });
        const asset = await readyAsset(params.videoId);
        res.setHeader('Cache-Control', 'no-store');
        res.type('application/octet-stream').send(openSecret(asset.encryptedKey));
        return RESPONSE_SENT;
      },
    }),
    openRoute({
      method: 'get',
      path: '/videos/:videoId/:variant/index.m3u8',
      summary: 'HLS variant playlist (rewritten with the caller token and key URI)',
      access: 'media-token',
      params: z.object({ videoId: uuid, variant: z.string().regex(VARIANT_PATTERN) }),
      query: tokenQuery,
      handler: async ({ res, params, query }) => {
        const claims = verifyMediaToken(query.token, 'video', params.videoId);
        await assertMediaAllowed(claims, { fresh: false });
        const asset = await readyAsset(params.videoId);
        const playlist = await readPlaylist(storageKey(asset.storageKey, params.variant, 'index.m3u8'));
        res.setHeader('Cache-Control', 'no-store');
        res.type(PLAYLIST_TYPE).send(rewriteVariantPlaylist(playlist, query.token!, '../key'));
        return RESPONSE_SENT;
      },
    }),
    openRoute({
      method: 'get',
      path: '/videos/:videoId/:variant/:segment',
      summary: 'Encrypted HLS segment',
      access: 'media-token',
      params: z.object({
        videoId: uuid,
        variant: z.string().regex(VARIANT_PATTERN),
        segment: z.string().regex(SEGMENT_PATTERN),
      }),
      query: tokenQuery,
      handler: async ({ res, params, query }) => {
        const claims = verifyMediaToken(query.token, 'video', params.videoId);
        await assertMediaAllowed(claims, { fresh: false });
        const asset = await readyAsset(params.videoId);
        await sendStorageFile(res, storageKey(asset.storageKey, params.variant, params.segment), {
          contentType: 'video/mp2t',
          cacheControl: 'private, max-age=600',
        });
        return RESPONSE_SENT;
      },
    }),
    openRoute({
      method: 'get',
      path: '/files/:fileId',
      summary: 'Download an educational file with a short-lived file token',
      access: 'media-token',
      params: z.object({ fileId: uuid }),
      query: tokenQuery,
      handler: async ({ res, params, query }) => {
        const claims = verifyMediaToken(query.token, 'file', params.fileId);
        await assertMediaAllowed(claims, { fresh: true });
        const file = await prisma.contentFile.findUnique({ where: { id: params.fileId } });
        if (!file) throw new AppError('FILE_NOT_FOUND');
        await sendStorageFile(res, file.storageKey, {
          contentType: file.mimeType,
          cacheControl: 'private, no-store',
          inlineName: `${file.title}.${file.extension}`,
        });
        return RESPONSE_SENT;
      },
    }),
    openRoute({
      method: 'get',
      path: '/teachers/:teacherId/image',
      summary: 'Teacher photo (non-sensitive, cacheable)',
      access: 'public',
      params: z.object({ teacherId: uuid }),
      handler: async ({ res, params }) => {
        const teacher = await prisma.teacher.findUnique({ where: { id: params.teacherId } });
        if (!teacher?.imageKey) throw new AppError('NOT_FOUND');
        const extension = teacher.imageKey.split('.').pop() ?? 'jpg';
        const contentType =
          extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
        await sendStorageFile(res, teacher.imageKey, { contentType, cacheControl: 'public, max-age=86400' });
        return RESPONSE_SENT;
      },
    }),
  ],
};
