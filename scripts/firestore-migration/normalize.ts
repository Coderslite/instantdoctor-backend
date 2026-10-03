import { GeoPoint, Timestamp } from 'firebase-admin/firestore';

/** Firestore value -> Date (Timestamp, ISO string, epoch ms, {_seconds}). */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Timestamp) return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object' && v && '_seconds' in v) return new Date(Number((v as { _seconds: number })._seconds) * 1000);
  return null;
}

export function toGeo(v: unknown): { latitude: number; longitude: number } | null {
  if (v instanceof GeoPoint) {
    // The app writes GeoPoint(0,0) as "unknown"; treat it as absent.
    if (v.latitude === 0 && v.longitude === 0) return null;
    return { latitude: round7(v.latitude), longitude: round7(v.longitude) };
  }
  return null;
}

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

export function str(v: unknown, max?: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return max ? s.slice(0, max) : s;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const int = (v: unknown) => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};

export const bool = (v: unknown, fallback = false) => (typeof v === 'boolean' ? v : fallback);

/** Firestore {hour, minute} -> "HH:MM:00". */
export function clock(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const { hour, minute } = v as { hour?: number; minute?: number };
  if (typeof hour !== 'number' || typeof minute !== 'number') return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

/** Recursively converts Timestamps to ISO strings so values are JSON-safe. */
export function plain(v: unknown): unknown {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof GeoPoint) return { latitude: v.latitude, longitude: v.longitude };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** Firestore ids are <= 28 chars in practice; our id columns allow 36. */
export const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 36;
