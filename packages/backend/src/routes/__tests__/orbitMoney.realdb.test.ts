/**
 * Orbit's money model (ADR 0015), end to end over HTTP and through the event
 * drain, against a real database and one recording fake provider per mode.
 *
 * What is pinned:
 *  - a merchant opens its OWN account; its card payments become destination
 *    charges with `on_behalf_of` and the fee its schedule computes; an Oxy
 *    first-party merchant stays a platform charge with no fee; a marketplace
 *    with no own account stays a platform charge; a platform names
 *    `transfer_data` for its seller;
 *  - the fee the provider took becomes a `fee_…`, and its refund an `fr_…`;
 *  - the ledger: every journal sums to zero, ingestion is idempotent, a
 *    release moves pending to available, the balance reads from the entries;
 *  - payouts mirrored from events, instructed on a manual schedule, and their
 *    reconciliation report;
 *  - the daily reconciliation records a mismatch and never corrects it;
 *  - `Peable-Account` scoping, the third-party live gate, FairCoin entries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { sql } from 'drizzle-orm';
import type {
  ProviderAccountSnapshot,
  ProviderApplicationFee,
  ProviderBalanceTransaction,
  ProviderMode,
  ProviderPayout,
} from '../../services/providers/provider';

/** Every provider call, `<mode>:<fn>`, and the request it carried. */
const calls: { readonly name: string; readonly request: unknown }[] = [];
let counter = 0;
const next = () => String(++counter);

/** What the fake provider holds, per provider account (`null` is the platform). */
const accountState = new Map<
  string,
  { chargesEnabled: boolean; payoutsEnabled: boolean; interval: 'manual' | 'daily' }
>();
const providerTxns = new Map<string | null, ProviderBalanceTransaction[]>();
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const providerPayouts = new Map<string, Mutable<ProviderPayout> & { account: string }>();
const providerFees = new Map<
  string,
  Omit<ProviderApplicationFee, 'refunds'> & { refunds: ProviderApplicationFee['refunds'][number][] }
>();
const chargeTxns = new Map<string, ProviderBalanceTransaction[]>();

function snapshotOf(id: string): ProviderAccountSnapshot {
  const state = accountState.get(id) ?? {
    chargesEnabled: false,
    payoutsEnabled: false,
    interval: 'daily' as const,
  };
  return {
    providerAccountId: id,
    payoutsEnabled: state.payoutsEnabled,
    chargesEnabled: state.chargesEnabled,
    transfersCapability: state.chargesEnabled ? 'active' : 'pending',
    cardPaymentsCapability: state.chargesEnabled ? 'active' : 'pending',
    currentlyDue: state.chargesEnabled ? [] : ['business_profile.url'],
    eventuallyDue: [],
    pastDue: [],
    pendingVerification: [],
    defaultCurrency: 'EUR',
    businessProfile: {
      name: 'Shop',
      url: null,
      support_email: null,
      support_url: null,
      product_description: null,
      mcc: null,
    },
    settings: {
      payouts: {
        schedule: {
          interval: state.interval,
          delay_days: 2,
          weekly_anchor: null,
          monthly_anchor: null,
        },
        statement_descriptor: null,
      },
      payments: { statement_descriptor: 'SHOP' },
      branding: { primary_color: null, secondary_color: null },
    },
  };
}

export function txn(
  id: string,
  overrides: Partial<ProviderBalanceTransaction> = {},
): ProviderBalanceTransaction {
  return {
    providerObjectId: id,
    amount: '10000',
    fee: '320',
    net: '9680',
    currency: 'EUR',
    type: 'payment',
    reportingCategory: 'charge',
    status: 'pending',
    availableOn: new Date('2026-11-10T00:00:00Z'),
    created: new Date(),
    description: null,
    exchangeRate: null,
    feeDetails: [{ amount: '320', currency: 'EUR', type: 'application_fee' }],
    sourceObjectId: null,
    sourceKind: null,
    originatingChargeObjectId: null,
    ...overrides,
  };
}

