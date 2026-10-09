import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { appSettings } from '../../db/schema/index.js';
import { round2 } from '../../lib/money.js';

export const COMMERCIAL_FEES_SETTINGS_KEY = 'commercial_fees';

export const DEFAULT_FEE_POLICY = {
  gatewayFeePercent: 0,
  orderSurchargePercent: 2,
  consultationPlatformPercent: 40,
  pharmacyPlatformPercent: 5,
  referralCommissionPercent: 10,
} as const;

const feePolicyFields = {
  gatewayFeePercent: z.number().min(0).max(100).multipleOf(0.01).default(DEFAULT_FEE_POLICY.gatewayFeePercent),
  orderSurchargePercent: z.number().min(0).max(100).multipleOf(0.01).default(DEFAULT_FEE_POLICY.orderSurchargePercent),
  consultationPlatformPercent: z.number().min(0).max(100).multipleOf(0.01).default(DEFAULT_FEE_POLICY.consultationPlatformPercent),
  pharmacyPlatformPercent: z.number().min(0).max(100).multipleOf(0.01).default(DEFAULT_FEE_POLICY.pharmacyPlatformPercent),
  referralCommissionPercent: z.number().min(0).max(100).multipleOf(0.01).default(DEFAULT_FEE_POLICY.referralCommissionPercent),
};

const checkFeeCombinations = <T extends { gatewayFeePercent: number; consultationPlatformPercent: number }>(
  value: T,
  context: z.RefinementCtx,
) => {
  if (value.gatewayFeePercent + value.consultationPlatformPercent > 100) {
    context.addIssue({
      code: 'custom',
      path: ['consultationPlatformPercent'],
      message: 'Consultation platform and gateway fees cannot exceed 100%',
    });
  }
};

export const feePolicySchema = z.object(feePolicyFields).superRefine(checkFeeCombinations);
export const feePolicyInputSchema = z
  .object({
    gatewayFeePercent: z.number().min(0).max(100).multipleOf(0.01),
    orderSurchargePercent: z.number().min(0).max(100).multipleOf(0.01),
    consultationPlatformPercent: z.number().min(0).max(100).multipleOf(0.01),
    pharmacyPlatformPercent: z.number().min(0).max(100).multipleOf(0.01),
    referralCommissionPercent: z.number().min(0).max(100).multipleOf(0.01),
  })
  .superRefine(checkFeeCombinations);

export type FeePolicy = z.infer<typeof feePolicySchema>;

/** Reads the current commercial policy. Existing installations use the original rates. */
export async function getFeePolicy(executor: Executor = db): Promise<FeePolicy> {
  const [row] = await executor
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, COMMERCIAL_FEES_SETTINGS_KEY))
    .limit(1);
  return feePolicySchema.parse(row?.value ?? {});
}

/** Fractional compatibility values for integrations that used the original constants. */
export const FEES = {
  gatewayFeeRate: DEFAULT_FEE_POLICY.gatewayFeePercent / 100,
  orderSurchargeRate: DEFAULT_FEE_POLICY.orderSurchargePercent / 100,
  doctorPlatformRate: DEFAULT_FEE_POLICY.consultationPlatformPercent / 100,
  pharmacyPlatformRate: DEFAULT_FEE_POLICY.pharmacyPlatformPercent / 100,
  referralCommissionRate: DEFAULT_FEE_POLICY.referralCommissionPercent / 100,
} as const;

const percentOf = (amount: number, percent: number) => round2(amount * percent / 100);

export const gatewayFee = (amount: number, policy: FeePolicy = DEFAULT_FEE_POLICY) =>
  percentOf(amount, policy.gatewayFeePercent);

/** Customer surcharge on drug orders, applied to goods only (not delivery). */
export function orderSurcharge(subtotal: number, policy: FeePolicy = DEFAULT_FEE_POLICY): number {
  return round2(percentOf(subtotal, policy.orderSurchargePercent) + gatewayFee(subtotal, policy));
}

export function doctorEarning(appointmentPrice: number, policy: FeePolicy = DEFAULT_FEE_POLICY): number {
  return Math.max(
    0,
    round2(appointmentPrice - percentOf(appointmentPrice, policy.consultationPlatformPercent) - gatewayFee(appointmentPrice, policy)),
  );
}

/** Pharmacy keeps goods + delivery minus the platform's cut of the goods. */
export function pharmacySplit(subtotal: number, deliveryFee: number, policy: FeePolicy = DEFAULT_FEE_POLICY) {
  const platform = percentOf(subtotal, policy.pharmacyPlatformPercent);
  return { pharmacyEarning: round2(subtotal + deliveryFee - platform), platformEarning: platform };
}

export const referralCommission = (amount: number, policy: FeePolicy = DEFAULT_FEE_POLICY) =>
  percentOf(amount, policy.referralCommissionPercent);
