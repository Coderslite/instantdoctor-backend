import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { PAYMENT_PROVIDERS } from '../db/schema/index.js';
import { paginationQuery } from '../lib/pagination.js';
import { askQuestionSchema } from '../modules/anonymous/anonymous.schemas.js';
import * as blog from '../modules/blog/blog.schemas.js';
import * as mailCenter from '../modules/mail-center/mail-center.schemas.js';
import * as hmo from '../modules/hmo/hmo.schemas.js';
import * as hmoPortal from '../modules/hmo-portal/hmo-portal.schemas.js';
import * as appointments from '../modules/appointments/appointments.schemas.js';
import * as auth from '../modules/auth/auth.schemas.js';
import { listDoctorsQuery } from '../modules/doctors/doctors.schemas.js';
import { listTipsQuery } from '../modules/health-tips/health-tips.schemas.js';
import { createLabResultSchema } from '../modules/lab-results/lab-results.schemas.js';
import * as medications from '../modules/medications/medications.schemas.js';
import * as carePlans from '../modules/care-plans/care-plans.schemas.js';
import * as family from '../modules/family/family.schemas.js';
import { initializePaymentSchema } from '../modules/payments/payments.service.js';
import * as pharmacy from '../modules/pharmacy/pharmacy.schemas.js';
import * as pharmacyPortal from '../modules/pharmacy-portal/pharmacy-portal.schemas.js';
import * as payoutSchemas from '../modules/payouts/payouts.schemas.js';
import { feePolicyInputSchema } from '../modules/pricing/fees.js';
import { listReferralsQuery } from '../modules/referrals/referrals.schemas.js';
import * as reports from '../modules/reports/reports.schemas.js';
import { FILE_POLICIES, FILE_PURPOSES } from '../modules/files/file-policies.js';
import { presignUploadSchema, uploadDocSchema } from '../modules/files/files.schemas.js';
import { certificateSchema } from '../modules/doctors/doctors.schemas.js';
import * as users from '../modules/users/users.schemas.js';
import { submitApplicationSchema } from '../modules/doctor-applications/doctor-applications.schemas.js';
import { joinWaitlistSchema, waitlistStatusQuery } from '../modules/waitlist/waitlist.schemas.js';
import { listTransactionsQuery, transferSchema } from '../modules/wallet/wallet.schemas.js';
import * as c from './components.js';

const registry = new OpenAPIRegistry();

const PURPOSE_TABLE = [
  '| Purpose | Who can upload | Visibility | Max size |',
  '| --- | --- | --- | --- |',
  ...FILE_PURPOSES.map((purpose) => {
    const policy = FILE_POLICIES[purpose];
    return `| \`${purpose}\` | ${policy.uploaders.join(', ')} | ${policy.visibility} | ${Math.round(policy.maxBytes / 1024 / 1024)} MB |`;
  }),
].join('\n');

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Access token from /auth/login, /auth/register/verify, /auth/google, /auth/apple or /auth/refresh.',
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Body = z.ZodType | { multipart: z.ZodType };

interface Operation {
  tag: string;
  summary: string;
  description?: string;
  /** Defaults to true. */
  auth?: boolean;
  /** Restricts the route to a role (documented, enforced by the handler). */
  role?: 'user' | 'doctor';
  idempotent?: boolean;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: Body;
  /** Success responses by status; `null` means no body. */
  ok: Record<number, z.ZodType | null>;
  /** Error codes this operation can return, documented on the error responses. */
  errors?: Partial<Record<400 | 401 | 403 | 404 | 409 | 422 | 502 | 503, string>>;
}

const idParam = z.object({ id: z.string().meta({ example: 'E7lvcmYH7Ks38oEDCKm8' }) });
const referenceParam = z.object({
  reference: z.string().meta({ example: 'IDP_20261003_K7Q2M9XA4P' }),
});
const idempotencyHeader = z.object({
  'Idempotency-Key': z.string().min(8).max(128).meta({
    description:
      'Unique per user intent (e.g. a UUID created when the button is first tapped). Reuse it for every retry.',
    example: '3f1c9a8e-5b0d-4c1e-9a77-2f4d6b8c1e20',
  }),
});

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: c.ErrorResponse } },
});

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
};

/** Express path (`/:id`) -> OpenAPI path (`/{id}`). */
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');

/** All documented operations, keyed "METHOD /path" — used by the route-coverage test. */
export const documentedOperations = new Set<string>();

function op(method: Method, path: string, o: Operation) {
  const fullPath = path === '/health' ? path : `/api/v1${path}`;
  documentedOperations.add(`${method.toUpperCase()} ${fullPath}`);

  const responses: RouteConfig['responses'] = {};
  for (const [status, schema] of Object.entries(o.ok)) {
    responses[status] = schema
      ? {
          description: STATUS_TEXT[Number(status)] ?? 'Success',
          content: { 'application/json': { schema } },
        }
      : { description: STATUS_TEXT[Number(status)] ?? 'Success' };
  }
  const isAuthed = o.auth !== false;
  const errors: NonNullable<Operation['errors']> = {
    ...(o.body || o.query
      ? { 400: 'BAD_REQUEST — validation failed; `details` lists each field' }
      : {}),
    ...(isAuthed ? { 401: 'UNAUTHORIZED — missing or expired access token' } : {}),
    ...(o.role ? { 403: `FORBIDDEN — requires role "${o.role}"` } : {}),
    ...(o.idempotent
      ? {
          409: 'IDEMPOTENCY_IN_PROGRESS — the same key is still being processed (see Retry-After)',
          422: 'IDEMPOTENCY_KEY_REUSED — key already used with a different body',
        }
      : {}),
  };
  for (const [status, text] of Object.entries(o.errors ?? {})) {
    const key = Number(status) as keyof typeof errors;
    errors[key] = errors[key] ? `${errors[key]}; ${text}` : text;
  }
  for (const [status, text] of Object.entries(errors)) responses[status] = errorResponse(text);

  const body: NonNullable<RouteConfig['request']>['body'] =
    o.body === undefined
      ? undefined
      : 'multipart' in o.body
        ? { required: true, content: { 'multipart/form-data': { schema: o.body.multipart } } }
        : { required: true, content: { 'application/json': { schema: o.body } } };

  const notes = [
    o.description,
    o.role ? `**Role:** ${o.role}.` : undefined,
    o.idempotent
      ? '**Idempotent:** requires `Idempotency-Key`; a retry with the same key and body replays the original response with `Idempotent-Replayed: true`.'
      : undefined,
  ].filter(Boolean);

  registry.registerPath({
    method,
    path: toOpenApiPath(fullPath),
    tags: [o.tag],
    summary: o.summary,
    description: notes.length ? notes.join('\n\n') : undefined,
    security: isAuthed ? [{ bearerAuth: [] }] : [],
    request: {
      params: o.params,
      query: o.query,
      headers: o.idempotent ? idempotencyHeader : undefined,
      body,
    },
    responses,
  });
}

// ─── System ──────────────────────────────────────────────────────────────────

op('get', '/health', {
  tag: 'System',
  summary: 'Liveness + database check',
  auth: false,
  ok: { 200: z.object({ status: z.literal('ok') }) },
});

// ─── Auth ────────────────────────────────────────────────────────────────────

op('post', '/auth/check-email', {
  tag: 'Auth',
  summary: 'Check whether an email is free to register',
  auth: false,
  body: auth.checkEmailSchema,
  ok: { 200: c.Availability },
});
op('post', '/auth/register', {
  tag: 'Auth',
  summary: 'Sign up — step 1: create the account and email a verification code',
  description:
    'Creates the account as `pending_verification` and emails a 5-digit code (valid 10 minutes, 5 attempts). No session is returned yet — confirm the code with `POST /auth/register/verify`. Registering again with an email that is still pending replaces the earlier details and sends a new code.',
  auth: false,
  body: auth.registerSchema,
  ok: { 201: c.PendingRegistration },
  errors: {
    409: 'EMAIL_TAKEN — a verified account exists | OTP_RATE_LIMITED — retry after a minute',
  },
});
op('post', '/auth/register/verify', {
  tag: 'Auth',
  summary: 'Sign up — step 2: confirm the code; returns the user and a session',
  auth: false,
  body: auth.verifyRegistrationSchema,
  ok: { 200: c.AuthResult },
  errors: { 400: 'BAD_REQUEST — invalid or expired code', 409: 'ALREADY_VERIFIED' },
});
op('post', '/auth/register/resend', {
  tag: 'Auth',
  summary: 'Resend the sign-up verification code',
  description: 'Responds identically whether or not a sign-up is pending for the email.',
  auth: false,
  body: auth.emailOnlySchema,
  ok: { 202: z.object({ message: z.string() }) },
  errors: { 409: 'OTP_RATE_LIMITED' },
});
op('post', '/auth/login', {
  tag: 'Auth',
  summary: 'Sign in with email and password',
  description: 'Accounts migrated from Firebase sign in with their existing password.',
  auth: false,
  body: auth.loginSchema,
  ok: { 200: c.AuthResult },
  errors: {
    403: 'EMAIL_NOT_VERIFIED — sign-up not confirmed; call /auth/register/resend then /auth/register/verify',
  },
});
op('post', '/auth/google', {
  tag: 'Auth',
  summary: 'Sign in with a Google ID token',
  description:
    'Links by Google account id, then by verified email; otherwise creates an account (`isNewUser: true`).',
  auth: false,
  body: auth.googleSchema,
  ok: { 200: c.AuthResult },
  errors: { 503: 'SERVICE_UNAVAILABLE — Google sign-in not configured' },
});
op('post', '/auth/apple', {
  tag: 'Auth',
  summary: 'Sign in with an Apple identity token',
  description: 'Send `firstName`/`lastName` on first authorisation — Apple only reveals them once.',
  auth: false,
  body: auth.appleSchema,
  ok: { 200: c.AuthResult },
  errors: { 503: 'SERVICE_UNAVAILABLE — Apple sign-in not configured' },
});
op('post', '/auth/refresh', {
  tag: 'Auth',
  summary: 'Rotate the refresh token and get a new access token',
  description:
    'Each refresh token is single-use. Re-using an old one revokes the whole session family.',
  auth: false,
  body: auth.refreshSchema,
  ok: { 200: z.object({ session: c.Session }) },
});
op('post', '/auth/logout', {
  tag: 'Auth',
  summary: 'Revoke a refresh token',
  auth: false,
  body: auth.refreshSchema,
  ok: { 204: null },
});
op('post', '/auth/password/forgot', {
  tag: 'Auth',
  summary: 'Password reset — step 1: email a 5-digit reset code',
  description:
    'Responds identically whether or not the account exists. The code is valid for 10 minutes (5 attempts); at most one code per minute.',
  auth: false,
  body: auth.emailOnlySchema,
  ok: { 202: z.object({ message: z.string() }) },
  errors: { 409: 'OTP_RATE_LIMITED' },
});
op('post', '/auth/password/verify-code', {
  tag: 'Auth',
  summary: 'Password reset — step 2: verify the code, get a reset token',
  description:
    'Returns a single-use `resetToken` valid for 15 minutes. Show the new-password screen only after this succeeds.',
  auth: false,
  body: auth.verifyResetCodeSchema,
  ok: { 200: c.PasswordResetToken },
  errors: { 400: 'BAD_REQUEST — invalid or expired code' },
});
op('post', '/auth/password/reset', {
  tag: 'Auth',
  summary: 'Password reset — step 3: set the new password',
  description:
    'Consumes the reset token and signs the account out of every device. The user then logs in with the new password.',
  auth: false,
  body: auth.resetPasswordSchema,
  ok: { 204: null },
  errors: { 400: 'BAD_REQUEST — reset token expired or already used' },
});
op('post', '/auth/password/change', {
  tag: 'Auth',
  summary: 'Change password (signs out other sessions)',
  body: auth.changePasswordSchema,
  ok: { 204: null },
});

// ─── Users ───────────────────────────────────────────────────────────────────

