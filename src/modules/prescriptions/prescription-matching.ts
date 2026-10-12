/**
 * Matches a prescribed medicine to pharmacy products by name. Pharmacies name
 * products freely ("Amoxicillin 500mg Capsules x 21 (Amoxil)"), so a product
 * matches when it contains every word of the prescribed name, and, when both
 * state a strength, the strengths agree. The pharmacist still checks every
 * prescription order before accepting it.
 */

export interface PrescribedMedicine {
  name: string;
  strength: string | null;
  form: string | null;
}

const UNITS = 'mg|mcg|µg|g|ml|iu|%';
const STRENGTH = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})(?![a-z])`, 'g');
const STOP = new Set(['tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules', 'syrup', 'susp', 'suspension', 'and', 'with', 'of']);

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/µg/g, 'mcg')
    .replace(/[^a-z0-9%.+/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "500 mg", "500mg", "0.5 g" → "500mg" / "0.5g"; several in combination products. */
export function strengthsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of normalise(text).matchAll(STRENGTH)) out.push(`${Number(m[1])}${m[2]}`);
  return out;
}

const words = (name: string) =>
  normalise(name)
    .replace(STRENGTH, ' ')
    .split(/[\s/+]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w));

/** Null when the product isn't this medicine; otherwise higher is a better match. */
export function matchScore(item: PrescribedMedicine, productName: string): number | null {
  const wanted = words(item.name);
  if (!wanted.length) return null;
  const product = normalise(productName);
  if (!wanted.every((w) => product.includes(w))) return null;

  let score = 10;
  const prescribed = strengthsIn(`${item.name} ${item.strength ?? ''}`);
  const offered = strengthsIn(productName);
  if (prescribed.length && offered.length) {
    // A different strength is a different medicine for dispensing purposes.
    if (!prescribed.every((s) => offered.includes(s))) return null;
    score += 5;
  }
  const form = item.form ? normalise(item.form).replace(/s$/, '') : '';
  if (form && product.includes(form.slice(0, 3))) score += 2;
  // Shorter names are usually the plain product rather than a combination.
  score -= Math.min(3, Math.floor(product.length / 40));
  return score;
}