function fakeProviderFor(mode: ProviderMode) {
  const record = (fn: string, request: unknown = null) =>
    calls.push({ name: `${mode}:${fn}`, request });
  return {
    id: 'stripe' as const,
    createPayment: async (request: unknown) => {
      record('createPayment', request);
      return {
        providerObjectId: `pi_${mode}_${next()}`,
        status: 'requires_payment_method' as const,
        clientAction: { kind: 'client_secret' as const, value: `secret_${mode}` },
      };
    },
    confirm: async () => {
      throw new Error('not used');
    },
    capture: async () => {
      throw new Error('not used');
    },
    cancel: async () => {
      throw new Error('not used');
    },
    refund: async (request: unknown) => {
      record('refund', request);
      return { providerObjectId: `re_${mode}_${next()}`, state: 'pending' as const };
    },
    getStatus: async (id: string) => ({
      providerObjectId: id,
      status: 'requires_payment_method' as const,
    }),
    verifyEvent: async () => {
      throw new Error('not used');
    },
    createTransfer: async () => {
      throw new Error('not used');
    },
    reverseTransfer: async () => {
      throw new Error('not used');
    },
    createAccount: async (request: { role: string }) => {
      record('createAccount', request);
      const id = `acct_${mode}_${next()}`;
      accountState.set(id, { chargesEnabled: false, payoutsEnabled: false, interval: 'daily' });
      return snapshotOf(id);
    },
    accountLink: async (request: unknown) => {
      record('accountLink', request);
      return { url: 'https://connect.example/onboard', expiresAt: new Date(Date.now() + 300_000) };
    },
    getAccount: async (id: string) => {
      record('getAccount', id);
      return snapshotOf(id);
    },
    updateAccount: async (
      id: string,
      update: { payoutSchedule?: { interval: 'manual' | 'daily' } },
    ) => {
      record('updateAccount', update);
      const state = accountState.get(id);
      if (state && update.payoutSchedule) state.interval = update.payoutSchedule.interval;
      return snapshotOf(id);
    },
    listBalanceTransactions: async (request: { account: string | null; payout?: string }) => {
      record('listBalanceTransactions', request);
      const all = providerTxns.get(request.account) ?? [];
      const data =
        request.payout === undefined
          ? all
          : all.filter((entry) => payoutOfTxn.get(entry.providerObjectId) === request.payout);
      return { data: [...data], hasMore: false };
    },
    getChargeBalanceTransactions: async (chargeId: string) => {
      record('getChargeBalanceTransactions', chargeId);
      return chargeTxns.get(chargeId) ?? [];
    },
    getPayout: async (account: string, id: string) => {
      record('getPayout', { account, id });
      const payout = providerPayouts.get(id);
      if (!payout || payout.account !== account) throw new Error(`no payout ${id}`);
      return payout;
    },
    listPayouts: async (request: { account: string }) => {
      record('listPayouts', request);
      return {
        data: [...providerPayouts.values()].filter((p) => p.account === request.account),
        hasMore: false,
      };
    },
    createPayout: async (request: { account: string; amount: string; currency: string }) => {
      record('createPayout', request);
      const payout = {
        providerObjectId: `po_${mode}_${next()}`,
        amount: request.amount,
        currency: request.currency,
        status: 'pending' as const,
        method: 'standard' as const,
        type: 'bank_account' as const,
        automatic: false,
        arrivalDate: new Date('2026-11-12T00:00:00Z'),
        description: null,
        statementDescriptor: null,
        failureCode: null,
        created: new Date(),
        account: request.account,
      };
      providerPayouts.set(payout.providerObjectId, payout);
      return payout;
    },
    cancelPayout: async (request: { account: string; providerObjectId: string }) => {
      record('cancelPayout', request);
      const payout = providerPayouts.get(request.providerObjectId);
      if (!payout) throw new Error('no payout');
      payout.status = 'canceled';
      return payout;
    },
    getApplicationFee: async (id: string) => {
      record('getApplicationFee', id);
      const fee = providerFees.get(id);
      if (!fee) throw new Error(`no fee ${id}`);
      return fee;
    },
    cancelRefund: async (request: { providerObjectId: string }) => {
      record('cancelRefund', request);
      return { providerObjectId: request.providerObjectId, state: 'canceled' as const };
    },
  };
}

/** Which provider payout a provider transaction was paid out by. */
const payoutOfTxn = new Map<string, string>();

const fakes = { test: fakeProviderFor('test'), live: fakeProviderFor('live') };
const realRegistry = await import('../../services/providers/registry');
// Captured BEFORE the mock: `mock.module` rewrites the namespace in place, so a
// call through `realRegistry.x` afterwards would recurse into the mock.
const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  availableProviderModes: realAvailableProviderModes,
} = realRegistry;
let useFakeRegistry = false;
const { config } = await import('../../config');
const fakeFor = (mode: ProviderMode) => (config.stripe[mode]?.cardRail ? fakes[mode] : undefined);
mock.module('../../services/providers/registry', () => ({
  ...realRegistry,
  resolveProvider: (id: 'stripe', mode: ProviderMode) =>
    useFakeRegistry ? fakeFor(mode) : realResolveProvider(id, mode),
  resolveCardProvider: (mode: ProviderMode) =>
    useFakeRegistry ? fakeFor(mode) : realResolveCardProvider(mode),
  availableProviderModes: (id: 'stripe') =>
    useFakeRegistry ? ['test', 'live'] : realAvailableProviderModes(id),
}));

const { setStripeModes, stripeModeFixture } = await import('../../__tests__/helpers/stripeModes');
const { createPaymentIntentsRouter } = await import('../paymentIntents');
const { createRefundsRouter } = await import('../refunds');
const { createConnectedAccountsRouter } = await import('../connectedAccounts');
const { createMoneyRouter, refuseMisplacedPeableAccount } = await import('../money');
const { gatewayDb, seedIntent, seedMerchant, storedEvents, testXpubFor, useGatewayDatabase } =
  await import('../../__tests__/helpers/gatewayTestDatabase');
