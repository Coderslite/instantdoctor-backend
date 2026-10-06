import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { pinoHttp } from 'pino-http';
import { sql } from 'drizzle-orm';
import { corsOrigin, env } from './config/env.js';
import { db } from './db/client.js';
import { newId } from './lib/ids.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { webhooksRouter } from './modules/payments/payments.routes.js';
import { buildOpenApiDocument } from './docs/openapi.js';
import { localPath, verifyLocalSignature, verifyLocalUpload } from './integrations/storage.js';
import { MAX_UPLOAD_BYTES } from './modules/files/file-policies.js';
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
  app.use(cors({ origin: corsOrigin }));

  // Webhooks need the raw body for signature verification: mount before JSON parsing.
  app.use('/api/v1/webhooks', webhooksRouter);

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
        swaggerOptions: {
          persistAuthorization: true,
          displayRequestDuration: true,
          tryItOutEnabled: false,
        },
      }),
    );
  }

  app.use(
    '/files/public',
    express.static(resolve(env.UPLOAD_DIR, 'public'), {
      maxAge: '365d',
      immutable: true,
      index: false,
    }),
  );
  if (env.STORAGE_DRIVER === 'local') {
    // Development stand-in for a presigned R2 PUT (see storage.presignUpload): same contract, signed the same way.
    app.put(
      /^\/files\/upload\/(.+)$/,
      express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
      async (req, res) => {
        const key = String(req.params[0] ?? '');
        const planned = {
          key,
          visibility:
            req.query.visibility === 'public' ? ('public' as const) : ('private' as const),
          contentType: String(req.query.type ?? ''),
          size: Number(req.query.size),
        };
        const valid =
          !key.includes('..') &&
          verifyLocalUpload(
            planned,
            Number(req.query.expires),
            String(req.query.signature ?? ''),
          ) &&
          req.headers['content-type'] === planned.contentType &&
          Buffer.isBuffer(req.body) &&
          req.body.length === planned.size;
        if (!valid) {
          res
            .status(403)
            .json({
              error: {
                code: 'FORBIDDEN',
                message: 'Upload URL invalid or expired, or the file does not match it',
              },
            });
          return;
        }
        const path = localPath(planned.visibility, key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, req.body);
        res.status(200).end();
      },
    );
  }
  app.get(/^\/files\/private\/(.+)$/, (req, res) => {
    const key = String(req.params[0] ?? '');
    const expires = Number(req.query.expires);
    const signature = String(req.query.signature ?? '');
    if (key.includes('..') || !verifyLocalSignature(key, expires, signature)) {
      res
        .status(403)
        .json({ error: { code: 'FORBIDDEN', message: 'This link is invalid or has expired' } });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(localPath('private', key), (err) => {
      if (err && !res.headersSent)
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    });
  });
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
