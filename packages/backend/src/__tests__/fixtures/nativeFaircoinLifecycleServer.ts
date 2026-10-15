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
import { createConfiguredFiscalAuthority } from '../../services/billing/configuredFiscalAuthority';
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
    interval: 'month' as const,
    intervalCount: 1 as const,
    taxTreatment: 'inclusive' as const,
  }));
  const calculator = createConfiguredFiscalAuthority(
    {
      keyId: 'fixture',
      quoteLifetimeSeconds: 300,
      declarations: offers.map((offer) => ({
        owner,
        sellerLegalEntity: {
          legalName: 'Synthetic only',
          taxIdentifier: 'SYNTHETIC-ID',
          registrationJurisdiction: 'SYNTHETIC',
        },
        product: {
          configurationApproved: true,
          planId: offer.planId,
          currency: 'USD',
          grossMinorUnits: offer.grossMinorUnits,
          taxTreatment: 'inclusive',
          sellerId: 'seller_fixture',
          invoiceIssuerId: 'issuer_fixture',
          taxRemitterId: 'remitter_fixture',
          taxServiceRef: 'synthetic',
          allowedCountries: ['RO'],
          coverageEvidenceId: 'synthetic_coverage',
        },
        rates: [
          {
            country: 'RO',
            rateNumerator: 1,
            rateDenominator: 5,
            rounding: 'half_up_minor_unit',
            evidenceId: 'SYNTHETIC_NOT_REAL_TAX',
            validFrom: '2026-01-01T00:00:00Z',
            validUntil: '2099-01-01T00:00:00Z',
          },
        ],
        locations: [
          {
            id: 'location_fixture',
            storeId: input.accountId,
            appId: input.appId,
            country: 'RO',
            mode: 'live',
            environment: 'production',
            observedAt: new Date(+clock() - 1000).toISOString(),
            expiresAt: '2099-01-01T00:00:00Z',
          },
        ],
      })),
    },
    keys.privateKey,
    clock,
  );
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
