import { Router, type Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { sha256 } from '../../lib/crypto.js';
import { conflict } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import { authenticateHmo, currentHmo, requireHmoRoles } from '../../middleware/authenticate-hmo.js';
import { refreshSchema } from '../auth/auth.schemas.js';
import type { Actor } from '../hmo/hmo.activity.js';
import * as activity from '../hmo/hmo.activity.js';
import * as claims from '../hmo/hmo.claims.js';
import * as enrollees from '../hmo/hmo.enrollees.js';
import * as team from '../hmo/hmo.users.js';
import * as schemas from './hmo-portal.schemas.js';
import * as service from './hmo-portal.service.js';

/**
 * /hmo-portal — the HMO's own workspace. The HMO is always the one in the
 * access token; no route takes an HMO id.
 *
 * Roles: viewers read everything; managers also add, update and import
 * members; admins also manage the team and the HMO's contact details.
 */
export const hmoPortalRouter = Router();

// The portal calls the API through its own server, so every person arrives from
// the same few addresses. Limits are therefore per account, not per address alone,
// or one person's typos would lock out every HMO.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return `${ipKeyGenerator(req.ip ?? '')}:${email}`;
  },
});
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: (req) =>
    typeof req.body?.refreshToken === 'string'
      ? sha256(req.body.refreshToken)
      : ipKeyGenerator(req.ip ?? ''),
});

hmoPortalRouter.post('/auth/login', loginLimiter, async (req, res) => {
  const input = parse(schemas.loginSchema, req.body);
  res.json(await service.login(input.email, input.password, req.get('user-agent')));
});
hmoPortalRouter.post('/auth/refresh', refreshLimiter, async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  res.json(await service.refreshSession(refreshToken, req.get('user-agent')));
});
hmoPortalRouter.post('/auth/logout', async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  await service.logout(refreshToken);
  res.status(204).end();
});

hmoPortalRouter.use(authenticateHmo);
const canManageMembers = requireHmoRoles('manager');
const isAdmin = requireHmoRoles();
const hmoId = (req: Request) => currentHmo(req).hmoId;
const actor = (req: Request): Actor => {
  const auth = currentHmo(req);
  return { type: 'hmo_user', id: auth.userId, name: auth.name };
};

// ── Account ─────────────────────────────────────────────────────────────────

hmoPortalRouter.get('/me', async (req, res) =>
  res.json(await service.me(hmoId(req), currentHmo(req).userId)),
);
hmoPortalRouter.patch('/password', async (req, res) =>
  res.json(
    await service.changePassword(
      currentHmo(req).userId,
      parse(schemas.passwordSchema, req.body),
      req.get('user-agent'),
    ),
  ),
);
hmoPortalRouter.patch('/profile', isAdmin, async (req, res) =>
  res.json(
    await service.updateProfile(hmoId(req), parse(schemas.profileSchema, req.body), actor(req)),
  ),
);

// ── Overview & agreement ────────────────────────────────────────────────────

hmoPortalRouter.get('/dashboard', async (req, res) =>
  res.json(await service.dashboard(hmoId(req))),
);
hmoPortalRouter.get('/plans', async (req, res) => res.json(await service.agreement(hmoId(req))));
hmoPortalRouter.get('/plans/:planId/price-preview', async (req, res) =>
  res.json(await service.planPricePreview(hmoId(req), String(req.params.planId))),
);

// ── Members ─────────────────────────────────────────────────────────────────

hmoPortalRouter.get('/enrollees', async (req, res) => {
  const page = await enrollees.listEnrollees(hmoId(req), parse(schemas.enrolleesQuery, req.query));
  res.json({ ...page, items: page.items.map(service.portalEnrollee) });
});
hmoPortalRouter.post('/enrollees', canManageMembers, async (req, res) =>
  res
    .status(201)
    .json(
      service.portalEnrollee(
        await enrollees.createEnrollee(
          hmoId(req),
          parse(schemas.enrolleeSchema, req.body),
          actor(req),
        ),
      ),
    ),
);
hmoPortalRouter.post('/enrollees/import', canManageMembers, async (req, res) =>
  res.json(
    await enrollees.importEnrollees(hmoId(req), parse(schemas.importSchema, req.body), actor(req)),
  ),
);
hmoPortalRouter.get('/enrollees/:enrolleeId', async (req, res) => {
  const profile = await enrollees.enrolleeProfile(hmoId(req), String(req.params.enrolleeId));
  res.json({ ...profile, enrollee: service.portalEnrollee(profile.enrollee) });
});
hmoPortalRouter.patch('/enrollees/:enrolleeId', canManageMembers, async (req, res) =>
  res.json(
    service.portalEnrollee(
      await enrollees.updateEnrollee(
        hmoId(req),
        String(req.params.enrolleeId),
        parse(schemas.updateEnrolleeSchema, req.body),
        actor(req),
      ),
    ),
  ),
);

// ── Claims & invoices (read-only: Instant Doctor issues and settles them) ──

hmoPortalRouter.get('/claims', async (req, res) => {
  const page = await claims.listClaims(hmoId(req), parse(schemas.claimsQuery, req.query));
  res.json({ ...page, items: page.items.map(service.portalClaim) });
});
hmoPortalRouter.get('/invoices', async (req, res) =>
  res.json({ items: (await claims.listInvoices(hmoId(req))).map(service.portalInvoice) }),
);
hmoPortalRouter.get('/invoices/:invoiceId', async (req, res) =>
  res.json(
    service.portalInvoice(await claims.getInvoice(hmoId(req), String(req.params.invoiceId))),
  ),
);

// ── Activity trail ──────────────────────────────────────────────────────────

hmoPortalRouter.get('/activity', async (req, res) =>
  res.json(await activity.listActivity(hmoId(req), parse(schemas.activityQuery, req.query))),
);

// ── Team ────────────────────────────────────────────────────────────────────

/** Admins change other people's access; their own goes through another admin. */
const notSelf = (req: Request) => {
  if (String(req.params.userId) === currentHmo(req).userId)
    throw conflict('OWN_ACCOUNT', 'Ask another admin to change your own access');
};

hmoPortalRouter.get('/team', isAdmin, async (req, res) =>
  res.json({ items: await team.listUsers(hmoId(req)) }),
);
hmoPortalRouter.post('/team', isAdmin, async (req, res) =>
  res
    .status(201)
    .json(await team.createUser(hmoId(req), parse(schemas.teamUserSchema, req.body), actor(req))),
);
hmoPortalRouter.patch('/team/:userId', isAdmin, async (req, res) => {
  notSelf(req);
  res.json(
    await team.updateUser(
      hmoId(req),
      String(req.params.userId),
      parse(schemas.updateTeamUserSchema, req.body),
      actor(req),
    ),
  );
});
hmoPortalRouter.post('/team/:userId/reset-password', isAdmin, async (req, res) => {
  notSelf(req);
  res.json(
    await team.resetPassword(
      hmoId(req),
      String(req.params.userId),
      parse(schemas.resetPasswordSchema, req.body).password,
      actor(req),
    ),
  );
});
