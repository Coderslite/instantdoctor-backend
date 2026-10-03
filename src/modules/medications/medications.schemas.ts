import { z } from 'zod';
import { isoDateTime } from '../../lib/validation.js';

/** "HH:MM" wall-clock time on the patient's device. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

export const medicationSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    prescription: z.string().trim().max(5000).default(''),
    startTime: isoDateTime(),
    endTime: isoDateTime(),
    morningTime: clockTime.nullable().default(null),
    middayTime: clockTime.nullable().default(null),
    eveningTime: clockTime.nullable().default(null),
    intervalHours: z.number().int().min(0).max(72).default(0),
  })
  .refine((m) => m.endTime > m.startTime, { message: 'endTime must be after startTime', path: ['endTime'] });

export const updateMedicationSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    prescription: z.string().trim().max(5000),
    startTime: isoDateTime(),
    endTime: isoDateTime(),
    morningTime: clockTime.nullable(),
    middayTime: clockTime.nullable(),
    eveningTime: clockTime.nullable(),
    intervalHours: z.number().int().min(0).max(72),
  })
  .partial();

export const doseSchema = z.object({
  date: z.iso.date(),
  time: clockTime,
  status: z.enum(['taken', 'missed']),
});
