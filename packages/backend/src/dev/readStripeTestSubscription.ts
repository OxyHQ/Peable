import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';
import { LOCAL_TEST_APP, localTestBillingConfiguration } from './stripeTestBilling';

async function run() {
  assertLocalStripeTestEnvironment(process.env);
  const interval = process.env.PEABLE_TEST_SUBSCRIPTION_INTERVAL ?? 'month';
  if (interval !== 'month' && interval !== 'year') throw new Error('Unsupported local interval');
  const artifact = z
    .object({ session: z.object({ id: z.string().regex(/^cs_test_[A-Za-z0-9]+$/) }) })
    .parse(
      JSON.parse(
        await readFile(
          join(homedir(), `.local/share/peable-stripe-test/subscription-${interval}.json`),
          'utf8',
        ),
      ),
    );
  const { getStripeClient } = await import('../services/providers/stripe/client');
  const { connectPostgres, disconnectPostgres } = await import('../db/postgres');
  const { findMerchantByAppEnvironment } = await import('../db/merchants/merchantRepository');
  const { configureBillingRuntime } = await import('../services/billing/configuredBilling');
  const account = await getStripeClient().accounts.retrieve(null);
  if (account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT)
    throw new Error('Unexpected test account');
  try {
    const db = await connectPostgres();
    const merchant = await findMerchantByAppEnvironment(db, LOCAL_TEST_APP, 'development');
    if (!merchant) throw new Error('Missing local merchant');
    const configuration = localTestBillingConfiguration(merchant, account.id);
    const cohort = configuration.cohorts[0];
    const runtime = await configureBillingRuntime(db, JSON.stringify(configuration));
    if (!cohort || !runtime) throw new Error('Missing local billing configuration');
    const { evidenceRef: _evidenceRef, ...owner } = cohort;
    const state = await runtime.service.retrieveCheckout(owner, artifact.session.id);
    const invoice =
      state.subscription && state.initialInvoiceId
        ? await runtime.service.retrieveInvoiceState(
            owner,
            state.subscription.providerSubscriptionId,
            state.initialInvoiceId,
          )
        : null;
    console.info(
      JSON.stringify({
        checkout: state.id,
        status: state.status,
        subscription: state.subscription?.providerSubscriptionId ?? null,
        subscriptionStatus: state.subscription?.status ?? null,
        invoice,
      }),
    );
  } finally {
    await disconnectPostgres();
  }
}
void run().catch(() => {
  console.error(
    'Local recurring readback failed. Check the test account, secure artifact, and Accounts/Checkout Sessions/Subscriptions/Invoices/Charges read permissions. Provider payloads are not logged.',
  );
  process.exitCode = 1;
});
