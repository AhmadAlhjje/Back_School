import type { FileKind } from '../../generated/prisma/enums.js';

/**
 * Allow-list of uploadable educational file types. Each extension declares its kind, MIME type
 * and the magic-byte signature its content must start with, so a renamed executable cannot
 * pass as a PDF.
 */
type Signature = 'pdf' | 'zip' | 'ole' | 'rar' | 'png' | 'jpeg' | 'gif' | 'webp' | 'text';

interface FileTypeRule {
  kind: FileKind;
  mime: string;
  signature: Signature;
}

export const EDUCATIONAL_FILE_TYPES: Record<string, FileTypeRule> = {
  pdf: { kind: 'PDF', mime: 'application/pdf', signature: 'pdf' },
  doc: { kind: 'DOCUMENT', mime: 'application/msword', signature: 'ole' },
  docx: {
    kind: 'DOCUMENT',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signature: 'zip',
  },
  txt: { kind: 'DOCUMENT', mime: 'text/plain', signature: 'text' },
  ppt: { kind: 'PRESENTATION', mime: 'application/vnd.ms-powerpoint', signature: 'ole' },
  pptx: {
    kind: 'PRESENTATION',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    signature: 'zip',
  },
  xls: { kind: 'SPREADSHEET', mime: 'application/vnd.ms-excel', signature: 'ole' },
  xlsx: {
    kind: 'SPREADSHEET',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    signature: 'zip',
  },
  zip: { kind: 'ARCHIVE', mime: 'application/zip', signature: 'zip' },
  rar: { kind: 'ARCHIVE', mime: 'application/vnd.rar', signature: 'rar' },
  png: { kind: 'IMAGE', mime: 'image/png', signature: 'png' },
  jpg: { kind: 'IMAGE', mime: 'image/jpeg', signature: 'jpeg' },
  jpeg: { kind: 'IMAGE', mime: 'image/jpeg', signature: 'jpeg' },
  webp: { kind: 'IMAGE', mime: 'image/webp', signature: 'webp' },
  gif: { kind: 'IMAGE', mime: 'image/gif', signature: 'gif' },
};

export const TEACHER_IMAGE_TYPES: Record<string, FileTypeRule> = {
  png: EDUCATIONAL_FILE_TYPES.png!,
  jpg: EDUCATIONAL_FILE_TYPES.jpg!,
  jpeg: EDUCATIONAL_FILE_TYPES.jpeg!,
  webp: EDUCATIONAL_FILE_TYPES.webp!,
};

export const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi']);

export function fileExtension(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return match ? match[1]!.toLowerCase() : '';
}

const startsWith = (head: Buffer, bytes: number[], offset = 0) => bytes.every((byte, i) => head[offset + i] === byte);

/** Checks the first bytes of a file against the expected signature. */
export function matchesSignature(head: Buffer, signature: Signature): boolean {
  switch (signature) {
    case 'pdf':
      return startsWith(head, [0x25, 0x50, 0x44, 0x46]); // %PDF
    case 'zip':
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]);
    case 'ole':
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'rar':
      return startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]); // Rar!
    case 'png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'gif':
      return startsWith(head, [0x47, 0x49, 0x46, 0x38]); // GIF8
    case 'webp':
      return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8);
    case 'text':
      // No NUL bytes in the first block → plausibly text.
      return !head.includes(0x00);
  }
}
