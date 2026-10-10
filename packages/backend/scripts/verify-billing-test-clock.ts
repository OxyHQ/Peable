/** Reviewed opt-in provider rehearsal, never booted by the application.
 * Run with --no-env-file. Only the existing test key is read, in memory.
 * Test Clock/import fixtures are distinct from actual hosted Checkout evidence.
 */
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

if (!process.argv.includes('--execute')) {
  console.log(
    'Dry run: no key read, database or Stripe call. Requires reviewed --execute and private unique manifest.',
  );
  process.exit(0);
}
const EXPECTED_ACCOUNT = 'acct_1TnXkUQWiCE02OnU';
const manifestPath = process.env.I08_SANDBOX_MANIFEST;
assert(manifestPath && resolve(manifestPath).startsWith('/home/nate/Oxy/.agent-evidence/'));
const admin = new URL(process.env.TEST_DATABASE_URL ?? '');
assert.equal(admin.hostname, '127.0.0.1');
assert.equal(admin.port, '5574');
assert.equal(admin.username, 'oxy_i01');
assert.equal(admin.pathname, '/postgres');
process.env.DATABASE_URL = admin.toString();
await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
assert.equal((await stat(dirname(manifestPath))).mode & 0o777, 0o700);
await (await open(manifestPath, 'wx', 0o600)).close();
const runId = `i08-clock-${randomUUID()}`;
type OwnedKind =
  | 'clock'
  | 'customer'
  | 'product'
  | 'price'
  | 'subscription'
  | 'paymentMethod'
  | 'invoice'
  | 'paymentIntent'
  | 'refund';
