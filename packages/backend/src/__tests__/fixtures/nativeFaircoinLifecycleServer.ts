/** Local-only native FairCoin acceptance fixture. Real routes, SDK, PostgreSQL and
 * settlement watcher; synthetic identity, price, fiscal declarations and node observations.
 * No external request, wallet signing or economic transfer is possible. */
import { createInterface } from 'node:readline';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { deriveKeyFromSeed, getNetwork, mnemonicToSeed } from '@fairco.in/core';
import { eq } from 'drizzle-orm';
import { createSuiteDatabase, dropSuiteDatabase } from '../../db/testDatabase';
import { insertMerchant } from '../../db/merchants/merchantRepository';
import { findIntentById } from '../../db/payments/paymentIntentRepository';
import { faircoinBillingInvoices } from '../../db/schema';
import {
  createFaircoinBillingService,
  faircoinBillingConfigurationSchema,
} from '../../services/billing/faircoinBillingService';
import { createPeableTaxQuoteCalculator } from '../../services/tax/billingTaxQuotes';
import { createTaxService } from '../../services/tax/taxService';
import type { TaxProvider } from '../../services/tax/provider';
import { taxLocationEvidence, taxRegistrations, taxSettings } from '../../db/schema/tax';
import { createBillingRouter } from '../../routes/billing';
import { createMerchantsRouter } from '../../routes/merchants';
import { transitionIntent } from '../../services/intentTransition';
import { SettlementWatcher } from '../../services/settlementWatcher';
import { must } from '../helpers/must';

