import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Database target selection, shared by the app, the migrator, drizzle-kit and
 * scripts. Deliberately independent of `env.ts` so tooling can resolve the
 * connection without the full application config.
 *
 *   DATABASE_URL           explicit URL; overrides everything (tests, containers, CI)
 *   DB_TARGET=local|live   otherwise picks DATABASE_URL_LOCAL or DATABASE_URL_LIVE
 *   DATABASE_SSL           auto (default: on for live) | true | false
 *   DATABASE_SSL_CA        optional CA bundle path (needed for TiDB Dedicated, not Serverless)
 */
export type DatabaseTarget = 'local' | 'live' | 'custom';

export interface DatabaseConfig {
  target: DatabaseTarget;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: { minVersion: 'TLSv1.2'; rejectUnauthorized: true; ca?: string } | undefined;
  poolSize: number;
}

const schema = z.object({
  DATABASE_URL: z.string().optional(),
  DB_TARGET: z.enum(['local', 'live']).default('local'),
  DATABASE_URL_LOCAL: z.string().optional(),
  DATABASE_URL_LIVE: z.string().optional(),
  DATABASE_SSL: z.enum(['auto', 'true', 'false']).default('auto'),
  DATABASE_SSL_CA: z.string().optional(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
});

const blankToUndefined = (source: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v?.trim() ? v.trim() : undefined]));

export function resolveDatabaseConfig(source: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = schema.safeParse(blankToUndefined(source));
  if (!parsed.success) {
    throw new Error(`Invalid database configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  const cfg = parsed.data;

  const target: DatabaseTarget = cfg.DATABASE_URL ? 'custom' : cfg.DB_TARGET;
  const raw = cfg.DATABASE_URL ?? (target === 'live' ? cfg.DATABASE_URL_LIVE : cfg.DATABASE_URL_LOCAL);
  if (!raw) {
    const missing = target === 'live' ? 'DATABASE_URL_LIVE' : 'DATABASE_URL_LOCAL';
    throw new Error(`DB_TARGET=${cfg.DB_TARGET} but ${missing} is not set`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Database URL for target "${target}" is not a valid URL`);
  }
  if (url.protocol !== 'mysql:') throw new Error(`Database URL must start with mysql:// (got ${url.protocol})`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error(`Database URL for target "${target}" has no database name`);

  // TLS: explicit setting wins; otherwise on for live, and honoured if the URL asks for it
  // (TiDB Cloud connection strings carry ?ssl=... or ?sslaccept=strict).
  const urlWantsTls = url.searchParams.has('ssl') || url.searchParams.get('sslaccept') === 'strict';
  const useTls = cfg.DATABASE_SSL === 'auto' ? target === 'live' || urlWantsTls : cfg.DATABASE_SSL === 'true';

  return {
    target,
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: useTls
      ? {
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
          ...(cfg.DATABASE_SSL_CA && { ca: readFileSync(cfg.DATABASE_SSL_CA, 'utf8') }),
        }
      : undefined,
    poolSize: cfg.DATABASE_POOL_SIZE,
  };
}

/** Human-readable target for logs; never includes credentials. */
export function describeDatabase(cfg: DatabaseConfig): string {
  return `${cfg.target} → ${cfg.host}:${cfg.port}/${cfg.database}${cfg.ssl ? ' (TLS)' : ''}`;
}
