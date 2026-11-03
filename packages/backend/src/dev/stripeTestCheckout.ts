import { assertLocalStripeTestEnvironment } from './stripeTestGuard';
import { LOCAL_TEST_APP } from './stripeTestBilling';

/** Shared by the CLI and loopback runner; never mounted by the production server. */
export async function createLocalStripeTestIntent(operationKey: string) {
  assertLocalStripeTestEnvironment(process.env);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationKey)) throw new Error('Invalid local operation key');
  const { getStripeClient } = await import('../services/providers/stripe/client');
  const account = await getStripeClient().accounts.retrieve(null);
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
    merchant.webhookUrl
  ) {
    throw new Error('Unexpected local test merchant');
  }
  const created = await createIntent({
    merchant,
    rail: 'card',
    currency: 'USD',
    amount: '599',
    idempotencyKey: `local-test-${operationKey}`,
    metadata: { purpose: 'local-provider-integration-test' },
  });
  return { account: account.id, merchant, created };
}
