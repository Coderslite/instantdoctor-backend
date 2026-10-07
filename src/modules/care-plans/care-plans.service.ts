import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import { carePlans, vitalReadings } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { resolveProfileId } from '../family/family.service.js';
import type { carePlanSchema, updateCarePlanSchema, vitalReadingSchema } from './care-plans.schemas.js';

async function requireOwned(userId: string, id: string) {
  const [plan] = await db.select().from(carePlans).where(and(eq(carePlans.id, id), eq(carePlans.userId, userId))).limit(1);
  if (!plan) throw notFound('Care plan');
  return plan;
}

const serializePlan = (plan: typeof carePlans.$inferSelect) => ({
  id: plan.id,
  profileId: plan.profileId,
  kind: plan.kind,
  name: plan.name,
  notes: plan.notes,
  nextReviewAt: plan.nextReviewAt,
  isActive: plan.isActive,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

/** Plans for one person: a family profile, or the account owner when [profileId] is null. */
export async function listCarePlans(userId: string, profileId: string | null = null) {
  const plans = await db
    .select()
    .from(carePlans)
    .where(and(eq(carePlans.userId, userId), profileId ? eq(carePlans.profileId, profileId) : isNull(carePlans.profileId)))
    .orderBy(desc(carePlans.isActive), desc(carePlans.updatedAt));
  return plans.map(serializePlan);
}

export async function getCarePlan(userId: string, id: string) {
  const plan = await requireOwned(userId, id);
  const readings = await db.select().from(vitalReadings).where(eq(vitalReadings.carePlanId, id)).orderBy(desc(vitalReadings.measuredAt)).limit(90);
  return { ...serializePlan(plan), readings };
}

export async function createCarePlan(userId: string, input: z.infer<typeof carePlanSchema>) {
  const profileId = await resolveProfileId(userId, input.profileId);
  const id = newId();
  await db.insert(carePlans).values({ id, userId, ...input, profileId });
  return getCarePlan(userId, id);
}

export async function updateCarePlan(userId: string, id: string, input: z.infer<typeof updateCarePlanSchema>) {
  await requireOwned(userId, id);
  await db.update(carePlans).set(input).where(eq(carePlans.id, id));
  return getCarePlan(userId, id);
}

export async function addVitalReading(userId: string, id: string, input: z.infer<typeof vitalReadingSchema>) {
  await requireOwned(userId, id);
  await db.insert(vitalReadings).values({ id: newId(), carePlanId: id, ...input });
  return getCarePlan(userId, id);
}
