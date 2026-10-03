import { and, asc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { db } from '../../db/client.js';
import { anonymousQuestions } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { newId } from '../../lib/ids.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { askQuestionSchema } from './anonymous.schemas.js';

// Small CRUD resource: queries live in the router; there is no domain logic to extract.
export const anonymousRouter = Router();
anonymousRouter.use(authenticate);

anonymousRouter.get('/', async (req, res) => {
  const items = await db
    .select()
    .from(anonymousQuestions)
    .where(eq(anonymousQuestions.userId, currentUser(req).userId))
    .orderBy(asc(anonymousQuestions.createdAt));
  res.json({ items });
});

anonymousRouter.post('/', async (req, res) => {
  const { question } = parse(askQuestionSchema, req.body);
  const userId = currentUser(req).userId;
  const row = { id: newId(), userId, question, answer: null, status: 'pending' as const, createdAt: new Date() };
  await db.insert(anonymousQuestions).values(row);
  void mailer.activity(userId, 'Anonymous');
  res.status(201).json(row);
});

anonymousRouter.delete('/:id', async (req, res) => {
  await db
    .delete(anonymousQuestions)
    .where(and(eq(anonymousQuestions.id, req.params.id), eq(anonymousQuestions.userId, currentUser(req).userId)));
  res.status(204).end();
});
