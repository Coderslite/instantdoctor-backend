import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../../db/client.js';
import { waitlistEntries } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { newId } from '../../lib/ids.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { joinWaitlistSchema, waitlistStatusQuery } from './waitlist.schemas.js';

/** "Notify me when pharmacy delivery reaches my area." Thin CRUD: queries live in the router. */
export const waitlistRouter = Router();
waitlistRouter.use(authenticate);

waitlistRouter.post('/', async (req, res) => {
  const input = parse(joinWaitlistSchema, req.body);
  const userId = currentUser(req).userId;
  const row = { id: newId(), userId, ...input };
  await db.insert(waitlistEntries).values(row);
  void mailer.activity(userId, 'Waitlist');
  res.status(201).json(row);
});

waitlistRouter.get('/status', async (req, res) => {
  const { latitude, longitude } = parse(waitlistStatusQuery, req.query);
  const [row] = await db
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.userId, currentUser(req).userId),
        eq(waitlistEntries.latitude, latitude),
        eq(waitlistEntries.longitude, longitude),
      ),
    )
    .limit(1);
  res.json({ joined: Boolean(row) });
});
