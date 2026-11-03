import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';

// Validate before importing configuration, opening a database or contacting Stripe.
let stage = 'local configuration';
async function run() {
  assertLocalStripeTestEnvironment(process.env);
  const { configureLocalStripeCardEntry } = await import('./stripeTestCardPolicy');
  await configureLocalStripeCardEntry();
  const { connectPostgres, disconnectPostgres } = await import('../db/postgres');
  const { toPaymentIntentDTO } = await import('../lib/serialize');
  const { createLocalStripeTestIntent } = await import('./stripeTestCheckout');
  try {
    await connectPostgres();
    stage = 'verified local test PaymentIntent creation';
    const { account, merchant, created } = await createLocalStripeTestIntent(
      process.env.PEABLE_TEST_RUN_ID ?? '',
    );
    const directory = join(homedir(), '.local/share/peable-stripe-test');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = join(directory, 'checkout.json');
    await writeFile(
      output,
      JSON.stringify({
        apiUrl: 'http://127.0.0.1:4310',
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY_TEST,
        intent: {
          ...toPaymentIntentDTO(created.intent),
          client_secret: created.intent.clientSecret,
        },
        client_action: created.clientAction,
      }),
      { mode: 0o600 },
    );
    console.info(
      JSON.stringify({
        account,
        merchant: merchant.publicId,
        intent: created.intent.publicId,
        reused: created.reused,
        artifact: output,
      }),
    );
  } finally {
    await disconnectPostgres();
  }
}
void run().catch(() => {
  console.error(
    `Local test failed during ${stage}. Check the test account, local configuration and restricted-key permission checklist in docs/local-stripe-test.md. Provider payloads are not logged.`,
  );
  process.exitCode = 1;
});
