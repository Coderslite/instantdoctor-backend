import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('*'),
  PUBLIC_BASE_URL: z.url().default('http://localhost:4000'),

  // Database selection lives in ./database.ts (DB_TARGET, DATABASE_URL_LOCAL/LIVE, ...).

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Push notifications (FCM) and Firestore migration share this service account.
  FIREBASE_SERVICE_ACCOUNT_PATH: optionalString,

  // Web API key of the legacy Firebase project; enables lazy password migration at login.
  FIREBASE_WEB_API_KEY: optionalString,

  MAIL_DRIVER: z.enum(['smtp', 'log']).default('log'),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: bool.default(true),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: z.string().default('Instant Doctor <no-reply@instantdoctor.co>'),
  MAIL_REPLY_TO: z.string().default('support@instantdoctor.co'),
  OPS_EMAIL: z.string().default('activities@instantdoctor.co'),
  MAIL_LOGO_URL: z.url().default('https://instantdoctor.co/images/logo.png'),
  WEBSITE_URL: z.url().default('https://instantdoctor.co'),
  /** Matches REVALIDATE_SECRET on the website; when set, blog changes refresh the site's cache at once. */
  WEBSITE_REVALIDATE_SECRET: optionalString,

  GOOGLE_CLIENT_IDS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  APPLE_CLIENT_IDS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  PAYSTACK_SECRET_KEY: optionalString,
  FLUTTERWAVE_SECRET_KEY: optionalString,
  FLUTTERWAVE_WEBHOOK_HASH: optionalString,
  PAYMENT_REDIRECT_URL: z.url().default('https://instantdoctor.co/payment/complete'),

  EXCHANGE_RATE_URL: z.url().default('https://open.er-api.com/v6/latest/USD'),
  EXCHANGE_RATE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  TRIAL_DOCTOR_ID: z.string().default('p3rzihnMKVQVU6pIroy1nQ5anXK2'),
  // An unpaid appointment holds the doctor's slot for this long before it stops blocking others.
  BOOKING_HOLD_MINUTES: z.coerce.number().int().positive().default(30),
  BOOKING_MIN_LEAD_MINUTES: z.coerce.number().int().nonnegative().default(5),

  /** `local` writes to UPLOAD_DIR and serves /files; `r2` stores in Cloudflare R2. */
  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  R2_ACCOUNT_ID: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET: optionalString,
  R2_PUBLIC_BUCKET: optionalString,
  R2_PRIVATE_BUCKET: optionalString,
  /** Public base URL of the bucket: a custom domain (https://files.instantdoctor.co) or its r2.dev URL. */
  R2_PUBLIC_URL: z.url().optional(),
  /** Overrides the R2 endpoint (any S3-compatible store, e.g. MinIO for local testing). */
  R2_ENDPOINT: z.url().optional(),
  UPLOAD_DIR: z.string().default('uploads'),
  FILE_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(3600),
  /** Lifetime of a presigned direct-upload URL. */
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

  ENABLE_PUSH: bool.default(true),
  /** The sole doctor permitted to receive FCM pushes from a test database. */
  TEST_DOCTOR_PUSH_EMAIL: z.string().email().default('doc@mailinator.com'),
  /** Serve Swagger UI at /docs and the spec at /openapi.json. */
  API_DOCS_ENABLED: bool.default(true),
}).superRefine((cfg, ctx) => {
  if (cfg.MAIL_DRIVER === 'smtp') {
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const) {
      if (!cfg[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when MAIL_DRIVER=smtp' });
    }
  }
  if (cfg.STORAGE_DRIVER !== 'r2') return;
  const required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PRIVATE_BUCKET', 'R2_PUBLIC_URL'] as const;
  for (const key of required) {
    if (!cfg[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when STORAGE_DRIVER=r2' });
  }
  if (!cfg.R2_PUBLIC_BUCKET && !cfg.R2_BUCKET) {
    ctx.addIssue({ code: 'custom', path: ['R2_PUBLIC_BUCKET'], message: 'required when STORAGE_DRIVER=r2' });
  }
  if ((cfg.R2_PUBLIC_BUCKET ?? cfg.R2_BUCKET) === cfg.R2_PRIVATE_BUCKET) {
    ctx.addIssue({ code: 'custom', path: ['R2_PRIVATE_BUCKET'], message: 'must differ from the public bucket' });
  }
  if (!cfg.R2_ACCOUNT_ID && !cfg.R2_ENDPOINT) {
    ctx.addIssue({ code: 'custom', path: ['R2_ACCOUNT_ID'], message: 'required when STORAGE_DRIVER=r2 (or set R2_ENDPOINT)' });
  }
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const source = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${details.join('\n')}`);
  }
  return parsed.data;
}

export const env = load();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const corsOrigin: true | string[] =
  env.CORS_ORIGINS.trim() === '*'
    ? true
    : env.CORS_ORIGINS.split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
