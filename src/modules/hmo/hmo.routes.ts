import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import {
  authenticateAdmin,
  currentAdmin,
  requireAdminRole,
} from '../../middleware/authenticate-admin.js';
import * as activity from './hmo.activity.js';
import * as agreements from './hmo.agreements.js';
import * as applications from './hmo.applications.js';
import * as authorizations from './hmo.authorizations.js';
import * as capitation from './hmo.capitation.js';
import * as claims from './hmo.claims.js';
import * as enrollees from './hmo.enrollees.js';
import * as member from './hmo.member.js';
import * as schemas from './hmo.schemas.js';
import * as hmoUsers from './hmo.users.js';

// ── Patients: /hmo ──────────────────────────────────────────────────────────

export const hmoMemberRouter = Router();
hmoMemberRouter.use(authenticate);
// Enrollee codes are short; slow down anyone trying to guess one.
const linkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});

hmoMemberRouter.get('/partners', async (_req, res) =>
  res.json({ items: await member.listPartners() }),
);
hmoMemberRouter.get('/me', async (req, res) =>
  res.json(await member.myCoverage(currentUser(req).userId)),
);
hmoMemberRouter.post('/link', linkLimiter, async (req, res) => {
  const result = await member.linkMembership(
    currentUser(req).userId,
    parse(schemas.linkSchema, req.body),
  );
  res.status(result.status === 'linked' ? 200 : 202).json(result);
});
// Pre-authorisation: ask the HMO to approve a service above the agreed amount.
hmoMemberRouter.get('/authorizations', async (req, res) =>
  res.json({ items: await authorizations.myAuthorizations(currentUser(req).userId) }),
);
hmoMemberRouter.post('/authorizations', async (req, res) =>
  res
    .status(201)
    .json(
      await authorizations.requestAuthorization(
        currentUser(req).userId,
        parse(schemas.authorizationRequestSchema, req.body),
      ),
    ),
);
hmoMemberRouter.post('/authorizations/:id/cancel', async (req, res) =>
  res.json(await authorizations.cancelMine(currentUser(req).userId, String(req.params.id))),
);
hmoMemberRouter.delete('/me', async (req, res) =>
  res.json(await member.unlinkMembership(currentUser(req).userId)),
);

// ── Admin: /admin/hmos ──────────────────────────────────────────────────────
// Every route below is scoped by :hmoId and calls HMO-scoped services; the HMO
// portal (/hmo-portal) exposes the same services with the HMO taken from its login.

export const adminHmoRouter = Router();
adminHmoRouter.use(authenticateAdmin);
const canManage = requireAdminRole('admin');
const hmoId = (req: Request) => String(req.params.hmoId);
/** Every change is recorded in the HMO's activity trail, which the HMO can read. */
const actor = (req: Request) => activity.adminActor(currentAdmin(req).adminId);

adminHmoRouter.get('/', async (_req, res) => res.json({ items: await agreements.listHmos() }));
adminHmoRouter.post('/', canManage, async (req, res) =>
  res.status(201).json(await agreements.createHmo(parse(schemas.hmoSchema, req.body))),
);
adminHmoRouter.get('/:hmoId', async (req, res) => res.json(await agreements.getHmo(hmoId(req))));
adminHmoRouter.patch('/:hmoId', canManage, async (req, res) =>
  res.json(
    await agreements.updateHmo(
      hmoId(req),
      parse(schemas.updateHmoSchema, req.body),
      await actor(req),
    ),
  ),
);