op('get', '/users/me', { tag: 'Users', summary: 'My profile', ok: { 200: c.Me } });
op('patch', '/users/me', {
  tag: 'Users',
  summary: 'Update my profile, region, doctor earning currency and medical details',
  body: users.updateProfileSchema,
  ok: { 200: c.Me },
});
op('put', '/users/me/fcm-token', {
  tag: 'Users',
  summary: 'Register (or clear) this device’s FCM push token',
  body: users.fcmTokenSchema,
  ok: { 204: null },
});
op('put', '/users/me/presence', {
  tag: 'Users',
  summary: 'Set presence (online / offline / away)',
  body: users.presenceSchema,
  ok: { 204: null },
});
op('get', '/users/me/saved-locations', {
  tag: 'Users',
  summary: 'My saved delivery locations',
  ok: { 200: c.ItemsOf(c.SavedLocation, 'SavedLocation') },
});
op('post', '/users/me/saved-locations', {
  tag: 'Users',
  summary: 'Save a location',
  body: users.savedLocationSchema,
  ok: { 201: c.SavedLocation },
});
op('delete', '/users/me/saved-locations/:id', {
  tag: 'Users',
  summary: 'Delete a saved location',
  params: idParam,
  ok: { 204: null },
});
op('get', '/users/tags/:tag/availability', {
  tag: 'Users',
  summary: 'Is a referral username free?',
  params: users.tagSchema,
  ok: { 200: c.Availability },
});
op('post', '/users/me/referral-program', {
  tag: 'Users',
  summary: 'Join the referral programme with a username',
  body: users.tagSchema,
  ok: { 200: c.Me },
  errors: { 409: 'TAG_TAKEN' },
});
op('get', '/users/me/payout-account', {
  tag: 'Users',
  summary: 'My payout bank account',
  ok: { 200: c.PayoutAccount },
  errors: { 404: 'NOT_FOUND — no payout account saved yet' },
});
op('put', '/users/me/payout-account', {
  tag: 'Users',
  summary: 'Save or replace my payout bank account',
  body: users.payoutAccountSchema,
  ok: { 200: c.PayoutAccount },
});
op('delete', '/users/me/payout-account', {
  tag: 'Users',
  summary: 'Remove my payout bank account',
  ok: { 204: null },
});
op('get', '/users/me/referral', {
  tag: 'Users',
  summary: 'Who referred me, and whether I can still enter a referral code',
  ok: { 200: c.MyReferral },
});
op('post', '/users/me/referral', {
  tag: 'Users',
  summary: 'Enter a referral code after sign-up',
  description:
    'For users who signed up without a code (e.g. via Google/Apple). Allowed once, within 7 days of sign-up and before the first paid consultation — the referrer earns their commission on that consultation.',
  body: users.applyReferralSchema,
  ok: { 200: c.MyReferral },
  errors: {
    400: 'Unknown code, or your own code',
    409: 'ALREADY_REFERRED',
    422: 'REFERRAL_WINDOW_CLOSED',
  },
});
op('get', '/users/:id', {
  tag: 'Users',
  summary: 'Public summary of a user',
  description:
    'Doctors are visible to everyone; patients only to doctors they share an appointment with.',
  params: idParam,
  ok: { 200: c.UserSummary },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND' },
});

// ─── Doctors ─────────────────────────────────────────────────────────────────

op('get', '/doctors', {
  tag: 'Doctors',
  summary: 'Available doctors, most recently active first',
  query: listDoctorsQuery,
  ok: { 200: c.ItemsOf(c.Doctor, 'Doctor') },
});
op('get', '/doctors/least-busy', {
  tag: 'Doctors',
  summary: 'Active doctor with the fewest consultations in the last 24h',
  ok: { 200: c.Doctor },
  errors: { 404: 'NOT_FOUND — nobody available' },
});
op('get', '/doctors/:id', {
  tag: 'Doctors',
  summary: 'Doctor profile with rating',
  params: idParam,
  ok: { 200: c.Doctor },
  errors: { 404: 'NOT_FOUND' },
});
op('get', '/doctors/:id/reviews', {
  tag: 'Doctors',
  summary: 'Doctor reviews',
  params: idParam,
  query: paginationQuery,
  ok: { 200: c.page(c.DoctorReview, 'DoctorReview') },
});

// ─── Appointments ────────────────────────────────────────────────────────────

op('get', '/appointments/packages', {
  tag: 'Appointments',
  summary: 'Consultation packages priced for my region',
  ok: { 200: c.ItemsOf(c.AppointmentPackage, 'AppointmentPackage') },
});
op('post', '/appointments', {
  tag: 'Appointments',
  summary: 'Book an appointment',
  description: [
    'Omit `doctorId` to create an **open request** that any doctor can accept after payment (the app’s default flow). With `doctorId`, the doctor’s calendar is checked under a lock so a slot can never be double-booked.',
    'The price is computed server-side from the package and your region. Pay with `POST /payments { purpose: "appointment", referenceId }`. Unpaid bookings hold the slot for 30 minutes.',
    '`isTrial: true` books the free trial (once per user); it is confirmed immediately with no payment.',
    "Send the `X-Timezone` header (IANA name, e.g. `Africa/Lagos`) so confirmation and status emails show times in the patient's zone.",
  ].join('\n\n'),
  role: 'user',
  idempotent: true,
  body: appointments.createAppointmentSchema,
  ok: { 201: c.Appointment, 200: c.Appointment },
  errors: {
    409: 'SLOT_UNAVAILABLE | TRIAL_UNAVAILABLE',
    422: 'DOCTOR_UNAVAILABLE | TRIAL_DISABLED',
  },
});
op('get', '/appointments', {
  tag: 'Appointments',
  summary: 'My appointments (patients: booked; doctors: assigned)',
  query: appointments.listAppointmentsQuery,
  ok: { 200: c.page(c.Appointment, 'Appointment') },
});
op('get', '/appointments/open', {
  tag: 'Appointments',
  summary: 'Paid requests awaiting acceptance (unassigned or booked with me)',
  role: 'doctor',
  query: appointments.listAppointmentsQuery,
  ok: { 200: c.page(c.Appointment, 'Appointment') },
});
op('get', '/appointments/:id', {
  tag: 'Appointments',
  summary: 'Appointment details',
  params: idParam,
  ok: { 200: c.Appointment },
  errors: { 404: 'NOT_FOUND' },
});
op('delete', '/appointments/:id', {
  tag: 'Appointments',
  summary: 'Remove an appointment from my list (soft delete)',
  params: idParam,
  ok: { 204: null },
  errors: { 403: 'FORBIDDEN — patients only', 404: 'NOT_FOUND' },
});
op('post', '/appointments/:id/accept', {
  tag: 'Appointments',
  summary: 'Accept a paid booking',
  description:
    'Atomically claims an open request (exactly one doctor wins) or accepts one addressed to you. Fails if it overlaps your calendar.',
  role: 'doctor',
  params: idParam,
  ok: { 200: c.Appointment },
  errors: { 409: 'ALREADY_TAKEN | SLOT_UNAVAILABLE | INVALID_TRANSITION', 422: 'NOT_PAID' },
});
op('post', '/appointments/:id/status', {
  tag: 'Appointments',
  summary: 'Complete or cancel an accepted appointment',
  role: 'doctor',
  params: idParam,
  body: appointments.doctorStatusSchema,
  ok: { 200: c.Appointment },
  errors: { 409: 'INVALID_TRANSITION | CONCURRENT_UPDATE' },
});

op('get', '/appointments/:id/messages', {
  tag: 'Chat',
  summary: 'Chat history (newest first, cursor paginated)',
  description: 'Live updates arrive over Socket.IO after emitting `appointment:join`.',
  params: idParam,
  query: appointments.listMessagesQuery,
  ok: { 200: c.MessagePage },
});
op('post', '/appointments/:id/messages', {
  tag: 'Chat',
  summary: 'Send a message',
  description:
    'For attachments, upload first via `POST /uploads?folder=chat` and send the returned `url` as `fileUrl`.',
  params: idParam,
  body: appointments.sendMessageSchema,
  ok: { 201: c.Message },
  errors: { 422: 'NOT_PAID | NOT_ASSIGNED' },
});
op('patch', '/appointments/:id/messages/:messageId', {
  tag: 'Chat',
  summary: 'Edit my message',
  params: z.object({ id: z.string(), messageId: z.string() }),
  body: appointments.editMessageSchema,
  ok: { 200: c.Message },
  errors: { 403: 'FORBIDDEN — not your message', 422: 'MESSAGE_DELETED' },
});
op('delete', '/appointments/:id/messages/:messageId', {
  tag: 'Chat',
  summary: 'Delete my message (content is removed)',
  params: z.object({ id: z.string(), messageId: z.string() }),
  ok: { 204: null },
});
op('post', '/appointments/:id/messages/read', {
  tag: 'Chat',
  summary: 'Mark the other participant’s messages as read',
  params: idParam,
  ok: { 204: null },
});
op('get', '/appointments/:id/messages/unread-count', {
  tag: 'Chat',
  summary: 'Unread messages from the other participant',
  params: idParam,
  ok: { 200: c.Count },
});

op('get', '/appointments/:id/prescriptions', {
  tag: 'Clinical',
  summary: 'Prescriptions for an appointment',
  params: idParam,
  ok: { 200: c.ItemsOf(c.Prescription, 'Prescription') },
});
op('post', '/appointments/:id/prescriptions', {
  tag: 'Clinical',
  summary: 'Issue a prescription after a completed appointment (doctor only)',
  params: idParam,
  description: 'Send structured `items` (an e-prescription with a pharmacy code, valid 30 days) and optional `notes`.',
  body: z.object({
    prescription: z.string().max(5000).optional().meta({ description: 'Older clients: the whole prescription as text.' }),
    notes: z.string().max(5000).nullish(),
    items: z
      .array(
        z.object({
          name: z.string().min(2).max(200),
          strength: z.string().max(60).nullish(),
          form: z.string().max(40).nullish(),
          directions: z.string().min(2).max(500),
          durationDays: z.number().int().min(1).max(365).nullish(),
          quantity: z.number().int().min(1).max(100).default(1),
        }),
      )
      .max(20)
      .optional(),
  }),
  ok: { 201: c.Prescription },
});
op('patch', '/appointments/:id/prescriptions/:prescriptionId', {
  tag: 'Clinical',
  summary: 'Correct a prescription (issuing doctor only)',
  params: z.object({ id: z.string(), prescriptionId: z.string() }),
  description: 'Items can no longer be changed once any have been ordered from a pharmacy (409 PRESCRIPTION_DISPENSED).',
  body: z.object({
    prescription: z.string().max(5000).optional().meta({ description: 'Older clients: the whole prescription as text.' }),
    notes: z.string().max(5000).nullish(),
    items: z
      .array(
        z.object({
          name: z.string().min(2).max(200),
          strength: z.string().max(60).nullish(),
          form: z.string().max(40).nullish(),
          directions: z.string().min(2).max(500),
          durationDays: z.number().int().min(1).max(365).nullish(),
          quantity: z.number().int().min(1).max(100).default(1),
        }),
      )
      .max(20)
      .optional(),
  }),
  ok: { 200: c.Prescription },
});
op('delete', '/appointments/:id/prescriptions/:prescriptionId', {
  tag: 'Clinical',
  summary: 'Delete a prescription (issuing doctor only)',
  params: z.object({ id: z.string(), prescriptionId: z.string() }),
  ok: { 204: null },
});
op('get', '/prescriptions', {
  tag: 'Clinical',
  summary: 'My prescriptions, newest first',
  query: z.object({ limit: z.number().int().optional(), offset: z.number().int().optional() }),
  ok: { 200: c.ItemsOf(c.Prescription, 'Prescription') },
});
op('get', '/prescriptions/:id', {
  tag: 'Clinical',
  summary: 'One of my prescriptions, with what is left to dispense',
  params: idParam,
  ok: { 200: c.Prescription },
});
op('get', '/prescriptions/:id/pharmacies', {
  tag: 'Clinical',
  summary: 'Nearby pharmacies that stock the prescribed medicines',
  description:
    'For each pharmacy: matching products per prescribed medicine (best first), an estimated subtotal, delivery fee and what the patient’s HMO would cover. Add the chosen products to the cart with `prescriptionItemId`.',
  params: idParam,
  query: z.object({ latitude: z.number(), longitude: z.number(), radiusKm: z.number().optional() }),
  ok: { 200: z.record(z.string(), z.unknown()) },
  errors: { 422: 'NOT_DISPENSABLE | PRESCRIPTION_EXPIRED | PRESCRIPTION_FULFILLED' },
});
op('get', '/pharmacy-portal/prescriptions/:code', {
  tag: 'Pharmacy portal',
  summary: 'Verify a prescription code a patient shows the pharmacist',
  description:
    'Pharmacist or manager. Returns the prescriber, validity, medicines and how much of each is left to dispense. The patient is identified by first name and surname initial. Rate-limited to 60 checks an hour per pharmacy.',
  params: z.object({ code: z.string() }),
  ok: { 200: z.record(z.string(), z.unknown()) },
  errors: { 404: 'Unknown code' },
});
op('post', '/prescriptions/:id/seen', {
  tag: 'Clinical',
  summary: 'Mark a prescription as seen',
  params: idParam,
  ok: { 204: null },
});
op('get', '/appointments/:id/review', {
  tag: 'Clinical',
  summary: 'My review of this appointment, if any',
  params: idParam,
  ok: { 200: z.object({ review: c.Review.nullable() }) },
});
op('post', '/appointments/:id/review', {
  tag: 'Clinical',
  summary: 'Rate the doctor (once per appointment)',
  role: 'user',
  params: idParam,
  body: appointments.reviewSchema,
  ok: { 201: c.Review },
  errors: { 409: 'ALREADY_REVIEWED', 422: 'NOT_PAID | NOT_ASSIGNED' },
});
op('post', '/reports', {
  tag: 'Clinical',
  summary: 'Report a problem with an appointment',
  body: reports.createReportSchema,
  ok: { 201: c.Report },
  errors: { 409: 'ALREADY_REPORTED' },
});
op('get', '/reports', {
  tag: 'Clinical',
  summary: 'My reports (optionally for one appointment)',
  query: reports.listReportsQuery,
  ok: { 200: c.ItemsOf(c.Report, 'Report') },
});
op('get', '/reports/:id/messages', {
  tag: 'Clinical',
  summary: 'Support conversation for a report',
  params: idParam,
  ok: { 200: c.ItemsOf(c.ReportMessage, 'ReportMessage') },
});
op('post', '/reports/:id/messages', {
  tag: 'Clinical',
  summary: 'Reply on a report',
  params: idParam,
  body: reports.reportMessageSchema,
  ok: { 201: c.ReportMessage },
});
op('delete', '/reports/:id', {
  tag: 'Clinical',
  summary: 'Delete a report and its conversation',
  params: idParam,
  ok: { 204: null },
});

