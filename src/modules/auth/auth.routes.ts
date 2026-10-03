import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import * as schemas from './auth.schemas.js';
import * as auth from './auth.service.js';
import { verifyAppleIdentityToken, verifyGoogleIdToken } from './oauth.js';

export const authRouter = Router();

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

authRouter.post('/otp', strictLimiter, async (req, res) => {
  const { email, purpose } = parse(schemas.requestOtpSchema, req.body);
  await auth.requestOtp(email, purpose);
  res.status(202).json({ message: 'If the address is eligible, a verification code has been sent' });
});

authRouter.post('/register', strictLimiter, async (req, res) => {
  const input = parse(schemas.registerSchema, req.body);
  const result = await auth.register(input, req.get('user-agent'));
  res.status(201).json(result);
});

authRouter.post('/login', strictLimiter, async (req, res) => {
  const { email, password } = parse(schemas.loginSchema, req.body);
  res.json(await auth.login(email, password, req.get('user-agent')));
});

authRouter.post('/google', strictLimiter, async (req, res) => {
  const { idToken, ...extra } = parse(schemas.googleSchema, req.body);
  const identity = await verifyGoogleIdToken(idToken);
  res.json(await auth.socialSignIn(identity, extra, req.get('user-agent')));
});

authRouter.post('/apple', strictLimiter, async (req, res) => {
  const { identityToken, ...extra } = parse(schemas.appleSchema, req.body);
  const identity = await verifyAppleIdentityToken(identityToken);
  res.json(await auth.socialSignIn(identity, extra, req.get('user-agent')));
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

authRouter.post('/password/reset', strictLimiter, async (req, res) => {
  const { email, otp, newPassword } = parse(schemas.resetPasswordSchema, req.body);
  await auth.resetPassword(email, otp, newPassword);
  res.status(204).end();
});

authRouter.post('/password/change', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = parse(schemas.changePasswordSchema, req.body);
  await auth.changePassword(currentUser(req).userId, currentPassword, newPassword);
  res.status(204).end();
});
