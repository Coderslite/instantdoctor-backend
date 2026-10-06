import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import * as schemas from './auth.schemas.js';
import * as auth from './auth.service.js';
import { verifyAppleIdentityToken, verifyGoogleIdToken } from './oauth.js';

export const authRouter = Router();

const clientOf = (req: Request): auth.ClientInfo => ({
  userAgent: req.get('user-agent'),
  platform: req.get('x-client-platform'),
  ip: req.ip,
});

/** Brute-force protection on credential and OTP endpoints. */
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});

authRouter.post('/check-email', strictLimiter, async (req, res) => {
  const { email } = parse(schemas.checkEmailSchema, req.body);
  res.json({ available: await auth.isEmailAvailable(email) });
});

/** Sign-up step 1: create a pending account; a 5-digit code is emailed. */
authRouter.post('/register', strictLimiter, async (req, res) => {
  const input = parse(schemas.registerSchema, req.body);
  res.status(201).json(await auth.register(input));
});

/** Sign-up step 2: confirm the emailed code; returns the user and a session. */
authRouter.post('/register/verify', strictLimiter, async (req, res) => {
  const { email, otp } = parse(schemas.verifyRegistrationSchema, req.body);
  res.json(await auth.verifyRegistration(email, otp, clientOf(req)));
});

authRouter.post('/register/resend', strictLimiter, async (req, res) => {
  const { email } = parse(schemas.emailOnlySchema, req.body);
  await auth.resendRegistrationCode(email);
  res.status(202).json({ message: 'If a sign-up is pending for this email, a new code has been sent' });
});

authRouter.post('/login', strictLimiter, async (req, res) => {
  const { email, password } = parse(schemas.loginSchema, req.body);
  res.json(await auth.login(email, password, clientOf(req)));
});

authRouter.post('/google', strictLimiter, async (req, res) => {
  const { idToken, ...extra } = parse(schemas.googleSchema, req.body);
  const identity = await verifyGoogleIdToken(idToken);
  res.json(await auth.socialSignIn(identity, extra, clientOf(req)));
});

authRouter.post('/apple', strictLimiter, async (req, res) => {
  const { identityToken, ...extra } = parse(schemas.appleSchema, req.body);
  const identity = await verifyAppleIdentityToken(identityToken);
  res.json(await auth.socialSignIn(identity, extra, clientOf(req)));
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = parse(schemas.refreshSchema, req.body);
  res.json({ session: await auth.refreshSession(refreshToken, req.get('user-agent')) });
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = parse(schemas.refreshSchema, req.body);
  await auth.revokeRefreshToken(refreshToken);
  res.status(204).end();
});

/** Password reset step 1: email a 5-digit code. */
authRouter.post('/password/forgot', strictLimiter, async (req, res) => {
  const { email } = parse(schemas.emailOnlySchema, req.body);
  await auth.forgotPassword(email);
  res.status(202).json({ message: 'If an account exists for this email, a reset code has been sent' });
});

/** Password reset step 2: verify the code; returns a single-use reset token. */
authRouter.post('/password/verify-code', strictLimiter, async (req, res) => {
  const { email, otp } = parse(schemas.verifyResetCodeSchema, req.body);
  res.json(await auth.verifyPasswordResetCode(email, otp));
});

/** Password reset step 3: set the new password with the reset token. */
authRouter.post('/password/reset', strictLimiter, async (req, res) => {
  const { resetToken, newPassword } = parse(schemas.resetPasswordSchema, req.body);
  await auth.resetPassword(resetToken, newPassword);
  res.status(204).end();
});

authRouter.post('/password/change', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = parse(schemas.changePasswordSchema, req.body);
  await auth.changePassword(currentUser(req).userId, currentPassword, newPassword);
  res.status(204).end();
});
