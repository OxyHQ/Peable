import { assertLocalStripeTestEnvironment } from './stripeTestGuard';

/** The local test merchant's application, never a production application. */
const LOCAL_TEST_APP = 'peable-local-stripe-test';

/** Shared by the CLI and loopback runner; never mounted by the production server. */
export async function createLocalStripeTestIntent(operationKey: string) {
  assertLocalStripeTestEnvironment(process.env);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationKey)) throw new Error('Invalid local operation key');
  const { getStripeClient } = await import('../services/providers/stripe/client');
  const account = await getStripeClient('test').accounts.retrieve(null);
  if (
    account.id !== 'acct_1USWGhAofUef123L' ||
    account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT
  )
    throw new Error('Unexpected local test account');
  const { getDb } = await import('../db/postgres');
  const { insertMerchant, findMerchantByAppEnvironment } = await import(
    '../db/merchants/merchantRepository'
  );
  const { newId } = await import('../lib/ids');
  const { createIntent } = await import('../services/createIntent');
  const { countEndpointsForMerchant } = await import('../db/webhooks/webhookEndpointRepository');
  const db = getDb();
  const merchant =
    (await findMerchantByAppEnvironment(db, LOCAL_TEST_APP, 'development')) ??
    (await insertMerchant(db, {
      publicId: newId('merch'),
      oxyAppId: LOCAL_TEST_APP,
      environment: 'development',
      displayName: 'Local test checkout',
    }));
  if (
    !merchant ||
    merchant.livemode ||
    merchant.network !== null ||
    merchant.xpub !== null ||
    (await countEndpointsForMerchant(db, merchant.id)) > 0
  ) {
    throw new Error('Unexpected local test merchant');
  }
  const created = await createIntent({
    merchant,
    rail: 'card',
    currency: 'USD',
    amount: '599',
    idempotencyKey: `local-test-payment-${operationKey}`,
    metadata: { purpose: 'local-provider-integration-test' },
  });
  return { account: account.id, merchant, created };
}