const owned: Array<{ kind: OwnedKind; id: string; customerId?: string }> = [];
const observations: Array<{ stage: string; ok: boolean }> = [];
const diagnostics: Array<Record<string, unknown>> = [];
const cleanup: Array<{ kind: string; id: string; ok: boolean; readback?: string }> = [];
let databaseName: string | undefined;
let stage = 'preflight';
let key: string | undefined;
function safeError(error: unknown) {
  const e = (error && typeof error === 'object' ? error : {}) as {
    name?: unknown;
    type?: unknown;
    code?: unknown;
    param?: unknown;
    statusCode?: unknown;
  };
  const safe = (v: unknown) =>
    typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v) ? v : undefined;
  return {
    name: safe(e.name),
    type: safe(e.type),
    code: safe(e.code),
    param: safe(e.param),
    httpStatus: typeof e.statusCode === 'number' ? e.statusCode : undefined,
  };
}
async function save() {
  const filePath = `${manifestPath}.${randomUUID()}.tmp`;
  const file = await open(filePath, 'wx', 0o600);
  try {
    await file.writeFile(
      JSON.stringify(
        {
          runId,
          phase: process.argv.includes('--failure-sca')
            ? 'test-clock-failure-sca-only'
            : 'test-clock-import-fixtures',
          account: EXPECTED_ACCOUNT,
          livemode: false,
          databaseName,
          owned,
          observations,
          diagnostics,
          cleanup,
        },
        null,
        2,
      ),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(filePath, manifestPath!);
}
async function record(kind: OwnedKind, id: string, customerId?: string) {
  assert(/^[A-Za-z0-9_]+$/.test(id));
  if (!owned.some((v) => v.kind === kind && v.id === id))
    owned.push({ kind, id, ...(customerId ? { customerId } : {}) });
  await save();
}
function requireOwned(kind: OwnedKind, id: string) {
  assert(owned.some((v) => v.kind === kind && v.id === id));
}
async function passed(label: string) {
  observations.push({ stage: label, ok: true });
  await save();
  console.log(`${label}: PASS`);
}
try {
  for await (const line of createInterface({
    input: createReadStream('/home/nate/Oxy/Mercaria/packages/backend/.env'),
    crlfDelay: Infinity,
  })) {
    if (!/^\s*STRIPE_SECRET_KEY\s*=/.test(line)) continue;
    assert.equal(key, undefined);
    key = line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  assert(key?.startsWith('sk_test_'));
  process.env.STRIPE_SECRET_KEY = key;
  const { getStripeClient, stripeBillingClient } = await import(
    '../src/services/providers/stripe/client'
  );
  const { createSuiteDatabase, dropSuiteDatabase } = await import('../src/db/testDatabase');
  const { insertMerchant } = await import('../src/db/merchants/merchantRepository');
  const { createVerifiedBillingBindings } = await import(
    '../src/services/billing/verifiedBindings'
  );
  const { createStripeBillingProvider } = await import(
    '../src/services/billing/stripeBillingProvider'
  );
  const { createBillingService } = await import('../src/services/billing/billingService');
  const { createBillingRouter } = await import('../src/routes/billing');
  const { Peable } = await import('@peable.to/sdk');
  const { default: express } = await import('express');
  const stripe = getStripeClient();
  const requestOptions = { timeout: 10_000, maxNetworkRetries: 0 } as const;
  async function platform() {
    assert(key?.startsWith('sk_test_'));
    assert.equal((await stripe.accounts.retrieve(null, {}, requestOptions)).id, EXPECTED_ACCOUNT);
  }
  async function mutate<T>(label: string, action: () => Promise<T>) {
    stage = label;
    await platform();
    return action();
  }
  await platform();
  await passed('test-key-and-platform-account');
  const db = await createSuiteDatabase();
  let http: ReturnType<ReturnType<typeof express>['listen']> | undefined;
  try {
    databaseName = new URL(db.databaseUrl).pathname.slice(1);
    await save();
    const merchant = await insertMerchant(db.db, {
      publicId: `merch_${randomUUID().replaceAll('-', '')}`,
      oxyAppId: runId,
      environment: 'development',
    });
    assert(merchant);
    const owner = {
      merchantId: merchant.id,
      oxyAppId: merchant.oxyAppId,
      environment: merchant.environment,
    };
    const deployment = {
      provider: 'stripe' as const,
      platformAccountId: EXPECTED_ACCOUNT,
      livemode: false,
    };
    const cohorts = [{ ...owner, ...deployment, evidenceRef: runId }];
    const client = stripeBillingClient();
    // No Portal calls/configuration mutation in this phase. Exact retained ref is server-side only.
    const provider = createStripeBillingProvider(deployment, client, {
      portalConfigurationRef: 'bpc_1UMJzbQWiCE02OnUPVAzh1TI',
    });
    const bindings = createVerifiedBillingBindings({ db: db.db, client, deployment, cohorts });
    const service = createBillingService({
      db: db.db,
      provider,
      cohorts,
      verifiedBindings: bindings,
    });
    const token = `synthetic-${randomUUID()}`;
    const secret = randomUUID();
    const app = express();
    app.use(express.json());
    app.post('/auth/service-token', (req, res) => {
      if (req.body.apiKey !== runId || req.body.apiSecret !== secret) {
        res.sendStatus(401);
        return;
      }
      res.json({ data: { token, expiresIn: 300 } });
    });
    app.use(
      createBillingRouter({
        service,
        requireMerchant: (req, res, next) => {
          if (req.header('Authorization') !== `Bearer ${token}`) {
            res.sendStatus(401);
            return;
          }
          Object.assign(req, {
            serviceApp: {
              appId: owner.oxyAppId,
              environment: owner.environment,
              appName: runId,
              credentialId: runId,
              ownerAccountId: 'synthetic-authority-not-payer',
              tier: 'external',
              scopes: ['payments:read', 'payments:write'],
            },
          });
          next();
        },
      }),
    );
    http = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => http!.once('listening', resolve));
    const address = http.address();
    assert(address && typeof address !== 'string');
    const baseURL = `http://127.0.0.1:${address.port}`;
    const sdk = new Peable({ publicKey: runId, secret, baseURL, oxyApiUrl: baseURL });
    const product = await mutate('create-owned-product', () =>
      stripe.products.create(
        { name: `Synthetic ${runId}`, metadata: { rehearsal: runId } },
        { ...requestOptions, idempotencyKey: `${runId}:product` },
      ),
    );
    assert.equal(product.livemode, false);
    await record('product', product.id);
    const price = await mutate('create-owned-price', () =>
      stripe.prices.create(
        {
          product: product.id,
          currency: 'usd',
          unit_amount: 100,
          recurring: { interval: 'month' },
        },
        { ...requestOptions, idempotencyKey: `${runId}:price` },
      ),
    );
    assert.equal(price.livemode, false);
    await record('price', price.id);
    await bindings.importPrice(owner, {
      providerPriceId: price.id,
      planId: `${runId}:plan`,
      evidenceRef: runId,
    });
    const clock = await mutate('create-owned-clock', () =>
      stripe.testHelpers.testClocks.create(
        { frozen_time: Math.floor(Date.now() / 1000), name: runId },
        { ...requestOptions, idempotencyKey: `${runId}:clock` },
      ),
    );
    await record('clock', clock.id);
    assert.equal(clock.livemode, false);
    let frozenTime = clock.frozen_time;
    async function advance(target: number) {
      requireOwned('clock', clock.id);
      assert(target > frozenTime);
      assert(target - frozenTime <= 35 * 86400);
      await mutate('advance-owned-clock', () =>
        stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: target }, requestOptions),
      );
      for (let attempt = 0; attempt < 60; attempt++) {
        const current = await stripe.testHelpers.testClocks.retrieve(clock.id, {}, requestOptions);
        assert.equal(current.livemode, false);
        if (current.status === 'ready') {
          assert.equal(current.frozen_time, target);
          frozenTime = target;
          return;
        }
        assert.equal(current.status, 'advancing');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('clock_deadline');
    }
    async function customer(label: string) {
      const value = await mutate(`create-owned-customer-${label}`, () =>
        stripe.customers.create(
          { name: `Synthetic ${label}`, test_clock: clock.id },
          { ...requestOptions, idempotencyKey: `${runId}:customer:${label}` },
        ),
      );
      assert.equal(value.livemode, false);
      assert.equal(value.test_clock, clock.id);
      await record('customer', value.id);
      await bindings.importCustomer(owner, {
        providerCustomerId: value.id,
        storeId: `${runId}:${label}`,
        evidenceRef: runId,
      });
      return value;
    }
    async function paymentMethod(
      customerId: string,
      fixture: 'pm_card_visa' | 'pm_card_chargeCustomerFail' | 'pm_card_authenticationRequired',
    ) {
      requireOwned('customer', customerId);
      const value = await mutate('attach-owned-test-payment-method', () =>
        stripe.paymentMethods.attach(
          fixture,
          { customer: customerId },
          { ...requestOptions, idempotencyKey: `${runId}:${customerId}:${fixture}` },
        ),
      );
      assert.equal(value.livemode, false);
      assert.equal(value.customer, customerId);
      await record('paymentMethod', value.id, customerId);
      return value.id;
    }
    async function subscription(
      customerId: string,
      method: string,
      label: string,
      trialDays: number,
    ) {
      requireOwned('customer', customerId);
      requireOwned('paymentMethod', method);
      requireOwned('price', price.id);
      const value = await mutate(`create-owned-subscription-${label}`, () =>
        stripe.subscriptions.create(
          {
            customer: customerId,
            items: [{ price: price.id, quantity: 1 }],
            default_payment_method: method,
            payment_behavior: 'allow_incomplete',
            ...(trialDays ? { trial_period_days: trialDays } : {}),
          },
          { ...requestOptions, idempotencyKey: `${runId}:subscription:${label}` },
        ),
      );
      assert.equal(value.livemode, false);
      assert.equal(value.customer, customerId);
      await record('subscription', value.id);
      await bindings.importSubscription(owner, {
        providerSubscriptionId: value.id,
        providerCustomerId: customerId,
        providerPriceId: price.id,
        evidenceRef: runId,
      });
      const actual = await sdk.billing.retrieveSubscription(value.id);
      assert.equal(actual.storeId, `${runId}:${label}`);
      assert.equal(actual.planId, `${runId}:plan`);
      return value;
    }
    async function latestInvoice(subscriptionId: string, customerId: string) {
      requireOwned('subscription', subscriptionId);
      requireOwned('customer', customerId);
      const sub = await stripe.subscriptions.retrieve(subscriptionId, {}, requestOptions);
      assert.equal(sub.livemode, false);
      assert.equal(sub.customer, customerId);
      assert.equal(typeof sub.latest_invoice, 'string');
      const invoice = await stripe.invoices.retrieve(
        sub.latest_invoice as string,
        {},
        requestOptions,
      );
      assert.equal(invoice.livemode, false);
      assert.equal(invoice.customer, customerId);
      assert.equal(invoice.parent?.subscription_details?.subscription, subscriptionId);
      await record('invoice', invoice.id);
      return invoice;
    }
    async function invoiceIntent(invoiceId: string, customerId: string) {
      requireOwned('invoice', invoiceId);
      const payments = await stripe.invoicePayments.list(
        { invoice: invoiceId, limit: 2 },
        requestOptions,
      );
      assert.equal(payments.has_more, false);
      assert.equal(payments.data.length, 1);
      const payment = payments.data[0]!;
      assert.equal(payment.livemode, false);
      assert.equal(payment.invoice, invoiceId);
      assert.equal(payment.payment.type, 'payment_intent');
      assert.equal(typeof payment.payment.payment_intent, 'string');
      const intent = await stripe.paymentIntents.retrieve(
        payment.payment.payment_intent as string,
        {},
        requestOptions,
      );
      assert.equal(intent.livemode, false);
      assert.equal(intent.customer, customerId);
      await record('paymentIntent', intent.id);
      return intent;
    }
    async function throughPeriod(subscriptionId: string) {
      const before = await sdk.billing.retrieveSubscription(subscriptionId);
      const end = Date.parse(before.currentPeriodEnd) / 1000;
      await advance(end + 1);
      await advance(end + 7201); // Observe invoice creation, then its automatic finalization window.
      return sdk.billing.retrieveSubscription(subscriptionId);
    }
    if (!process.argv.includes('--failure-sca')) {
      const goodCustomer = await customer('happy');
      const visa = await paymentMethod(goodCustomer.id, 'pm_card_visa');
      const good = await subscription(goodCustomer.id, visa, 'happy', 3);
      assert.equal((await sdk.billing.retrieveSubscription(good.id)).status, 'trialing');
      await passed('real-test-clock-trial-projection');
      assert.equal((await throughPeriod(good.id)).status, 'active');
      const firstInvoice = await latestInvoice(good.id, goodCustomer.id);
      assert.equal(firstInvoice.status, 'paid');
      assert.equal(firstInvoice.amount_paid, 100);
      await passed('real-trial-to-paid-invoice');
      assert.equal((await throughPeriod(good.id)).status, 'active');
      const renewed = await latestInvoice(good.id, goodCustomer.id);
      assert.notEqual(renewed.id, firstInvoice.id);
      assert.equal(renewed.status, 'paid');
      assert.equal(renewed.amount_paid, 100);
      await passed('real-renewal-paid-new-invoice');
      const paidIntent = await invoiceIntent(renewed.id, goodCustomer.id);
      assert.equal(paidIntent.status, 'succeeded');
      assert.equal(paidIntent.amount_received, 100);
      const refundParams = { payment_intent: paidIntent.id, amount: 100 };
      const refundOptions = { ...requestOptions, idempotencyKey: `${runId}:refund` };
      const refund = await mutate('refund-owned-test-invoice', () =>
        stripe.refunds.create(refundParams, refundOptions),
      );
      await record('refund', refund.id);
      assert.equal(refund.payment_intent, paidIntent.id);
      assert.equal(refund.status, 'succeeded');
      assert.equal(refund.amount, 100);
      const retryRefund = await mutate('replay-owned-test-refund', () =>
        stripe.refunds.create(refundParams, refundOptions),
      );
      assert.equal(retryRefund.id, refund.id);
      await passed('real-own-invoice-refund-same-key');
      const cancelled = await mutate('sdk-period-end-cancellation', () =>
        sdk.billing.cancelAtPeriodEnd(good.id, { idempotencyKey: `${runId}:cancel` }),
      );
      assert.equal(cancelled.cancelAtPeriodEnd, true);
      const cancelEnd = Date.parse(cancelled.currentPeriodEnd) / 1000;
      await advance(cancelEnd + 1);
      assert.equal((await sdk.billing.retrieveSubscription(good.id)).status, 'canceled');
      await passed('real-period-end-cancellation-observed');
    }

    const failedCustomer = await customer('failure');
    const goodMethod = await paymentMethod(failedCustomer.id, 'pm_card_visa');
    const failing = await subscription(failedCustomer.id, goodMethod, 'failure', 0);
    assert.equal(failing.status, 'active');
    const declined = await paymentMethod(failedCustomer.id, 'pm_card_chargeCustomerFail');
    await mutate('set-owned-declining-method', () =>
      stripe.subscriptions.update(failing.id, { default_payment_method: declined }, requestOptions),
    );
    const pastDue = await throughPeriod(failing.id);
    assert.equal(pastDue.status, 'past_due');
    const failedInvoice = await latestInvoice(failing.id, failedCustomer.id);
    assert.equal(failedInvoice.status, 'open');
    assert.equal(failedInvoice.amount_paid, 0);
    const failedIntent = await invoiceIntent(failedInvoice.id, failedCustomer.id);
    assert.equal(failedIntent.status, 'requires_payment_method');
    await passed('real-renewal-payment-failure-projected');

    const scaCustomer = await customer('sca');
    const scaMethod = await paymentMethod(scaCustomer.id, 'pm_card_authenticationRequired');
    const sca = await subscription(scaCustomer.id, scaMethod, 'sca', 0);
    assert.equal((await sdk.billing.retrieveSubscription(sca.id)).status, 'incomplete');
    const scaInvoice = await latestInvoice(sca.id, scaCustomer.id);
    assert.equal(scaInvoice.status, 'open');
    assert.equal(scaInvoice.amount_paid, 0);
    const scaIntent = await invoiceIntent(scaInvoice.id, scaCustomer.id);
    assert.equal(scaIntent.status, 'requires_action');
    // Do not complete or bypass the challenge. Only observe its authoritative state.
    await passed('real-sca-required-incomplete-projected');
  } catch (error) {
    diagnostics.push({ stage, ...safeError(error) });
    observations.push({ stage, ok: false });
    await save();
    console.log(`${stage}: FAIL (sanitized details in private manifest)`);
    process.exitCode = 1;
  } finally {
    try {
      if (http)
        await new Promise<void>((resolve) => {
          http!.close(() => resolve());
          http!.closeAllConnections();
        });
    } catch {
      process.exitCode = 1;
    }
    for (const value of owned.filter((v) => v.kind === 'customer')) {
      try {
        requireOwned('customer', value.id);
        await mutate('cleanup-owned-customer', () =>
          stripe.customers.del(value.id, {}, requestOptions),
        );
        const after = await stripe.customers.retrieve(value.id, {}, requestOptions);
        assert('deleted' in after && after.deleted);
        cleanup.push({ ...value, ok: true, readback: 'deleted' });
      } catch (error) {
        cleanup.push({ ...value, ok: false });
        diagnostics.push({ stage: 'cleanup-customer', ...safeError(error) });
        process.exitCode = 1;
      }
      await save().catch(() => {
        process.exitCode = 1;
      });
    }
    for (const value of owned.filter((v) => v.kind === 'subscription')) {
      try {
        const after = await stripe.subscriptions.retrieve(value.id, {}, requestOptions);
        assert.equal(after.status, 'canceled');
        cleanup.push({ ...value, ok: true, readback: 'canceled' });
      } catch (error) {
        cleanup.push({ ...value, ok: false });
        diagnostics.push({ stage: 'cleanup-subscription', ...safeError(error) });
        process.exitCode = 1;
      }
    }
    for (const value of owned.filter((v) => v.kind === 'paymentMethod')) {
      try {
        const before = await stripe.paymentMethods.retrieve(value.id, {}, requestOptions);
        assert.equal(before.livemode, false);
        if (before.customer !== null) {
          assert(value.customerId);
          requireOwned('customer', value.customerId);
          assert.equal(before.customer, value.customerId);
          await mutate('cleanup-own-payment-method', () =>
            stripe.paymentMethods.detach(value.id, {}, requestOptions),
          );
        }
        const after = await stripe.paymentMethods.retrieve(value.id, {}, requestOptions);
        assert.equal(after.customer, null);
        cleanup.push({
          kind: value.kind,
          id: value.id,
          ok: true,
          readback: 'detached-readback-null',
        });
      } catch (error) {
        cleanup.push({ ...value, ok: false });
        diagnostics.push({ stage: 'cleanup-payment-method', ...safeError(error) });
        process.exitCode = 1;
      }
    }
    for (const value of [...owned]
      .reverse()
      .filter((v) => ['clock', 'price', 'product'].includes(v.kind))) {
      try {
        requireOwned(value.kind, value.id);
        if (value.kind === 'clock') {
          const removed = await mutate('cleanup-owned-clock', () =>
            stripe.testHelpers.testClocks.del(value.id, {}, requestOptions),
          );
          assert.equal(removed.deleted, true);
        }
        if (value.kind === 'price') {
          await mutate('cleanup-owned-price', () =>
            stripe.prices.update(value.id, { active: false }, requestOptions),
          );
          assert.equal((await stripe.prices.retrieve(value.id, {}, requestOptions)).active, false);
        }
        if (value.kind === 'product') {
          await mutate('cleanup-owned-product', () =>
            stripe.products.update(value.id, { active: false }, requestOptions),
          );
          assert.equal(
            (await stripe.products.retrieve(value.id, {}, requestOptions)).active,
            false,
          );
        }
        cleanup.push({
          ...value,
          ok: true,
          readback: value.kind === 'clock' ? 'deleted' : 'inactive',
        });
      } catch (error) {
        cleanup.push({ ...value, ok: false });
        diagnostics.push({ stage: `cleanup-${value.kind}`, ...safeError(error) });
        process.exitCode = 1;
      }
      await save().catch(() => {
        process.exitCode = 1;
      });
    }
    try {
      await dropSuiteDatabase(db);
      cleanup.push({ kind: 'database', id: databaseName!, ok: true, readback: 'dropped' });
    } catch {
      cleanup.push({ kind: 'database', id: databaseName!, ok: false });
      process.exitCode = 1;
    }
    await save().catch(() => {
      process.exitCode = 1;
    });
  }
} catch (error) {
  diagnostics.push({ stage, ...safeError(error) });
  await save().catch(() => {});
  console.log('test-clock-preflight-or-cleanup: FAIL');
  process.exitCode = 1;
} finally {
  delete process.env.STRIPE_SECRET_KEY;
  key = undefined;
}