// ─── Payments ────────────────────────────────────────────────────────────────

op('post', '/payments', {
  tag: 'Payments',
  summary: 'Start a payment (Stripe, Paystack or Flutterwave)',
  description: [
    'The amount is derived from server-side state (appointment, checkout, lab result) — never from the client. `wallet_topup` takes an NGN `amount`.',
    'Follow `clientAction`: present the Stripe payment sheet with `clientSecret`, or open `authorizationUrl` for Paystack/Flutterwave. Then call `POST /payments/{reference}/verify`.',
    '**Paystack methods.** `method: "card"` opens Paystack checkout limited to cards. `method: "bank_transfer"` (NGN only) returns a `bank_transfer` action with a temporary account valid for 30 minutes: show its details and an "I\'ve sent the money" button that calls `POST /payments/{reference}/transfer-sent`. Asking again for the same purchase returns the same account while it is still open.',
  ].join('\n\n'),
  idempotent: true,
  body: initializePaymentSchema,
  ok: { 201: c.PaymentInitialized },
  errors: {
    404: 'NOT_FOUND — target does not exist or is not yours',
    409: 'ALREADY_PAID | SLOT_UNAVAILABLE',
    422: 'NO_PAYMENT_REQUIRED | APPOINTMENT_STARTED | APPOINTMENT_CANCELLED | CURRENCY_NOT_SUPPORTED | METHOD_NOT_SUPPORTED (bank transfer outside Paystack/NGN)',
    502: 'PAYMENT_PROVIDER_ERROR',
    503: 'SERVICE_UNAVAILABLE — provider not configured',
  },
});
op('get', '/payments/:reference', {
  tag: 'Payments',
  summary: 'Payment status',
  params: referenceParam,
  ok: { 200: c.Payment },
});
op('post', '/payments/:reference/verify', {
  tag: 'Payments',
  summary: 'Confirm a payment with the provider',
  description:
    'Call after the payment sheet / checkout closes. Safe to call repeatedly; the purchase is fulfilled exactly once. A short capture is marked `failed`.',
  params: referenceParam,
  ok: { 200: c.Payment },
});
op('post', '/payments/:reference/transfer-sent', {
  tag: 'Payments',
  summary: 'Bank transfer: the customer has sent the money',
  description:
    'Records the confirmation and checks with Paystack immediately. If the money has not landed yet the payment stays `pending`; show a "confirming your transfer" state and wait for `payment:updated` (or poll `GET /payments/{reference}`). Once the window plus a 15-minute grace passes without money, the payment becomes `cancelled`; a transfer that still arrives later is honoured.',
  params: referenceParam,
  ok: { 200: c.Payment },
  errors: { 404: 'NOT_FOUND', 422: 'NOT_BANK_TRANSFER' },
});
op('post', '/webhooks/:provider', {
  tag: 'Payments',
  summary: 'Provider webhook (server-to-server)',
  description:
    'Register with each provider. Signatures: Stripe `Stripe-Signature`; Paystack `x-paystack-signature` (HMAC-SHA512); Flutterwave `verif-hash`. Redeliveries are de-duplicated; status is re-verified with the provider API.',
  auth: false,
  params: z.object({ provider: z.enum(PAYMENT_PROVIDERS) }),
  body: z.object({}).loose().meta({ description: 'Raw provider event payload.' }),
  ok: { 200: c.WebhookAck },
  errors: { 401: 'UNAUTHORIZED — invalid signature' },
});

op('get', '/wallet', { tag: 'Wallet', summary: 'My wallet balance (NGN)', ok: { 200: c.Wallet } });
op('get', '/wallet/transactions', {
  tag: 'Wallet',
  summary: 'Wallet history',
  query: listTransactionsQuery,
  ok: { 200: c.page(c.WalletTransaction, 'WalletTransaction') },
});
op('post', '/wallet/transfers', {
  tag: 'Wallet',
  summary: 'Send funds to another user by email',
  idempotent: true,
  body: transferSchema,
  ok: { 201: c.TransferResult },
  errors: { 400: 'No user with that email / cannot send to yourself', 422: 'INSUFFICIENT_FUNDS' },
});
op('get', '/referrals', {
  tag: 'Wallet',
  summary: 'People I referred in a month (default: current)',
  query: listReferralsQuery,
  ok: { 200: c.ItemsOf(c.Referral, 'Referral') },
});
op('get', '/referrals/summary', {
  tag: 'Wallet',
  summary: 'Referral totals and balance',
  ok: { 200: c.ReferralSummary },
});

// ─── Pharmacy ────────────────────────────────────────────────────────────────

op('get', '/pharmacies', {
  tag: 'Pharmacy',
  summary: 'Pharmacies (nearest first when a location is given)',
  query: pharmacy.nearbyQuery,
  ok: { 200: c.ItemsOf(c.Pharmacy, 'Pharmacy') },
});
op('get', '/pharmacies/:id', {
  tag: 'Pharmacy',
  summary: 'Pharmacy details',
  params: idParam,
  ok: { 200: c.Pharmacy },
});
op('get', '/pharmacies/:id/products', {
  tag: 'Pharmacy',
  summary: 'A pharmacy’s products',
  params: idParam,
  ok: { 200: c.ItemsOf(c.Product, 'Product') },
});
op('get', '/products/categories', {
  tag: 'Pharmacy',
  summary: 'Product categories',
  ok: { 200: c.ItemsOf(c.ProductCategory, 'ProductCategory') },
});
op('get', '/products/:id', {
  tag: 'Pharmacy',
  summary: 'Product details',
  params: idParam,
  ok: { 200: c.Product },
});
op('post', '/orders/quote', {
  tag: 'Pharmacy',
  summary: 'Price a cart (delivery fees + surcharge) without ordering',
  description:
    'Lines with `prescriptionItemId` dispense an e-prescription; for HMO members their cost is priced by the plan’s medicines rule (`hmoAmount` is billed to the HMO, delivery never is).',
  body: pharmacy.cartSchema,
  ok: { 200: c.CartQuote },
  errors: { 422: 'OUT_OF_STOCK | PHARMACY_NOT_DELIVERABLE | PRESCRIPTION_EXPIRED | PRESCRIPTION_MISMATCH | PRESCRIPTION_QUANTITY_EXCEEDED' },
});
op('post', '/orders/checkout', {
  tag: 'Pharmacy',
  summary: 'Create a checkout (one order per pharmacy), awaiting payment',
  idempotent: true,
  body: pharmacy.checkoutSchema,
  ok: { 201: c.Checkout, 200: c.Checkout },
  errors: { 422: 'OUT_OF_STOCK | PHARMACY_NOT_DELIVERABLE' },
});
op('get', '/orders', {
  tag: 'Pharmacy',
  summary: 'My orders',
  query: pharmacy.listOrdersQuery,
  ok: { 200: c.page(c.Order, 'Order') },
});
op('get', '/orders/:id', {
  tag: 'Pharmacy',
  summary: 'Order details, tracking timeline, review and reported problems',
  params: idParam,
  ok: { 200: c.OrderDetail },
});
op('post', '/orders/:id/confirm-delivery', {
  tag: 'Pharmacy',
  summary: 'Confirm I received an order that is out for delivery',
  params: idParam,
  ok: { 200: c.OrderDetail },
});
op('post', '/orders/:id/review', {
  tag: 'Pharmacy',
  summary: 'Rate the pharmacy for a delivered order (once)',
  params: idParam,
  body: pharmacy.reviewSchema,
  ok: { 201: c.OrderDetail },
});
op('post', '/orders/:id/issues', {
  tag: 'Pharmacy',
  summary: 'Report a problem with an order',
  description: 'The pharmacy is emailed and responds from its workspace; the customer is notified.',
  params: idParam,
  body: pharmacy.issueSchema,
  ok: { 201: c.OrderDetail },
});
op('get', '/pharmacies/:id/reviews', {
  tag: 'Pharmacy',
  summary: 'Reviews for a pharmacy, newest first',
  params: idParam,
  query: pharmacy.pageQuery,
  ok: { 200: z.object({ items: z.array(c.PharmacyReview) }) },
});

// ─── Health ──────────────────────────────────────────────────────────────────

op('get', '/lab-results/price', {
  tag: 'Health',
  summary: 'Lab result interpretation price for my region',
  ok: { 200: c.Quote },
});
op('post', '/lab-results', {
  tag: 'Health',
  summary: 'Submit lab result files for interpretation',
  description:
    'Upload files first (`POST /uploads?folder=lab-results`). Pay with `POST /payments { purpose: "lab_result" }`.',
  idempotent: true,
  body: createLabResultSchema,
  ok: { 201: c.LabResult },
});
op('get', '/lab-results', {
  tag: 'Health',
  summary: 'My lab results',
  ok: { 200: c.ItemsOf(c.LabResult, 'LabResult') },
});
op('post', '/lab-results/:id/opened', {
  tag: 'Health',
  summary: 'Mark a result as opened',
  params: idParam,
  ok: { 204: null },
});
op('delete', '/lab-results/:id', {
  tag: 'Health',
  summary: 'Delete a lab result',
  params: idParam,
  ok: { 204: null },
});

op('get', '/medications', {
  tag: 'Health',
  summary: 'My medication schedules with dose history',
  query: family.profileQuerySchema,
  ok: { 200: c.ItemsOf(c.Medication, 'Medication') },
});
op('post', '/medications', {
  tag: 'Health',
  summary: 'Add a medication schedule',
  body: medications.medicationSchema,
  ok: { 201: c.Medication },
});
op('get', '/medications/:id', {
  tag: 'Health',
  summary: 'Medication details',
  params: idParam,
  ok: { 200: c.Medication },
});
op('patch', '/medications/:id', {
  tag: 'Health',
  summary: 'Update a medication schedule',
  params: idParam,
  body: medications.updateMedicationSchema,
  ok: { 200: c.Medication },
});
op('delete', '/medications/:id', {
  tag: 'Health',
  summary: 'Delete a medication schedule',
  params: idParam,
  ok: { 204: null },
});
op('put', '/medications/:id/doses', {
  tag: 'Health',
  summary: 'Mark a dose as taken or missed',
  params: idParam,
  body: medications.doseSchema,
  ok: { 200: c.Medication },
});

op('get', '/care-plans', {
  tag: 'Health',
  summary: 'Care plans for me or a family member',
  query: family.profileQuerySchema,
  ok: { 200: c.ItemsOf(c.CarePlan, 'CarePlan') },
});
op('post', '/care-plans', {
  tag: 'Health',
  summary: 'Create a care plan',
  body: carePlans.carePlanSchema,
  ok: { 201: c.CarePlan },
});
op('get', '/care-plans/:id', {
  tag: 'Health',
  summary: 'Care plan with recent readings',
  params: idParam,
  ok: { 200: c.CarePlan.extend({ readings: z.array(c.VitalReading) }) },
});
op('patch', '/care-plans/:id', {
  tag: 'Health',
  summary: 'Update a care plan',
  params: idParam,
  body: carePlans.updateCarePlanSchema,
  ok: { 200: c.CarePlan.extend({ readings: z.array(c.VitalReading) }) },
});
op('post', '/care-plans/:id/readings', {
  tag: 'Health',
  summary: 'Record a blood pressure or glucose reading',
  params: idParam,
  body: carePlans.vitalReadingSchema,
  ok: { 201: c.CarePlan.extend({ readings: z.array(c.VitalReading) }) },
});

// ─── Family care ─────────────────────────────────────────────────────────────

const shareIdParam = z.object({ id: z.string() });
const tokenParam = z.object({
  token: z.string().meta({ description: 'Share token from the link' }),
});

