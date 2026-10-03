import { resolve } from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { pinoHttp } from 'pino-http';
import { sql } from 'drizzle-orm';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { newId } from './lib/ids.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { webhooksRouter } from './modules/payments/payments.routes.js';
import { buildOpenApiDocument } from './docs/openapi.js';
import { apiRouter } from './routes.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? newId();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',') }));

  // Webhooks need the raw body for signature verification: mount before JSON parsing.
  app.use('/v1/webhooks', webhooksRouter);

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    await db.execute(sql`SELECT 1`);
    res.json({ status: 'ok' });
  });

  if (env.API_DOCS_ENABLED) {
    const spec = buildOpenApiDocument(env.PUBLIC_BASE_URL);
    app.get('/openapi.json', (_req, res) => {
      res.json(spec);
    });
    app.use(
      '/docs',
      swaggerUi.serve,
      swaggerUi.setup(spec, {
        customSiteTitle: 'Instant Doctor API',
        swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: false },
      }),
    );
  }

  app.use('/files', express.static(resolve(env.UPLOAD_DIR), { maxAge: '7d', index: false }));
  app.use('/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
