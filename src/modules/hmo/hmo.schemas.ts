import { z } from 'zod';
import {
  HMO_ACTIVITY_ACTORS,
  HMO_CLAIM_STATUSES,
  HMO_COVERAGE_TYPES,
  HMO_ENROLLEE_STATUSES,
  HMO_LIMIT_PERIODS,
  HMO_OVER_LIMIT,
  HMO_SERVICES,
  HMO_STATUSES,
  HMO_USER_ROLES,
} from '../../db/schema/index.js';

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) =>
  text(max)
    .nullish()
    .transform((v) => (v === undefined ? v : v || null));
const amount = z.number().min(0).max(100_000_000).multipleOf(0.01);
/** A date-only value is a whole day in Lagos: starts at 00:00, ends at 23:59:59 (WAT, UTC+1). */
const lagosDay = (edge: 'start' | 'end') =>
  z.iso
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .or(
      z.iso
        .date()
        .transform(
          (d) => new Date(`${d}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}+01:00`),
        ),
    )
    .nullish();
const startDate = lagosDay('start');
const endDate = lagosDay('end');
const dateOfBirth = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .or(z.literal('').transform(() => null))
  .nullish();

// ── Agreements ──────────────────────────────────────────────────────────────

export const hmoSchema = z.object({
  name: text(200).min(2),
  code: text(20)
    .min(2)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and dashes only')
    .transform((v) => v.toUpperCase()),
  logo: z
    .url()
    .max(1024)
    .nullish()
    .or(z.literal('').transform(() => null)),
  contactName: optional(200),
  contactEmail: z
    .email()
    .max(191)
    .nullish()
    .or(z.literal('').transform(() => null)),
  contactPhone: optional(32),
  address: optional(500),
  status: z.enum(HMO_STATUSES).default('active'),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  notes: optional(5000),
});
export const updateHmoSchema = hmoSchema.partial();

export const planSchema = z.object({
  name: text(120).min(1),
  isActive: z.boolean().default(true),
  validFrom: startDate,
  validTo: endDate,
  notes: optional(5000),
});
export const updatePlanSchema = planSchema.partial();

const ruleFields = z.object({
  service: z.enum(HMO_SERVICES),
  /** Consultations: one package, or null/absent for all packages. */
  packageId: z.string().max(36).nullish(),
  coverage: z.enum(HMO_COVERAGE_TYPES),
  patientAmount: amount.nullish(),
  percent: z.number().min(0).max(100).multipleOf(0.01).nullish(),
  hmoAmount: amount.nullish(),
  doctorEarning: amount.nullish(),
  limitCount: z.number().int().min(1).max(10_000).nullish(),
  /** Medicines: the most the HMO pays per period, in naira. */
  limitAmount: amount.nullish(),
  limitPeriod: z.enum(HMO_LIMIT_PERIODS).nullish(),
  overLimit: z.enum(HMO_OVER_LIMIT).default('standard_price'),
  isActive: z.boolean().default(true),
});

/** Each coverage type needs its own numbers; reject agreements that can't be priced. */
function checkRule(rule: z.infer<typeof ruleFields>, ctx: z.RefinementCtx) {
  const need = (field: 'patientAmount' | 'percent', message: string) => {
    if (rule[field] === null || rule[field] === undefined)
      ctx.addIssue({ code: 'custom', path: [field], message });
  };
  if (rule.coverage === 'copay_fixed' || rule.coverage === 'fixed_price')
    need('patientAmount', 'Enter what the patient pays');
  if (rule.coverage === 'copay_percent' || rule.coverage === 'discount_percent')
    need('percent', 'Enter the percentage');
  if (rule.service !== 'consultation' && rule.packageId) {
    ctx.addIssue({
      code: 'custom',
      path: ['packageId'],
      message: 'Only consultation rules apply to a package',
    });
  }
  if (rule.service !== 'consultation' && rule.doctorEarning != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['doctorEarning'],
      message: 'Doctor pay applies to consultations only',
    });
  }
  if ((rule.limitCount || rule.limitAmount) && !rule.limitPeriod)
    ctx.addIssue({ code: 'custom', path: ['limitPeriod'], message: 'Choose the limit period' });
  if (rule.service === 'medicines') {
    // The pharmacy is always paid in full, so the HMO must pay whatever the patient doesn't:
    // discounts nobody is billed for, and per-order tariffs, don't apply to medicines.
    if (!MEDICINE_COVERAGE.includes(rule.coverage))
      ctx.addIssue({
        code: 'custom',
        path: ['coverage'],
        message: 'Medicines can be fully covered, have a co-pay, or be excluded',
      });
    if (rule.hmoAmount != null)
      ctx.addIssue({
        code: 'custom',
        path: ['hmoAmount'],
        message: 'The HMO is billed for the medicines actually dispensed',
      });
  } else if (rule.limitAmount != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['limitAmount'],
      message: 'An amount limit applies to medicines only',
    });
  }
}

