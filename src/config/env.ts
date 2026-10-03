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

  // Existing mail service (instantdoctorapi /mail/*). Mail stays there; this service calls it.
  MAIL_SERVICE_URL: optionalString,

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

  UPLOAD_DIR: z.string().default('uploads'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),

  ENABLE_PUSH: bool.default(true),
  /** Serve Swagger UI at /docs and the spec at /openapi.json. */
  API_DOCS_ENABLED: bool.default(true),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${details.join('\n')}`);
  }
  return parsed.data;
}

export const env = load();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
