import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { createReportSchema, listReportsQuery, reportMessageSchema } from './reports.schemas.js';
import * as service from './reports.service.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

reportsRouter.post('/', async (req, res) => {
  const input = parse(createReportSchema, req.body);
  res.status(201).json(await service.createReport(currentUser(req).userId, input));
});

reportsRouter.get('/', async (req, res) => {
  const { appointmentId } = parse(listReportsQuery, req.query);
  const userId = currentUser(req).userId;
  if (appointmentId) {
    const report = await service.getReportForAppointment(userId, appointmentId);
    res.json({ items: report ? [report] : [] });
    return;
  }
  res.json({ items: await service.listReports(userId) });
});

reportsRouter.get('/:id/messages', async (req, res) => {
  res.json({ items: await service.listMessages(currentUser(req).userId, req.params.id) });
});

reportsRouter.post('/:id/messages', async (req, res) => {
  const input = parse(reportMessageSchema, req.body);
  res.status(201).json(await service.sendMessage(currentUser(req).userId, req.params.id, input));
});

reportsRouter.delete('/:id', async (req, res) => {
  await service.deleteReport(currentUser(req).userId, req.params.id);
  res.status(204).end();
});
