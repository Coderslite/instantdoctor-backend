import type { HmoBilling, HmoCoverageType } from '../../db/schema/index.js';
import { round2 } from '../../lib/money.js';
import { doctorEarning, type FeePolicy } from '../pricing/fees.js';

/** HMO agreements are priced in naira, whatever region the enrollee's account is set to. */
export const NIGERIA = { country: 'NG', currency: 'NGN' };

/** The parts of an agreement rule that decide money. */
export interface PricingRule {
  coverage: HmoCoverageType;
  patientAmount: number | null;
  percent: number | null;
  hmoAmount: number | null;
  doctorEarning: number | null;
  /** capitation: already paid for by the monthly capitation, so nothing is billed per use. */
  billing?: HmoBilling;
}

export interface CoverageAmounts {
  /** What the enrollee pays in the app. */
  patientAmount: number;
  /** What is billed to the HMO (0 for discount-only agreements). */
  hmoAmount: number;
  /** Consultations: what the doctor earns. Null for services without a doctor share. */
  doctorEarning: number | null;
}

/** Whole naira: agreement maths should never produce kobo fractions on a patient's screen. */
const naira = (value: number) => Math.max(0, Math.round(value));

/**
 * Applies an agreement rule to the standard price of a service.
 * Returns null for `not_covered` (the standard price applies).
 *
 * The rule's tariff (`hmoAmount`) is the full agreed price of the service for
 * this HMO's members; without one, the normal price is. Co-pays come out of
 * that agreed price and the HMO is billed the rest, so member + HMO always
 * add up to it. `percent` on a percentage co-pay is the member's share.
 *
 * Capitated rules bill the HMO nothing per use (it pays a monthly amount per
 * member instead); the member still pays any co-pay.
 *
 * Doctor pay: the rule's fixed amount, otherwise the usual consultation share
 * of the agreed price, so a ₦1,000 co-pay on a ₦10,000 consultation pays the
 * doctor on ₦10,000, and a ₦1,000 tariff pays them on ₦1,000.
 */
export function applyRule(
  rule: PricingRule,
  standardAmount: number,
  opts: { withDoctorShare: boolean; feePolicy?: FeePolicy },
): CoverageAmounts | null {
  const standard = round2(standardAmount);
  const pct = Math.min(100, Math.max(0, rule.percent ?? 0));
  const agreed = round2(rule.hmoAmount ?? standard);
  // A member never pays more than a non-member would.
  const capped = (amount: number) => Math.min(naira(amount), naira(standard));
  let patientAmount: number;
  let hmoAmount: number;

  switch (rule.coverage) {
    case 'not_covered':
      return null;
    case 'full':
      patientAmount = 0;
      hmoAmount = agreed;
      break;
    case 'copay_fixed':
      patientAmount = Math.min(capped(rule.patientAmount ?? 0), naira(agreed));
      hmoAmount = Math.max(0, agreed - patientAmount);
      break;
    case 'copay_percent':
      patientAmount = capped((agreed * pct) / 100);
      hmoAmount = Math.max(0, agreed - patientAmount);
      break;
    case 'discount_percent':
      patientAmount = naira(standard * (1 - pct / 100));
      hmoAmount = 0;
      break;
    case 'fixed_price':
      patientAmount = capped(rule.patientAmount ?? 0);
      hmoAmount = 0;
      break;
  }

  // Capitated: the member's share is the same, but the HMO already paid through capitation.
  hmoAmount = rule.billing === 'capitation' ? 0 : round2(hmoAmount);
  const earning = opts.withDoctorShare
    ? (rule.doctorEarning ?? doctorEarning(round2(patientAmount + hmoAmount), opts.feePolicy))
    : null;
  return { patientAmount, hmoAmount, doctorEarning: earning === null ? null : round2(earning) };
}

/** Human summary of a rule, for the admin, the app and claim descriptions. */
export function describeRule(rule: PricingRule): string {
  const ngn = (n: number | null) => `₦${Number(n ?? 0).toLocaleString('en-NG')}`;
  switch (rule.coverage) {
    case 'full':
      return 'Fully covered';
    case 'copay_fixed':
      return `You pay ${ngn(rule.patientAmount)}`;
    case 'copay_percent': {
      const member = Number(rule.percent ?? 0);
      return `HMO covers ${Math.round((100 - member) * 100) / 100}% · you pay ${member}%`;
    }
    case 'discount_percent':
      return `${Number(rule.percent ?? 0)}% off`;
    case 'fixed_price':
      return `Fixed price ${ngn(rule.patientAmount)}`;
    case 'not_covered':
      return 'Not covered';
  }
}

/** What a rule covers, in words: "GP consultation", "Prescribed medicines". */
export const benefitLabel = (service: string, packageName: string | null) =>
  service === 'lab_interpretation'
    ? 'Lab result interpretation'
    : service === 'medicines'
      ? 'Prescribed medicines'
      : packageName
        ? `${packageName} consultation`
        : 'Consultations';
