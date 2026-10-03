import { round2 } from '../../lib/money.js';

/**
 * Commercial fee policy, ported from the mobile app's PaymentController.
 * Gateway and transfer fees are currently waived there (both return 0).
 */
export const FEES = {
  gatewayFeeRate: 0,
  /** Customer surcharge on drug orders, applied to goods only (not delivery). */
  orderSurchargeRate: 0.02,
  /** Platform share of consultation revenue. */
  doctorPlatformRate: 0.4,
  /** Platform share of pharmacy goods revenue. */
  pharmacyPlatformRate: 0.05,
  /** Referrer commission on a referred user's first paid appointment. */
  referralCommissionRate: 0.1,
} as const;

export const gatewayFee = (amount: number) => round2(amount * FEES.gatewayFeeRate);

export function orderSurcharge(subtotal: number): number {
  return round2(subtotal * FEES.orderSurchargeRate + gatewayFee(subtotal));
}

export function doctorEarning(appointmentPrice: number): number {
  return round2(appointmentPrice - appointmentPrice * FEES.doctorPlatformRate - gatewayFee(appointmentPrice));
}

/** Pharmacy keeps goods + delivery minus the platform's cut of the goods. */
export function pharmacySplit(subtotal: number, deliveryFee: number) {
  const platform = round2(subtotal * FEES.pharmacyPlatformRate);
  return { pharmacyEarning: round2(subtotal + deliveryFee - platform), platformEarning: platform };
}

export const referralCommission = (amount: number) => round2(amount * FEES.referralCommissionRate);
