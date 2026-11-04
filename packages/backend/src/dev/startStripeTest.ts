import { assertLocalStripeTestEnvironment } from './stripeTestGuard';

let stage = 'local configuration';
async function run() {
  assertLocalStripeTestEnvironment(process.env);
  process.env.STRIPE_ACCOUNT_ID = process.env.PEABLE_TEST_STRIPE_ACCOUNT;
  const { configureLocalStripeCardEntry } = await import('./stripeTestCardPolicy');
  await configureLocalStripeCardEntry();
  if (process.env.PORT !== '4310') throw new Error('Local Stripe test requires port4310');
  // This local runner does not publish workload telemetry.
  delete process.env.AWS_REGION;
  const { getStripeClient } = await import('../services/providers/stripe/client');
  stage = 'Stripe Accounts read';
  const account = await getStripeClient('test').accounts.retrieve(null);
  if (account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT) {
    throw new Error('Stripe account does not match the explicitly approved local test account');
  }
  stage = 'gateway startup';
  const { start } = await import('../server');
  await start({ listenHost: '127.0.0.1' });
}
void run().catch(() => {
  console.error(
    `Local test failed during ${stage}. Check the test account, local configuration and restricted-key permission checklist in docs/local-stripe-test.md. Provider payloads are not logged.`,
  );
  process.exitCode = 1;
});