op('get', '/family-profiles', {
  tag: 'Family',
  summary: 'People I manage care for',
  ok: { 200: c.ItemsOf(c.FamilyProfile, 'FamilyProfile') },
});
op('get', '/family-profiles/overview', {
  tag: 'Family',
  summary: 'Whole-household dashboard data',
  description:
    'The account owner (`profile: null`) and every family member, each with medications (incl. dose history) and active care plans with up to 30 readings from the last 30 days.',
  ok: {
    200: z.object({
      people: z.array(
        z.object({
          profile: c.FamilyProfile.nullable(),
          name: z.string(),
          medications: z.array(c.Medication),
          carePlans: z.array(c.CarePlan.extend({ readings: z.array(c.VitalReading) })),
        }),
      ),
      generatedAt: z.iso.datetime(),
    }),
  },
});
op('post', '/family-profiles', {
  tag: 'Family',
  summary: 'Add a family member',
  body: family.familyProfileSchema,
  ok: { 201: c.FamilyProfile },
  errors: { 409: 'FAMILY_LIMIT_REACHED — too many family members on this account' },
});
op('get', '/family-profiles/:id', {
  tag: 'Family',
  summary: 'A family member',
  params: idParam,
  ok: { 200: c.FamilyProfile },
  errors: { 404: 'NOT_FOUND' },
});
op('patch', '/family-profiles/:id', {
  tag: 'Family',
  summary: 'Update a family member',
  params: idParam,
  body: family.updateFamilyProfileSchema,
  ok: { 200: c.FamilyProfile },
  errors: { 404: 'NOT_FOUND' },
});
op('delete', '/family-profiles/:id', {
  tag: 'Family',
  summary: 'Remove a family member',
  description: 'Also deletes their care plans, medications and share links.',
  params: idParam,
  ok: { 204: null },
  errors: { 404: 'NOT_FOUND' },
});
op('get', '/care-summary', {
  tag: 'Family',
  summary: 'Preview the doctor visit summary for me or a family member',
  query: family.profileQuerySchema,
  ok: { 200: c.CareSummary },
});
op('get', '/care-summary/shares', {
  tag: 'Family',
  summary: 'Active share links',
  query: family.profileQuerySchema,
  ok: { 200: c.ItemsOf(c.CareSummaryShare, 'CareSummaryShare') },
});
op('post', '/care-summary/shares', {
  tag: 'Family',
  summary: 'Create a read-only share link',
  description:
    'The returned `url` contains the token and is shown only once. Links expire and can be revoked.',
  body: family.createShareSchema,
  ok: { 201: c.CareSummaryShare.extend({ url: z.string() }) },
});
op('delete', '/care-summary/shares/:id', {
  tag: 'Family',
  summary: 'Revoke a share link',
  params: shareIdParam,
  ok: { 204: null },
  errors: { 404: 'NOT_FOUND' },
});
op('get', '/care-summaries/:token', {
  tag: 'Family',
  summary: 'View a shared care summary',
  description:
    'Public. Browsers (`Accept: text/html`) get a print-friendly page; API clients get JSON.',
  auth: false,
  params: tokenParam,
  ok: {
    200: z.object({
      summary: c.CareSummary,
      sharedBy: z.string().nullable(),
      expiresAt: z.iso.datetime(),
    }),
  },
  errors: { 404: 'NOT_FOUND — unknown, expired or revoked link' },
});

// ─── Content ─────────────────────────────────────────────────────────────────

op('get', '/health-tips/categories', {
  tag: 'Content',
  summary: 'Health tip categories with article counts',
  ok: { 200: c.ItemsOf(c.HealthTipCategory, 'HealthTipCategory') },
});
op('get', '/health-tips', {
  tag: 'Content',
  summary: 'Published health tips',
  query: listTipsQuery,
  ok: { 200: c.page(c.HealthTipSummary, 'HealthTipSummary') },
});
op('get', '/health-tips/:id', {
  tag: 'Content',
  summary: 'Read a health tip (records a unique view)',
  params: idParam,
  ok: { 200: c.HealthTip },
});
op('get', '/health-tips/:id/related', {
  tag: 'Content',
  summary: 'Related tips from the same category',
  params: idParam,
  ok: { 200: c.ItemsOf(c.HealthTipSummary, 'HealthTipSummary') },
});
op('post', '/health-tips/:id/like', {
  tag: 'Content',
  summary: 'Toggle my like',
  params: idParam,
  ok: { 200: c.LikeState },
});
op('get', '/anonymous-questions', {
  tag: 'Content',
  summary: 'My anonymous questions',
  ok: { 200: c.ItemsOf(c.AnonymousQuestion, 'AnonymousQuestion') },
});
op('post', '/anonymous-questions', {
  tag: 'Content',
  summary: 'Ask a doctor anonymously',
  body: askQuestionSchema,
  ok: { 201: c.AnonymousQuestion },
});
op('delete', '/anonymous-questions/:id', {
  tag: 'Content',
  summary: 'Delete my question',
  params: idParam,
  ok: { 204: null },
});

// ─── Blog (public) ───────────────────────────────────────────────────────────

const slugParam = z.object({
  slug: z.string().meta({ example: 'how-to-lower-blood-pressure-naturally' }),
});
const PUBLIC =
  'Responses are cacheable (`Cache-Control: public`); only live posts (published, not scheduled for later) are returned.';
op('get', '/blog/posts', {
  tag: 'Blog',
  summary: 'Live posts, newest first',
  description: `Filter by category, tag or author slug, or search with \`q\`. Posts marked noindex are left out. ${PUBLIC}`,
  auth: false,
  query: blog.publicListQuery,
  ok: { 200: c.BlogPostPage },
});
op('get', '/blog/posts/:slug', {
  tag: 'Blog',
  summary: 'A live post with its author, reviewer, related posts and neighbours',
  description: `Also accepts a post id, so legacy links can be resolved and redirected to the slug. ${PUBLIC}`,
  auth: false,
  params: slugParam,
  ok: { 200: c.BlogPost },
  errors: { 404: 'NOT_FOUND' },
});
op('post', '/blog/posts/:slug/view', {
  tag: 'Blog',
  summary: 'Count a page view',
  description: 'Rate limited per IP. Does not change `updatedAt`.',
  auth: false,
  params: slugParam,
  ok: { 200: z.object({ counted: z.boolean() }) },
});
op('get', '/blog/categories', {
  tag: 'Blog',
  summary: 'Categories with live post counts',
  auth: false,
  ok: { 200: c.ItemsOf(c.BlogCategory, 'BlogCategory') },
});
op('get', '/blog/categories/:slug', {
  tag: 'Blog',
  summary: 'A category with its SEO fields',
  auth: false,
  params: slugParam,
  ok: { 200: c.BlogCategoryDetail },
  errors: { 404: 'NOT_FOUND' },
});
op('get', '/blog/authors/:slug', {
  tag: 'Blog',
  summary: 'An author profile',
  auth: false,
  params: slugParam,
  ok: { 200: c.BlogAuthor.extend({ postCount: z.number().int() }) },
  errors: { 404: 'NOT_FOUND' },
});
op('get', '/blog/tags', {
  tag: 'Blog',
  summary: 'Tags on live posts, most used first',
  auth: false,
  ok: { 200: c.ItemsOf(c.BlogTag, 'BlogTag') },
});
op('get', '/blog/sitemap', {
  tag: 'Blog',
  summary: 'Every indexable post, category and author with last-modified dates',
  description: 'Feeds the website sitemaps and RSS feed.',
  auth: false,
  ok: { 200: c.BlogSitemap },
});

// ─── Blog (admin) ────────────────────────────────────────────────────────────

const ADMIN =
  'Requires an **admin** access token (from /admin/auth/login). Writes need the `admin` or `marketer` role.';
const adminWrite = { 403: 'FORBIDDEN — requires the admin or marketer role' } as const;
op('get', '/admin/blog/posts', {
  tag: 'Blog admin',
  summary: 'All posts with status counts',
  description: ADMIN,
  query: blog.adminPostsQuery,
  ok: { 200: c.AdminBlogPostPage },
});
op('get', '/admin/blog/posts/:id', {
  tag: 'Blog admin',
  summary: 'A post for editing',
  description: ADMIN,
  params: idParam,
  ok: { 200: c.AdminBlogPost },
  errors: { 404: 'NOT_FOUND' },
});
op('post', '/admin/blog/posts', {
  tag: 'Blog admin',
  summary: 'Create a post',
  description: `${ADMIN}\n\nThe body HTML is sanitised. A blank slug is derived from the title; a blank excerpt is generated. Publishing without \`publishedAt\` publishes now; a future date schedules the post.`,
  body: blog.postSchema,
  ok: { 201: c.AdminBlogPost },
  errors: { ...adminWrite, 409: 'SLUG_TAKEN' },
});
op('patch', '/admin/blog/posts/:id', {
  tag: 'Blog admin',
  summary: 'Update a post',
  description: `${ADMIN}\n\nOnly the fields sent are changed.`,
  params: idParam,
  body: blog.updatePostSchema,
  ok: { 200: c.AdminBlogPost },
  errors: { ...adminWrite, 404: 'NOT_FOUND', 409: 'SLUG_TAKEN' },
});
op('delete', '/admin/blog/posts/:id', {
  tag: 'Blog admin',
  summary: 'Delete a post',
  description: ADMIN,
  params: idParam,
  ok: { 200: c.Deleted },
  errors: { ...adminWrite, 404: 'NOT_FOUND' },
});
op('get', '/admin/blog/categories', {
  tag: 'Blog admin',
  summary: 'Categories with post counts',
  description: ADMIN,
  ok: { 200: c.ItemsOf(c.AdminBlogCategory, 'AdminBlogCategory') },
});
op('post', '/admin/blog/categories', {
  tag: 'Blog admin',
  summary: 'Create a category',
  description: ADMIN,
  body: blog.categorySchema,
  ok: { 201: c.BlogCategoryDetail },
  errors: { ...adminWrite, 409: 'SLUG_TAKEN' },
});
op('patch', '/admin/blog/categories/:id', {
  tag: 'Blog admin',
  summary: 'Update a category',
  description: ADMIN,
  params: idParam,
  body: blog.updateCategorySchema,
  ok: { 200: c.BlogCategoryDetail },
  errors: { ...adminWrite, 404: 'NOT_FOUND', 409: 'SLUG_TAKEN' },
});
op('delete', '/admin/blog/categories/:id', {
  tag: 'Blog admin',
  summary: 'Delete a category (its posts become uncategorised)',
  description: ADMIN,
  params: idParam,
  ok: { 200: c.Deleted },
  errors: { ...adminWrite, 404: 'NOT_FOUND' },
});
op('get', '/admin/blog/authors', {
  tag: 'Blog admin',
  summary: 'Authors and reviewers with post counts',
  description: ADMIN,
  ok: { 200: c.ItemsOf(c.AdminBlogAuthor, 'AdminBlogAuthor') },
});
op('post', '/admin/blog/authors', {
  tag: 'Blog admin',
  summary: 'Create an author',
  description: ADMIN,
  body: blog.authorSchema,
  ok: { 201: c.BlogAuthor },
  errors: { ...adminWrite, 409: 'SLUG_TAKEN' },
});
op('patch', '/admin/blog/authors/:id', {
  tag: 'Blog admin',
  summary: 'Update an author',
  description: ADMIN,
  params: idParam,
  body: blog.updateAuthorSchema,
  ok: { 200: c.BlogAuthor },
  errors: { ...adminWrite, 404: 'NOT_FOUND', 409: 'SLUG_TAKEN' },
});
op('delete', '/admin/blog/authors/:id', {
  tag: 'Blog admin',
  summary: 'Delete an author (their posts fall back to the team byline)',
  description: ADMIN,
  params: idParam,
  ok: { 200: c.Deleted },
  errors: { ...adminWrite, 404: 'NOT_FOUND' },
});
op('post', '/admin/blog/uploads', {
  tag: 'Blog admin',
  summary: 'Upload a blog image (PNG, JPEG, GIF or WebP, max 8 MB)',
  description: `${ADMIN} Stored as a public \`blog_image\` file.`,
  body: { multipart: z.object({ file: z.string().meta({ format: 'binary' }) }) },
  ok: { 201: c.StoredFile },
  errors: { ...adminWrite, 502: 'STORAGE_ERROR — upload to storage failed; retry' },
});

// ─── Mail centre (admin) ─────────────────────────────────────────────────────

