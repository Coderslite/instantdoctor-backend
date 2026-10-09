import { z } from 'zod';
import { DOCTOR_APPLICATION_STATUSES, DOCTOR_DOCUMENT_TYPES } from '../../db/schema/index.js';
import { isCountryCode, toE164 } from '../../lib/phone.js';

const text = (max: number) => z.string().trim().min(1, 'Required').max(max);
const optionalText = (max: number) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), z.string().trim().max(max).nullable().optional());
const year = z.string().trim().regex(/^(19|20)\d{2}$/, 'Enter a 4-digit year');
const optionalDate = z.preprocess((value) => (value === '' ? null : value), z.coerce.date().nullable().optional());

export const submitApplicationSchema = z
  .object({
    email: z.email().trim().toLowerCase().max(191),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    firstName: text(100),
    lastName: text(100),
    country: z.string().trim().toUpperCase().refine(isCountryCode, 'Choose your country'),
    phoneNumber: z.string().trim().max(32),
    gender: optionalText(32),
    dateOfBirth: optionalDate,
    state: optionalText(64),
    address: optionalText(512),

    specialization: text(128),
    experienceYears: z.coerce.number().int().min(0).max(70),
    licenceNumber: text(64),
    licensingBody: text(128),
    licenceExpiresAt: optionalDate,
    institution: text(255),
    graduationYear: year,
    housemanship: optionalText(255),
    housemanshipYear: z.preprocess((value) => (value === '' ? null : value), year.nullable().optional()),
    workplace: optionalText(255),
    languages: optionalText(255),
    bio: optionalText(2000),

    documents: z
      .array(z.object({ type: z.enum(DOCTOR_DOCUMENT_TYPES), fileId: z.string().trim().min(1).max(36) }))
      .min(1)
      .max(12),
    acceptTerms: z.literal(true, 'Please confirm the declaration to submit'),
  })
  .transform((input, ctx) => {
    const phoneNumber = toE164(input.phoneNumber, input.country);
    if (!phoneNumber) {
      ctx.addIssue({ code: 'custom', path: ['phoneNumber'], message: 'Enter a valid phone number' });
      return z.NEVER;
    }
    return { ...input, phoneNumber };
  });

export type SubmitApplicationInput = z.infer<typeof submitApplicationSchema>;

export const listApplicationsQuery = z.object({
  status: z.enum(DOCTOR_APPLICATION_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const approveApplicationSchema = z.object({ note: optionalText(2000) });
export const rejectApplicationSchema = z.object({ reason: text(2000) });
