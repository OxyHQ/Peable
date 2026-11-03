import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';
import {
  LOCAL_TEST_APP,
  LOCAL_TEST_PRICES,
  LOCAL_TEST_PRODUCT,
  localTestBillingConfiguration,
  localTestBillingOwner,
  requireLocalBillingReturnUrl,
} from './stripeTestBilling';

let stage = 'local configuration';
async function run() {
  assertLocalStripeTestEnvironment(process.env);
  const returnUrl = requireLocalBillingReturnUrl(process.env.PEABLE_TEST_RETURN_URL);
  const interval = process.env.PEABLE_TEST_SUBSCRIPTION_INTERVAL ?? 'month';
  if (interval !== 'month' && interval !== 'year')
    throw new Error('Test subscription interval must be month or year');
  const selected = LOCAL_TEST_PRICES[interval];
  const { getStripeClient, stripeBillingClient } = await import(
    '../services/providers/stripe/client'
  );
  const { connectPostgres, disconnectPostgres } = await import('../db/postgres');
  const { insertMerchant, findMerchantByAppEnvironment } = await import(
    '../db/merchants/merchantRepository'
  );
  const { newId } = await import('../lib/ids');
  const { configureBillingRuntime } = await import('../services/billing/configuredBilling');
  const { createVerifiedBillingBindings } = await import('../services/billing/verifiedBindings');
  const client = getStripeClient('test');
  stage = 'Stripe Accounts read';
  const account = await client.accounts.retrieve(null);
  if (account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT)
    throw new Error('Unexpected Stripe test account');
  stage = 'Stripe Prices read and approved quote validation';
  const price = await client.prices.retrieve(selected.id);
  if (
    price.livemode ||
    !price.active ||
    price.product !== LOCAL_TEST_PRODUCT ||
    price.currency !== 'usd' ||
    price.unit_amount !== selected.amount ||
    price.recurring?.interval !== interval ||
    price.recurring.interval_count !== 1 ||
    price.tax_behavior !== 'inclusive'
  ) {
    throw new Error(
      'Test price does not match the approved product, amount, interval and inclusive tax treatment',
    );
  }
  try {
    const db = await connectPostgres();
    const merchant =
      (await findMerchantByAppEnvironment(db, LOCAL_TEST_APP, 'development')) ??
      (await insertMerchant(db, {
        publicId: newId('merch'),
        oxyAppId: LOCAL_TEST_APP,
        environment: 'development',
        displayName: 'Local test checkout',
      }));
    if (!merchant) throw new Error('Local test merchant registration failed');
    const configuration = localTestBillingConfiguration(
      await localTestBillingOwner(db, merchant),
      account.id,
    );
    const cohort = configuration.cohorts[0];
    if (!cohort) throw new Error('Local billing owner is absent');
    const { evidenceRef, ...owner } = cohort;
    stage = 'Accounts and Billing Portal configuration read';
    const runtime = await configureBillingRuntime(db, JSON.stringify(configuration));
    if (!runtime) throw new Error('Local billing runtime unavailable');
    const bindings = createVerifiedBillingBindings({
      db,
      client: stripeBillingClient('test'),
      deployment: configuration.deployment,
      cohorts: [{ ...cohort, ...configuration.deployment }],
    });
    stage = 'Price ownership binding';
    await bindings.importPrice(owner, {
      providerPriceId: selected.id,
      planId: selected.plan,
      evidenceRef,
    });
    const storeId = `local-payer-${process.env.PEABLE_TEST_RUN_ID}`;
    stage = 'Customers create/read';
    const customer = await runtime.service.ensureCustomer(
      owner,
      { store_id: storeId, store_name: 'Local subscription test', rail: 'stripe' },
      `customer-${process.env.PEABLE_TEST_RUN_ID}`,
    );
    stage = 'Checkout Sessions create/read';
    const session = await runtime.service.createCheckoutSession(
      owner,
      {
        rail: 'stripe',
        store_id: storeId,
        plan_id: selected.plan,
        provider_customer_id: customer.provider_customer_id,
        provider_price_id: selected.id,
        trial_days: 0,
        return_url: returnUrl,
      },
      `subscription-${interval}-${process.env.PEABLE_TEST_RUN_ID}`,
    );
    const directory = join(homedir(), '.local/share/peable-stripe-test');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = join(directory, `subscription-${interval}.json`);
    await writeFile(
      output,
      JSON.stringify({
        object: 'local_test_subscription_checkout',
        livemode: false,
        account: account.id,
        owner: {
          merchant_id: owner.merchantId,
          oxy_app_id: owner.oxyAppId,
          environment: owner.environment,
        },
        interval,
        amount: String(selected.amount),
        currency: 'USD',
        session,
      }),
      { mode: 0o600 },
    );
    console.info(
      JSON.stringify({
        account: account.id,
        merchant: merchant.publicId,
        interval,
        artifact: output,
      }),
    );
  } finally {
    await disconnectPostgres();
  }
}
void run().catch((error: unknown) => {
  const safe = (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;
  const info = error as {
    issues?: { path: (string | number)[]; code: string }[];
    name?: unknown;
    code?: unknown;
    cause?: { code?: unknown; constraint_name?: unknown };
  };
  console.error(
    JSON.stringify({
      issues: info?.issues?.map((i) => ({ path: i.path, code: i.code })),
      error_type: safe(info?.name),
      code: safe(info?.code),
      database_code: safe(info?.cause?.code),
      constraint: safe(info?.cause?.constraint_name),
    }),
  );
  console.error(
    `Local test failed during ${stage}. Check the test account, local configuration and restricted-key permission checklist in docs/local-stripe-test.md. Provider payloads are not logged.`,
  );
  process.exitCode = 1;
});
