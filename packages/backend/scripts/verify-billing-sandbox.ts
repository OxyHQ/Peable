/** Explicit opt-in rehearsal. Never imported by runtime/tests. Review before --execute.
 * Run Bun with --no-env-file. Reads ONLY the named Stripe test key, never loads a dotenv environment.
 * Public stdout contains stage names/outcomes only; the private manifest contains owned IDs, no URLs/keys.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, open, access, stat, realpath, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const EXPECTED_ACCOUNT = 'acct_1TnXkUQWiCE02OnU';
const KEY_FILE = '/home/nate/Oxy/Mercaria/packages/backend/.env';
const args = new Set(process.argv.slice(2));
if (!args.has('--execute')) {
  console.log('Dry run: no environment file read, provider call, database or browser created. Requires reviewed --execute --checkout and I08_SANDBOX_MANIFEST.');
  process.exit(0);
}
assert(args.has('--checkout'), 'Only the reviewed Checkout phase is implemented by this script');
const manifestPath = process.env.I08_SANDBOX_MANIFEST;
assert(manifestPath && resolve(manifestPath).startsWith('/home/nate/Oxy/.agent-evidence/'), 'Private manifest path required');
const adminUrl = process.env.TEST_DATABASE_URL;
assert(adminUrl, 'Explicit own PostgreSQL required');
const parsedAdmin = new URL(adminUrl);
assert.equal(parsedAdmin.hostname, '127.0.0.1'); assert.equal(parsedAdmin.port, '5574'); assert.equal(parsedAdmin.username, 'oxy_i01'); assert.equal(parsedAdmin.pathname, '/postgres');
process.env.DATABASE_URL = adminUrl;
// Never enable browser protocol logging in a rehearsal handling hosted URLs.
delete process.env.DEBUG; delete process.env.PWDEBUG;
const manifestDirectory = dirname(manifestPath);
await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
assert.equal((await stat(manifestDirectory)).mode & 0o777, 0o700, 'Manifest directory must be private (0700)');
const manifestFile = await open(manifestPath, 'wx', 0o600);
await manifestFile.close();
let testKey: string | undefined;
try {
const playwrightPath = process.env.I08_PLAYWRIGHT_MODULE;
assert(playwrightPath, 'Reviewed local Playwright module required');
assert(playwrightPath.startsWith('/'), 'Reviewed local Playwright module must be absolute');
const resolvedPlaywright = await realpath(playwrightPath);
await access(resolvedPlaywright, constants.R_OK);
const browserExecutable = '/home/nate/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
await access(browserExecutable, constants.X_OK);
const { chromium } = await import(resolvedPlaywright);
assert.equal(typeof chromium?.launch, 'function', 'Invalid Playwright module');
for await (const line of createInterface({ input: createReadStream(KEY_FILE), crlfDelay: Infinity })) {
  if (!/^\s*STRIPE_SECRET_KEY\s*=/.test(line)) continue;
  assert.equal(testKey, undefined, 'Ambiguous Stripe key assignment');
  const raw = line.slice(line.indexOf('=') + 1).trim();
  testKey = raw.replace(/^(['"])(.*)\1$/, '$2');
}
assert(testKey?.startsWith('sk_test_'), 'Only the existing sk_test_ key is allowed');
process.env.STRIPE_SECRET_KEY = testKey;
// No STRIPE_ENABLED/publishable/webhook settings are invented or copied.
const { getStripeClient, stripeBillingClient } = await import('../src/services/providers/stripe/client');
const { createSuiteDatabase, dropSuiteDatabase } = await import('../src/db/testDatabase');
const { insertMerchant } = await import('../src/db/merchants/merchantRepository');
const { createVerifiedBillingBindings } = await import('../src/services/billing/verifiedBindings');
const { createStripeBillingProvider } = await import('../src/services/billing/stripeBillingProvider');
const { createBillingService } = await import('../src/services/billing/billingService');
const { createBillingRouter } = await import('../src/routes/billing');
const { Peable } = await import('@peable.to/sdk');
const { default: express } = await import('express');
const stripe = getStripeClient();
const requestOptions = { timeout: 10_000, maxNetworkRetries: 0 } as const;
const runId = `i08-${randomUUID()}`;
type Owned = { kind: 'product' | 'price' | 'portalConfiguration' | 'customer' | 'checkout' | 'subscription'; id: string };
const owned: Owned[] = [];
const observations: Array<{ stage: string; ok: boolean }> = [];
const cleanup: Array<{ kind: string; id: string; ok: boolean; readback?: string }> = [];
let databaseName: string | undefined;
let stage = 'preflight';
async function save() {
  const data = JSON.stringify({ schemaVersion: 1, runId, account: EXPECTED_ACCOUNT, livemode: false, phase: 'real-checkout', databaseName, owned, observations, cleanup }, null, 2);
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temporary, manifestPath!);
}
async function record(kind: Owned['kind'], id: string) { assert(!id.includes('?')); owned.push({ kind, id }); await save(); }
function requireOwned(kind: Owned['kind'], id: string) { assert(owned.some((value) => value.kind === kind && value.id === id), 'Object not owned by this rehearsal'); }
async function assertPlatform() {
  assert(testKey?.startsWith('sk_test_'));
  const account = await stripe.accounts.retrieve(null, {}, { timeout: 10_000, maxNetworkRetries: 0 });
  assert.equal(account.id, EXPECTED_ACCOUNT);
}
async function mutate<T>(label: string, effect: () => Promise<T>): Promise<T> {
  stage = label; await assertPlatform(); return effect();
}
async function passed(label: string) { observations.push({ stage: label, ok: true }); await save(); console.log(`${label}: PASS`); }
await assertPlatform(); await passed('test-key-and-platform-account');
const db = await createSuiteDatabase();
databaseName = new URL(db.databaseUrl).pathname.slice(1);
let http: ReturnType<ReturnType<typeof express>['listen']> | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  await save();
  // Validate that the isolated browser can launch before creating ANY Stripe object.
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const merchant = await insertMerchant(db.db, { publicId: `merch_${randomUUID().replaceAll('-', '')}`, oxyAppId: runId, environment: 'development' });
  assert(merchant);
  const owner = { merchantId: merchant.id, oxyAppId: merchant.oxyAppId, environment: merchant.environment };
  const deployment = { provider: 'stripe' as const, platformAccountId: EXPECTED_ACCOUNT, livemode: false };
  const cohorts = [{ ...owner, ...deployment, evidenceRef: runId }];
  const product = await mutate('create-owned-test-product', () => stripe.products.create({ name: `Synthetic I08 ${runId}`, metadata: { rehearsal: runId } }, { ...requestOptions, idempotencyKey: `${runId}:product` }));
  assert.equal(product.livemode, false); await record('product', product.id);
  const price = await mutate('create-owned-test-price', () => stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 100, recurring: { interval: 'month' }, metadata: { rehearsal: runId } }, { ...requestOptions, idempotencyKey: `${runId}:price` }));
  assert.equal(price.livemode, false); await record('price', price.id);
  const portal = await mutate('create-owned-test-portal-configuration', () => stripe.billingPortal.configurations.create({
    business_profile: { headline: 'Synthetic I08 test billing', privacy_policy_url: 'https://example.invalid/privacy', terms_of_service_url: 'https://example.invalid/terms' },
    features: { payment_method_update: { enabled: true }, subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'at_period_end' } },
    metadata: { rehearsal: runId },
  }, { ...requestOptions, idempotencyKey: `${runId}:portal-config` }));
  assert.equal(portal.livemode, false); await record('portalConfiguration', portal.id);
  const client = stripeBillingClient();
  const provider = createStripeBillingProvider(deployment, client, { portalConfigurationRef: portal.id });
  const verifiedBindings = createVerifiedBillingBindings({ db: db.db, client, deployment, cohorts });
  const service = createBillingService({ db: db.db, provider, cohorts, verifiedBindings });
  const token = `synthetic-${randomUUID()}`; const secret = randomUUID();
  const app = express(); app.use(express.json());
  app.post('/auth/service-token', (req, res) => {
    if (req.body.apiKey !== runId || req.body.apiSecret !== secret) { res.sendStatus(401); return; }
    res.json({ data: { token, expiresIn: 300 } });
  });
  let loseFirstCheckoutResponse = true;
  app.use((req, res, next) => {
    if (req.path === '/v1/billing/checkout_sessions' && loseFirstCheckoutResponse) {
      const original = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode < 400) { loseFirstCheckoutResponse = false; res.destroy(); return res; }
        return original(body);
      }) as typeof res.json;
    }
    next();
  });
  app.use(createBillingRouter({ service, requireMerchant: (req, res, next) => {
    if (req.header('Authorization') !== `Bearer ${token}`) { res.sendStatus(401); return; }
    Object.assign(req, { serviceApp: { appId: owner.oxyAppId, environment: owner.environment, appName: runId, credentialId: runId, ownerAccountId: 'synthetic-authority-not-payer', tier: 'external', scopes: ['payments:read', 'payments:write'] } }); next();
  } }));
  http = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => http!.once('listening', resolve));
  const address = http.address(); assert(address && typeof address !== 'string'); const baseURL = `http://127.0.0.1:${address.port}`;
  const sdk = new Peable({ publicKey: runId, secret, baseURL, oxyApiUrl: baseURL });
  const customer = await mutate('sdk-ensure-customer', () => sdk.billing.ensureCustomer({ storeId: runId, storeName: 'Synthetic I08 Store' }, { idempotencyKey: `${runId}:customer` }));
  await record('customer', customer.providerCustomerId);
  assert.deepEqual(await sdk.billing.ensureCustomer({ storeId: runId, storeName: 'Renamed Synthetic I08 Store' }, { idempotencyKey: `${runId}:customer-reuse` }), customer);
  await passed('real-customer-idempotent-store-binding');
  await verifiedBindings.importPrice(owner, { providerPriceId: price.id, planId: `${runId}:plan`, evidenceRef: runId });
  const checkoutInput = { providerCustomerId: customer.providerCustomerId, providerPriceId: price.id, trialDays: 0, returnUrl: 'https://example.invalid/i08', storeId: runId, planId: `${runId}:plan` };
  let lostResponse = false;
  try { await mutate('sdk-checkout-response-loss', () => sdk.billing.createCheckoutSession(checkoutInput, { idempotencyKey: `${runId}:checkout` })); } catch { lostResponse = !loseFirstCheckoutResponse; }
  assert(lostResponse, 'Expected a lost HTTP response only after committed real Checkout success');
  const checkout = await mutate('sdk-checkout-retry', () => sdk.billing.createCheckoutSession(checkoutInput, { idempotencyKey: `${runId}:checkout` }));
  await passed('real-provider-success-http-response-loss-same-key-recovery');
  assert.deepEqual(await sdk.billing.createCheckoutSession(checkoutInput, { idempotencyKey: `${runId}:checkout` }), checkout);
  // URL is retained only in memory. Do not print it or browser diagnostics.
  const sessions = await stripe.checkout.sessions.list({ customer: customer.providerCustomerId, limit: 2 }, requestOptions);
  assert.equal(sessions.has_more, false); assert.equal(sessions.data.length, 1); const session = sessions.data[0]!;
  assert.equal(session.livemode, false); assert.equal(session.mode, 'subscription'); await record('checkout', session.id);
  const portalSession = await mutate('sdk-portal', () => sdk.billing.createPortalSession({ providerCustomerId: customer.providerCustomerId, returnUrl: checkoutInput.returnUrl }, { idempotencyKey: `${runId}:portal` }));
  assert(new URL(portalSession.url).protocol === 'https:'); await passed('real-checkout-and-portal-created');
  stage = 'isolated-browser-checkout';
  const context = await (browser as any).newContext(); const page = await context.newPage();
  await page.goto(checkout.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('#email').fill(`i08-${randomUUID()}@example.invalid`);
  await page.locator('#cardNumber').fill('4242424242424242');
  await page.locator('#cardExpiry').fill('1235'); await page.locator('#cardCvc').fill('123');
  if (await page.locator('#billingName').count()) await page.locator('#billingName').fill('Synthetic I08');
  if (await page.locator('#billingCountry').count()) await page.locator('#billingCountry').selectOption('US');
  if (await page.locator('#billingPostalCode').count()) await page.locator('#billingPostalCode').fill('42424');
  await assertPlatform();
  await page.getByRole('button', { name: /Subscribe|Pay \$/ }).last().click();
  let subscriptionId: string | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await stripe.checkout.sessions.retrieve(session.id, {}, requestOptions);
    assert.equal(value.livemode, false); assert.equal(value.customer, customer.providerCustomerId);
    if (value.status === 'complete' && typeof value.subscription === 'string') { subscriptionId = value.subscription; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(subscriptionId, 'Checkout did not complete within the bounded observation window'); await record('subscription', subscriptionId);
  const snapshot = await sdk.billing.retrieveSubscription(subscriptionId);
  assert.equal(snapshot.storeId, runId); assert.equal(snapshot.planId, `${runId}:plan`); assert.equal(snapshot.providerCustomerId, customer.providerCustomerId); assert.equal(snapshot.providerPriceId, price.id); assert.equal(snapshot.livemode, false);
  await passed('real-hosted-checkout-to-verified-local-binding');
  const cancelled = await mutate('sdk-cancel-at-period-end', () => sdk.billing.cancelAtPeriodEnd(subscriptionId!, { idempotencyKey: `${runId}:cancel` }));
  assert.equal(cancelled.cancelAtPeriodEnd, true); await passed('real-cancel-at-period-end');
} catch {
  observations.push({ stage, ok: false }); await save(); console.log(`${stage}: FAIL (details intentionally not logged)`); process.exitCode = 1;
 } finally {
  // Each cleanup is independent: a browser failure cannot skip provider or DB teardown.
  try { await browser?.close(); } catch { cleanup.push({ kind: 'browser', id: 'isolated-context', ok: false }); process.exitCode = 1; }
  try {
    if (http) await new Promise<void>((resolve) => { http!.close(() => resolve()); http!.closeAllConnections(); });
  } catch { cleanup.push({ kind: 'http', id: 'owned-loopback-server', ok: false }); process.exitCode = 1; }
  for (const value of [...owned].reverse()) {
    requireOwned(value.kind, value.id);
    if (value.kind === 'subscription') continue; // Checked after the owning test customer is deleted.
    try {
      let readback = 'unchanged';
      if (value.kind === 'checkout') {
        await mutate('cleanup-checkout', async () => {
          const current = await stripe.checkout.sessions.retrieve(value.id, {}, requestOptions);
          assert.equal(current.livemode, false);
          if (current.status === 'open') await stripe.checkout.sessions.expire(value.id, {}, requestOptions);
        });
        const valueAfter = await stripe.checkout.sessions.retrieve(value.id, {}, requestOptions); assert(valueAfter.status === 'complete' || valueAfter.status === 'expired'); readback = valueAfter.status;
      }
      if (value.kind === 'customer') {
        await mutate('cleanup-test-customer', () => stripe.customers.del(value.id, {}, requestOptions));
        const valueAfter = await stripe.customers.retrieve(value.id, {}, requestOptions); assert('deleted' in valueAfter && valueAfter.deleted); readback = 'deleted';
      }
      if (value.kind === 'portalConfiguration') {
        await mutate('cleanup-test-portal', () => stripe.billingPortal.configurations.update(value.id, { active: false }, requestOptions));
        assert.equal((await stripe.billingPortal.configurations.retrieve(value.id, {}, requestOptions)).active, false); readback = 'inactive';
      }
      if (value.kind === 'price') {
        await mutate('cleanup-test-price', () => stripe.prices.update(value.id, { active: false }, requestOptions));
        assert.equal((await stripe.prices.retrieve(value.id, {}, requestOptions)).active, false); readback = 'inactive';
      }
      if (value.kind === 'product') {
        await mutate('cleanup-test-product', () => stripe.products.update(value.id, { active: false }, requestOptions));
        assert.equal((await stripe.products.retrieve(value.id, {}, requestOptions)).active, false); readback = 'inactive';
      }
      cleanup.push({ kind: value.kind, id: value.id, ok: true, readback });
    } catch { cleanup.push({ kind: value.kind, id: value.id, ok: false }); process.exitCode = 1; }
    await save().catch(() => { process.exitCode = 1; });
  }
  for (const value of owned.filter((value) => value.kind === 'subscription')) {
    try { const after = await stripe.subscriptions.retrieve(value.id, {}, requestOptions); assert.equal(after.status, 'canceled'); cleanup.push({ kind: value.kind, id: value.id, ok: true, readback: 'canceled-by-test-customer-deletion' }); }
    catch { cleanup.push({ kind: value.kind, id: value.id, ok: false }); process.exitCode = 1; }
  }
  try { await dropSuiteDatabase(db); cleanup.push({ kind: 'database', id: databaseName!, ok: true, readback: 'dropTestDatabase-completed' }); }
  catch { cleanup.push({ kind: 'database', id: databaseName!, ok: false }); process.exitCode = 1; }
  await save().catch(() => { process.exitCode = 1; });
}
} catch {
  console.log('sandbox-preflight-or-cleanup: FAIL (details intentionally not logged)');
  process.exitCode = 1;
} finally {
  // This encloses preflight, dynamic imports, DB creation and every cleanup.
  delete process.env.STRIPE_SECRET_KEY; testKey = undefined;
}
