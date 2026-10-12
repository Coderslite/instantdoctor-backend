import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) =>
  text(max)
    .nullish()
    .transform((v) => v || null);

export const prescriptionItemSchema = z.object({
  name: text(200).min(2),
  strength: optional(60),
  form: optional(40),
  directions: text(500).min(2),
  durationDays: z.number().int().min(1).max(365).nullish(),
  /** Units (packs) the patient may be dispensed in total. */
  quantity: z.number().int().min(1).max(100).default(1),
});

export const prescriptionSchema = z
  .object({
    /** Older clients: the whole prescription as text. */
    prescription: text(5000).optional(),
    notes: text(5000).nullish(),
    items: z.array(prescriptionItemSchema).max(20).optional(),
  })
  .refine((v) => (v.items?.length ?? 0) > 0 || Boolean((v.prescription ?? v.notes)?.trim()), {
    message: 'Add at least one medicine or write the prescription',
    path: ['items'],
  });

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyOptionsQuery = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(100).default(15),
});
