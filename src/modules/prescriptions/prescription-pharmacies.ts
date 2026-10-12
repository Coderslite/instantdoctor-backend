import { and, gt, inArray, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pharmacies, products } from '../../db/schema/index.js';
import { unprocessable } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { coverageFor, membershipFor } from '../hmo/hmo.coverage.js';
import { deliveryFeeFor, listPharmacies } from '../pharmacy/pharmacy.service.js';
import { matchScore } from './prescription-matching.js';
import { getForPatient } from './prescriptions.service.js';

const CANDIDATES_PER_ITEM = 5;

/**
 * Where a patient can get their prescription filled: nearby live pharmacies
 * that stock the prescribed medicines, best match first for each medicine,
 * with an estimated total and what their HMO would cover. Pharmacies that
 * have every medicine come first, then open ones, then the nearest.
 */
export async function pharmacyOptions(
  userId: string,
  prescriptionId: string,
  query: { latitude: number; longitude: number; radiusKm: number },
) {
  const prescription = await getForPatient(userId, prescriptionId);
  if (!prescription.items.length)
    throw unprocessable('NOT_DISPENSABLE', 'This prescription has no medicines that can be ordered. Show it to a pharmacist instead.');
  if (prescription.isExpired)
    throw unprocessable('PRESCRIPTION_EXPIRED', 'This prescription has expired. Ask your doctor for a new one.');
  const wanted = prescription.items.filter((i) => i.remaining > 0);
  if (!wanted.length)
    throw unprocessable('PRESCRIPTION_FULFILLED', 'You have already ordered every medicine on this prescription.');

  const nearby = await listPharmacies(query);
  const ids = nearby.map((p) => p.id);
  const [stock, locations] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(products)
          .where(and(inArray(products.pharmacyId, ids), ne(products.status, 'deleted'), gt(products.stockRemaining, 0))),
        db
          .select({ id: pharmacies.id, latitude: pharmacies.latitude, longitude: pharmacies.longitude, deliveryFeePerKm: pharmacies.deliveryFeePerKm })
          .from(pharmacies)
          .where(inArray(pharmacies.id, ids)),
      ])
    : [[], []];
  const locationOf = new Map(locations.map((l) => [l.id, l]));
  const membership = await membershipFor(userId);

  const options = [];
  for (const pharmacy of nearby) {
    const own = stock.filter((p) => p.pharmacyId === pharmacy.id);
    const items = wanted.map((item) => {
      const candidates = own
        .map((product) => ({ product, score: matchScore(item, product.name) }))
        .filter((c): c is { product: typeof c.product; score: number } => c.score !== null)
        .sort((a, b) => b.score - a.score || a.product.amount - b.product.amount)
        .slice(0, CANDIDATES_PER_ITEM)
        .map((c) => c.product);
      const best = candidates[0];
      const quantity = best ? Math.min(item.remaining, best.stockRemaining) : 0;
      return {
        prescriptionItemId: item.id,
        name: item.name,
        strength: item.strength,
        remaining: item.remaining,
        suggestedQuantity: quantity,
        candidates,
        estimate: best ? round2(best.amount * quantity) : 0,
      };
    });
    const available = items.filter((i) => i.candidates.length).length;
    if (!available) continue;
    const subtotal = round2(items.reduce((s, i) => s + i.estimate, 0));
    const location = locationOf.get(pharmacy.id);
    const deliveryFee = location ? deliveryFeeFor(location, query) : null;
    const check = membership && subtotal > 0
      ? await coverageFor(userId, 'medicines', null, subtotal, { membership })
      : null;
    options.push({
      pharmacy,
      available,
      total: wanted.length,
      items,
      subtotal,
      deliveryFee,
      hmo: check?.decision
        ? { covered: true, hmoName: check.decision.membership.hmo.name, summary: check.decision.summary, hmoAmount: check.decision.hmoAmount, patientAmount: check.decision.patientAmount }
        : check?.membership
          ? { covered: false, hmoName: check.membership.hmo.name, notice: check.notice }
          : null,
    });
  }
  options.sort(
    (a, b) =>
      b.available - a.available ||
      Number(b.pharmacy.isOpen) - Number(a.pharmacy.isOpen) ||
      (a.pharmacy.distanceKm ?? Infinity) - (b.pharmacy.distanceKm ?? Infinity),
  );
  return { prescription, items: options };
}
