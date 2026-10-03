import { randomBytes, randomInt, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-friendly random code from an unambiguous alphabet (no 0/O, 1/I). */
export function randomCode(length: number, alphabet = REFERENCE_ALPHABET): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Merchant reference sent to payment providers, e.g. `IDP_20261003_K7Q2M9XA`. */
export function paymentReference(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `IDP_${day}_${randomCode(10)}`;
}

export const randomToken = (bytes = 48): string => randomBytes(bytes).toString('base64url');
