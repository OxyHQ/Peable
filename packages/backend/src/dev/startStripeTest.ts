import { assertLocalStripeTestEnvironment } from './stripeTestGuard';

assertLocalStripeTestEnvironment(process.env);
if (process.env.PORT !== '4310') throw new Error('Local Stripe test requires port4310');
// This local runner does not publish workload telemetry or activate fiscal cohorts.
delete process.env.AWS_REGION;
if (process.env.PEABLE_BILLING_COHORT)
  throw new Error('Configure and review test billing separately before enabling a cohort');
const { getStripeClient } = await import('../services/providers/stripe/client');
const account = await getStripeClient().accounts.retrieve(null);
if (account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT) {
  throw new Error('Stripe account does not match the explicitly approved local test account');
}
const { start } = await import('../server');
await start({ listenHost: '127.0.0.1' });
