import { z } from 'zod';
import * as hmo from '../hmo/hmo.schemas.js';

export const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(128) });

export const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'Choose a password different from the current one',
    path: ['newPassword'],
  });

/** The HMO keeps its own contact details current; name, code, status and terms stay with Instant Doctor. */
export const profileSchema = hmo.hmoSchema
  .pick({ logo: true, contactName: true, contactEmail: true, contactPhone: true, address: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const enrolleeSchema = hmo.enrolleeSchema;
/** Linking a member to an app account stays with the member (and Instant Doctor). */
export const updateEnrolleeSchema = hmo.updateEnrolleeSchema.omit({ userId: true });
export const importSchema = hmo.importSchema;
export const enrolleesQuery = hmo.enrolleesQuery;
export const claimsQuery = hmo.claimsQuery;
export const activityQuery = hmo.activityQuery;

export const teamUserSchema = hmo.hmoUserSchema;
export const updateTeamUserSchema = hmo.updateHmoUserSchema;
export const resetPasswordSchema = hmo.resetPasswordSchema;
