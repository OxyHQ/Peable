import { assertLocalStripeTestEnvironment } from './stripeTestGuard';
import { LOCAL_TEST_APP, localTestBillingConfiguration } from './stripeTestBilling';

let stage = 'local configuration';
async function run() {
  assertLocalStripeTestEnvironment(process.env);
  const { configureLocalStripeCardEntry } = await import('./stripeTestCardPolicy');
  await configureLocalStripeCardEntry();
  if (process.env.PORT !== '4310') throw new Error('Local Stripe test requires port4310');
  // This local runner does not publish workload telemetry or activate fiscal cohorts.
  delete process.env.AWS_REGION;
  if (process.env.PEABLE_BILLING_COHORT)
    throw new Error('Configure and review test billing separately before enabling a cohort');
  const { getStripeClient } = await import('../services/providers/stripe/client');
  stage = 'Stripe Accounts read';
  const account = await getStripeClient().accounts.retrieve(null);
  if (account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT) {
    throw new Error('Stripe account does not match the explicitly approved local test account');
  }
  let billingConfiguration: string | undefined;
  if (process.env.PEABLE_TEST_ENABLE_BILLING === 'true') {
    const { connectPostgres } = await import('../db/postgres');
    const { findMerchantByAppEnvironment } = await import('../db/merchants/merchantRepository');
    const merchant = await findMerchantByAppEnvironment(
      await connectPostgres(),
      LOCAL_TEST_APP,
      'development',
    );
    if (!merchant)
      throw new Error('Seed the local test merchant before enabling recurring observations');
    billingConfiguration = JSON.stringify(localTestBillingConfiguration(merchant, account.id));
  }
  stage = 'gateway startup and recurring configuration validation';
  const { start } = await import('../server');
  const gateway = await start({ listenHost: '127.0.0.1', billingConfiguration });
  const { createLocalStripeTestCheckoutRouter } = await import('./stripeTestCheckoutRouter');
  const { createLocalStripeTestIntent } = await import('./stripeTestCheckout');
  const { readLocalSubscription, withLocalSubscriptionBootstrap } = await import(
    './stripeTestEmbeddedSubscription'
  );
  const { createLocalPreparationReader } = await import('./stripeTestPreparation');
  const prepare = createLocalPreparationReader();
  gateway.app.use(
    createLocalStripeTestCheckoutRouter({
      read: readLocalSubscription,
      prepare,
      create: (key, interval) =>
        withLocalSubscriptionBootstrap(async () => {
          const { created } = await createLocalStripeTestIntent(key, interval);
          const snapshot = await readLocalSubscription(created.intent.publicId);
          return { ...snapshot, clientSecret: created.intent.clientSecret };
        }),
    }),
  );
}
void run().catch(() => {
  console.error(
    `Local test failed during ${stage}. Check the test account, local configuration and restricted-key permission checklist in docs/local-stripe-test.md. Provider payloads are not logged.`,
  );
  process.exitCode = 1;
});