export const MEDICINE_COVERAGE: readonly string[] = ['full', 'copay_fixed', 'copay_percent', 'not_covered'];

export const ruleSchema = ruleFields.superRefine(checkRule);
export type RuleInput = z.infer<typeof ruleSchema>;

export const pricePreviewQuery = z.object({ planId: z.string().max(36) });

// ── Enrollees ───────────────────────────────────────────────────────────────

const enrolleeFields = {
  planId: z.string().max(36),
  enrolleeCode: text(64).min(1),
  firstName: optional(100),
  lastName: optional(100),
  phone: optional(32),
  email: z
    .email()
    .max(191)
    .nullish()
    .or(z.literal('').transform(() => null)),
  dateOfBirth,
  status: z.enum(HMO_ENROLLEE_STATUSES).default('active'),
  validFrom: startDate,
  validTo: endDate,
};
export const enrolleeSchema = z.object(enrolleeFields);
export type EnrolleeInput = z.infer<typeof enrolleeSchema>;

export const updateEnrolleeSchema = z
  .object(enrolleeFields)
  .omit({ enrolleeCode: true })
  .partial()
  .extend({
    /** Link to an app account (admin), or null to unlink. */
    userId: z.string().max(36).nullish(),
  });

/** Spreadsheet rows, already parsed by the admin; the plan applies to every row unless a row names one. */
export const importSchema = z.object({
  planId: z.string().max(36),
  rows: z
    .array(
      z.object({
        enrolleeCode: text(64).min(1),
        firstName: optional(100),
        lastName: optional(100),
        phone: optional(32),
        email: z.string().trim().max(191).nullish(),
        dateOfBirth: z.string().trim().max(20).nullish(),
        validTo: z.string().trim().max(30).nullish(),
      }),
    )
    .min(1)
    .max(20_000),
  /** End memberships of this plan that are missing from the file (a full monthly list). */
  endMissing: z.boolean().default(false),
});

export const enrolleesQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(HMO_ENROLLEE_STATUSES).optional(),
  planId: z.string().max(36).optional(),
  linked: z.enum(['yes', 'no']).optional(),
  /** Active members whose cover ends within this many days. */
  expiringWithinDays: z.coerce.number().int().min(1).max(366).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Claims & invoices ───────────────────────────────────────────────────────

export const claimsQuery = z.object({
  status: z.enum(HMO_CLAIM_STATUSES).optional(),
  service: z.enum(HMO_SERVICES).optional(),
  enrolleeId: z.string().max(36).optional(),
  /** Enrollee code or patient name. */
  search: z.string().trim().max(100).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const claimUpdateSchema = z.object({
  status: z.enum(['unbilled', 'rejected', 'void']),
  note: optional(500),
});

export const invoiceSchema = z.object({
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  notes: optional(5000),
});

export const invoiceUpdateSchema = z.object({
  status: z.enum(['paid', 'cancelled']),
  paymentReference: optional(120),
});

// ── Members (app) ───────────────────────────────────────────────────────────

export const linkSchema = z
  .object({
    hmoId: z.string().max(36),
    enrolleeCode: text(64).min(1),
    /** At least one detail the HMO has on file, to prove the card is theirs. */
    lastName: optional(100),
    phone: optional(32),
    dateOfBirth,
  })
  .refine((v) => v.lastName || v.phone || v.dateOfBirth, {
    message: 'Add your surname, phone number or date of birth as on your HMO record',
    path: ['lastName'],
  });

export const linkRequestsQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const approveLinkSchema = z.object({ enrolleeId: z.string().max(36) });
export const rejectLinkSchema = z.object({ note: optional(500) });

// ── Portal accounts & activity ──────────────────────────────────────────────

const password = z.string().min(8).max(128);

export const hmoUserSchema = z.object({
  name: text(200).min(2),
  email: z.email().max(191),
  role: z.enum(HMO_USER_ROLES),
  /** Temporary: the person must choose their own at first sign-in. */
  password,
});
export const updateHmoUserSchema = z
  .object({
    name: text(200).min(2).optional(),
    role: z.enum(HMO_USER_ROLES).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export const resetPasswordSchema = z.object({ password });

export const activityQuery = z.object({
  entityType: z.string().trim().max(32).optional(),
  entityId: z.string().max(36).optional(),
  actorType: z.enum(HMO_ACTIVITY_ACTORS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
