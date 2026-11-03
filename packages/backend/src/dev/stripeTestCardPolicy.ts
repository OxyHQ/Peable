import { z } from 'zod';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';

export const LOCAL_TEST_CARD_CONFIGURATION = 'pmc_1UXZRQAofUef123L4QGpwlFQ';

/** This separately owned TEST configuration leaves account defaults untouched. */
export async function configureLocalStripeCardEntry() {
  assertLocalStripeTestEnvironment(process.env);
  const { getStripeClient } = await import('../services/providers/stripe/client');
  const client = getStripeClient();
  const account = await client.accounts.retrieve(null);
  if (
    account.id !== 'acct_1USWGhAofUef123L' ||
    account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT
  )
    throw new Error('Unexpected local test account');
  const configuration = await client.paymentMethodConfigurations.retrieve(
    LOCAL_TEST_CARD_CONFIGURATION,
  );
  if (
    configuration.livemode ||
    configuration.is_default ||
    !configuration.active ||
    configuration.card?.display_preference.value !== 'on' ||
    configuration.link?.display_preference.value !== 'off'
  )
    throw new Error('Local card-entry configuration is not isolated or has unexpected methods');
  const enabled = Object.entries(configuration)
    .filter(([, settings]) => {
      const parsed = z
        .object({ display_preference: z.object({ value: z.string() }) })
        .safeParse(settings);
      return parsed.success && parsed.data.display_preference.value === 'on';
    })
    .map(([method]) => method);
  if (enabled.length !== 1 || enabled[0] !== 'card')
    throw new Error('Local card-entry configuration permits other methods');
  const { configureStripePaymentProvider } = await import('../services/providers/registry');
  const { LocalSubscriptionStripeProvider } = await import('./stripeTestEmbeddedSubscription');
  configureStripePaymentProvider(
    {
      paymentMethodConfiguration: configuration.id,
    },
    (options) => new LocalSubscriptionStripeProvider(options),
  );
}
