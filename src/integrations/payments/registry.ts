import { env } from '../../config/env.js';
import type { PaymentProviderName } from '../../db/schema/payments.js';
import { serviceUnavailable } from '../../lib/errors.js';
import { FlutterwaveProvider } from './flutterwave.provider.js';
import { PaystackProvider } from './paystack.provider.js';
import { StripeProvider } from './stripe.provider.js';
import type { PaymentProvider } from './types.js';

const providers = new Map<PaymentProviderName, PaymentProvider>();

function build(name: PaymentProviderName): PaymentProvider | null {
  switch (name) {
    case 'stripe':
      return env.STRIPE_SECRET_KEY ? new StripeProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET) : null;
    case 'paystack':
      return env.PAYSTACK_SECRET_KEY
        ? new PaystackProvider(env.PAYSTACK_SECRET_KEY, env.PAYMENT_REDIRECT_URL)
        : null;
    case 'flutterwave':
      return env.FLUTTERWAVE_SECRET_KEY
        ? new FlutterwaveProvider(env.FLUTTERWAVE_SECRET_KEY, env.FLUTTERWAVE_WEBHOOK_HASH, env.PAYMENT_REDIRECT_URL)
        : null;
  }
}

export function getPaymentProvider(name: PaymentProviderName): PaymentProvider {
  let provider = providers.get(name);
  if (!provider) {
    const built = build(name);
    if (!built) throw serviceUnavailable(`Payment provider "${name}" is not configured`);
    provider = built;
    providers.set(name, provider);
  }
  return provider;
}

/** Test hook: inject a fake provider. */
export function registerPaymentProvider(provider: PaymentProvider) {
  providers.set(provider.name, provider);
}
