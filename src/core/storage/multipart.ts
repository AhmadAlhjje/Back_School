import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import busboy from 'busboy';
import { AppError } from '../errors/app-error.js';
import { fileExtension, matchesSignature } from './file-types.js';
import { ensureStorageDir, resolveStorageKey, StorageArea, storageKey } from './storage.js';

type FileTypeRules = Record<string, { kind: string; mime: string; signature: Parameters<typeof matchesSignature>[1] }>;

export interface ReceivedFile {
  /** Temporary storage key; move it with `commitReceivedFile` or delete it with `discardReceivedFile`. */
  tempKey: string;
  originalFileName: string;
  extension: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  sha256: string;
}

export interface MultipartResult {
  fields: Record<string, string>;
  file: ReceivedFile;
}

const SIGNATURE_BYTES = 16;
const MAX_FIELDS = 20;

/**
 * Streams a single-file multipart upload straight to private temp storage while hashing it.
 * Never buffers the file in memory. Enforces size and type (extension + magic bytes);
 * any violation deletes the partial file and fails with a typed error.
 */
export async function receiveSingleFile(
  req: Request,
  options: { maxBytes: number; allowed: FileTypeRules },
): Promise<MultipartResult> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw new AppError('VALIDATION_ERROR', { details: { reason: 'EXPECTED_MULTIPART' } });
  }
  await ensureStorageDir(StorageArea.uploads);
  const tempKey = storageKey(StorageArea.uploads, `${randomUUID()}.upload`);
  const tempPath = resolveStorageKey(tempKey);

  return new Promise<MultipartResult>((resolve, reject) => {
    const fields: Record<string, string> = {};
    let fileInfo: Omit<ReceivedFile, 'sizeBytes' | 'sha256'> | null = null;
    let fileDone: Promise<{ sizeBytes: number; sha256: string }> | null = null;
    let failure: AppError | null = null;

    const fail = (error: AppError) => {
      failure ??= error;
    };

    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        limits: { files: 1, fields: MAX_FIELDS, fieldSize: 10_000, fileSize: options.maxBytes },
        defParamCharset: 'utf8',
      });
    } catch {
      reject(new AppError('VALIDATION_ERROR', { details: { reason: 'MALFORMED_MULTIPART' } }));
      return;
    }

    parser.on('field', (name, value) => {
      fields[name] = value;
    });

    parser.on('file', (_field, stream, info) => {
      const originalFileName = path.basename(info.filename || 'file').slice(0, 255);
      const extension = fileExtension(originalFileName);
      const rule = options.allowed[extension];
      if (!rule) {
        fail(new AppError('INVALID_FILE_TYPE', { details: { extension } }));
        stream.resume();
        return;
      }
      fileInfo = { tempKey, originalFileName, extension, mimeType: rule.mime, kind: rule.kind };
      const hash = createHash('sha256');
      const out = createWriteStream(tempPath);
      let size = 0;
      let head = Buffer.alloc(0);

      fileDone = new Promise((resolveFile, rejectFile) => {
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          hash.update(chunk);
          if (head.length < SIGNATURE_BYTES) head = Buffer.concat([head, chunk]).subarray(0, SIGNATURE_BYTES);
        });
        stream.on('limit', () => fail(new AppError('FILE_TOO_LARGE', { details: { maxBytes: options.maxBytes } })));
        stream.pipe(out);
        out.on('finish', () => {
          if (size === 0) fail(new AppError('UPLOAD_FAILED', { details: { reason: 'EMPTY_FILE' } }));
          else if (!matchesSignature(head, rule.signature)) {
            fail(new AppError('INVALID_FILE_TYPE', { details: { extension, reason: 'CONTENT_MISMATCH' } }));
          }
          resolveFile({ sizeBytes: size, sha256: hash.digest('hex') });
        });
        out.on('error', rejectFile);
      });
    });

    parser.on('error', () => fail(new AppError('UPLOAD_FAILED')));

    parser.on('close', () => {
      void (async () => {
        try {
          const stats = fileDone ? await fileDone : null;
          if (!failure && (!fileInfo || !stats)) {
            fail(new AppError('VALIDATION_ERROR', { details: { reason: 'FILE_REQUIRED' } }));
          }
          if (failure) {
            await fs.rm(tempPath, { force: true });
            reject(failure);
            return;
          }
          resolve({ fields, file: { ...fileInfo!, ...stats! } });
        } catch (error) {
          await fs.rm(tempPath, { force: true });
          reject(new AppError('UPLOAD_FAILED', { cause: error }));
        }
      })();
    });

    req.on('aborted', () => fail(new AppError('UPLOAD_FAILED', { details: { reason: 'CLIENT_ABORTED' } })));
    req.pipe(parser);
  });
}

/** Moves a received temp file to its permanent storage key. */
export async function commitReceivedFile(file: ReceivedFile, destinationKey: string): Promise<void> {
  const destination = resolveStorageKey(destinationKey);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(resolveStorageKey(file.tempKey), destination);
}

export async function discardReceivedFile(file: ReceivedFile): Promise<void> {
  await fs.rm(resolveStorageKey(file.tempKey), { force: true });
}
