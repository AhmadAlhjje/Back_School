import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { config } from './config/env.js';
import { errorHandler, notFoundHandler } from './core/errors/error-handler.js';
import { buildApiRouter } from './core/http/route.js';
import { logger, redactUrl } from './core/logger/logger.js';
import { buildOpenApiDocument } from './docs/openapi.js';
import { healthRouter } from './routes/health.js';
import { apiModules } from './routes/api-modules.js';

export const API_PREFIX = '/api/v1';

/** BigInt columns (file sizes) are serialized as JSON numbers. */
function jsonReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? Number(value) : value;
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('json replacer', jsonReplacer);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: {
        ignore: (req) => req.url?.startsWith('/health') === true || /\.(ts|m3u8)(\?|$)/.test(req.url ?? ''),
      },
    }),
  );

  app.use(
    helmet({
      // Media and teacher images are consumed by the app and by dashboards on other origins.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const allowedOrigins = new Set(config.corsOrigins);
  app.use(
    cors({
      origin: (origin, callback) => {
        // Native apps and server-to-server calls send no Origin header.
        callback(null, !origin || allowedOrigins.has(origin));
      },
      credentials: true,
      exposedHeaders: ['x-request-id', 'content-disposition', 'ratelimit', 'ratelimit-policy'],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/health', healthRouter);
  app.use(API_PREFIX, buildApiRouter(API_PREFIX, apiModules));

  if (config.enableApiDocs) {
    const document = buildOpenApiDocument();
    app.get('/api/docs/openapi.json', (_req, res) => {
      res.json(document);
    });
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'Edu Platform API' }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
