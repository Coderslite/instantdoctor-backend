import { z } from 'zod';
import { isoDateTime } from '../../lib/validation.js';

export const carePlanKind = z.enum(['hypertension', 'diabetes', 'general']);

export const carePlanSchema = z.object({
  /** Family member the plan is for; null/absent = the account owner. */
  profileId: z.uuid().nullable().default(null),
  kind: carePlanKind,
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(5000).default(''),
  nextReviewAt: isoDateTime().nullable().default(null),
});

export const updateCarePlanSchema = carePlanSchema
  .omit({ profileId: true })
  .extend({ isActive: z.boolean() })
  .partial();

export const vitalReadingSchema = z
  .object({
    systolic: z.number().int().min(40).max(300).nullable().default(null),
    diastolic: z.number().int().min(20).max(200).nullable().default(null),
    glucose: z.number().int().min(10).max(1000).nullable().default(null),
    measuredAt: isoDateTime().default(() => new Date()),
    note: z.string().trim().max(500).default(''),
  })
  .superRefine((reading, ctx) => {
    const hasBloodPressure = reading.systolic !== null || reading.diastolic !== null;
    if (hasBloodPressure && (reading.systolic === null || reading.diastolic === null)) {
      ctx.addIssue({ code: 'custom', message: 'Enter both systolic and diastolic readings', path: ['systolic'] });
    }
    if (!hasBloodPressure && reading.glucose === null) {
      ctx.addIssue({ code: 'custom', message: 'Enter a blood pressure or glucose reading' });
    }
  });
