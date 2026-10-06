import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser, requireRole } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as schemas from './appointments.schemas.js';
import * as appointments from './appointments.service.js';
import * as clinical from './clinical.service.js';
import * as messages from './messages.service.js';

export const appointmentsRouter = Router();
appointmentsRouter.use(authenticate);

appointmentsRouter.get('/packages', async (req, res) => {
  res.json({ items: await appointments.listPackagesForUser(currentUser(req).userId) });
});

/**
 * Book an appointment. Requires an `Idempotency-Key` header: retries with the
 * same key return the original booking (200) instead of creating another.
 */
appointmentsRouter.post('/', requireRole('user'), idempotent('appointments.create'), async (req, res) => {
  const input = parse(schemas.createAppointmentSchema, req.body);
  const { appointment, created } = await appointments.createAppointment(
    currentUser(req).userId,
    input,
    req.idempotencyKey,
    req.get('x-timezone'),
  );
  res.status(created ? 201 : 200).json(appointment);
});

appointmentsRouter.get('/', async (req, res) => {
  const query = parse(schemas.listAppointmentsQuery, req.query);
  const items = await appointments.listAppointments(currentUser(req), query);
  res.json({ items, limit: query.limit, offset: query.offset });
});

/** Doctors: paid open requests awaiting acceptance. */
appointmentsRouter.get('/open', requireRole('doctor'), async (req, res) => {
  const query = parse(schemas.listAppointmentsQuery, req.query);
  res.json({ items: await appointments.listOpenRequests(query), limit: query.limit, offset: query.offset });
});

appointmentsRouter.get('/:id', async (req, res) => {
  res.json(await appointments.getAppointmentForUser(currentUser(req), req.params.id));
});

appointmentsRouter.delete('/:id', async (req, res) => {
  await appointments.deleteAppointment(currentUser(req).userId, req.params.id);
  res.status(204).end();
});

appointmentsRouter.post<{ id: string }>('/:id/accept', requireRole('doctor'), async (req, res) => {
  res.json(await appointments.acceptAppointment(currentUser(req).userId, req.params.id));
});

appointmentsRouter.post<{ id: string }>('/:id/status', requireRole('doctor'), async (req, res) => {
  const { status } = parse(schemas.doctorStatusSchema, req.body);
  res.json(await appointments.transitionByDoctor(currentUser(req).userId, req.params.id, status));
});

// ─── Chat ────────────────────────────────────────────────────────────────────

appointmentsRouter.get('/:id/messages', async (req, res) => {
  const query = parse(schemas.listMessagesQuery, req.query);
  const items = await messages.listMessages(currentUser(req).userId, req.params.id, query);
  res.json({ items, nextBefore: items.length === query.limit ? items.at(-1)?.createdAt : null });
});

appointmentsRouter.post('/:id/messages', async (req, res) => {
  const input = parse(schemas.sendMessageSchema, req.body);
  res.status(201).json(await messages.sendMessage(currentUser(req).userId, req.params.id, input));
});

appointmentsRouter.patch('/:id/messages/:messageId', async (req, res) => {
  const input = parse(schemas.editMessageSchema, req.body);
  res.json(await messages.editMessage(currentUser(req).userId, req.params.id, req.params.messageId, input));
});

appointmentsRouter.delete('/:id/messages/:messageId', async (req, res) => {
  await messages.deleteMessage(currentUser(req).userId, req.params.id, req.params.messageId);
  res.status(204).end();
});

appointmentsRouter.post('/:id/messages/read', async (req, res) => {
  await messages.markRead(currentUser(req).userId, req.params.id);
  res.status(204).end();
});

appointmentsRouter.get('/:id/messages/unread-count', async (req, res) => {
  res.json({ count: await messages.unreadCount(currentUser(req).userId, req.params.id) });
});

// ─── Prescriptions & review ──────────────────────────────────────────────────

appointmentsRouter.get('/:id/prescriptions', async (req, res) => {
  res.json({ items: await clinical.listPrescriptions(currentUser(req).userId, req.params.id) });
});

appointmentsRouter.get('/:id/review', async (req, res) => {
  res.json({ review: await clinical.getReview(currentUser(req).userId, req.params.id) });
});

appointmentsRouter.post<{ id: string }>('/:id/review', requireRole('user'), async (req, res) => {
  const input = parse(schemas.reviewSchema, req.body);
  res.status(201).json(await clinical.addReview(currentUser(req).userId, req.params.id, input));
});
