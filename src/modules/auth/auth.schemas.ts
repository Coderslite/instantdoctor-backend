import { z } from 'zod';
import { OTP_PURPOSES } from '../../db/schema/index.js';

const email = z.email().trim().toLowerCase().max(191);
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const name = z.string().trim().min(1).max(100);

export const checkEmailSchema = z.object({ email });

export const requestOtpSchema = z.object({ email, purpose: z.enum(OTP_PURPOSES) });

export const registerSchema = z.object({
  email,
  password,
  otp: z.string().regex(/^\d{5}$/, 'Code must be 5 digits'),
  firstName: name,
  lastName: name,
  phoneNumber: z.string().trim().min(5).max(32),
  gender: z.string().trim().max(32),
  platform: z.enum(['ios', 'android', 'web']).optional(),
  referredBy: z.string().trim().max(64).optional(),
});

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

export const resetPasswordSchema = z.object({
  email,
  otp: z.string().regex(/^\d{5}$/),
  newPassword: password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(128).default(''),
  newPassword: password,
});
