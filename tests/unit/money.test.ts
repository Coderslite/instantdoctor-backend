import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../src/lib/crypto.js';
import { fromMinorUnits, round2, toMinorUnits } from '../../src/lib/money.js';

describe('money', () => {
  it('converts to provider minor units', () => {
    expect(toMinorUnits(9.99, 'USD')).toBe(999);
    expect(toMinorUnits(7500, 'NGN')).toBe(750_000);
    expect(toMinorUnits(500, 'JPY')).toBe(500);
    expect(toMinorUnits(1.005, 'USD')).toBe(101);
  });

  it('round-trips minor units', () => {
    expect(fromMinorUnits(999, 'usd')).toBe(9.99);
    expect(fromMinorUnits(500, 'XAF')).toBe(500);
  });

  it('rounds half up to cents', () => expect(round2(0.1 + 0.2)).toBe(0.3));
});

describe('stableStringify', () => {
  it('is independent of key order and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(stableStringify({ a: { d: [1, 2] }, b: 1 }));
  });
});