const LETTER = `Official letters on the Instant Doctor letterhead, sent from \`MAIL_OFFICIAL_FROM\` (contact@). Each recipient gets their own message; \`{{firstName}}\`, \`{{name}}\` and \`{{email}}\` in the body are filled in per person. Requires an **admin** token; sending needs the \`admin\` or \`marketer\` role.`;
const LetterRecipient = z.object({
  email: z.string(),
  name: z.string().nullable(),
  status: z.enum(['pending', 'sent', 'failed']),
  error: z.string().nullable(),
  sentAt: z.string().nullable(),
});
const LetterSummary = z.object({
  id: z.string(),
  reference: z.string().meta({ example: 'ID/2026/10/0007' }),
  subject: z.string(),
  status: z.enum(['sending', 'sent', 'partial', 'failed']),
  audience: z.object({
    segment: z.string().nullable(),
    emails: z.number().int(),
    users: z.number().int(),
  }),
  recipientCount: z.number().int(),
  sentCount: z.number().int(),
  failedCount: z.number().int(),
  createdAt: z.string(),
  sentBy: z.string().nullable(),
});
const LetterDetail = LetterSummary.extend({
  body: z.string(),
  signatureName: z.string(),
  signatureTitle: z.string().nullable(),
  recipients: z.array(LetterRecipient),
});
op('post', '/admin/mail/preview', {
  tag: 'Mail centre',
  summary: 'Render a letter as recipients will see it',
  description: LETTER,
  body: mailCenter.previewSchema,
  ok: { 200: z.object({ html: z.string() }) },
});
op('get', '/admin/mail/audience', {
  tag: 'Mail centre',
  summary: 'How many people a segment reaches',
  description: 'Counts active, non-suspended accounts.',
  query: mailCenter.audienceQuery,
  ok: { 200: z.object({ segment: z.string(), recipients: z.number().int() }) },
});
op('post', '/admin/mail/test', {
  tag: 'Mail centre',
  summary: 'Send the letter to myself',
  description: LETTER,
  body: mailCenter.testSchema,
  ok: { 200: z.object({ sentTo: z.string() }) },
  errors: { 403: 'FORBIDDEN', 422: 'MAIL_FAILED' },
});
op('post', '/admin/mail', {
  tag: 'Mail centre',
  summary: 'Send a letter',
  description: `${LETTER}\n\nRecipients are the union of \`emails\`, \`userIds\` and \`segment\`, de-duplicated by address (max ${mailCenter.MAX_RECIPIENTS}). Returns at once with status \`sending\`; poll \`GET /admin/mail/{id}\` for progress.`,
  body: mailCenter.sendSchema,
  ok: { 202: LetterDetail },
  errors: { 403: 'FORBIDDEN', 422: 'NO_RECIPIENTS | TOO_MANY_RECIPIENTS' },
});
op('get', '/admin/mail', {
  tag: 'Mail centre',
  summary: 'Sent letters, newest first',
  description: LETTER,
  query: mailCenter.historyQuery,
  ok: {
    200: z.object({
      items: z.array(LetterSummary),
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
  },
});
op('get', '/admin/mail/:id', {
  tag: 'Mail centre',
  summary: 'A sent letter with per-recipient delivery status',
  description: LETTER,
  params: idParam,
  ok: { 200: LetterDetail },
  errors: { 404: 'NOT_FOUND' },
});

// ─── HMO partnerships ────────────────────────────────────────────────────────

const HMO_ADMIN =
  'Requires an **admin** token; changes need the `admin` role. Every route is scoped to one HMO (`hmoId`); the HMO portal exposes the same data with the HMO taken from its login. Changes are recorded in the HMO’s activity trail.';
const hmoParams = z.object({ hmoId: z.string() });
const planParams = hmoParams.extend({ planId: z.string() });
const anyJson = z.record(z.string(), z.unknown());
op('get', '/hmo/partners', {
  tag: 'HMO',
  summary: 'Partner HMOs a patient can link to',
  ok: {
    200: c.ItemsOf(
      z.object({ id: z.string(), name: z.string(), code: z.string(), logo: z.string().nullable() }),
      'HmoPartner',
    ),
  },
});
op('get', '/hmo/me', {
  tag: 'HMO',
  summary: 'My HMO membership and what it covers',
  description:
    'Includes benefits with usage against limits, a lapsed membership, or a pending link request.',
  ok: { 200: anyJson },
});
op('post', '/hmo/link', {
  tag: 'HMO',
  summary: 'Link my HMO',
  description:
    'Matches the enrollee code plus one detail (surname, phone or date of birth) against the HMO list. 200 = linked; 202 = queued for review. Rate limited.',
  body: hmo.linkSchema,
  ok: { 200: anyJson, 202: anyJson },
  errors: {
    404: 'NOT_FOUND — unknown or inactive HMO',
    409: 'ENROLLEE_ALREADY_LINKED | ACCOUNT_ALREADY_LINKED',
  },
});
op('delete', '/hmo/me', {
  tag: 'HMO',
  summary: 'Unlink my HMO',
  ok: { 200: z.object({ unlinked: z.boolean() }) },
});

op('get', '/admin/hmos', {
  tag: 'HMO admin',
  summary: 'HMOs with member and unbilled totals',
  description: HMO_ADMIN,
  ok: { 200: c.ItemsOf(anyJson, 'AdminHmo') },
});
op('post', '/admin/hmos', {
  tag: 'HMO admin',
  summary: 'Add an HMO',
  description: HMO_ADMIN,
  body: hmo.hmoSchema,
  ok: { 201: anyJson },
  errors: { 403: 'FORBIDDEN', 409: 'HMO_CODE_TAKEN' },
});
op('get', '/admin/hmos/:hmoId', {
  tag: 'HMO admin',
  summary: 'An HMO with its plans and agreement rules',
  description: HMO_ADMIN,
  params: hmoParams,
  ok: { 200: anyJson },
  errors: { 404: 'NOT_FOUND' },
});
op('patch', '/admin/hmos/:hmoId', {
  tag: 'HMO admin',
  summary: 'Update an HMO (pause or end the partnership here)',
  description: HMO_ADMIN,
  params: hmoParams,
  body: hmo.updateHmoSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'HMO_CODE_TAKEN' },
});
op('post', '/admin/hmos/:hmoId/plans', {
  tag: 'HMO admin',
  summary: 'Add a plan',
  description: HMO_ADMIN,
  params: hmoParams,
  body: hmo.planSchema,
  ok: { 201: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND' },
});
op('patch', '/admin/hmos/:hmoId/plans/:planId', {
  tag: 'HMO admin',
  summary: 'Update a plan',
  description: HMO_ADMIN,
  params: planParams,
  body: hmo.updatePlanSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND' },
});
op('get', '/admin/hmos/:hmoId/plans/:planId/price-preview', {
  tag: 'HMO admin',
  summary: 'What every service costs under a plan',
  description: `${HMO_ADMIN}\n\nPer consultation package and lab interpretation: standard price, patient pays, HMO billed, doctor earns.`,
  params: planParams,
  ok: { 200: anyJson },
  errors: { 404: 'NOT_FOUND' },
});
op('post', '/admin/hmos/:hmoId/plans/:planId/rules', {
  tag: 'HMO admin',
  summary: 'Add an agreement rule',
  description: `${HMO_ADMIN}\n\nCoverage types: \`full\`, \`copay_fixed\`, \`copay_percent\`, \`discount_percent\`, \`fixed_price\`, \`not_covered\`. A package-specific rule overrides the plan-wide consultation rule.`,
  params: planParams,
  body: hmo.ruleSchema,
  ok: { 201: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'HMO_RULE_EXISTS' },
});
op('put', '/admin/hmos/:hmoId/plans/:planId/rules/:ruleId', {
  tag: 'HMO admin',
  summary: 'Replace an agreement rule',
  description: HMO_ADMIN,
  params: planParams.extend({ ruleId: z.string() }),
  body: hmo.ruleSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'HMO_RULE_EXISTS' },
});
op('delete', '/admin/hmos/:hmoId/plans/:planId/rules/:ruleId', {
  tag: 'HMO admin',
  summary: 'Remove a rule (switched off instead if claims use it)',
  description: HMO_ADMIN,
  params: planParams.extend({ ruleId: z.string() }),
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND' },
});
op('get', '/admin/hmos/:hmoId/enrollees', {
  tag: 'HMO admin',
  summary: 'The HMO member list',
  description: HMO_ADMIN,
  params: hmoParams,
  query: hmo.enrolleesQuery,
  ok: { 200: anyJson },
});
op('post', '/admin/hmos/:hmoId/enrollees', {
  tag: 'HMO admin',
  summary: 'Add a member (linked at once if an account matches)',
  description: HMO_ADMIN,
  params: hmoParams,
  body: hmo.enrolleeSchema,
  ok: { 201: anyJson },
  errors: { 403: 'FORBIDDEN', 409: 'ENROLLEE_CODE_TAKEN' },
});
op('post', '/admin/hmos/:hmoId/enrollees/import', {
  tag: 'HMO admin',
  summary: 'Import the HMO member list',
  description: `${HMO_ADMIN}\n\nAdds new codes, updates known ones, optionally ends members missing from a full list, then links matching accounts. Row problems are returned in \`errors\`.`,
  params: hmoParams,
  body: hmo.importSchema,
  ok: {
    200: z.object({
      created: z.number(),
      updated: z.number(),
      ended: z.number(),
      matched: z.number(),
      errors: z.array(anyJson),
    }),
  },
  errors: { 403: 'FORBIDDEN' },
});
op('patch', '/admin/hmos/:hmoId/enrollees/:enrolleeId', {
  tag: 'HMO admin',
  summary: 'Update a member, or link/unlink an account',
  description: HMO_ADMIN,
  params: hmoParams.extend({ enrolleeId: z.string() }),
  body: hmo.updateEnrolleeSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'ACCOUNT_ALREADY_LINKED' },
});
op('get', '/admin/hmos/:hmoId/claims', {
  tag: 'HMO admin',
  summary: 'Claims, with totals by status',
  description: HMO_ADMIN,
  params: hmoParams,
  query: hmo.claimsQuery,
  ok: { 200: anyJson },
});
op('patch', '/admin/hmos/:hmoId/claims/:claimId', {
  tag: 'HMO admin',
  summary: 'Reject, void or restore a claim',
  description: HMO_ADMIN,
  params: hmoParams.extend({ claimId: z.string() }),
  body: hmo.claimUpdateSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CLAIM_PAID | CLAIM_INVOICED' },
});
op('get', '/admin/hmos/:hmoId/invoices', {
  tag: 'HMO admin',
  summary: 'Invoices issued to the HMO',
  description: HMO_ADMIN,
  params: hmoParams,
  ok: { 200: c.ItemsOf(anyJson, 'HmoInvoice') },
});
op('post', '/admin/hmos/:hmoId/invoices', {
  tag: 'HMO admin',
  summary: 'Invoice the billable claims of a period',
  description: `${HMO_ADMIN}\n\nOnly claims whose service stands (paid, not cancelled) and that bill the HMO something are included.`,
  params: hmoParams,
  body: hmo.invoiceSchema,
  ok: { 201: anyJson },
  errors: { 403: 'FORBIDDEN', 422: 'NOTHING_TO_INVOICE | INVALID_PERIOD' },
});
op('get', '/admin/hmos/:hmoId/invoices/:invoiceId', {
  tag: 'HMO admin',
  summary: 'An invoice with its claims',
  description: HMO_ADMIN,
  params: hmoParams.extend({ invoiceId: z.string() }),
  ok: { 200: anyJson },
  errors: { 404: 'NOT_FOUND' },
});
op('patch', '/admin/hmos/:hmoId/invoices/:invoiceId', {
  tag: 'HMO admin',
  summary: 'Mark an invoice paid, or cancel it',
  description: HMO_ADMIN,
  params: hmoParams.extend({ invoiceId: z.string() }),
  body: hmo.invoiceUpdateSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'INVOICE_CLOSED' },
});
op('get', '/admin/hmo-link-requests', {
  tag: 'HMO admin',
  summary: '"Link my HMO" requests awaiting review',
  description: HMO_ADMIN,
  query: hmo.linkRequestsQuery,
  ok: { 200: anyJson },
});
op('post', '/admin/hmo-link-requests/:id/approve', {
  tag: 'HMO admin',
  summary: 'Approve a link request against a member',
  description: HMO_ADMIN,
  params: idParam,
  body: hmo.approveLinkSchema,
  ok: { 200: z.object({ approved: z.boolean() }) },
  errors: {
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'LINK_REQUEST_CLOSED | ENROLLEE_ALREADY_LINKED',
  },
});
op('post', '/admin/hmo-link-requests/:id/reject', {
  tag: 'HMO admin',
  summary: 'Reject a link request',
  description: HMO_ADMIN,
  params: idParam,
  body: hmo.rejectLinkSchema,
  ok: { 200: z.object({ rejected: z.boolean() }) },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'LINK_REQUEST_CLOSED' },
});

op('get', '/admin/hmo-applications', {
  tag: 'HMO admin',
  summary: 'HMO partnership applications from the website',
  description: HMO_ADMIN,
  query: hmo.applicationsQuery,
  ok: { 200: anyJson },
});
op('get', '/admin/hmo-applications/:id', {
  tag: 'HMO admin',
  summary: 'One HMO partnership application',
  description: HMO_ADMIN,
  params: idParam,
  ok: { 200: anyJson },
  errors: { 404: 'NOT_FOUND' },
});
op('post', '/admin/hmo-applications/:id/approve', {
  tag: 'HMO admin',
  summary: 'Approve an application: create the HMO and its first portal admin',
  description: `${HMO_ADMIN} The HMO is created paused unless \`status\` says otherwise. The portal admin gets a temporary password by email, also returned once in \`portalAdmin\`.`,
  params: idParam,
  body: hmo.approveApplicationSchema,
  ok: {
    200: z.object({
      application: anyJson,
      hmoId: z.string(),
      portalAdmin: z.object({ email: z.string(), temporaryPassword: z.string() }),
    }),
  },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'APPLICATION_REVIEWED | HMO_CODE_TAKEN | EMAIL_TAKEN' },
});
op('post', '/admin/hmo-applications/:id/reject', {
  tag: 'HMO admin',
  summary: 'Reject an application; the reason is emailed to the applicant',
  description: HMO_ADMIN,
  params: idParam,
  body: hmo.rejectApplicationSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'APPLICATION_REVIEWED' },
});
op('post', '/hmo-applications', {
  tag: 'HMO admin',
  summary: 'Apply to partner as an HMO (website form)',
  description: 'Creates a pending application and emails the applicant a reference. Rate limited to 5 an hour.',
  auth: false,
  body: hmo.applicationSchema,
  ok: { 201: z.object({ id: z.string(), reference: z.string(), status: z.literal('pending'), email: z.string() }) },
  errors: { 409: 'APPLICATION_EXISTS — an application from this email is under review' },
});