adminHmoRouter.post('/:hmoId/plans', canManage, async (req, res) =>
  res
    .status(201)
    .json(
      await agreements.createPlan(
        hmoId(req),
        parse(schemas.planSchema, req.body),
        await actor(req),
      ),
    ),
);
adminHmoRouter.patch('/:hmoId/plans/:planId', canManage, async (req, res) =>
  res.json(
    await agreements.updatePlan(
      hmoId(req),
      String(req.params.planId),
      parse(schemas.updatePlanSchema, req.body),
      await actor(req),
    ),
  ),
);
adminHmoRouter.get('/:hmoId/plans/:planId/price-preview', async (req, res) =>
  res.json(await agreements.pricePreview(hmoId(req), String(req.params.planId))),
);
adminHmoRouter.post('/:hmoId/plans/:planId/rules', canManage, async (req, res) =>
  res
    .status(201)
    .json(
      await agreements.createRule(
        hmoId(req),
        String(req.params.planId),
        parse(schemas.ruleSchema, req.body),
        await actor(req),
      ),
    ),
);
adminHmoRouter.put('/:hmoId/plans/:planId/rules/:ruleId', canManage, async (req, res) =>
  res.json(
    await agreements.updateRule(
      hmoId(req),
      String(req.params.planId),
      String(req.params.ruleId),
      parse(schemas.ruleSchema, req.body),
      await actor(req),
    ),
  ),
);
adminHmoRouter.delete('/:hmoId/plans/:planId/rules/:ruleId', canManage, async (req, res) =>
  res.json(
    await agreements.deleteRule(
      hmoId(req),
      String(req.params.planId),
      String(req.params.ruleId),
      await actor(req),
    ),
  ),
);

adminHmoRouter.get('/:hmoId/enrollees', async (req, res) =>
  res.json(await enrollees.listEnrollees(hmoId(req), parse(schemas.enrolleesQuery, req.query))),
);
adminHmoRouter.post('/:hmoId/enrollees', canManage, async (req, res) =>
  res
    .status(201)
    .json(
      await enrollees.createEnrollee(
        hmoId(req),
        parse(schemas.enrolleeSchema, req.body),
        await actor(req),
      ),
    ),
);
adminHmoRouter.post('/:hmoId/enrollees/import', canManage, async (req, res) =>
  res.json(
    await enrollees.importEnrollees(
      hmoId(req),
      parse(schemas.importSchema, req.body),
      await actor(req),
    ),
  ),
);
adminHmoRouter.patch('/:hmoId/enrollees/:enrolleeId', canManage, async (req, res) =>
  res.json(
    await enrollees.updateEnrollee(
      hmoId(req),
      String(req.params.enrolleeId),
      parse(schemas.updateEnrolleeSchema, req.body),
      await actor(req),
    ),
  ),
);

adminHmoRouter.get('/:hmoId/claims', async (req, res) =>
  res.json(await claims.listClaims(hmoId(req), parse(schemas.claimsQuery, req.query))),
);
adminHmoRouter.patch('/:hmoId/claims/:claimId', canManage, async (req, res) =>
  res.json(
    await claims.updateClaim(
      hmoId(req),
      String(req.params.claimId),
      parse(schemas.claimUpdateSchema, req.body),
      await actor(req),
    ),
  ),
);
adminHmoRouter.get('/:hmoId/invoices', async (req, res) =>
  res.json({ items: await claims.listInvoices(hmoId(req)) }),
);
adminHmoRouter.post('/:hmoId/invoices', canManage, async (req, res) =>
  res
    .status(201)
    .json(
      await claims.createInvoice(
        hmoId(req),
        currentAdmin(req).adminId,
        parse(schemas.invoiceSchema, req.body),
        await actor(req),
      ),
    ),
);
adminHmoRouter.get('/:hmoId/invoices/:invoiceId', async (req, res) =>
  res.json(await claims.getInvoice(hmoId(req), String(req.params.invoiceId))),
);
adminHmoRouter.patch('/:hmoId/invoices/:invoiceId', canManage, async (req, res) =>
  res.json(
    await claims.updateInvoice(
      hmoId(req),
      String(req.params.invoiceId),
      parse(schemas.invoiceUpdateSchema, req.body),
      await actor(req),
    ),
  ),
);

// Approvals: decide on members' pre-authorisation requests on the HMO's behalf.
adminHmoRouter.get('/:hmoId/authorizations', async (req, res) =>
  res.json(await authorizations.listAuthorizations(hmoId(req), parse(schemas.authorizationsQuery, req.query))),
);
adminHmoRouter.post('/:hmoId/authorizations/:id/decision', canManage, async (req, res) =>
  res.json(
    await authorizations.decideAuthorization(
      hmoId(req),
      String(req.params.id),
      parse(schemas.authorizationDecisionSchema, req.body),
      await actor(req),
    ),
  ),
);

