import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';

// Validate before importing configuration, opening a database or contacting Stripe.
assertLocalStripeTestEnvironment(process.env);
const { getStripeClient } = await import('../services/providers/stripe/client');
const { connectPostgres, disconnectPostgres } = await import('../db/postgres');
const { insertMerchant, findMerchantByAppEnvironment } = await import(
  '../db/merchants/merchantRepository'
);
const { createIntent } = await import('../services/createIntent');
const { newId } = await import('../lib/ids');
const { toPaymentIntentDTO } = await import('../lib/serialize');

const account = await getStripeClient().accounts.retrieve(null);
if (account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT) {
  throw new Error('Stripe account does not match the explicitly approved local test account');
}
try {
  const db = await connectPostgres();
  const appId = 'peable-local-stripe-test';
  const merchant =
    (await findMerchantByAppEnvironment(db, appId, 'development')) ??
    (await insertMerchant(db, {
      publicId: newId('merch'),
      oxyAppId: appId,
      environment: 'development',
      displayName: 'Local test checkout',
      // Card-only registration: no chain key is fabricated or accepted.
    }));
  if (!merchant || merchant.livemode || merchant.network !== null || merchant.xpub !== null) {
    throw new Error('Local test merchant is missing or has an unexpected mode/rail');
  }
  const created = await createIntent({
    merchant,
    rail: 'card',
    currency: 'USD',
    amount: '599',
    idempotencyKey: `local-test-${process.env.PEABLE_TEST_RUN_ID}`,
    metadata: { purpose: 'local-provider-integration-test' },
  });
  const directory = join(homedir(), '.local/share/peable-stripe-test');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = join(directory, 'checkout.json');
  await writeFile(
    output,
    JSON.stringify({
      apiUrl: 'http://127.0.0.1:4310',
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      intent: { ...toPaymentIntentDTO(created.intent), client_secret: created.intent.clientSecret },
      client_action: created.clientAction,
    }),
    { mode: 0o600 },
  );
  console.info(
    JSON.stringify({
      account: account.id,
      merchant: merchant.publicId,
      intent: created.intent.publicId,
      reused: created.reused,
      artifact: output,
    }),
  );
} finally {
  await disconnectPostgres();
}
