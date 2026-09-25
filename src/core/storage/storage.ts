import { createReadStream, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config/env.js';

/**
 * Private media storage on the server's disk. Nothing here is ever served statically:
 * every byte leaves through an authorizing API route (or Nginx X-Accel-Redirect issued by one).
 *
 * Layout (relative "storage keys"):
 *   tmp/uploads/<uploadJobId>/<index>.part   chunked video uploads in progress
 *   tmp/work/<uploadJobId>/                  worker scratch space (key files, ffmpeg output)
 *   originals/<videoId>/<uploadJobId>.<ext>  source video (optional retention)
 *   videos/<videoId>/<uploadJobId>/          HLS output: master.m3u8, v0/index.m3u8, v0/seg_00000.ts
 *   files/<yyyy>/<mm>/<fileId>.<ext>          educational files
 *   images/teachers/<teacherId>-<rand>.<ext>  teacher photos
 */
export const StorageArea = {
  uploads: 'tmp/uploads',
  work: 'tmp/work',
  originals: 'originals',
  videos: 'videos',
  files: 'files',
  teacherImages: 'images/teachers',
} as const;

export function storageRoot(): string {
  return config.storageRoot;
}

/** Resolves a storage key to an absolute path, refusing anything that escapes the root. */
export function resolveStorageKey(key: string): string {
  const root = storageRoot();
  const absolute = path.resolve(root, key);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Storage key escapes storage root: ${key}`);
  }
  return absolute;
}

/** Joins path segments into a storage key using forward slashes (portable across OSes). */
export function storageKey(...segments: string[]): string {
  return segments.join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
}

export async function ensureStorageDir(key: string): Promise<string> {
  const absolute = resolveStorageKey(key);
  await fs.mkdir(absolute, { recursive: true });
  return absolute;
}

export async function removeStoragePath(key: string): Promise<void> {
  await fs.rm(resolveStorageKey(key), { recursive: true, force: true });
}

export async function storagePathExists(key: string): Promise<boolean> {
  try {
    await fs.access(resolveStorageKey(key));
    return true;
  } catch {
    return false;
  }
}

export function openStorageReadStream(key: string, options?: { start?: number; end?: number }) {
  return createReadStream(resolveStorageKey(key), options);
}

/** Total bytes under a storage key (used for statistics). */
export async function directorySize(key: string): Promise<number> {
  let absolute: string;
  try {
    absolute = resolveStorageKey(key);
  } catch {
    return 0;
  }
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await fs.stat(path.join(entry.parentPath, entry.name));
    total += stat.size;
  }
  return total;
}

export async function ensureStorageLayout(): Promise<void> {
  await Promise.all(Object.values(StorageArea).map((area) => fs.mkdir(path.join(storageRoot(), area), { recursive: true })));
}
