import { createHash } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  carePlans,
  careSummaryShares,
  labResults,
  medications,
  userMedicalProfiles,
  users,
  vitalReadings,
} from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { newId, randomToken } from '../../lib/ids.js';
import type { createShareSchema } from './family.schemas.js';
import { requireOwnedProfile, resolveProfileId } from './family.service.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The mobile app tags readings as `[ctx:fasting] note`; split that back out. */
const CONTEXT_LABELS: Record<string, string> = {
  fasting: 'Fasting',
  beforeMeal: 'Before meal',
  afterMeal: 'After meal',
  bedtime: 'Bedtime',
  resting: 'Resting',
  afterActivity: 'After activity',
  random: 'Any time',
};
function splitNote(raw: string | null) {
  const match = /^\[ctx:(\w+)\]\s*/.exec(raw ?? '');
  return {
    context: match ? (CONTEXT_LABELS[match[1]!] ?? null) : null,
    note: (raw ?? '').replace(/^\[ctx:\w+\]\s*/, '').trim() || null,
  };
}

function ageFrom(dob: Date | string | null) {
  if (!dob) return null;
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age--;
  return age >= 0 ? age : null;
}

/** Most recent readings per plan included in the chart series. */
const TREND_POINTS = 120;

const toHhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const avg = (values: (number | null)[]) => {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

export type CareSummary = Awaited<ReturnType<typeof buildCareSummary>>;

/** Everything a doctor needs at a glance, for the owner or one family member. */
export async function buildCareSummary(ownerUserId: string, profileId: string | null) {
  let person: {
    name: string;
    relationship: string;
    age: number | null;
    sex: string | null;
    bloodGroup: string | null;
    genotype: string | null;
    allergies: string | null;
    conditions: string | null;
  };

  if (profileId) {
    const p = await requireOwnedProfile(ownerUserId, profileId);
    person = {
      name: p.name,
      relationship: p.relationship,
      age: ageFrom(p.dateOfBirth),
      sex: p.sex,
      bloodGroup: p.bloodGroup,
      genotype: p.genotype,
      allergies: p.allergies,
      conditions: p.conditions,
    };
  } else {
    const [u] = await db.select().from(users).where(eq(users.id, ownerUserId)).limit(1);
    if (!u) throw notFound('User');
    const [m] = await db.select().from(userMedicalProfiles).where(eq(userMedicalProfiles.userId, ownerUserId)).limit(1);
    person = {
      name: `${u.firstName} ${u.lastName}`.trim() || 'Patient',
      relationship: 'self',
      age: ageFrom(u.dateOfBirth),
      sex: u.gender,
      bloodGroup: m?.bloodGroup ?? null,
      genotype: m?.genotype ?? null,
      allergies: null,
      conditions: m?.surgicalHistory ? `Surgical history: ${m.surgicalHistory}` : null,
    };
  }

  const owned = (table: typeof medications | typeof carePlans) =>
    and(eq(table.userId, ownerUserId), profileId ? eq(table.profileId, profileId) : isNull(table.profileId));

  const now = new Date();
  const meds = await db
    .select()
    .from(medications)
    .where(and(owned(medications), gt(medications.endTime, now)))
    .orderBy(medications.startTime);

  const plans = await db
    .select()
    .from(carePlans)
    .where(and(owned(carePlans), eq(carePlans.isActive, true)))
    .orderBy(desc(carePlans.updatedAt));

  const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const readings = plans.length
    ? await db
        .select()
        .from(vitalReadings)
        .where(and(inArray(vitalReadings.carePlanId, plans.map((p) => p.id)), gte(vitalReadings.measuredAt, since)))
        .orderBy(desc(vitalReadings.measuredAt))
    : [];

  // Lab results are only recorded against the account owner.
  const labs = profileId
    ? []
    : await db
        .select()
        .from(labResults)
        .where(and(eq(labResults.userId, ownerUserId), eq(labResults.status, 'completed')))
        .orderBy(desc(labResults.createdAt))
        .limit(3);

  return {
    person,
    medications: meds.map((m) => ({
      name: m.name,
      instructions: m.prescription,
      times: [m.morningTime, m.middayTime, m.eveningTime].map(toHhmm).filter((t): t is string => !!t),
      until: m.endTime,
    })),
    carePlans: plans.map((p) => {
      const own = readings.filter((r) => r.carePlanId === p.id);
      return {
        name: p.name,
        kind: p.kind,
        notes: p.notes,
        nextReviewAt: p.nextReviewAt,
        last30Days: {
          count: own.length,
          averageSystolic: avg(own.map((r) => r.systolic)),
          averageDiastolic: avg(own.map((r) => r.diastolic)),
          averageGlucose: avg(own.map((r) => r.glucose)),
        },
        /** Oldest first, for charting the 30-day trend. */
        trend: own
          .slice(0, TREND_POINTS)
          .reverse()
          .map((r) => ({
            systolic: r.systolic,
            diastolic: r.diastolic,
            glucose: r.glucose,
            measuredAt: r.measuredAt,
            context: splitNote(r.note).context,
          })),
        recentReadings: own.slice(0, 5).map((r) => ({
          systolic: r.systolic,
          diastolic: r.diastolic,
          glucose: r.glucose,
          measuredAt: r.measuredAt,
          ...splitNote(r.note),
        })),
      };
    }),
    labResults: labs.map((l) => ({
      testName: l.testName,
      resultDate: l.resultDate ?? l.reviewedAt ?? l.createdAt,
      interpretation: l.interpretation ?? l.adminResponse,
    })),
    generatedAt: now,
  };
}

const serializeShare = (s: typeof careSummaryShares.$inferSelect) => ({
  id: s.id,
  profileId: s.profileId,
  expiresAt: s.expiresAt,
  viewCount: s.viewCount,
  lastViewedAt: s.lastViewedAt,
  createdAt: s.createdAt,
});

/**
 * Links open the branded page on the website (instantdoctor_web `/care/[token]`),
 * which reads `GET /api/v1/care-summaries/:token`. That endpoint still serves
 * its own HTML page, so links issued before this change keep working.
 */
export const shareUrl = (token: string) => `${env.WEBSITE_URL}/care/${token}`;

/** Creates a short-lived, read-only link. The raw token is returned once only. */
export async function createShare(ownerUserId: string, input: z.infer<typeof createShareSchema>) {
  const profileId = await resolveProfileId(ownerUserId, input.profileId);
  const token = randomToken(32);
  const id = newId();
  const expiresAt = new Date(Date.now() + input.expiresInHours * 3600 * 1000);
  await db.insert(careSummaryShares).values({ id, ownerUserId, profileId, tokenHash: hashToken(token), expiresAt });
  const [row] = await db.select().from(careSummaryShares).where(eq(careSummaryShares.id, id)).limit(1);
  return { ...serializeShare(row!), url: shareUrl(token) };
}

export async function listActiveShares(ownerUserId: string, profileId: string | null) {
  const rows = await db
    .select()
    .from(careSummaryShares)
    .where(
      and(
        eq(careSummaryShares.ownerUserId, ownerUserId),
        profileId ? eq(careSummaryShares.profileId, profileId) : isNull(careSummaryShares.profileId),
        isNull(careSummaryShares.revokedAt),
        gt(careSummaryShares.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(careSummaryShares.createdAt));
  return rows.map(serializeShare);
}

export async function revokeShare(ownerUserId: string, id: string) {
  const [row] = await db
    .select()
    .from(careSummaryShares)
    .where(and(eq(careSummaryShares.id, id), eq(careSummaryShares.ownerUserId, ownerUserId)))
    .limit(1);
  if (!row) throw notFound('Share link');
  if (!row.revokedAt) {
    await db.update(careSummaryShares).set({ revokedAt: new Date() }).where(eq(careSummaryShares.id, id));
  }
}

/** Public lookup by token. Expired, revoked and unknown links all look the same. */
export async function viewSharedSummary(token: string) {
  if (token.length < 20 || token.length > 128) throw notFound('Care summary');
  const [share] = await db
    .select()
    .from(careSummaryShares)
    .where(eq(careSummaryShares.tokenHash, hashToken(token)))
    .limit(1);
  if (!share || share.revokedAt || share.expiresAt <= new Date()) throw notFound('Care summary');
  await db
    .update(careSummaryShares)
    .set({ viewCount: share.viewCount + 1, lastViewedAt: new Date() })
    .where(eq(careSummaryShares.id, share.id));
  const [owner] = await db.select().from(users).where(eq(users.id, share.ownerUserId)).limit(1);
  return {
    summary: await buildCareSummary(share.ownerUserId, share.profileId),
    sharedBy: owner ? `${owner.firstName} ${owner.lastName}`.trim() : null,
    expiresAt: share.expiresAt,
  };
}
