import { z } from 'zod';

export const MAIL_SEGMENTS = ['patients', 'doctors', 'everyone'] as const;
export type MailSegment = (typeof MAIL_SEGMENTS)[number];

/** Letters are capped so a mistake can't mail the whole database twice over. */
export const MAX_RECIPIENTS = 5000;

const letterFields = {
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1, 'Write the letter before sending').max(200_000),
  signatureName: z.string().trim().min(1).max(128),
  signatureTitle: z.string().trim().max(128).nullish(),
};

export const previewSchema = z.object({
  ...letterFields,
  subject: letterFields.subject.or(z.literal('').transform(() => 'Subject')),
  body: z.string().max(200_000).default(''),
  signatureName: z.string().trim().max(128).default(''),
  recipientName: z.string().trim().max(200).optional(),
  /** For re-rendering a sent letter exactly as it went out. */
  recipientEmail: z.email().max(191).optional(),
  recipientTitle: z.string().trim().max(128).optional(),
  recipientOrganization: z.string().trim().max(200).optional(),
  recipientAddress: z.string().trim().max(500).optional(),
  reference: z.string().trim().max(32).optional(),
  date: z.iso.datetime({ offset: true }).optional(),
});

export const testSchema = z.object(letterFields);

export const sendSchema = z
  .object({
    ...letterFields,
    /** Typed addresses, optionally with a name for the salutation. */
    emails: z
      .array(
        z.object({
          email: z.email().max(191),
          name: z.string().trim().max(200).optional(),
          /** For organisations such as HMOs and partner companies. */
          title: z.string().trim().max(128).optional(),
          organization: z.string().trim().max(200).optional(),
          address: z.string().trim().max(500).optional(),
        }),
      )
      .max(MAX_RECIPIENTS)
      .default([]),
    /** Patients or doctors picked in the admin. */
    userIds: z.array(z.string().max(36)).max(MAX_RECIPIENTS).default([]),
    segment: z.enum(MAIL_SEGMENTS).nullish(),
  })
  .refine((v) => v.emails.length > 0 || v.userIds.length > 0 || v.segment, {
    message: 'Choose at least one recipient',
    path: ['emails'],
  });
export type SendInput = z.infer<typeof sendSchema>;

export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const audienceQuery = z.object({ segment: z.enum(MAIL_SEGMENTS) });