const HmoPortalUser = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'manager', 'viewer']),
  status: z.enum(['active', 'inactive']),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.date().nullable(),
  createdAt: z.date(),
});
const userParams = hmoParams.extend({ userId: z.string() });
op('get', '/admin/hmos/:hmoId/users', {
  tag: 'HMO admin',
  summary: 'HMO portal accounts',
  description: HMO_ADMIN,
  params: hmoParams,
  ok: { 200: c.ItemsOf(HmoPortalUser, 'HmoPortalUser') },
  errors: { 404: 'NOT_FOUND' },
});
op('post', '/admin/hmos/:hmoId/users', {
  tag: 'HMO admin',
  summary: 'Give someone at the HMO portal access',
  description: `${HMO_ADMIN}\n\nThe password is temporary: the person must choose their own at first sign-in. Share it securely.`,
  params: hmoParams,
  body: hmo.hmoUserSchema,
  ok: { 201: HmoPortalUser },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'EMAIL_TAKEN' },
});
op('patch', '/admin/hmos/:hmoId/users/:userId', {
  tag: 'HMO admin',
  summary: 'Change a portal account’s name, role or status',
  description: `${HMO_ADMIN}\n\nDeactivating signs the person out everywhere. The HMO always keeps at least one active admin.`,
  params: userParams,
  body: hmo.updateHmoUserSchema,
  ok: { 200: HmoPortalUser },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'LAST_ADMIN' },
});
op('post', '/admin/hmos/:hmoId/users/:userId/reset-password', {
  tag: 'HMO admin',
  summary: 'Set a temporary password for a portal account',
  description: `${HMO_ADMIN}\n\nSigns the person out everywhere; they choose a new password at next sign-in.`,
  params: userParams,
  body: hmo.resetPasswordSchema,
  ok: { 200: HmoPortalUser },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND' },
});
const HmoActivityPage = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      actorType: z.enum(['hmo_user', 'admin', 'system']),
      actorName: z.string(),
      action: z.string().meta({ example: 'member.updated' }),
      entityType: z.string().nullable(),
      entityId: z.string().nullable(),
      summary: z.string(),
      details: anyJson.nullable(),
      createdAt: z.date(),
    }),
  ),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
op('get', '/admin/hmos/:hmoId/activity', {
  tag: 'HMO admin',
  summary: 'The HMO’s activity trail',
  description: `${HMO_ADMIN}\n\nEvery change to the HMO’s members, team, agreement and billing — by its own people or by Instant Doctor staff. The HMO sees the same trail in its portal.`,
  params: hmoParams,
  query: hmo.activityQuery,
  ok: { 200: HmoActivityPage },
  errors: { 404: 'NOT_FOUND' },
});

// ─── HMO portal ──────────────────────────────────────────────────────────────

const HMO_PORTAL =
  'Requires an **HMO portal** token (from `/hmo-portal/auth/login`). The HMO comes from the token. Until a temporary password is changed, only `GET /hmo-portal/me` and `PATCH /hmo-portal/password` work (403 `PASSWORD_CHANGE_REQUIRED`).';
const roles = (who: string) => `${HMO_PORTAL}\n\nRoles: ${who}.`;
const HmoPortalProfile = z.object({ account: HmoPortalUser, hmo: anyJson });
op('post', '/hmo-portal/auth/login', {
  tag: 'HMO portal',
  summary: 'Sign in to the HMO portal',
  auth: false,
  body: hmoPortal.loginSchema,
  ok: { 200: HmoPortalProfile.extend({ session: c.Session }) },
  errors: { 401: 'UNAUTHORIZED', 403: 'FORBIDDEN — account deactivated' },
});
op('post', '/hmo-portal/auth/refresh', {
  tag: 'HMO portal',
  summary: 'Renew an HMO portal session',
  description:
    'Exchange the `refreshToken` for a new access token and refresh token. Each refresh token is single-use; a second use within 30 seconds is allowed, later reuse ends the session.',
  auth: false,
  body: auth.refreshSchema,
  ok: { 200: z.object({ session: c.Session }) },
  errors: { 401: 'UNAUTHORIZED' },
});
op('post', '/hmo-portal/auth/logout', {
  tag: 'HMO portal',
  summary: 'Sign out of the HMO portal on this device',
  auth: false,
  body: auth.refreshSchema,
  ok: { 204: null },
});
op('get', '/hmo-portal/me', {
  tag: 'HMO portal',
  summary: 'The signed-in account and its HMO',
  description: HMO_PORTAL,
  ok: { 200: HmoPortalProfile },
});
op('patch', '/hmo-portal/password', {
  tag: 'HMO portal',
  summary: 'Change your password',
  description: `${HMO_PORTAL}\n\nSigns out every other session and returns a fresh one for this device.`,
  body: hmoPortal.passwordSchema,
  ok: { 200: z.object({ updated: z.boolean(), session: c.Session }) },
  errors: { 400: 'BAD_REQUEST — current password incorrect' },
});
op('patch', '/hmo-portal/profile', {
  tag: 'HMO portal',
  summary: 'Update the HMO’s contact details and logo',
  description: roles('admin'),
  body: hmoPortal.profileSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN' },
});
op('get', '/hmo-portal/dashboard', {
  tag: 'HMO portal',
  summary: 'Members, utilisation and billing at a glance',
  description: `${roles('all')}\n\nUtilisation covers the last six months (Lagos time) and counts only services that happened: paid, not cancelled, delivered.`,
  ok: { 200: anyJson },
});
op('get', '/hmo-portal/plans', {
  tag: 'HMO portal',
  summary: 'The HMO’s plans and the benefits of each',
  description: roles('all'),
  ok: { 200: z.object({ plans: z.array(anyJson) }) },
});
op('get', '/hmo-portal/plans/:planId/price-preview', {
  tag: 'HMO portal',
  summary: 'What each service costs a member, and the HMO, under a plan',
  description: roles('all'),
  params: z.object({ planId: z.string() }),
  ok: { 200: anyJson },
  errors: { 404: 'NOT_FOUND' },
});
op('get', '/hmo-portal/enrollees', {
  tag: 'HMO portal',
  summary: 'Members',
  description: `${roles('all')}\n\n\`linked\` says whether the member uses the Instant Doctor app; their app account itself is not shared.`,
  query: hmoPortal.enrolleesQuery,
  ok: { 200: anyJson },
});
op('post', '/hmo-portal/enrollees', {
  tag: 'HMO portal',
  summary: 'Add a member',
  description: roles('admin, manager'),
  body: hmoPortal.enrolleeSchema,
  ok: { 201: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND — plan', 409: 'ENROLLEE_CODE_TAKEN' },
});
op('post', '/hmo-portal/enrollees/import', {
  tag: 'HMO portal',
  summary: 'Import a member list',
  description: `${roles('admin, manager')}\n\nNew codes are added, known codes updated and re-activated. With \`endMissing\`, members of the plan absent from the list are ended.`,
  body: hmoPortal.importSchema,
  ok: {
    200: z.object({
      created: z.number(),
      updated: z.number(),
      ended: z.number(),
      matched: z.number(),
      errors: z.array(anyJson),
    }),
  },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND — plan' },
});
op('get', '/hmo-portal/enrollees/:enrolleeId', {
  tag: 'HMO portal',
  summary: 'A member, their benefit usage and claim totals',
  description: roles('all'),
  params: z.object({ enrolleeId: z.string() }),
  ok: { 200: anyJson },
  errors: { 404: 'NOT_FOUND' },
});
op('patch', '/hmo-portal/enrollees/:enrolleeId', {
  tag: 'HMO portal',
  summary: 'Update a member (plan, details, status, cover dates)',
  description: roles('admin, manager'),
  params: z.object({ enrolleeId: z.string() }),
  body: hmoPortal.updateEnrolleeSchema,
  ok: { 200: anyJson },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND' },
});
op('get', '/hmo-portal/claims', {
  tag: 'HMO portal',
  summary: 'Claims, with totals by status',
  description: roles('all'),
  query: hmoPortal.claimsQuery,
  ok: { 200: anyJson },
});
op('get', '/hmo-portal/invoices', {
  tag: 'HMO portal',
  summary: 'Invoices issued to the HMO',
  description: roles('all'),
  ok: { 200: c.ItemsOf(anyJson, 'HmoPortalInvoice') },
});
op('get', '/hmo-portal/invoices/:invoiceId', {
  tag: 'HMO portal',
  summary: 'An invoice with its claims',
  description: roles('all'),
  params: z.object({ invoiceId: z.string() }),
  ok: { 200: anyJson },
  errors: { 404: 'NOT_FOUND' },
});
op('get', '/hmo-portal/activity', {
  tag: 'HMO portal',
  summary: 'Activity trail: who changed what, on either side',
  description: roles('all'),
  query: hmoPortal.activityQuery,
  ok: { 200: HmoActivityPage },
});
op('get', '/hmo-portal/team', {
  tag: 'HMO portal',
  summary: 'Portal accounts at your HMO',
  description: roles('admin'),
  ok: { 200: c.ItemsOf(HmoPortalUser, 'HmoPortalTeamUser') },
  errors: { 403: 'FORBIDDEN' },
});
op('post', '/hmo-portal/team', {
  tag: 'HMO portal',
  summary: 'Give a colleague portal access',
  description: `${roles('admin')}\n\nThe password is temporary; they choose their own at first sign-in.`,
  body: hmoPortal.teamUserSchema,
  ok: { 201: HmoPortalUser },
  errors: { 403: 'FORBIDDEN', 409: 'EMAIL_TAKEN' },
});
op('patch', '/hmo-portal/team/:userId', {
  tag: 'HMO portal',
  summary: 'Change a colleague’s name, role or status',
  description: `${roles('admin')}\n\nYou cannot change your own access, and the HMO always keeps one active admin.`,
  params: z.object({ userId: z.string() }),
  body: hmoPortal.updateTeamUserSchema,
  ok: { 200: HmoPortalUser },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'OWN_ACCOUNT | LAST_ADMIN' },
});
op('post', '/hmo-portal/team/:userId/reset-password', {
  tag: 'HMO portal',
  summary: 'Set a temporary password for a colleague',
  description: roles('admin'),
  params: z.object({ userId: z.string() }),
  body: hmoPortal.resetPasswordSchema,
  ok: { 200: HmoPortalUser },
  errors: { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'OWN_ACCOUNT' },
});

// ─── Misc ────────────────────────────────────────────────────────────────────

