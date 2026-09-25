import type { ContentFile } from '../../generated/prisma/client.js';

/** File metadata for dashboards. The private storage key is never exposed. */
export function toStaffFileDto(file: ContentFile) {
  const { storageKey: _storageKey, sha256: _sha256, ...rest } = file;
  return rest;
}

/** File metadata for students (no internal identifiers of parents). */
export function toStudentFileDto(file: ContentFile) {
  return {
    id: file.id,
    title: file.title,
    kind: file.kind,
    extension: file.extension,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sortOrder: file.sortOrder,
    createdAt: file.createdAt,
  };
}
