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
import { listReferralsQuery } from '../modules/referrals/referrals.schemas.js';
import * as reports from '../modules/reports/reports.schemas.js';
import { FILE_POLICIES, FILE_PURPOSES } from '../modules/files/file-policies.js';
import { presignUploadSchema, uploadDocSchema } from '../modules/files/files.schemas.js';
import { certificateSchema } from '../modules/doctors/doctors.schemas.js';
import * as users from '../modules/users/users.schemas.js';
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
  summary: 'Update my profile, region and medical details',
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
  summary: 'Paid open requests awaiting a doctor',
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
  body: z.object({ prescription: z.string().min(1).max(5000) }),
  ok: { 201: c.Prescription },
});
op('patch', '/appointments/:id/prescriptions/:prescriptionId', {
  tag: 'Clinical',
  summary: 'Correct a prescription (issuing doctor only)',
  params: z.object({ id: z.string(), prescriptionId: z.string() }),
  body: z.object({ prescription: z.string().min(1).max(5000) }),
  ok: { 200: c.Prescription },
});
op('delete', '/appointments/:id/prescriptions/:prescriptionId', {
  tag: 'Clinical',
  summary: 'Delete a prescription (issuing doctor only)',
  params: z.object({ id: z.string(), prescriptionId: z.string() }),
  ok: { 204: null },
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
  body: pharmacy.cartSchema,
  ok: { 200: c.CartQuote },
  errors: { 422: 'OUT_OF_STOCK | PHARMACY_NOT_DELIVERABLE' },
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
  summary: 'Order details and tracking status',
  params: idParam,
  ok: { 200: c.Order },
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
const tokenParam = z.object({ token: z.string().meta({ description: 'Share token from the link' }) });

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
  description: 'The returned `url` contains the token and is shown only once. Links expire and can be revoked.',
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
  description: 'Public. Browsers (`Accept: text/html`) get a print-friendly page; API clients get JSON.',
  auth: false,
  params: tokenParam,
  ok: {
    200: z.object({ summary: c.CareSummary, sharedBy: z.string().nullable(), expiresAt: z.iso.datetime() }),
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