op('get', '/notifications', {
  tag: 'Notifications',
  summary: 'My notifications, newest first',
  query: paginationQuery,
  ok: { 200: c.page(c.Notification, 'Notification') },
});
op('get', '/notifications/unread-count', {
  tag: 'Notifications',
  summary: 'Unread notification count',
  ok: { 200: c.Count },
});
op('post', '/notifications/read-all', {
  tag: 'Notifications',
  summary: 'Mark all notifications as read',
  ok: { 204: null },
});
op('post', '/doctor-applications/documents', {
  tag: 'Provider applications',
  summary: 'Upload one document for a provider application (no account needed)',
  description:
    'Used by the website\'s "Become a provider" form. multipart/form-data with `file` (PDF, JPEG, PNG, WebP or HEIC, up to 10 MB). Send the returned `id` in `documents[].fileId` when submitting. Documents not attached to an application within 24 hours are deleted.',
  auth: false,
  body: { multipart: z.object({ file: z.string().meta({ format: 'binary' }) }) },
  ok: {
    201: z.object({
      id: z.string(),
      name: z.string().nullable(),
      contentType: z.string(),
      size: z.number(),
    }),
  },
  errors: { 422: 'UNSUPPORTED_FILE_TYPE | FILE_TOO_LARGE' },
});
op('post', '/doctor-applications', {
  tag: 'Provider applications',
  summary: 'Apply to join as a provider',
  description:
    'Creates a pending application. Required documents: practising_licence, registration_certificate, medical_degree, government_id, headshot, cv. When an admin approves it, a doctor account is created with this email and password and the applicant is emailed how to sign in to the doctor app.',
  auth: false,
  body: submitApplicationSchema,
  ok: {
    201: z.object({
      id: z.string(),
      reference: z.string(),
      status: z.literal('pending'),
      email: z.string(),
    }),
  },
  errors: {
    409: 'EMAIL_TAKEN — an account already uses this email | APPLICATION_EXISTS — an application for this email is under review',
  },
});
op('post', '/waitlist', {
  tag: 'Misc',
  summary: 'Join the delivery waitlist for an area',
  body: joinWaitlistSchema,
  ok: { 201: c.WaitlistEntry },
});
op('get', '/waitlist/status', {
  tag: 'Misc',
  summary: 'Have I joined the waitlist for this location?',
  query: waitlistStatusQuery,
  ok: { 200: z.object({ joined: z.boolean() }) },
});
op('post', '/uploads', {
  tag: 'Files',
  summary: 'Upload a file for a purpose (patients and doctors)',
  description: [
    'multipart/form-data with `purpose` and `file`. Each purpose has its own allowed types, size limit, uploaders and visibility:',
    PURPOSE_TABLE,
    '**Public** files get a permanent CDN link. **Private** files (medical records, chat attachments, doctor documents) are never publicly reachable: the API returns short-lived signed links, refreshed every time the file is returned to someone allowed to see it.',
    'Reference private files by `id`: send `fileId` in chat messages, report messages, lab result submissions and `PUT /doctors/me/certificate`.',
  ].join('\n\n'),
  body: { multipart: uploadDocSchema },
  ok: { 201: c.StoredFile },
  errors: {
    403: 'FORBIDDEN — your role cannot upload for this purpose',
    422: 'UNSUPPORTED_FILE_TYPE | FILE_TOO_LARGE',
    502: 'STORAGE_ERROR — upload to storage failed; retry',
  },
});
op('post', '/admin/auth/refresh', {
  tag: 'Auth',
  summary: 'Renew a admin session',
  description:
    'Exchange the `refreshToken` from login for a new access token and refresh token. Call it when a request returns 401. Each refresh token is single-use; a second use within 30 seconds (for example, two tabs refreshing together) is allowed, and later reuse ends the session.',
  auth: false,
  body: auth.refreshSchema,
  ok: { 200: z.object({ session: c.Session }) },
});
op('get', '/admin/commercial-fees', {
  tag: 'Admin',
  summary: 'Get the commercial fee policy',
  ok: { 200: z.object({ fees: c.CommercialFees }) },
});
op('put', '/admin/commercial-fees', {
  tag: 'Admin',
  summary: 'Update the commercial fee policy',
  description:
    'Requires an administrator role. The values affect new payment calculations; rates stored with a payment are retained for settlement.',
  body: feePolicyInputSchema,
  ok: { 200: z.object({ fees: c.CommercialFees }) },
  errors: { 403: 'FORBIDDEN — requires the administrator role' },
});
op('post', '/admin/auth/logout', {
  tag: 'Auth',
  summary: 'Sign a admin out on this device',
  auth: false,
  body: auth.refreshSchema,
  ok: { 204: null },
});
op('post', '/pharmacy-portal/auth/refresh', {
  tag: 'Auth',
  summary: 'Renew a pharmacy session',
  description:
    'Exchange the `refreshToken` from login for a new access token and refresh token. Call it when a request returns 401. Each refresh token is single-use; a second use within 30 seconds (for example, two tabs refreshing together) is allowed, and later reuse ends the session.',
  auth: false,
  body: auth.refreshSchema,
  ok: { 200: z.object({ session: c.Session }) },
});
op('post', '/pharmacy-portal/auth/logout', {
  tag: 'Auth',
  summary: 'Sign a pharmacy out on this device',
  auth: false,
  body: auth.refreshSchema,
  ok: { 204: null },
});
op('post', '/admin/uploads', {
  tag: 'Files',
  summary: 'Upload a file as an admin',
  description:
    'Same as `POST /uploads`, authenticated with an **admin** token. Admin purposes: `doctor_document`, `lab_result_report`, `blog_image`, `product_image`, `pharmacy_logo`. Attach a `doctor_document` to a doctor with `PATCH /admin/doctors/{id}` `{ certificateFileId }`.',
  body: { multipart: uploadDocSchema },
  ok: { 201: c.StoredFile },
  errors: { 403: 'FORBIDDEN', 422: 'UNSUPPORTED_FILE_TYPE | FILE_TOO_LARGE', 502: 'STORAGE_ERROR' },
});
op('post', '/pharmacy-portal/uploads', {
  tag: 'Files',
  summary: 'Upload a product image or logo as a pharmacy',
  description:
    'Authenticated with a **pharmacy** token. Purposes: `product_image`, `pharmacy_logo` (public). Use the returned `url` in product `images` or the pharmacy `image`.',
  body: { multipart: uploadDocSchema },
  ok: { 201: c.StoredFile },
  errors: { 403: 'FORBIDDEN', 422: 'UNSUPPORTED_FILE_TYPE | FILE_TOO_LARGE', 502: 'STORAGE_ERROR' },
});
op('get', '/pharmacy-portal/staff', {
  tag: 'Pharmacy portal',
  summary: 'List staff for the authenticated pharmacy',
  ok: {
    200: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          email: z.string().nullable(),
          phoneNumber: z.string().nullable(),
          role: z.string(),
          status: z.enum(['active', 'inactive']),
          createdAt: z.date(),
          updatedAt: z.date(),
        }),
      ),
    }),
  },
});
op('post', '/pharmacy-portal/staff', {
  tag: 'Pharmacy portal',
  summary: 'Create a staff account with a temporary password',
  description:
    'Owner-only. Staff sign in with the supplied email and temporary password and must change that password before using the workspace.',
  body: pharmacyPortal.staffSchema,
  ok: {
    201: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      phoneNumber: z.string().nullable(),
      role: z.string(),
      status: z.enum(['active', 'inactive']),
      createdAt: z.date(),
      updatedAt: z.date(),
    }),
  },
});
op('patch', '/pharmacy-portal/staff/:id', {
  tag: 'Pharmacy portal',
  summary: 'Update a staff account role or active status',
  description: 'Owner-only. Deactivating an account revokes its refresh sessions.',
  body: pharmacyPortal.updateStaffSchema,
  ok: {
    200: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      phoneNumber: z.string().nullable(),
      role: z.string(),
      status: z.enum(['active', 'inactive']),
      createdAt: z.date(),
      updatedAt: z.date(),
    }),
  },
});
const posPayment = z.object({
  method: z.enum(['cash', 'card', 'transfer', 'pos_terminal', 'other']),
  amount: z.number(),
  reference: z.string().nullable(),
});
const PosSale = z
  .object({
    id: z.string(),
    receiptNumber: z.string(),
    deviceId: z.string().nullable(),
    cashierStaffId: z.string().nullable(),
    cashierName: z.string(),
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
    subtotal: z.number(),
    discountTotal: z.number(),
    total: z.number(),
    payments: z.array(posPayment),
    amountTendered: z.number(),
    changeDue: z.number(),
    status: z.enum(['completed', 'voided']),
    notes: z.string().nullable(),
    voidReason: z.string().nullable(),
    voidedByName: z.string().nullable(),
    voidedAt: z.date().nullable(),
    stockWarnings: z
      .array(
        z.object({
          productId: z.string(),
          name: z.string(),
          requested: z.number(),
          available: z.number(),
        }),
      )
      .nullable(),
    soldAt: z.date(),
    createdAt: z.date(),
    items: z.array(
      z.object({
        id: z.string(),
        productId: z.string().nullable(),
        name: z.string(),
        sku: z.string().nullable(),
        batchNumber: z.string().nullable(),
        unitPrice: z.number(),
        discount: z.number(),
        quantity: z.number(),
        lineTotal: z.number(),
        unitCost: z.number().nullable().meta({ description: 'Null for non-manager roles' }),
      }),
    ),
  })
  .meta({ id: 'PosSale' });
const posSaleId = z.object({ id: z.string() });
op('post', '/pharmacy-portal/products/:id/stock', {
  tag: 'Pharmacy portal',
  summary: 'Adjust a product’s stock',
  description:
    'Pass a client-generated `id` (UUID) to make the adjustment idempotent: an offline till that retries the same adjustment gets the current stock back instead of applying it twice.',
  params: posSaleId,
  body: pharmacyPortal.stockSchema,
  ok: { 200: z.object({ id: z.string(), stockRemaining: z.number() }) },
  errors: { 404: 'NOT_FOUND', 409: 'MOVEMENT_ID_REUSED — the id belongs to another product' },
});
op('get', '/pharmacy-portal/pos/catalog', {
  tag: 'Pharmacy portal',
  summary: 'Download every sellable product for the offline till',
  description:
    'Everything a till needs to sell without a connection. `purchasePrice` is null for non-manager roles. Roles: manager, pharmacist, sales assistant, inventory officer.',
  ok: {
    200: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
      generatedAt: z.iso.datetime(),
    }),
  },
});
op('post', '/pharmacy-portal/pos/sales/sync', {
  tag: 'Pharmacy portal',
  summary: 'Upload counter sales recorded at the till (online or offline)',
  description: [
    'Each sale carries a till-generated UUID `id`; re-sending a sale returns `duplicate` with the stored sale, so retries are safe.',
    'Totals are recomputed on the server: each line is `round2(unitPrice × quantity)` less its `discount` %, then `saleDiscount` (managers only) comes off. A `total` that does not match is rejected.',
    'Stock is taken off the shelf. Stock that ran short while offline is recorded in `stockWarnings` rather than refusing the sale. Change may only be given from cash.',
    'Every sale is handled on its own: a rejected sale does not block the rest of the batch.',
  ].join('\n\n'),
  body: pharmacyPortal.posSyncSchema.extend({
    sales: z.array(pharmacyPortal.posSaleSchema).min(1).max(50),
  }),
  ok: {
    200: z.object({
      results: z.array(
        z.union([
          z.object({ id: z.string(), status: z.enum(['synced', 'duplicate']), sale: PosSale }),
          z.object({ id: z.string().nullable(), status: z.literal('rejected'), error: z.string() }),
        ]),
      ),
      syncedAt: z.iso.datetime(),
    }),
  },
});
op('get', '/pharmacy-portal/pos/sales', {
  tag: 'Pharmacy portal',
  summary: 'List counter sales',
  description: 'Managers see every sale; other staff see only the sales they rang up.',
  query: pharmacyPortal.posSalesListSchema,
  ok: {
    200: z.object({
      items: z.array(PosSale),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    }),
  },
});
op('get', '/pharmacy-portal/pos/sales/:id', {
  tag: 'Pharmacy portal',
  summary: 'Get one counter sale (for reprinting)',
  params: posSaleId,
  ok: { 200: PosSale },
  errors: { 403: 'FORBIDDEN — not your sale', 404: 'NOT_FOUND' },
});
op('post', '/pharmacy-portal/pos/sales/:id/void', {
  tag: 'Pharmacy portal',
  summary: 'Void a counter sale and return its stock',
  description: 'Manager or owner. Puts back only what the sale actually took off the shelf.',
  params: posSaleId,
  body: pharmacyPortal.posVoidSchema,
  ok: { 200: PosSale },
  errors: { 404: 'NOT_FOUND' },
});
op('get', '/pharmacy-portal/pos/summary', {
  tag: 'Pharmacy portal',
  summary: 'End-of-day totals for a time window',
  description:
    'Manager or owner. The till sends its local day bounds. Cash takings are net of change given.',
  query: pharmacyPortal.posSummarySchema,
  ok: {
    200: z.object({
      from: z.string(),
      to: z.string(),
      salesCount: z.number(),
      itemsSold: z.number(),
      gross: z.number(),
      discounts: z.number(),
      net: z.number(),
      averageSale: z.number(),
      costOfGoods: z.number(),
      grossProfit: z.number(),
      costComplete: z.boolean(),
      voidedCount: z.number(),
      voidedTotal: z.number(),
      payments: z.array(z.object({ method: z.string(), amount: z.number() })),
      cashiers: z.array(z.object({ name: z.string(), sales: z.number(), total: z.number() })),
      topProducts: z.array(
        z.object({ name: z.string(), quantity: z.number(), revenue: z.number() }),
      ),
      stockWarnings: z.array(
        z.object({
          productId: z.string(),
          name: z.string(),
          requested: z.number(),
          available: z.number(),
          receiptNumber: z.string(),
        }),
      ),
    }),
  },
});
const Payout = z
  .object({
    id: z.string(),
    pharmacyId: z.string(),
    reference: z.string(),
    amount: z.number(),
    currency: z.string(),
    trigger: z.enum(['on_demand', 'scheduled']),
    status: z.enum(['pending_approval', 'processing', 'paid', 'failed', 'rejected', 'cancelled']),
    bankName: z.string(),
    accountNumber: z.string(),
    accountName: z.string(),
    requestedBy: z.string(),
    approvedBy: z.string().nullable(),
    approvedAt: z.date().nullable(),
    transferCode: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    lastError: z.string().nullable(),
    paidAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .meta({ id: 'PharmacyPayout' });
const LedgerEntry = z
  .object({
    id: z.string(),
    type: z.enum(['order_earning', 'order_reversal', 'payout', 'payout_reversal', 'adjustment']),
    amount: z.number(),
    balanceAfter: z.number(),
    description: z.string(),
    orderId: z.string().nullable(),
    payoutId: z.string().nullable(),
    createdBy: z.string().nullable(),
    availableAt: z.date(),
    createdAt: z.date(),
  })
  .meta({ id: 'PharmacyLedgerEntry' });
const BankAccount = z
  .object({
    bankCode: z.string(),
    bankName: z.string(),
    accountNumber: z.string(),
    accountName: z.string(),
    updatedAt: z.date(),
  })
  .meta({ id: 'PharmacyBankAccount' });
const PayoutSummary = z.object({
  balance: z.number(),
  available: z.number().meta({ description: 'Withdrawable now' }),
  pending: z.number().meta({ description: 'Still in the clearing period' }),
  currency: z.string(),
  totalPaidOut: z.number(),
  openPayout: Payout.nullable(),
  bankAccount: BankAccount.nullable(),
  clearingHour: z
    .number()
    .meta({ description: 'Earnings clear at this Lagos hour on the day after delivery' }),
  nextWeeklyPayoutAt: z.iso.datetime().nullable(),
});
const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number(), limit: z.number(), offset: z.number() });
const PAYOUT_FLOW =
  'Earnings from delivered orders land in the pharmacy ledger and become withdrawable after the clearing period. A withdrawal reserves the money at once and waits for an admin; approval sends a Paystack Transfer to the verified bank account, and `transfer.*` webhooks settle it. Pharmacies that did not withdraw are paid out weekly.';

