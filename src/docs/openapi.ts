import { z } from 'zod';
import { config } from '../config/env.js';
import { ERROR_DEFINITIONS } from '../core/errors/error-codes.js';
import { routeRegistry, type RegisteredRoute } from '../core/http/route.js';

/**
 * Builds the OpenAPI 3.1 document from the live route registry, so documentation cannot drift
 * from the implementation: request schemas are the same Zod schemas used for validation, and
 * the roles listed are the roles enforced.
 */

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodType): JsonSchema {
  try {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchema;
    return rest;
  } catch {
    return { type: 'object' };
  }
}

function parametersFrom(schema: z.ZodType | undefined, location: 'path' | 'query') {
  if (!schema) return [];
  const json = toJsonSchema(schema);
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: property,
  }));
}

function requestBody(route: RegisteredRoute) {
  if (route.bodyKind === 'binary') {
    return {
      required: true,
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    };
  }
  if (route.bodyKind === 'multipart') {
    return {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              file: { type: 'string', format: 'binary' },
              ...((route.body ? toJsonSchema(route.body).properties : {}) as object),
            },
          },
        },
      },
    };
  }
  if (!route.body) return undefined;
  return { required: true, content: { 'application/json': { schema: toJsonSchema(route.body) } } };
}

function accessDescription(route: RegisteredRoute): string {
  if (route.access === 'public') return '**Access:** public';
  if (route.access === 'media-token')
    return '**Access:** signed media token (`?token=`) issued by a playback/file grant';
  return `**Roles:** ${route.access.join(', ')}`;
}

function security(route: RegisteredRoute) {
  if (route.access === 'public') return [];
  if (route.access === 'media-token') return [{ mediaToken: [] }];
  return [{ bearerAuth: [] }];
}

const errorResponse = { $ref: '#/components/responses/Error' };

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routeRegistry) {
    const openApiPath = route.fullPath.replace(/:(\w+)/g, '{$1}');
    paths[openApiPath] ??= {};
    paths[openApiPath][route.method] = {
      tags: [route.tag],
      summary: route.summary,
      description: [accessDescription(route), route.description].filter(Boolean).join('\n\n'),
      security: security(route),
      parameters: [...parametersFrom(route.params, 'path'), ...parametersFrom(route.query, 'query')],
      requestBody: requestBody(route),
      responses: {
        [String(route.successStatus)]: { $ref: '#/components/responses/Success' },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        409: errorResponse,
        429: errorResponse,
        500: errorResponse,
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Educational Institute Platform API',
      version: '1.0.0',
      description: [
        'All responses use the envelope `{ success, data, message, meta }` (errors: `{ success: false, data: null, message, error: { code, details } }`).',
        'Lists return `data = { items, page, limit, total, totalPages }`.',
        'Student app requests must send `X-Device-Id` (the bound device identifier).',
        'Messages default to Arabic; send `Accept-Language: en` for English.',
      ].join('\n\n'),
    },
    servers: [{ url: config.apiBaseUrl }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        mediaToken: { type: 'apiKey', in: 'query', name: 'token' },
      },
      schemas: {
        ErrorCode: {
          type: 'string',
          enum: Object.keys(ERROR_DEFINITIONS),
          description: Object.entries(ERROR_DEFINITIONS)
            .map(([code, def]) => `- \`${code}\` (${def.status}): ${def.en}`)
            .join('\n'),
        },
        SuccessEnvelope: {
          type: 'object',
          properties: {
            success: { const: true },
            data: {},
            message: { type: ['string', 'null'] },
            meta: { type: ['object', 'null'] },
          },
        },
        ErrorEnvelope: {
          type: 'object',
          properties: {
            success: { const: false },
            data: { type: 'null' },
            message: { type: 'string' },
            error: {
              type: 'object',
              properties: { code: { $ref: '#/components/schemas/ErrorCode' }, details: {} },
            },
          },
        },
      },
      responses: {
        Success: {
          description: 'Success',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } } },
        },
        Error: {
          description: 'Error — see ErrorCode',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
        },
      },
    },
  };
}
