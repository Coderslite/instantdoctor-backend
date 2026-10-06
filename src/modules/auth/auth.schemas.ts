import { z } from 'zod';
import { toE164 } from '../../lib/phone.js';

const email = z.email().trim().toLowerCase().max(191);
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const name = z.string().trim().min(1).max(100);

export const checkEmailSchema = z.object({ email });

const otp = z.string().regex(/^\d{5}$/, 'Code must be 5 digits');

/** Step 1 of sign-up. Creates a pending account and emails a verification code. */
export const registerSchema = z.object({
  email,
  password,
  firstName: name,
  lastName: name,
  phoneNumber: z
    .string()
    .trim()
    .max(32)
    .transform((value, ctx) => {
      const normalized = toE164(value);
      if (!normalized) {
        ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number including the country code' });
        return z.NEVER;
      }
      return normalized;
    }),
  gender: z.string().trim().max(32),
  platform: z.enum(['ios', 'android', 'web']).optional(),
  referredBy: z.string().trim().max(64).optional(),
});

/** Step 2 of sign-up. */
export const verifyRegistrationSchema = z.object({ email, otp });

/** Used by both "resend sign-up code" and "forgot password". */
export const emailOnlySchema = z.object({ email });

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });

export const googleSchema = z.object({
  idToken: z.string().min(1),
  referredBy: z.string().trim().max(64).optional(),
  platform: z.enum(['ios', 'android', 'web']).optional(),
});

export const appleSchema = z.object({
  identityToken: z.string().min(1),
  // Apple only returns the name to the client on first authorisation.
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  referredBy: z.string().trim().max(64).optional(),
  platform: z.enum(['ios', 'android', 'web']).optional(),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(20) });

/** Password reset step 2: exchange the emailed code for a reset token. */
export const verifyResetCodeSchema = z.object({ email, otp });

/** Password reset step 3. */
export const resetPasswordSchema = z.object({
  resetToken: z.string().min(20).max(128),
  newPassword: password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(128).default(''),
  newPassword: password,
});