op('get', '/pharmacy-portal/payouts/summary', {
  tag: 'Pharmacy portal',
  summary: 'Balances, bank account and the payout in progress',
  description: `${PAYOUT_FLOW}\n\nOwner or manager.`,
  ok: { 200: PayoutSummary },
});
op('get', '/pharmacy-portal/payouts', {
  tag: 'Pharmacy portal',
  summary: 'Payout history',
  query: payoutSchemas.payoutListSchema,
  ok: { 200: page(Payout) },
});
op('get', '/pharmacy-portal/payouts/ledger', {
  tag: 'Pharmacy portal',
  summary: 'Earnings statement (every credit and debit)',
  query: payoutSchemas.pageSchema,
  ok: { 200: page(LedgerEntry) },
});
op('get', '/pharmacy-portal/payouts/banks', {
  tag: 'Pharmacy portal',
  summary: 'Nigerian banks payouts can be sent to',
  description: 'Owner only.',
  ok: { 200: z.object({ items: z.array(z.object({ name: z.string(), code: z.string() })) }) },
});
op('put', '/pharmacy-portal/payouts/bank-account', {
  tag: 'Pharmacy portal',
  summary: 'Set the payout bank account',
  description:
    'Owner only. The account is resolved with the bank and the bank’s account name is stored. The owner is emailed on every change. Blocked while a payout is in progress.',
  body: payoutSchemas.bankAccountSchema,
  ok: { 200: BankAccount },
  errors: { 409: 'PAYOUT_IN_PROGRESS', 422: 'ACCOUNT_NOT_FOUND' },
});
op('post', '/pharmacy-portal/payouts', {
  tag: 'Pharmacy portal',
  summary: 'Request a withdrawal',
  description:
    'Owner only. Reserves the amount from the available balance and queues it for admin approval. One payout in progress at a time.',
  body: payoutSchemas.payoutRequestSchema,
  ok: { 201: Payout },
  errors: { 409: 'PAYOUT_IN_PROGRESS', 422: 'NO_BANK_ACCOUNT | INSUFFICIENT_BALANCE' },
});
op('post', '/pharmacy-portal/payouts/:id/cancel', {
  tag: 'Pharmacy portal',
  summary: 'Cancel a withdrawal awaiting approval',
  params: idParam,
  ok: { 200: Payout },
});

op('get', '/admin/payouts/overview', {
  tag: 'Admin',
  summary: 'Payout queue totals, next weekly run and settings',
  description: PAYOUT_FLOW,
  ok: { 200: z.record(z.string(), z.unknown()) },
});
op('get', '/admin/payouts', {
  tag: 'Admin',
  summary: 'All pharmacy payouts',
  query: payoutSchemas.payoutListSchema,
  ok: { 200: page(Payout.extend({ pharmacyName: z.string() })) },
});
op('get', '/admin/payouts/balances', {
  tag: 'Admin',
  summary: 'What each pharmacy is owed',
  query: payoutSchemas.balancesListSchema,
  ok: { 200: page(z.record(z.string(), z.unknown())) },
});
op('get', '/admin/payouts/gateway-balance', {
  tag: 'Admin',
  summary: 'Paystack balance available for transfers',
  ok: {
    200: z.object({ balance: z.object({ currency: z.string(), amount: z.number() }).nullable() }),
  },
});
op('put', '/admin/payouts/settings', {
  tag: 'Admin',
  summary: 'Weekly schedule, clearing period, auto-approval',
  body: payoutSchemas.settingsUpdateSchema,
  ok: { 200: z.record(z.string(), z.unknown()) },
});
op('post', '/admin/payouts/run-weekly', {
  tag: 'Admin',
  summary: 'Create this week’s payouts now',
  ok: {
    200: z
      .object({ runId: z.string(), payoutCount: z.number(), totalAmount: z.number() })
      .nullable(),
  },
});
op('post', '/admin/payouts/approve', {
  tag: 'Admin',
  summary: 'Approve and send several payouts',
  description: 'Stops early if Paystack reports its balance is too low.',
  body: payoutSchemas.approveManySchema,
  ok: {
    200: z.object({
      results: z.array(
        z.object({
          id: z.string(),
          ok: z.boolean(),
          status: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
  },
});
op('post', '/admin/payouts/:id/approve', {
  tag: 'Admin',
  summary: 'Approve a payout and send it via Paystack',
  description:
    'A Paystack refusal returns the payout to the approval queue with `lastError`; an unknown outcome leaves it processing until the webhook or reconciliation settles it.',
  params: idParam,
  ok: { 200: Payout },
  errors: { 422: 'TRANSFER_REFUSED' },
});
op('post', '/admin/payouts/:id/reject', {
  tag: 'Admin',
  summary: 'Decline a payout; the money returns to the pharmacy balance',
  params: idParam,
  body: payoutSchemas.rejectSchema,
  ok: { 200: Payout },
});
op('get', '/admin/pharmacies/:id/ledger', {
  tag: 'Admin',
  summary: 'A pharmacy’s earnings statement and payout summary',
  params: idParam,
  query: payoutSchemas.pageSchema,
  ok: { 200: page(LedgerEntry).extend({ summary: PayoutSummary }) },
});
op('post', '/admin/pharmacies/:id/ledger-adjustments', {
  tag: 'Admin',
  summary: 'Credit or debit a pharmacy balance with a reason',
  params: idParam,
  body: payoutSchemas.adjustmentSchema,
  ok: { 200: z.object({ balance: z.number(), available: z.number(), pending: z.number() }) },
});
const DIRECT_UPLOAD = [
  '**Preferred upload flow** — the file goes straight to storage, never through the API:',
  '1. `POST …/uploads/presign` with `purpose`, `contentType`, exact `size` (bytes) and optional `name`. The purpose policy (type, size, who may upload) is checked here.',
  '2. `PUT` the raw bytes to `upload.url` with `upload.headers`. The URL only accepts that exact type and size, and expires after 15 minutes.',
  '3. `POST …/uploads/{fileId}/complete`. The API checks the stored object (size, type, real file signature) and returns the file. Only completed files can be attached; unconfirmed uploads are deleted after 24 hours.',
].join('\n\n');
const presignErrors = {
  403: 'FORBIDDEN — your role cannot upload for this purpose',
  422: 'UNSUPPORTED_FILE_TYPE | FILE_TOO_LARGE',
} as const;
const completeErrors = {
  400: 'BAD_REQUEST — file content does not match its declared type (the upload is discarded)',
  404: 'NOT_FOUND — no such pending upload of yours',
  409: 'UPLOAD_NOT_RECEIVED — nothing has been PUT to the upload URL yet',
  422: 'UPLOAD_MISMATCH — stored size or type differs from what was declared (the upload is discarded)',
  502: 'STORAGE_ERROR',
} as const;
const uploadIdParam = z.object({
  id: z.string().meta({ description: 'The `fileId` from presign' }),
});
for (const [prefix, who] of [
  ['', 'patients and doctors'],
  ['/admin', 'admins'],
  ['/pharmacy-portal', 'pharmacies'],
] as const) {
  op('post', `${prefix}/uploads/presign`, {
    tag: 'Files',
    summary: `Start a direct upload (${who})`,
    description: `${DIRECT_UPLOAD}\n\n${PURPOSE_TABLE}`,
    body: presignUploadSchema,
    ok: { 201: c.UploadSession },
    errors: presignErrors,
  });
  op('post', `${prefix}/uploads/:id/complete`, {
    tag: 'Files',
    summary: `Confirm a direct upload (${who})`,
    description: 'Verifies the stored object and makes the file usable. Safe to retry.',
    params: uploadIdParam,
    ok: { 200: c.StoredFile },
    errors: completeErrors,
  });
}
op('post', '/admin/lab-results/:id/result', {
  tag: 'Files',
  summary: 'Publish an interpreted lab result from an uploaded file (admins)',
  description:
    'Upload with purpose `lab_result_report` via `/admin/uploads/presign`, then send its `fileId` with any result fields. Marks the result completed.',
  params: idParam,
  body: z.object({
    fileId: z.string(),
    testName: z.string().nullable().optional(),
    laboratoryName: z.string().nullable().optional(),
    interpretation: z.string().nullable().optional(),
    adminResponse: z.string().nullable().optional(),
  }),
  ok: {
    201: z
      .object({ id: z.string(), status: z.string(), resultUrl: z.string().nullable() })
      .passthrough(),
  },
  errors: {
    403: 'FORBIDDEN — requires the admin role',
    404: 'NOT_FOUND',
    422: 'WRONG_FILE_PURPOSE',
  },
});
op('get', '/files/:id', {
  tag: 'Files',
  summary: 'One of my uploads, with a fresh link',
  description: 'Use when a signed link has expired.',
  params: idParam,
  ok: { 200: c.StoredFile },
  errors: { 404: 'NOT_FOUND' },
});
op('put', '/doctors/me/certificate', {
  tag: 'Files',
  summary: 'Attach my licence or certificate (doctors)',
  description: 'Upload first with purpose `doctor_document`, then send its `fileId`.',
  role: 'doctor',
  body: certificateSchema,
  ok: { 200: z.object({ certificateUrl: z.url().nullable() }) },
  errors: { 404: 'NOT_FOUND — file is not yours', 422: 'WRONG_FILE_PURPOSE' },
});
op('get', '/settings', {
  tag: 'Misc',
  summary: 'App settings (feature flags, version, marquee)',
  auth: false,
  ok: { 200: c.AppSettings },
});
op('get', '/currencies', {
  tag: 'Misc',
  summary: 'Supported currencies',
  auth: false,
  ok: { 200: c.ItemsOf(z.object({ code: z.string() }), 'Currency') },
});
op('get', '/video-call/credentials', {
  tag: 'Misc',
  summary: 'Active video call (ZEGOCLOUD) credentials',
  ok: { 200: c.VideoCallCredentials },
  errors: { 404: 'NOT_FOUND' },
});

// ─── Document ────────────────────────────────────────────────────────────────

const OVERVIEW = `
Core API for the Instant Doctor patient app.

## Authentication
Send \`Authorization: Bearer <accessToken>\`. Access tokens expire after ~15 minutes; exchange the refresh token at \`POST /api/v1/auth/refresh\` (refresh tokens rotate — always store the new one).

## Errors
Every error is \`{ "error": { "code", "message", "details?" } }\`. Branch on \`code\`, not on \`message\`.

## Idempotency
Operations marked **Idempotent** require an \`Idempotency-Key\` header. Generate one UUID per user intent and reuse it for retries: the first result is replayed (\`Idempotent-Replayed: true\`) instead of booking or charging twice. Keys are kept for 24 hours.

## Pagination
List endpoints take \`limit\` and \`offset\` (chat uses a \`before\` timestamp cursor) and return \`nextOffset\` / \`nextBefore\`, \`null\` on the last page.

## Realtime (Socket.IO)
Connect with \`io(BASE_URL, { auth: { token } })\`. You join your personal room automatically; emit \`appointment:join\` (appointment id, ack) to receive that chat.

| Event | Payload |
| --- | --- |
| \`message:new\`, \`message:updated\` | Message |
| \`messages:read\` | \`{ appointmentId, readerId }\` |
| \`appointment:updated\` | \`{ id, status, isPaid }\` |
| \`notification:new\` | Notification |
| \`payment:updated\` | \`{ reference, status, purpose }\` |
`.trim();

export function buildOpenApiDocument(serverUrl: string) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Instant Doctor API', version: '1.0.0', description: OVERVIEW },
    servers: [{ url: serverUrl }],
    tags: [
      { name: 'Auth', description: 'Registration, sign-in (email, Google, Apple) and sessions' },
      { name: 'Users', description: 'Profile, devices and saved locations' },
      { name: 'Doctors' },
      { name: 'Appointments', description: 'Booking, open requests and lifecycle' },
      { name: 'Chat', description: 'Consultation messaging' },
      { name: 'Clinical', description: 'Prescriptions, reviews and reports' },
      { name: 'Payments', description: 'Stripe, Paystack and Flutterwave' },
      { name: 'Wallet', description: 'Wallet, transfers and referrals' },
      { name: 'Pharmacy', description: 'Pharmacies, products and orders' },
      { name: 'Health', description: 'Lab results and medication tracking' },
      { name: 'Family', description: 'Family profiles and shareable care summaries' },
      { name: 'Content', description: 'Health tips and anonymous questions' },
      { name: 'Notifications' },
      {
        name: 'Files',
        description:
          'Uploads for every purpose: avatars, chat, lab results, doctor documents, blog and product images',
      },
      { name: 'Misc' },
      { name: 'System' },
    ],
  });
}
