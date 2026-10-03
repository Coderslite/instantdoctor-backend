import { z } from 'zod';
import { isoDateTime } from '../../lib/validation.js';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    phoneNumber: optionalText(32),
    photoUrl: z.url().max(1024).nullable().optional(),
    gender: optionalText(32),
    dateOfBirth: isoDateTime().nullable().optional(),
    maritalStatus: optionalText(32),
    stateOfOrigin: optionalText(64),
    otherLanguage: optionalText(255),
    country: z.string().trim().length(2).toUpperCase().optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    address: optionalText(512),
    location: z
      .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
      .nullable()
      .optional(),
    medical: z
      .object({
        height: optionalText(16),
        weight: optionalText(16),
        bloodGroup: optionalText(8),
        genotype: optionalText(8),
        surgicalHistory: optionalText(5000),
      })
      .optional(),
  })
  .strict();

export const fcmTokenSchema = z.object({ token: z.string().trim().min(10).max(512).nullable() });

export const presenceSchema = z.object({ presence: z.enum(['online', 'offline', 'away']) });

export const savedLocationSchema = z.object({
  name: z.string().trim().min(1).max(128),
  address: z.string().trim().min(1).max(512),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const tagSchema = z.object({
  tag: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,32}$/, 'Use 3-32 letters, digits or underscores'),
});
