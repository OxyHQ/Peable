import { assertLocalStripeTestEnvironment } from './stripeTestGuard';
import { LOCAL_TEST_APP, LOCAL_TEST_PRICES, LOCAL_TEST_PRODUCT } from './stripeTestBilling';
import { localSubscriptionPaymentMethods } from './stripeTestPaymentMethods';
import { LOCAL_TEST_CARD_CONFIGURATION } from './stripeTestCardPolicy';

/** Public field initialization only. No customer, intent or subscription is created. */
export async function readLocalCheckoutPreparation() {
  assertLocalStripeTestEnvironment(process.env);
  const { getStripeClient } = await import('../services/providers/stripe/client');
  const { getDb } = await import('../db/postgres');
  const { findMerchantByAppEnvironment } = await import('../db/merchants/merchantRepository');
  const { countEndpointsForMerchant } = await import('../db/webhooks/webhookEndpointRepository');
  const client = getStripeClient('test');
  const [account, merchant, configuration, month, year] = await Promise.all([
    client.accounts.retrieve(null),
    findMerchantByAppEnvironment(getDb(), LOCAL_TEST_APP, 'development'),
    client.paymentMethodConfigurations.retrieve(LOCAL_TEST_CARD_CONFIGURATION),
    client.prices.retrieve(LOCAL_TEST_PRICES.month.id),
    client.prices.retrieve(LOCAL_TEST_PRICES.year.id),
  ]);
  if (
    account.id !== 'acct_1USWGhAofUef123L' ||
    account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT ||
    !merchant ||
    merchant.livemode ||
    merchant.xpub !== null ||
    merchant.network !== null ||
    (await countEndpointsForMerchant(getDb(), merchant.id)) > 0 ||
    !configuration.active ||
    configuration.livemode ||
    configuration.is_default ||
    configuration.card?.display_preference.value !== 'on' ||
    configuration.link?.display_preference.value !== 'off'
  )
    throw new Error('Local checkout preparation unavailable');
  for (const [interval, price] of [
    ['month', month],
    ['year', year],
  ] as const) {
    assertLocalPreparationPrice(interval, price);
  }
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY_TEST;
  if (!publishableKey?.startsWith('pk_test_')) throw new Error('Missing test publishable key');
  return {
    environment: 'test' as const,
    publishableKey,
    scope: { merchantId: merchant.publicId, productId: LOCAL_TEST_PRODUCT },
    currency: 'USD' as const,
    prices: {
      month: { amountMinorUnits: month.unit_amount, interval: 'month' as const },
      year: { amountMinorUnits: year.unit_amount, interval: 'year' as const },
    },
    paymentMethods: localSubscriptionPaymentMethods(true),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/** Coalesce read-only page warmups; never cache payment or paid-readiness state. */
export function createPreparationReader<T>(
  read: () => Promise<T>,
  now = Date.now,
  verify = () => {},
) {
  let cached: { expires: number; result: Promise<T> } | undefined;
  return () => {
    verify();
    if (cached && cached.expires > now()) return cached.result;
    const entry = { expires: now() + 60_000, result: Promise.resolve().then(read) };
    cached = entry;
    void entry.result.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return entry.result;
  };
}

export function createLocalPreparationReader() {
  const names = [
    'STRIPE_SECRET_KEY_TEST',
    'STRIPE_PUBLISHABLE_KEY_TEST',
    'PEABLE_TEST_STRIPE_ACCOUNT',
    'DATABASE_URL',
  ] as const;
  const initial = names.map((name) => process.env[name]);
  return createPreparationReader(readLocalCheckoutPreparation, Date.now, () => {
    assertLocalStripeTestEnvironment(process.env);
    if (names.some((name, index) => process.env[name] !== initial[index]))
      throw new Error('Local checkout configuration changed; restart required');
  });
}

export function assertLocalPreparationPrice(
  interval: 'month' | 'year',
  price: {
    product: string | { id: string };
    livemode: boolean;
    active: boolean;
    currency: string;
    unit_amount: number | null;
    recurring: { interval: string; interval_count: number } | null;
    tax_behavior?: string | null;
  },
) {
  const product = typeof price.product === 'string' ? price.product : price.product.id;
  if (
    price.livemode ||
    !price.active ||
    product !== LOCAL_TEST_PRODUCT ||
    price.currency !== 'usd' ||
    price.unit_amount !== LOCAL_TEST_PRICES[interval].amount ||
    price.recurring?.interval !== interval ||
    price.recurring.interval_count !== 1 ||
    price.tax_behavior !== 'inclusive'
  )
    throw new Error('Unapproved local catalogue');
}
