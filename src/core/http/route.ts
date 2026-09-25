import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { z } from 'zod';
import type { UserRole } from '../../generated/prisma/enums.js';
import type { AuthContext } from '../auth/auth-context.js';
import { authenticate, authorize } from '../auth/authenticate.js';
import { AppError } from '../errors/app-error.js';

/**
 * Declarative route definitions.
 *
 * Every endpoint states who may call it (`roles`, or explicitly `public` / `media-token`),
 * and its params/query/body schemas. The same declaration is used to:
 *   1. build the Express route (auth → role check → validation → handler → envelope),
 *   2. generate the OpenAPI document (see src/docs/openapi.ts).
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type BodyKind = 'json' | 'multipart' | 'binary';

/** Returned by handlers that wrote the response themselves (streams, files, playlists). */
export const RESPONSE_SENT = Symbol('RESPONSE_SENT');

type Schema = z.ZodType | undefined;
type Output<S extends Schema> = S extends z.ZodType ? z.output<S> : Record<string, never>;

interface SpecBase<P extends Schema, Q extends Schema, B extends Schema> {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  params?: P;
  query?: Q;
  body?: B;
  bodyKind?: BodyKind;
  /** Extra middleware run after authorization and before validation (e.g. rate limiters). */
  middleware?: RequestHandler[];
  successStatus?: number;
}

export interface HandlerContext<P, Q, B> {
  req: Request;
  res: Response;
  params: P;
  query: Q;
  body: B;
}

export interface AuthedHandlerContext<P, Q, B> extends HandlerContext<P, Q, B> {
  auth: AuthContext;
}

export type RouteAccess = readonly UserRole[] | 'public' | 'media-token';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  access: RouteAccess;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  bodyKind: BodyKind;
  successStatus: number;
  handlers: RequestHandler[];
}

function parseOrThrow(schema: z.ZodType | undefined, input: unknown, location: string): unknown {
  if (!schema) return {};
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', {
      details: result.error.issues.map((issue) => ({
        location,
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    });
  }
  return result.data;
}

function executor(
  spec: SpecBase<Schema, Schema, Schema>,
  handler: (ctx: HandlerContext<unknown, unknown, unknown> & { auth?: AuthContext }) => Promise<unknown>,
): RequestHandler {
  const status = spec.successStatus ?? 200;
  const parsesJsonBody = (spec.bodyKind ?? 'json') === 'json';
  return async (req, res) => {
    const params = parseOrThrow(spec.params, req.params, 'params');
    const query = parseOrThrow(spec.query, req.query, 'query');
    const body = parsesJsonBody ? parseOrThrow(spec.body, req.body, 'body') : {};
    const result = await handler({ req, res, params, query, body, auth: req.auth });
    if (result === RESPONSE_SENT || res.headersSent) return;
    res.status(status).json({ success: true, data: result ?? null, message: null, meta: null });
  };
}

/** An authenticated route restricted to the given roles. */
export function route<
  P extends Schema = undefined,
  Q extends Schema = undefined,
  B extends Schema = undefined,
>(
  spec: SpecBase<P, Q, B> & {
    roles: readonly UserRole[];
    handler: (ctx: AuthedHandlerContext<Output<P>, Output<Q>, Output<B>>) => Promise<unknown>;
  },
): RouteDefinition {
  if (spec.roles.length === 0)
    throw new Error(`Route ${spec.method} ${spec.path} must allow at least one role`);
  const run = executor(spec, (ctx) => {
    if (!ctx.auth) throw new AppError('UNAUTHENTICATED');
    return spec.handler(ctx as AuthedHandlerContext<Output<P>, Output<Q>, Output<B>>);
  });
  return {
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    description: spec.description,
    access: spec.roles,
    params: spec.params,
    query: spec.query,
    body: spec.body,
    bodyKind: spec.bodyKind ?? 'json',
    successStatus: spec.successStatus ?? 200,
    handlers: [authenticate, authorize(spec.roles), ...(spec.middleware ?? []), run],
  };
}

/**
 * A route without bearer authentication: either fully `public` (login, health), or
 * `media-token` (authorization comes from a signed, short-lived media token in the URL).
 */
export function openRoute<
  P extends Schema = undefined,
  Q extends Schema = undefined,
  B extends Schema = undefined,
>(
  spec: SpecBase<P, Q, B> & {
    access: 'public' | 'media-token';
    handler: (ctx: HandlerContext<Output<P>, Output<Q>, Output<B>>) => Promise<unknown>;
  },
): RouteDefinition {
  const run = executor(spec, (ctx) => spec.handler(ctx as HandlerContext<Output<P>, Output<Q>, Output<B>>));
  return {
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    description: spec.description,
    access: spec.access,
    params: spec.params,
    query: spec.query,
    body: spec.body,
    bodyKind: spec.bodyKind ?? 'json',
    successStatus: spec.successStatus ?? 200,
    handlers: [...(spec.middleware ?? []), run],
  };
}

export interface ApiModule {
  /** Mount path relative to /api/v1, e.g. "/students". */
  prefix: string;
  /** OpenAPI tag. */
  tag: string;
  routes: RouteDefinition[];
}

export interface RegisteredRoute extends RouteDefinition {
  fullPath: string;
  tag: string;
}

/** Registry of every mounted route; consumed by the OpenAPI generator and tests. */
export const routeRegistry: RegisteredRoute[] = [];

export function buildApiRouter(basePath: string, modules: ApiModule[]): Router {
  const router = Router();
  routeRegistry.length = 0;
  for (const module of modules) {
    for (const definition of module.routes) {
      const path = `${module.prefix}${definition.path}`.replace(/\/+$/, '') || '/';
      router[definition.method](path, ...definition.handlers);
      routeRegistry.push({ ...definition, fullPath: `${basePath}${path}`, tag: module.tag });
    }
  }
  return router;
}
