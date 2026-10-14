import { describe, expect, it } from 'vitest';
import { applyRule, describeRule, type PricingRule } from '../../src/modules/hmo/hmo.pricing.js';
import { DEFAULT_FEE_POLICY } from '../../src/modules/pricing/fees.js';

const rule = (r: Partial<PricingRule> & Pick<PricingRule, 'coverage'>): PricingRule => ({
  patientAmount: null,
  percent: null,
  hmoAmount: null,
  doctorEarning: null,
  ...r,
});
const consult = { withDoctorShare: true, feePolicy: DEFAULT_FEE_POLICY };
// Default policy: doctor keeps 60% (40% platform, 0% gateway).

describe('HMO agreement pricing', () => {
  it('full cover: patient pays nothing, HMO is billed the standard price or its tariff', () => {
    expect(applyRule(rule({ coverage: 'full' }), 10_000, consult)).toEqual({
      patientAmount: 0,
      hmoAmount: 10_000,
      doctorEarning: 6_000,
    });
    expect(applyRule(rule({ coverage: 'full', hmoAmount: 8_000 }), 10_000, consult)).toEqual({
      patientAmount: 0,
      hmoAmount: 8_000,
      doctorEarning: 4_800,
    });
  });

  it('fixed co-pay: doctor is paid on the whole visit, not on the co-pay', () => {
    expect(
      applyRule(rule({ coverage: 'copay_fixed', patientAmount: 1_000 }), 10_000, consult),
    ).toEqual({ patientAmount: 1_000, hmoAmount: 9_000, doctorEarning: 6_000 });
    // With a tariff, the co-pay comes out of the agreed price.
    expect(
      applyRule(
        rule({
          coverage: 'copay_fixed',
          patientAmount: 1_000,
          hmoAmount: 6_000,
          doctorEarning: 3_500,
        }),
        10_000,
        consult,
      ),
    ).toEqual({
      patientAmount: 1_000,
      hmoAmount: 5_000,
      doctorEarning: 3_500,
    });
  });

  it('the tariff is the agreed price: co-pays and doctor pay are worked out on it', () => {
    // ₦13,400 normally; agreed ₦1,000; member co-pays 30% (HMO covers 70%).
    expect(
      applyRule(rule({ coverage: 'copay_percent', percent: 30, hmoAmount: 1_000 }), 13_400, consult),
    ).toEqual({ patientAmount: 300, hmoAmount: 700, doctorEarning: 600 });
    expect(describeRule(rule({ coverage: 'copay_percent', percent: 30 }))).toBe(
      'HMO covers 70% · you pay 30%',
    );
  });

  it('percentage co-pay rounds to whole naira', () => {
    expect(applyRule(rule({ coverage: 'copay_percent', percent: 15 }), 7_333, consult)).toEqual({
      patientAmount: 1_100,
      hmoAmount: 6_233,
      doctorEarning: 4_399.8,
    });
  });

  it('discounts and fixed prices bill nothing to the HMO', () => {
    expect(applyRule(rule({ coverage: 'discount_percent', percent: 30 }), 10_000, consult)).toEqual(
      { patientAmount: 7_000, hmoAmount: 0, doctorEarning: 4_200 },
    );
    expect(
      applyRule(rule({ coverage: 'fixed_price', patientAmount: 3_000 }), 10_000, consult),
    ).toEqual({ patientAmount: 3_000, hmoAmount: 0, doctorEarning: 1_800 });
  });

  it('not covered falls back to the normal price; non-consultations have no doctor share', () => {
    expect(applyRule(rule({ coverage: 'not_covered' }), 10_000, consult)).toBeNull();
    expect(applyRule(rule({ coverage: 'full' }), 3_000, { withDoctorShare: false })).toEqual({
      patientAmount: 0,
      hmoAmount: 3_000,
      doctorEarning: null,
    });
  });

  it('never charges a member more than the normal price', () => {
    expect(
      applyRule(rule({ coverage: 'copay_fixed', patientAmount: 1_000 }), 100, consult),
    ).toMatchObject({ patientAmount: 100, hmoAmount: 0 });
    expect(
      applyRule(rule({ coverage: 'fixed_price', patientAmount: 5_000 }), 3_000, consult),
    ).toMatchObject({ patientAmount: 3_000 });
  });

  it('describes rules for people', () => {
    expect(describeRule(rule({ coverage: 'copay_fixed', patientAmount: 1500 }))).toBe(
      'You pay ₦1,500',
    );
    expect(describeRule(rule({ coverage: 'discount_percent', percent: 30 }))).toBe('30% off');
  });
});
