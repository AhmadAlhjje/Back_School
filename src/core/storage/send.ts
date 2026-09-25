import type { Response } from 'express';
import { config } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';
import { resolveStorageKey, storagePathExists } from './storage.js';

interface SendOptions {
  contentType: string;
  cacheControl: string;
  /** When set, sent as a download with this (UTF-8 safe) file name. */
  downloadName?: string;
  inlineName?: string;
}

/**
 * Sends a private storage file after the caller has been authorized.
 * In production with MEDIA_ACCEL_REDIRECT=true, Nginx streams the bytes from an `internal`
 * location (X-Accel-Redirect); otherwise Node streams it with Range support.
 */
export async function sendStorageFile(res: Response, key: string, options: SendOptions): Promise<void> {
  if (!(await storagePathExists(key))) throw new AppError('FILE_NOT_FOUND');
  res.setHeader('Cache-Control', options.cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (options.downloadName) res.attachment(options.downloadName);
  else if (options.inlineName) {
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(options.inlineName)}`);
  }

  if (config.media.accelRedirect) {
    res.setHeader('Content-Type', options.contentType);
    res.setHeader('X-Accel-Redirect', `${config.media.accelPrefix}/${key.split('/').map(encodeURIComponent).join('/')}`);
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    res.sendFile(
      resolveStorageKey(key),
      { headers: { 'Content-Type': options.contentType }, acceptRanges: true, cacheControl: false, dotfiles: 'deny' },
      (error) => (error && !res.headersSent ? reject(error) : resolve()),
    );
  });
}
