import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../logger/logger.js';
import { AppError } from './app-error.js';
import { errorMessage, type ErrorCode, type Locale } from './error-codes.js';

export function requestLocale(req: Request): Locale {
  return req.acceptsLanguages('ar', 'en') === 'en' ? 'en' : 'ar';
}

function fromZod(error: ZodError): AppError {
  return new AppError('VALIDATION_ERROR', {
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    })),
  });
}

function fromPrisma(error: Prisma.PrismaClientKnownRequestError): AppError | null {
  switch (error.code) {
    case 'P2002':
      return new AppError('CONFLICT', { details: { target: error.meta?.target ?? null } });
    case 'P2025':
      return new AppError('NOT_FOUND');
    case 'P2003':
      return new AppError('CONFLICT', { details: { reason: 'RELATION_CONSTRAINT' } });
    default:
      return null;
  }
}

interface BodyParserError {
  type?: string;
  status?: number;
}

function fromBodyParser(error: BodyParserError): AppError | null {
  if (error.type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE');
  if (error.type === 'entity.parse.failed') {
    return new AppError('VALIDATION_ERROR', { details: { reason: 'MALFORMED_JSON' } });
  }
  return null;
}

function normalize(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return fromZod(error);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = fromPrisma(error);
    if (mapped) return mapped;
  }
  if (error && typeof error === 'object') {
    const mapped = fromBodyParser(error);
    if (mapped) return mapped;
  }
  return new AppError('INTERNAL_ERROR', { cause: error });
}

export function sendError(
  req: Request,
  res: Parameters<RequestHandler>[1],
  code: ErrorCode,
  details: unknown = null,
) {
  res.status(new AppError(code).status).json({
    success: false,
    data: null,
    message: errorMessage(code, requestLocale(req)),
    error: { code, details },
  });
}

/** Final error middleware: logs unexpected failures and returns the uniform error envelope. */
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const appError = normalize(error);
  if (appError.status >= 500) {
    logger.error({ err: error, method: req.method, path: req.path }, 'Unhandled request error');
  }
  res.status(appError.status).json({
    success: false,
    data: null,
    message: errorMessage(appError.code, requestLocale(req)),
    error: {
      code: appError.code,
      // Internal errors never leak implementation details to clients.
      details: appError.status >= 500 ? null : appError.details,
    },
  });
};

export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(req, res, 'ROUTE_NOT_FOUND');
};
