import { z } from 'zod';
import { PHARMACY_APPLICATION_STATUSES } from '../../db/schema/index.js';

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

/** The "Partner with us" form on the website. */
export const applicationSchema = z.object({
  pharmacyName: text(255).min(2, 'Enter your pharmacy’s name'),
  contactName: text(200).min(1, 'Enter your name'),
  contactRole: optional(120),
  email: z.email('Enter a valid email address').trim().toLowerCase().max(191),
  phone: text(32).min(7, 'Enter a phone number we can reach you on'),
  address: text(512).min(5, 'Enter the pharmacy’s street address'),
  city: optional(120),
  state: optional(120),
  licenceNumber: optional(80),
  branches: optional(40),
  /** From the address picker; both or neither. */
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  message: optional(5000),
}).transform((v) => (v.latitude == null || v.longitude == null ? { ...v, latitude: null, longitude: null } : v));

export const applicationsQuery = z.object({
  status: z.enum(PHARMACY_APPLICATION_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The pharmacy to create (the reviewer can correct the applicant's details) and the owner login. */
export const approveApplicationSchema = z.object({
  name: text(255).min(2),
  /** The owner's sign-in email for the pharmacy portal. */
  email: z.email().trim().toLowerCase().max(191),
  phoneNumber: optional(32),
  address: optional(512),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  note: optional(2000),
});

export const rejectApplicationSchema = z.object({ reason: text(2000).min(1, 'Give a reason') });