// Capitation: what each capitation plan earns against what its members use, and who was counted.
adminHmoRouter.get('/:hmoId/capitation', async (req, res) =>
  res.json(await capitation.utilisation(hmoId(req), parse(schemas.capitationQuery, req.query).months)),
);
adminHmoRouter.get('/:hmoId/plans/:planId/capitation/:month/members', async (req, res) => {
  const planId = String(req.params.planId);
  await capitation.requireCapitationPlan(hmoId(req), planId);
  res.json({
    items: await capitation.capitationMembers(
      hmoId(req),
      planId,
      parse(schemas.capitationMonth, req.params.month),
    ),
  });
});

// HMO portal accounts. The first one is created here; the HMO's admins then manage their team.
adminHmoRouter.get('/:hmoId/users', async (req, res) =>
  res.json({ items: await hmoUsers.listUsers(hmoId(req)) }),
);
adminHmoRouter.post('/:hmoId/users', canManage, async (req, res) =>
  res
    .status(201)
    .json(
      await hmoUsers.createUser(
        hmoId(req),
        parse(schemas.hmoUserSchema, req.body),
        await actor(req),
      ),
    ),
);
adminHmoRouter.patch('/:hmoId/users/:userId', canManage, async (req, res) =>
  res.json(
    await hmoUsers.updateUser(
      hmoId(req),
      String(req.params.userId),
      parse(schemas.updateHmoUserSchema, req.body),
      await actor(req),
    ),
  ),
);
adminHmoRouter.post('/:hmoId/users/:userId/reset-password', canManage, async (req, res) =>
  res.json(
    await hmoUsers.resetPassword(
      hmoId(req),
      String(req.params.userId),
      parse(schemas.resetPasswordSchema, req.body).password,
      await actor(req),
    ),
  ),
);
adminHmoRouter.get('/:hmoId/activity', async (req, res) => {
  await agreements.requireHmo(hmoId(req));
  res.json(await activity.listActivity(hmoId(req), parse(schemas.activityQuery, req.query)));
});

// ── Admin: /admin/hmo-link-requests ─────────────────────────────────────────

export const adminHmoLinkRequestsRouter = Router();
adminHmoLinkRequestsRouter.use(authenticateAdmin);

adminHmoLinkRequestsRouter.get('/', async (req, res) =>
  res.json(await enrollees.listLinkRequests(parse(schemas.linkRequestsQuery, req.query))),
);
adminHmoLinkRequestsRouter.post('/:id/approve', canManage, async (req, res) =>
  res.json(
    await enrollees.approveLinkRequest(
      currentAdmin(req).adminId,
      String(req.params.id),
      parse(schemas.approveLinkSchema, req.body).enrolleeId,
    ),
  ),
);
adminHmoLinkRequestsRouter.post('/:id/reject', canManage, async (req, res) =>
  res.json(
    await enrollees.rejectLinkRequest(
      currentAdmin(req).adminId,
      String(req.params.id),
      parse(schemas.rejectLinkSchema, req.body).note,
    ),
  ),
);

// ── Website: /hmo-applications ──────────────────────────────────────────────

/** Public: the "Apply to partner" form on the website. */
export const hmoApplicationsRouter = Router();
hmoApplicationsRouter.post(
  '/',
  rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, skip: () => isTest }),
  async (req, res) =>
    res.status(201).json(await applications.submit(parse(schemas.applicationSchema, req.body))),
);

// ── Admin: /admin/hmo-applications ──────────────────────────────────────────

export const adminHmoApplicationsRouter = Router();
adminHmoApplicationsRouter.use(authenticateAdmin);

adminHmoApplicationsRouter.get('/', async (req, res) =>
  res.json(await applications.list(parse(schemas.applicationsQuery, req.query))),
);
adminHmoApplicationsRouter.get('/:id', async (req, res) =>
  res.json(await applications.get(String(req.params.id))),
);
adminHmoApplicationsRouter.post('/:id/approve', canManage, async (req, res) =>
  res.json(
    await applications.approve(
      String(req.params.id),
      currentAdmin(req).adminId,
      parse(schemas.approveApplicationSchema, req.body),
    ),
  ),
);
adminHmoApplicationsRouter.post('/:id/reject', canManage, async (req, res) =>
  res.json(
    await applications.reject(
      String(req.params.id),
      currentAdmin(req).adminId,
      parse(schemas.rejectApplicationSchema, req.body).reason,
    ),
  ),
);