for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(process.env[name] ?? '').hostname))
    throw new Error('Local database required');
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (!['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('External network forbidden');
  return nativeFetch(input, init);
}) as typeof fetch;
const suite = await createSuiteDatabase();
let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
const RealDate = Date;
let offset = 0;
class FixtureDate extends RealDate {
  constructor(value?: string | number) {
    super(value === undefined ? RealDate.now() + offset : value);
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = FixtureDate as DateConstructor;
const clock = () => new Date();
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
async function initialize(input: {
  appId: string;
  accountId: string;
  offers: Array<{
    planId: string;
    offerId: string;
    offerVersion: number;
    providerPriceId: string;
    grossMinorUnits: number;
    interval?: 'month' | 'year';
  }>;
}) {
  // Public BIP39 test vector, never a user's wallet. Only its watch-only xpub enters the gateway.
  const network = getNetwork('mainnet');
  const vector = `${'abandon '.repeat(23)}art`;
  const xpub = deriveKeyFromSeed(mnemonicToSeed(vector), network).derive(
    `m/44'/${network.bip44CoinType}'/0'`,
  ).hdKey.publicExtendedKey;
  const merchant = must(
    await insertMerchant(suite.db, {
      publicId: `merch_${randomUUID().replaceAll('-', '')}`,
      oxyAppId: input.appId,
      environment: 'production',
      network: 'mainnet',
      xpub,
      webhookUrl: 'https://example.invalid/synthetic',
      webhookSecret: 'synthetic',
    }),
  );
  const owner = {
    merchantId: merchant.id,
    oxyAppId: input.appId,
    environment: 'production' as const,
  };
  const offers = input.offers.map((offer) => ({
    ...offer,
    currency: 'USD' as const,
    interval: offer.interval ?? 'month',
    intervalCount: 1 as const,
    taxTreatment: 'inclusive' as const,
  }));
  // Peable Tax with a synthetic provider: an approved RO registration and a
  // flat 20% inclusive rate. SYNTHETIC — not a real rate, registration or seller.
  await suite.db.insert(taxSettings).values({
    merchantId: merchant.id,
    status: 'active',
    legalName: 'Synthetic only',
    headOffice: { country: 'US', state: 'DE' },
    calculationAccount: 'platform',
    approvedAt: clock(),
    approvedBy: 'synthetic-owner',
  });
  await suite.db.insert(taxRegistrations).values({
    publicId: 'taxreg_synthetic',
    merchantId: merchant.id,
    country: 'RO',
    scheme: 'standard',
    activeFrom: new Date('2026-01-01T00:00:00Z'),
    approvedAt: clock(),
    approvedBy: 'synthetic-owner',
  });
  await suite.db.insert(taxLocationEvidence).values({
    publicId: 'location_fixture',
    merchantId: merchant.id,
    customerRef: input.accountId,
    status: 'sufficient',
    rule: 'eu_digital_two_items',
    country: 'RO',
    items: [
      { type: 'billing_address', country: 'RO', state: null },
      { type: 'payment_method_country', country: 'RO', state: null },
    ],
    observedAt: new Date(+clock() - 1000),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  });
  const syntheticProvider: TaxProvider = {
    id: 'synthetic_tax',
    livemode: true,
    async status() {
      return { active: true, headOffice: { country: 'US', state: 'DE' }, missing: [] };
    },
    async calculate(request) {
      return {
        providerRef: `synthetic_${randomUUID()}`,
        livemode: true,
        expiresAt: null,
        lineItems: request.lineItems.map((line) => {
          const amountTax =
            line.taxBehavior === 'inclusive'
              ? line.amount - Math.round(line.amount / 1.2)
              : Math.round(line.amount * 0.2);
          return {
            reference: line.reference,
            amount: line.amount,
            amountTax,
            taxBehavior: line.taxBehavior,
            breakdown: [
              {
                country: 'RO',
                state: null,
                level: 'country',
                displayName: 'SYNTHETIC_NOT_REAL_TAX',
                taxType: 'vat',
                ratePercentage: '20.0',
                taxableAmount:
                  line.taxBehavior === 'inclusive' ? line.amount - amountTax : line.amount,
                amount: amountTax,
                inclusive: line.taxBehavior === 'inclusive',
                taxabilityReason: 'standard_rated',
              },
            ],
          };
        }),
      };
    },
  };
  const calculator = createPeableTaxQuoteCalculator({
    db: suite.db,
    tax: createTaxService({ db: suite.db, provider: syntheticProvider, now: clock }),
    offers: () => offers,
    signingKey: keys.privateKey,
    keyId: 'fixture',
    now: clock,
  });
  const service = createFaircoinBillingService({
    db: suite.db,
    configuration: faircoinBillingConfigurationSchema.parse({
      cohorts: [{ ...owner, offers }],
      priceSource: 'faircoin_explorer_indexed_usd',
      taxQuoteAdapterRef: 'fixture',
      invoiceSigningKeyId: 'fixture',
    }),
    taxQuoteCalculator: calculator,
    invoiceSigningKey: keys.privateKey,
    now: clock,
    quote: async (amount) => ({
      id: `fx_${randomUUID()}`,
      currency: 'USD',
      grossMinorUnits: amount,
      amountBaseUnits: String(BigInt(amount) * 1000000n),
      usdPerFair: '1',
      source: 'SYNTHETIC_NOT_REAL_FX',
      observedAt: clock().toISOString(),
      quotedAt: new Date(+clock() - 1000).toISOString(),
      expiresAt: new Date(+clock() + 300000).toISOString(),
      rounding: 'ceil_to_base_unit',
    }),
  });
  const auth: RequestHandler = (req, _res, next) => {
    (req as OxyAuthRequest).serviceApp = {
      appId: input.appId,
      environment: 'production',
      appName: 'synthetic',
      credentialId: 'synthetic',
      ownerAccountId: 'not-payer',
      tier: 'external',
      scopes: ['payments:read', 'payments:write'],
    };
    next();
  };
  const app = express();
  app.use(express.json());
  app.post('/auth/service-token', (_req, res) =>
    res.json({ data: { token: 'synthetic', expiresIn: 300 } }),
  );
  app.use(createBillingRouter({ requireMerchant: auth, service }));
  app.use(createMerchantsRouter({ requireMerchant: auth }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => must(server).once('listening', resolve));
  return {
    merchantId: merchant.publicId,
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    publicKey,
    now: clock().toISOString(),
  };
}
async function settle(checkoutId: string) {
  const [row] = await suite.db
    .select()
    .from(faircoinBillingInvoices)
    .where(eq(faircoinBillingInvoices.checkoutRef, checkoutId));
  const invoice = must(row);
  const intent = must(await findIntentById(suite.db, must(invoice.paymentIntentId)));
  await transitionIntent(intent.id, {
    from: 'created',
    status: 'broadcast',
    txid: randomUUID().replaceAll('-', '').repeat(2),
  });
  const updated = must(await findIntentById(suite.db, intent.id));
  const watcher = new SettlementWatcher({
    getTransaction: async (txid) => ({
      txid,
      confirmations: 2,
      outputs: [{ address: must(updated.address), valueSat: BigInt(updated.amount) }],
    }),
    onChange: () => {},
  });
  await watcher.check();
  return { invoiceId: invoice.id, subscriptionId: invoice.subscriptionId };
}
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line) as { id: number; method: string; input: unknown };
  try {
    let result: unknown;
    if (message.method === 'initialize')
      result = await initialize(message.input as Parameters<typeof initialize>[0]);
    else if (message.method === 'settle') result = await settle(String(message.input));
    else if (message.method === 'clock') {
      offset = +new RealDate(String(message.input)) - RealDate.now();
      result = { now: clock().toISOString() };
    } else if (message.method === 'shutdown') {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      await dropSuiteDatabase(suite);
      result = { ok: true };
    } else throw new Error('Unknown command');
    console.log(`NATIVE_FIXTURE:${JSON.stringify({ id: message.id, result })}`);
    if (message.method === 'shutdown') break;
  } catch (error) {
    console.log(
      `NATIVE_FIXTURE:${JSON.stringify({ id: message.id, error: error instanceof Error ? error.message : 'fixture_failed' })}`,
    );
  }
}