const { must } = await import('../../__tests__/helpers/must');
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');
const { setFeeSchedule } = await import('../../db/money/feeScheduleRepository');
const { findMerchantAccount, findAccountByPublicId, registerFaircoinKey } = await import(
  '../../db/accounts/connectedAccountRepository'
);
const { findIntentByPublicId, linkProviderCharge, linkProviderObject, updateIntentState } =
  await import('../../db/payments/paymentIntentRepository');
const { insertProviderEvent, findProviderEventById } = await import(
  '../../db/providers/providerEventRepository'
);
const { processProviderEvent } = await import('../../services/providers/eventProcessor');
const { syncAccountLedger } = await import('../../services/money/ledger');
const { reconcileAccount } = await import('../../services/money/reconciliation');
const { transitionIntent } = await import('../../services/intentTransition');
const { refreshConnectedAccount } = await import('../../services/accounts/connectedAccountService');

/** The credential the next request carries. */
const credential: {
  appId: string;
  environment: OxyServiceEnvironment;
  firstParty: boolean;
} = { appId: 'app_money', environment: 'development', firstParty: false };

const stubRequireMerchant: RequestHandler = (req, _res, nextHandler) => {
  (req as OxyAuthRequest).serviceApp = credential.firstParty
    ? {
        appId: credential.appId,
        appName: 't',
        credentialId: 'c',
        ownerAccountId: 'owner',
        environment: credential.environment,
        tier: 'internal',
        authority: 'first_party',
      }
    : {
        appId: credential.appId,
        appName: 't',
        scopes: ['payments:read', 'payments:write'],
        credentialId: 'c',
        ownerAccountId: 'owner',
        environment: credential.environment,
        tier: 'external',
      };
  nextHandler();
};
const passthrough: RequestHandler = (_req, _res, nextHandler) => nextHandler();

let server: Server;
let baseUrl = '';
let restoreModes: () => void = () => undefined;

type Json = Record<string, unknown> & {
  error?: { type: string; code?: string; message: string; param?: string };
};

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

function as(appId: string, environment: OxyServiceEnvironment = 'development', firstParty = false) {
  credential.appId = appId;
  credential.environment = environment;
  credential.firstParty = firstParty;
}

/** A merchant with its own onboarded account (charges and payouts enabled). */
async function onboardedMerchant(
  appId: string,
  environment: OxyServiceEnvironment = 'development',
) {
  as(appId, environment);
  const merchant = await seedMerchant({ oxyAppId: appId, environment });
  const opened = await call('POST', '/v1/account', { country: 'es', business_type: 'company' });
  expect(opened.status).toBe(201);
  const account = must(await findMerchantAccount(gatewayDb(), merchant.id));
  accountState.set(must(account.providerAccountId), {
    chargesEnabled: true,
    payoutsEnabled: true,
    interval: 'daily',
  });
  const refreshed = await refreshConnectedAccount(account);
  return { merchant, account: refreshed, providerAccountId: must(account.providerAccountId) };
}

async function storeEvent(
  type: string,
  objectIds: Record<string, string>,
  providerAccountId: string | null = null,
) {
  const eventId = `evt_money_${next()}`;
  const id = await insertProviderEvent(gatewayDb(), {
    provider: 'stripe',
    providerEventId: eventId,
    providerAccountId,
    type,
    livemode: false,
    apiVersion: '2026-07-29.dahlia',
    objectIds,
    payload: { id: eventId, object: 'event' },
  });
  return must(id ? await findProviderEventById(gatewayDb(), id) : null);
}

