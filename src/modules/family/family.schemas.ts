import { z } from 'zod';
import { FAMILY_RELATIONSHIPS, SEXES } from '../../db/schema/family.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

export const familyProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  relationship: z.enum(FAMILY_RELATIONSHIPS),
  dateOfBirth: z.iso
    .date()
    .refine((d) => new Date(d) <= new Date(), 'Date of birth cannot be in the future')
    .nullable()
    .default(null),
  sex: z.enum(SEXES).nullable().default(null),
  bloodGroup: optionalText(8).default(null),
  genotype: optionalText(8).default(null),
  allergies: optionalText(2000).default(null),
  conditions: optionalText(2000).default(null),
  caregiverReminders: z.boolean().default(true),
});

export const updateFamilyProfileSchema = familyProfileSchema.partial();

/**
 * Which person a request is about: a family profile id, or `me` / absent for
 * the account owner. Used by care plans, medications and care summaries.
 */
export const profileQuerySchema = z.object({
  profileId: z.union([z.literal('me'), z.uuid()]).optional(),
});

export const profileRefSchema = z.uuid().nullable().optional();

export const createShareSchema = z.object({
  profileId: z.uuid().nullable().default(null),
  /** 1 hour to 7 days; links are deliberately short-lived. */
  expiresInHours: z.number().int().min(1).max(168).default(72),
});
