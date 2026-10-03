import { Router } from 'express';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { page, paginationQuery } from '../../lib/pagination.js';
import { parse } from '../../lib/validation.js';
import { listNotifications, markAllRead, unreadCount } from './notifications.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', async (req, res) => {
  const pagination = parse(paginationQuery, req.query);
  res.json(page(await listNotifications(currentUser(req).userId, pagination), pagination));
});

notificationsRouter.get('/unread-count', async (req, res) => {
  res.json({ count: await unreadCount(currentUser(req).userId) });
});

notificationsRouter.post('/read-all', async (req, res) => {
  await markAllRead(currentUser(req).userId);
  res.status(204).end();
});