async function journalSums(): Promise<string[]> {
  const rows = await gatewayDb().execute(
    sql`select sum(amount::numeric)::text as total from ledger_entries group by journal_id having sum(amount::numeric) <> 0`,
  );
  return rows.map((row) => String(row.total));
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("Orbit's money model (ADR 0015)", () => {
  useGatewayDatabase();

  beforeAll(() => {
    useFakeRegistry = true;
    restoreModes = setStripeModes({
      test: stripeModeFixture('test'),
      live: stripeModeFixture('live'),
    });
    const app = express();
    app.use(express.json());
    app.use(refuseMisplacedPeableAccount);
    app.use(
      createPaymentIntentsRouter({
        requireMerchant: stubRequireMerchant,
        optionalServiceAuth: passthrough,
      }),
    );
    app.use(createRefundsRouter({ requireMerchant: stubRequireMerchant }));
    app.use(createConnectedAccountsRouter({ requireMerchant: stubRequireMerchant }));
    app.use(createMoneyRouter({ requireMerchant: stubRequireMerchant }));
    app.use(
      (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: { type: 'api_error', message: error.message } });
      },
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    calls.length = 0;
    config.orbit.thirdPartyLivePayments = false;
  });

  afterAll(async () => {
    restoreModes();
    useFakeRegistry = false;
    config.orbit.thirdPartyLivePayments = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('the merchant account', () => {
    test('a merchant without one is told so, never shown zeros', async () => {
      as('app_no_account');
      await seedMerchant({ oxyAppId: 'app_no_account' });
      const account = await call('GET', '/v1/account');
      expect(account.status).toBe(404);
      expect(account.json.error?.code).toBe('account_missing');
      const balance = await call('GET', '/v1/balance');
      expect(balance.status).toBe(404);
      expect(balance.json.error?.code).toBe('account_missing');
    });

    test('opens with no provider dashboard, reads back Stripe-shaped, and writes settings', async () => {
      as('app_open');
      await seedMerchant({ oxyAppId: 'app_open' });
      const opened = await call('POST', '/v1/account', { country: 'es', business_type: 'company' });
      expect(opened.status).toBe(201);
      expect(opened.json.object).toBe('account');
      expect(opened.json.type).toBe('merchant');
      expect(opened.json.country).toBe('ES');
      expect(opened.json.charges_enabled).toBe(false);
      expect(opened.json.requirements).toEqual({
        currently_due: ['business_profile.url'],
        eventually_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      });
      expect(JSON.stringify(opened.json)).not.toContain('acct_');
      expect(calls.find((c) => c.name === 'test:createAccount')?.request).toMatchObject({
        role: 'merchant',
      });

      // A second open converges.
      const again = await call('POST', '/v1/account', { country: 'es', business_type: 'company' });
      expect(again.status).toBe(400);
      expect(again.json.error?.param).toBe('country');

      const updated = await call('POST', '/v1/account', {
        settings: { payouts: { schedule: { interval: 'manual' } } },
      });
      expect(updated.status).toBe(200);
      expect(
        (updated.json.settings as { payouts: { schedule: { interval: string } } }).payouts.schedule
          .interval,
      ).toBe('manual');
      const link = await call('POST', '/v1/account_links', {
        refresh_url: 'https://orbit.peable.to/account?refresh=1',
        return_url: 'https://orbit.peable.to/account',
      });
      expect(link.status).toBe(201);
      expect(link.json.object).toBe('account_link');
    });
  });

  describe('charge models', () => {
    test('an onboarded merchant: a destination charge on behalf of its account, with its fee', async () => {
      const { merchant, account, providerAccountId } = await onboardedMerchant('app_dest');
      await setFeeSchedule(gatewayDb(), {
        merchantId: merchant.id,
        paymentMethodType: 'card',
        currency: 'EUR',
        percentBps: 290,
        fixedAmount: '30',
      });
      calls.length = 0;
      const created = await call('POST', '/v1/payment_intents', {
        amount: '10000',
        rail: 'card',
        currency: 'EUR',
      });
      expect(created.status).toBe(201);
      expect(created.json.application_fee_amount).toBe('320');
      expect(created.json.transfer_data).toEqual({ destination: account.publicId, amount: null });
      expect(created.json.on_behalf_of).toBe(account.publicId);
      expect(calls.find((c) => c.name === 'test:createPayment')?.request).toMatchObject({
        transferDestination: providerAccountId,
        onBehalfOf: providerAccountId,
        applicationFeeAmount: '320',
      });
    });

    test('an Oxy first-party merchant: a platform charge with no fee, whatever its account', async () => {
      as('app_first_party', 'development', true);
      const merchant = await seedMerchant({ oxyAppId: 'app_first_party' });
      const created = await call('POST', '/v1/payment_intents', {
        amount: '5000',
        rail: 'card',
        currency: 'EUR',
      });
      expect(created.status).toBe(201);
      expect(created.json.transfer_data).toBeNull();
      expect(created.json.application_fee_amount).toBeNull();
      const request = calls.find((c) => c.name === 'test:createPayment')?.request as Record<
        string,
        unknown
      >;
      expect(request.transferDestination).toBeUndefined();
      expect(request.applicationFeeAmount).toBeUndefined();
      // The verified authority is mirrored onto the merchant.
      const rows = await gatewayDb().execute(
        sql`select first_party from merchants where id = ${merchant.id}`,
      );
      expect(rows[0]?.first_party).toBe(true);
    });

    test('a marketplace with no own account stays a platform charge; it names transfer_data for a seller', async () => {
      as('app_market');
      const merchant = await seedMerchant({ oxyAppId: 'app_market' });
      const plain = await call('POST', '/v1/payment_intents', {
        amount: '5000',
        rail: 'card',
        currency: 'EUR',
      });
      expect(plain.status).toBe(201);
      expect(plain.json.transfer_data).toBeNull();

      const seller = await call('POST', '/v1/connected_accounts', {
        external_ref: 'store_9',
        country: 'ES',
        business_type: 'individual',
      });
      expect(seller.status).toBe(201);
      const onBehalf = {
        amount: '5000',
        rail: 'card',
        currency: 'EUR',
        application_fee_amount: '250',
        transfer_data: { destination: seller.json.id },
        on_behalf_of: seller.json.id,
      };
      // ADR 0021 D5: a seller without its own FairCoin key is not payable.
      const notReady = await call('POST', '/v1/payment_intents', onBehalf);
      expect(notReady.status).toBe(409);
      expect(notReady.json.error?.code).toBe('account_not_ready');
      // The platform opens the FairCoin half; the SELLER registers the key.
      const both = await call('POST', '/v1/connected_accounts', {
        external_ref: 'store_9',
        faircoin: { network: 'testnet', oxy_user_id: 'user_store_9' },
      });
      expect(both.status).toBe(200);
      const sellerRow = must(
        await findAccountByPublicId(gatewayDb(), merchant.id, String(seller.json.id)),
      );
      expect(
        (await registerFaircoinKey(gatewayDb(), sellerRow.id, testXpubFor('testnet', 9))).ok,
      ).toBe(true);
      calls.length = 0;
      const routed = await call('POST', '/v1/payment_intents', {
        amount: '5000',
        rail: 'card',
        currency: 'EUR',
        application_fee_amount: '250',
        transfer_data: { destination: seller.json.id },
        on_behalf_of: seller.json.id,
      });
      expect(routed.status).toBe(201);
      expect(routed.json.transfer_data).toEqual({ destination: seller.json.id, amount: null });
      expect(calls.find((c) => c.name === 'test:createPayment')?.request).toMatchObject({
        transferDestination: sellerRow.providerAccountId,
        onBehalfOf: sellerRow.providerAccountId,
        applicationFeeAmount: '250',
      });

      const bad = await call('POST', '/v1/payment_intents', {
        amount: '5000',
        rail: 'card',
        currency: 'EUR',
        transfer_data: { destination: 'ca_000000000000000000000000' },
      });
      expect(bad.status).toBe(400);
      expect(bad.json.error?.param).toBe('transfer_data[destination]');

      const faircoin = await call('POST', '/v1/payment_intents', {
        amount: '5000',
        network: 'testnet',
        application_fee_amount: '1',
      });
      expect(faircoin.status).toBe(400);
      expect(faircoin.json.error?.param).toBe('application_fee_amount');
    });
  });

  describe('the third-party live gate', () => {
    test('a live third-party merchant cannot open an account or take a destination charge until the flag opens', async () => {
      as('app_live', 'production');
      await seedMerchant({ oxyAppId: 'app_live', environment: 'production', network: 'mainnet' });
      const refused = await call('POST', '/v1/account', {
        country: 'ES',
        business_type: 'company',
      });
      expect(refused.status).toBe(403);
      expect(refused.json.error?.code).toBe('live_payments_gated');
      expect(calls.some((c) => c.name === 'live:createAccount')).toBe(false);

      config.orbit.thirdPartyLivePayments = true;
      const opened = await call('POST', '/v1/account', { country: 'ES', business_type: 'company' });
      expect(opened.status).toBe(201);
      expect(opened.json.livemode).toBe(true);
    });

    test('an Oxy first-party merchant is never gated', async () => {
      as('app_live_oxy', 'production', true);
      await seedMerchant({
        oxyAppId: 'app_live_oxy',
        environment: 'production',
        network: 'mainnet',
      });
      const opened = await call('POST', '/v1/account', { country: 'ES', business_type: 'company' });
      expect(opened.status).toBe(201);
    });
  });

  describe('application fees', () => {
    test('the fee the provider took, its refund, and a refund that asks for both reversals', async () => {
      const { merchant, account } = await onboardedMerchant('app_fees');
      as('app_fees');
      const created = await call('POST', '/v1/payment_intents', {
        amount: '10000',
        rail: 'card',
        currency: 'EUR',
      });
      const intent = must(await findIntentByPublicId(gatewayDb(), String(created.json.id)));
      await linkProviderCharge(gatewayDb(), intent.id, 'stripe', 'ch_fees_1');
      await updateIntentState(gatewayDb(), intent.id, {
        from: 'requires_payment_method',
        status: 'succeeded',
        amountReceived: '10000',
      });
      providerFees.set('fee_provider_1', {
        providerObjectId: 'fee_provider_1',
        amount: '320',
        currency: 'EUR',
        chargeObjectId: 'ch_fees_1',
        accountObjectId: null,
        refunds: [],
        created: new Date(),
      });
      const outcome = await processProviderEvent(
        await storeEvent('application_fee.created', { application_fee: 'fee_provider_1' }),
      );
      expect(outcome.kind).toBe('noop');
      const list = await call('GET', '/v1/application_fees');
      expect(list.status).toBe(200);
      const data = list.json.data as Record<string, unknown>[];
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        object: 'application_fee',
        amount: '320',
        amount_refunded: '0',
        account: account.publicId,
        payment_intent: intent.publicId,
      });
      expect(
        await storedEvents({ merchantId: merchant.id, type: 'application_fee.created' }),
      ).toHaveLength(1);

      // A redelivery records nothing twice.
      await processProviderEvent(
        await storeEvent('application_fee.created', { application_fee: 'fee_provider_1' }),
      );
      expect(
        await storedEvents({ merchantId: merchant.id, type: 'application_fee.created' }),
      ).toHaveLength(1);

      const refund = await call('POST', '/v1/refunds', {
        payment_intent: intent.publicId,
        external_ref: 'refund_fees_1',
        amount: '5000',
        reason: 'requested_by_customer',
        refund_application_fee: true,
        reverse_transfer: true,
        metadata: { order: '42' },
      });
      expect(refund.status).toBe(201);
      expect(refund.json.reason).toBe('requested_by_customer');
      expect(refund.json.metadata).toEqual({ order: '42' });
      expect(calls.find((c) => c.name === 'test:refund')?.request).toMatchObject({
        reason: 'requested_by_customer',
        refundApplicationFee: true,
        reverseTransfer: true,
      });

      const patched = await call('POST', `/v1/refunds/${String(refund.json.id)}`, {
        metadata: { order: '', note: 'x' },
      });
      expect(patched.json.metadata).toEqual({ note: 'x' });
      const canceled = await call('POST', `/v1/refunds/${String(refund.json.id)}/cancel`);
      expect(canceled.status).toBe(200);
      expect(canceled.json.status).toBe('canceled');

      must(providerFees.get('fee_provider_1')).refunds.push({
        providerObjectId: 'fr_provider_1',
        amount: '160',
        currency: 'EUR',
        created: new Date(),
      });
      await processProviderEvent(
        await storeEvent('application_fee.refunded', { application_fee: 'fee_provider_1' }),
      );
      const fee = await call('GET', `/v1/application_fees/${String(data[0]?.id)}`);
      expect(fee.json.amount_refunded).toBe('160');
      expect(fee.json.refunded).toBe(false);
      expect((fee.json.refunds as { data: unknown[] }).data).toHaveLength(1);
      expect(
        await storedEvents({ merchantId: merchant.id, type: 'application_fee.refunded' }),
      ).toHaveLength(1);
    });
  });

  describe('the ledger', () => {
    test('journals sum to zero, ingestion is idempotent, a release moves pending to available', async () => {
      const { account, providerAccountId } = await onboardedMerchant('app_ledger');
      providerTxns.set(providerAccountId, [
        txn('txn_p_1'),
        txn('txn_p_2', {
          amount: '-2000',
          fee: '0',
          net: '-2000',
          type: 'payment_refund',
          reportingCategory: 'refund',
          status: 'available',
          feeDetails: [],
        }),
      ]);
      const first = await syncAccountLedger(
        must(await asCardAccount(account.publicId, 'app_ledger')),
      );
      expect(first.created).toBe(2);
      const again = await syncAccountLedger(
        must(await asCardAccount(account.publicId, 'app_ledger')),
      );
      expect(again).toEqual({ created: 0, released: 0, mismatched: 0 });
      expect(await journalSums()).toEqual([]);

      as('app_ledger');
      let balance = await call('GET', '/v1/balance');
      expect(balance.status).toBe(200);
      expect(balance.json.pending).toEqual([{ amount: '9680', currency: 'EUR' }]);
      expect(balance.json.available).toEqual([{ amount: '-2000', currency: 'EUR' }]);
      expect(balance.json.account).toBe(account.publicId);

      // The provider releases the charge's funds.
      must(providerTxns.get(providerAccountId))[0] = txn('txn_p_1', { status: 'available' });
      const released = await syncAccountLedger(
        must(await asCardAccount(account.publicId, 'app_ledger')),
      );
      expect(released.released).toBe(1);
      balance = await call('GET', '/v1/balance');
      expect(balance.json.available).toEqual([{ amount: '7680', currency: 'EUR' }]);
      expect(balance.json.pending).toEqual([{ amount: '0', currency: 'EUR' }]);
      expect(await journalSums()).toEqual([]);

      const list = await call('GET', '/v1/balance_transactions?type=payment');
      const rows = list.json.data as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        object: 'balance_transaction',
        amount: '10000',
        fee: '320',
        net: '9680',
        status: 'available',
        fee_details: [{ amount: '320', currency: 'EUR', type: 'application_fee' }],
      });
      expect(JSON.stringify(list.json)).not.toContain('txn_p_');
    });

    test('a first-party merchant reads its platform charges, attributed one by one', async () => {
      as('app_fp_ledger', 'development', true);
      const merchant = await seedMerchant({ oxyAppId: 'app_fp_ledger' });
      await call('GET', '/v1/balance'); // mirrors first_party onto the row
      const intent = await seedIntent(merchant, { rail: 'card', amount: '5000' });
      await linkProviderObject(gatewayDb(), intent.id, 'stripe', 'pi_fp_1');
      await linkProviderCharge(gatewayDb(), intent.id, 'stripe', 'ch_fp_1');
      chargeTxns.set('ch_fp_1', [
        txn('txn_fp_1', {
          amount: '5000',
          fee: '175',
          net: '4825',
          type: 'charge',
          sourceObjectId: 'ch_fp_1',
          sourceKind: 'charge',
          feeDetails: [{ amount: '175', currency: 'EUR', type: 'processing_fee' }],
        }),
      ]);
      const { syncPlatformChargeLedger } = await import('../../services/money/ledger');
      await syncPlatformChargeLedger(
        must(await findIntentByPublicId(gatewayDb(), intent.publicId)),
      );
      const balance = await call('GET', '/v1/balance');
      expect(balance.status).toBe(200);
      expect(balance.json.account).toBeNull();
      expect(balance.json.pending).toEqual([{ amount: '4825', currency: 'EUR' }]);
      const list = await call('GET', '/v1/balance_transactions');
      expect((list.json.data as { source: string }[])[0]?.source).toBe(intent.publicId);
    });

    test('FairCoin payments are informational entries, rewound by a reorg', async () => {
      as('app_fair');
      const merchant = await seedMerchant({ oxyAppId: 'app_fair' });
      const intent = await seedIntent(merchant, { amount: '250000000' });
      await transitionIntent(intent.id, {
        from: 'requires_action',
        status: 'processing',
        txid: 'ab'.repeat(32),
      });
      await transitionIntent(intent.id, {
        from: 'processing',
        status: 'succeeded',
        amountReceived: '250000000',
      });
      const fair = await gatewayDb().execute(
        sql`select status, type, amount from balance_transactions where payment_intent_id = ${intent.id}`,
      );
      expect(fair.map((row) => [row.status, row.type, row.amount])).toEqual([
        ['informational', 'faircoin_payment', '250000000'],
      ]);
      // A reorg rewinds it, and the informational sum follows.
      await transitionIntent(intent.id, { from: 'succeeded', status: 'processing' });
      const sums = await gatewayDb().execute(
        sql`select balance_type, sum(amount::numeric)::text as total from ledger_entries where merchant_id = ${merchant.id} group by balance_type order by balance_type`,
      );
      expect(sums.map((row) => [row.balance_type, row.total])).toEqual([
        ['external', '0'],
        ['informational', '0'],
      ]);
      expect(await journalSums()).toEqual([]);
    });
  });

  describe('payouts', () => {
    test('mirrored from events, instructed on a manual schedule, reconciled to their transactions', async () => {
      const { merchant, account, providerAccountId } = await onboardedMerchant('app_payouts');
      providerPayouts.set('po_provider_1', {
        providerObjectId: 'po_provider_1',
        amount: '9680',
        currency: 'EUR',
        status: 'pending',
        method: 'standard',
        type: 'bank_account',
        automatic: true,
        arrivalDate: new Date('2026-11-12T00:00:00Z'),
        description: null,
        statementDescriptor: null,
        failureCode: null,
        created: new Date(),
        account: providerAccountId,
      });
      await processProviderEvent(
        await storeEvent(
          'payout.created',
          { payout: 'po_provider_1', account: providerAccountId },
          providerAccountId,
        ),
      );
      as('app_payouts');
      let list = await call('GET', '/v1/payouts');
      const payouts = list.json.data as Record<string, unknown>[];
      expect(payouts).toHaveLength(1);
      expect(payouts[0]).toMatchObject({
        status: 'pending',
        automatic: true,
        account: account.publicId,
      });
      const payoutId = String(payouts[0]?.id);

      // Paid: its transactions are read with the payout filter and attached.
      providerTxns.set(providerAccountId, [
        txn('txn_po_1', { status: 'available' }),
        txn('txn_po_2', {
          amount: '-9680',
          fee: '0',
          net: '-9680',
          type: 'payout',
          reportingCategory: 'payout',
          status: 'available',
          sourceObjectId: 'po_provider_1',
          sourceKind: 'payout',
          feeDetails: [],
        }),
      ]);
      payoutOfTxn.set('txn_po_1', 'po_provider_1');
      payoutOfTxn.set('txn_po_2', 'po_provider_1');
      must(providerPayouts.get('po_provider_1')).status = 'paid';
      await processProviderEvent(
        await storeEvent(
          'payout.paid',
          { payout: 'po_provider_1', account: providerAccountId },
          providerAccountId,
        ),
      );
      const types = (await storedEvents({ merchantId: merchant.id }))
        .map(({ event }) => event.type)
        .filter((type) => type.startsWith('payout.'));
      expect(types).toEqual(['payout.created', 'payout.paid']);

      const report = await call('GET', `/v1/reports/payout_reconciliation?payout=${payoutId}`);
      expect(report.status).toBe(200);
      expect(report.json.status).toBe('complete');
      expect(report.json.summary).toEqual({ count: 2, amount: '320', fee: '320', net: '0' });
      const detail = await call('GET', `/v1/payouts/${payoutId}`);
      expect(detail.json.balance_transaction).toMatch(/^txn_/);

      // An automatic schedule refuses an instruction; a manual one forwards it.
      const refused = await call('POST', '/v1/payouts', { amount: '100', currency: 'EUR' });
      expect(refused.status).toBe(400);
      expect(refused.json.error?.code).toBe('payout_not_allowed');
      await call('POST', '/v1/account', {
        settings: { payouts: { schedule: { interval: 'manual' } } },
      });
      const instructed = await call('POST', '/v1/payouts', { amount: '100', currency: 'EUR' });
      expect(instructed.status).toBe(201);
      expect(instructed.json).toMatchObject({ status: 'pending', automatic: false, amount: '100' });
      const canceled = await call('POST', `/v1/payouts/${String(instructed.json.id)}/cancel`);
      expect(canceled.json.status).toBe('canceled');
      list = await call('GET', '/v1/payouts?status=canceled');
      expect((list.json.data as unknown[]).length).toBe(1);
    });
  });

  describe('reconciliation', () => {
    test('records a transaction the ledger lacks, ingests afterwards, and resolves on the next run', async () => {
      const { merchant, account, providerAccountId } = await onboardedMerchant('app_recon');
      const card = must(await asCardAccount(account.publicId, 'app_recon'));
      providerTxns.set(providerAccountId, [txn('txn_recon_1')]);
      const first = await reconcileAccount(card, new Date());
      expect(first.newMismatches).toBe(1);
      const open = await gatewayDb().execute(
        sql`select kind, resolved_at from reconciliation_mismatches where merchant_id = ${merchant.id}`,
      );
      expect(open.map((row) => [row.kind, row.resolved_at])).toEqual([['missing_in_ledger', null]]);

      const second = await reconcileAccount(
        must(await asCardAccount(account.publicId, 'app_recon')),
        new Date(Date.now() + 1000),
      );
      expect(second.newMismatches).toBe(0);
      expect(second.resolved).toBe(1);
    });

    test('an amount the provider changed is a mismatch, never an overwrite', async () => {
      const { merchant, account, providerAccountId } = await onboardedMerchant('app_recon_amount');
      providerTxns.set(providerAccountId, [txn('txn_amount_1')]);
      await syncAccountLedger(must(await asCardAccount(account.publicId, 'app_recon_amount')));
      providerTxns.set(providerAccountId, [txn('txn_amount_1', { amount: '10001', net: '9681' })]);
      const outcome = await syncAccountLedger(
        must(await asCardAccount(account.publicId, 'app_recon_amount')),
      );
      expect(outcome.mismatched).toBe(1);
      const stored = await gatewayDb().execute(
        sql`select amount from balance_transactions where provider_object_id = 'txn_amount_1'`,
      );
      expect(stored[0]?.amount).toBe('10000');
      const kinds = await gatewayDb().execute(
        sql`select kind from reconciliation_mismatches where merchant_id = ${merchant.id}`,
      );
      expect(kinds.map((row) => row.kind)).toEqual(['amount_mismatch']);
    });
  });

  describe('Peable-Account', () => {
    test("a platform reads its seller's balance; another merchant's account is refused; elsewhere the header is refused", async () => {
      as('app_platform');
      const platform = await seedMerchant({ oxyAppId: 'app_platform' });
      const seller = await call('POST', '/v1/connected_accounts', {
        external_ref: 'seller_1',
        country: 'ES',
        business_type: 'individual',
      });
      const sellerRow = must(
        await findAccountByPublicId(gatewayDb(), platform.id, String(seller.json.id)),
      );
      providerTxns.set(must(sellerRow.providerAccountId), [txn('txn_seller_1')]);
      await syncAccountLedger(must(await asCardAccount(String(seller.json.id), 'app_platform')));

      const balance = await call('GET', '/v1/balance', undefined, {
        'Peable-Account': String(seller.json.id),
      });
      expect(balance.status).toBe(200);
      expect(balance.json.account).toBe(seller.json.id);
      expect(balance.json.pending).toEqual([{ amount: '9680', currency: 'EUR' }]);
      const sellerAccount = await call('GET', '/v1/account', undefined, {
        'Peable-Account': String(seller.json.id),
      });
      expect(sellerAccount.json.type).toBe('connected');

      as('app_other');
      await seedMerchant({ oxyAppId: 'app_other' });
      const foreign = await call('GET', '/v1/balance', undefined, {
        'Peable-Account': String(seller.json.id),
      });
      expect(foreign.status).toBe(403);
      expect(foreign.json.error?.param).toBe('Peable-Account');

      const misplaced = await call('GET', '/v1/payment_intents', undefined, {
        'Peable-Account': String(seller.json.id),
      });
      expect(misplaced.status).toBe(400);
      expect(misplaced.json.error?.param).toBe('Peable-Account');
    });
  });
});

/** The account row, as the card-only shape every money path takes. */
async function asCardAccount(publicId: string, appId: string) {
  const { findAccountForOnboarding } = await import('../../db/accounts/connectedAccountRepository');
  const rows = await gatewayDb().execute(
    sql`select ca.id from connected_accounts ca join merchants m on m.id = ca.merchant_id where ca.public_id = ${publicId} and m.oxy_app_id = ${appId}`,
  );
  const id = rows[0]?.id;
  if (typeof id !== 'string') return null;
  const row = await findAccountForOnboarding(gatewayDb(), id);
  return row?.provider && row.providerAccountId && row.country
    ? (row as typeof row & { provider: 'stripe'; providerAccountId: string; country: string })
    : null;
}
