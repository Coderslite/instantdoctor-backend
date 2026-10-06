import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { portalSessions, type PortalSubject } from '../../db/schema/index.js';
import { sha256 } from '../../lib/crypto.js';
import { unauthorized } from '../../lib/errors.js';
import { newId, randomToken } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';

const ROTATION_GRACE_MS = 30_000;

async function issue(executor: Executor, subject: PortalSubject, subjectId: string, familyId: string, userAgent?: string) {
  const refreshToken = randomToken();
  await executor.insert(portalSessions).values({
    id: newId(),
    subjectType: subject,
    subjectId,
    tokenHash: sha256(refreshToken),
    familyId,
    userAgent: userAgent?.slice(0, 255) ?? null,
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000),
  });
  return refreshToken;
}

export function openPortalSession(subject: PortalSubject, subjectId: string, userAgent?: string) {
  return issue(db, subject, subjectId, newId(), userAgent);
}

export async function rotatePortalSession(subject: PortalSubject, refreshToken: string, userAgent?: string) {
  const outcome = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(portalSessions)
      .where(eq(portalSessions.tokenHash, sha256(refreshToken)))
      .for('update');
    if (!session || session.subjectType !== subject || session.revokedAt || session.expiresAt < new Date()) {
      return null;
    }
    if (session.rotatedAt) {
      if (Date.now() - session.rotatedAt.getTime() <= ROTATION_GRACE_MS) {
        return { subjectId: session.subjectId, refreshToken: await issue(tx, subject, session.subjectId, session.familyId, userAgent) };
      }
      await tx
        .update(portalSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(portalSessions.familyId, session.familyId), isNull(portalSessions.revokedAt)));
      logger.warn({ subject, subjectId: session.subjectId }, 'Portal refresh token reuse detected; session family revoked');
      return 'reused' as const;
    }
    await tx.update(portalSessions).set({ rotatedAt: new Date() }).where(eq(portalSessions.id, session.id));
    return { subjectId: session.subjectId, refreshToken: await issue(tx, subject, session.subjectId, session.familyId, userAgent) };
  });
  if (!outcome || outcome === 'reused') throw unauthorized('Your session has ended. Please sign in again.');
  return outcome;
}

export async function closePortalSession(subject: PortalSubject, refreshToken: string) {
  const [session] = await db
    .select({ familyId: portalSessions.familyId })
    .from(portalSessions)
    .where(and(eq(portalSessions.tokenHash, sha256(refreshToken)), eq(portalSessions.subjectType, subject)))
    .limit(1);
  if (!session) return;
  await db
    .update(portalSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(portalSessions.familyId, session.familyId), isNull(portalSessions.revokedAt)));
}

export async function closeAllPortalSessions(subject: PortalSubject, subjectId: string) {
  await db
    .update(portalSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(portalSessions.subjectType, subject), eq(portalSessions.subjectId, subjectId), isNull(portalSessions.revokedAt)),
    );
}
