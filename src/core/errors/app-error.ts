import { ERROR_DEFINITIONS, type ErrorCode } from './error-codes.js';

/** An expected, client-facing error with a stable code. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, options: { details?: unknown; message?: string; cause?: unknown } = {}) {
    super(options.message ?? code, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_DEFINITIONS[code].status;
    this.details = options.details ?? null;
  }
}

export const notFound = (entity: string) => new AppError('NOT_FOUND', { details: { entity } });
