/**
 * Payment method breadth on the card rail, over HTTP against a real database
 * and a recording fake provider:
 *
 *  - a merchant's default configuration exists on first read, with cards and
 *    wallets on, local methods off, and the truth about what cannot be offered;
 *  - a change merges, bumps the version, and the provider copy is pushed again
 *    before the next payment uses it;
 *  - a PaymentIntent carries the configuration's methods in its currency, or
 *    exactly the types it named — refused when one cannot take the currency;
 *  - currencies beyond EUR/USD, JPY's zero decimals included;
 *  - wallet domains: validated, registered at the provider, re-validated;
 *  - FairCoin (ADR 0021 D2): an always-on, locked entry, available once the
 *    merchant has a FairCoin key; `off` refused with `payment_method_locked` on
 *    the API and the dashboard; never stored, pushed or a card payment's type.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { ProviderMode } from '../../services/providers/provider';
import { must } from '../../__tests__/helpers/must';
import { stubOxyAccess } from '../../__tests__/helpers/oxyAccessStub';

interface Call {
  readonly fn: string;
  readonly request: Record<string, unknown>;
}
const calls: Call[] = [];
let objects = 0;
/** What the fake provider's wallets say about a domain on validation. */
let applePayVerified = false;

const domainAnswer = (id: string, enabled: boolean) => ({
  providerObjectId: id,
  enabled,
  applePay: applePayVerified
    ? { status: 'active' as const, error: null }
    : { status: 'inactive' as const, error: 'Apple Pay has not verified this domain yet.' },
  googlePay: { status: 'active' as const, error: null },
});

const fakeProvider = {
  id: 'stripe' as const,
  createPayment: async (request: Record<string, unknown>) => {
    calls.push({ fn: 'createPayment', request });
    objects += 1;
    return {
      providerObjectId: `pi_fake_${String(objects)}`,
      status: 'requires_payment_method' as const,
      clientAction: { kind: 'client_secret' as const, value: 'secret' },
    };
  },
  savePaymentMethodConfiguration: async (request: Record<string, unknown>) => {
    calls.push({ fn: 'savePaymentMethodConfiguration', request });
    return {
      providerObjectId: (request.providerObjectId as string) ?? `pmc_fake_${String(++objects)}`,
    };
  },
  createPaymentMethodDomain: async (request: Record<string, unknown>) => {
    calls.push({ fn: 'createPaymentMethodDomain', request });
    return domainAnswer(`pmd_fake_${String(request.domainName)}`, request.enabled as boolean);
  },
  updatePaymentMethodDomain: async (request: Record<string, unknown>) => {
    calls.push({ fn: 'updatePaymentMethodDomain', request });
    return domainAnswer(String(request.providerObjectId), request.enabled as boolean);
  },
  validatePaymentMethodDomain: async (providerObjectId: string) => {
    calls.push({ fn: 'validatePaymentMethodDomain', request: { providerObjectId } });
    return domainAnswer(providerObjectId, true);
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
  refund: async () => {
    throw new Error('not used');
  },
  getStatus: async () => {
    throw new Error('not used');
  },
  verifyEvent: async () => {
    throw new Error('not used');
  },
};

const realRegistry = await import('../../services/providers/registry');
const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  resetProviders: realResetProviders,
} = realRegistry;
let useFake = false;
mock.module('../../services/providers/registry', () => ({
  ...realRegistry,
  resolveProvider: (id: 'stripe', mode: ProviderMode) =>
    useFake ? fakeProvider : realResolveProvider(id, mode),
  resolveCardProvider: (mode: ProviderMode) =>
    useFake ? fakeProvider : realResolveCardProvider(mode),
  resetProviders: () => {
    realResetProviders();
  },
}));

const { createPaymentMethodConfigurationsRouter } = await import('../paymentMethodConfigurations');
const { createPaymentIntentsRouter } = await import('../paymentIntents');
const { createDashboardRouter } = await import('../dashboard');
const { requestIdMiddleware } = await import('../../lib/requestId');
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  '../../__tests__/helpers/gatewayTestDatabase'
);
const { insertMerchant } = await import('../../db/merchants/merchantRepository');
const { findConfigurationByPublicId } = await import(
  '../../db/paymentMethods/paymentMethodConfigurationRepository'
);
const { useStripeKeys } = await import('../../__tests__/helpers/stripeModes');
const { POSTGRES_TESTS_ENABLED } = await import('../../db/testDatabase');

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
type Json = Record<string, unknown> & {
  error?: { type: string; code?: string; param?: string; message: string };
};
type Entry = {
  available: boolean;
  display_preference: { preference: string; value: string };
  locked: boolean;
  unavailable_reason: string | null;
  currencies: string[];
};

let merchant: Merchant;
let actingAs: () => Merchant;
let server: Server;
let baseUrl = '';
let dashboardServer: Server;
let dashboardUrl = '';
const MEMBER = 'user_member';

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

async function defaultConfiguration(): Promise<Json> {
  const list = await call('GET', '/v1/payment_method_configurations');
  const found = (list.json.data as Json[]).find((row) => row.is_default === true);
  if (!found) throw new Error('no default configuration');
  return found;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('payment method breadth', () => {
  useGatewayDatabase();
  useStripeKeys(['test'], { cardRail: true });

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant();
    actingAs = () => merchant;
    const stubAuth: RequestHandler = (req, _res, next) => {
      const as = actingAs();
      (req as OxyAuthRequest).serviceApp = {
        appId: as.oxyAppId,
        appName: 't',
        scopes: ['payments:read', 'payments:write'],
        credentialId: 'c',
        ownerAccountId: as.ownerAccountId ?? 'owner',
        environment: 'development',
        tier: 'external',
      };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(createPaymentMethodConfigurationsRouter({ requireMerchant: stubAuth }));
    app.use(
      createPaymentIntentsRouter({ requireMerchant: stubAuth, optionalServiceAuth: stubAuth }),
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    const dashboard = express();
    dashboard.use(requestIdMiddleware);
    dashboard.use(express.json());
    dashboard.use(
      createDashboardRouter({
        requireOxyUser: (req, _res, next) => {
          (req as OxyAuthRequest).userId = MEMBER;
          (req as OxyAuthRequest).accessToken = `token-for-${MEMBER}`;
          next();
        },
        access: stubOxyAccess({
          application: (userId) => (userId === MEMBER ? { ownerAccountId: 'owner' } : undefined),
        }),
      }),
    );
    dashboardServer = dashboard.listen(0);
    dashboardUrl = `http://127.0.0.1:${String((dashboardServer.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    calls.length = 0;
    actingAs = () => merchant;
  });

  afterAll(async () => {
    useFake = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => dashboardServer.close(() => resolve()));
  });

  test('the default exists on first read, and says what cannot be offered and why', async () => {
    const config = await defaultConfiguration();
    expect(config.object).toBe('payment_method_configuration');
    expect(config.active).toBe(true);
    const card = config.card as Entry;
    expect(card.available).toBe(true);
    expect(card.display_preference).toEqual({ preference: 'none', value: 'on' });
    expect((config.apple_pay as Entry).available).toBe(true);
    expect((config.sepa_debit as Entry).available).toBe(false);
    expect((config.sepa_debit as Entry).currencies).toEqual(['EUR']);
    expect((config.bizum as Entry).unavailable_reason).toBe('provider_unsupported');
    // Reading twice does not make a second default.
    const list = await call('GET', '/v1/payment_method_configurations');
    expect((list.json.data as Json[]).filter((row) => row.is_default === true)).toHaveLength(1);
  });

  test('a change merges, refuses what can never take effect, and resets with none', async () => {
    const config = await defaultConfiguration();
    const on = await call('POST', `/v1/payment_method_configurations/${String(config.id)}`, {
      sepa_debit: { display_preference: { preference: 'on' } },
      ideal: { display_preference: { preference: 'on' } },
    });
    expect(on.status).toBe(200);
    expect((on.json.sepa_debit as Entry).available).toBe(true);
    expect((on.json.card as Entry).available).toBe(true);

    const bizum = await call('POST', `/v1/payment_method_configurations/${String(config.id)}`, {
      bizum: { display_preference: { preference: 'on' } },
    });
    expect(bizum.status).toBe(400);
    expect(bizum.json.error?.param).toBe('bizum');

    const cardOff = await call('POST', `/v1/payment_method_configurations/${String(config.id)}`, {
      card: { display_preference: { preference: 'off' } },
    });
    expect((cardOff.json.apple_pay as Entry).unavailable_reason).toBe('requires_card');
    expect((cardOff.json.apple_pay as Entry).available).toBe(false);
    const reset = await call('POST', `/v1/payment_method_configurations/${String(config.id)}`, {
      card: { display_preference: { preference: 'none' } },
      ideal: { display_preference: { preference: 'none' } },
    });
    expect((reset.json.card as Entry).display_preference).toEqual({
      preference: 'none',
      value: 'on',
    });
    expect((reset.json.ideal as Entry).available).toBe(false);
    expect((reset.json.sepa_debit as Entry).available).toBe(true);

    const deactivate = await call(
      'POST',
      `/v1/payment_method_configurations/${String(config.id)}`,
      {
        active: false,
      },
    );
    expect(deactivate.status).toBe(400);
  });

  test('a card payment carries the configuration’s methods in its currency, pushed first', async () => {
    const eur = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'EUR',
    });
    expect(eur.status).toBe(201);
    expect(eur.json.payment_method_types).toEqual(['card', 'sepa_debit']);
    const config = await defaultConfiguration();
    expect(eur.json.payment_method_configuration_details).toEqual({ id: config.id });
    const save = calls.find((entry) => entry.fn === 'savePaymentMethodConfiguration');
    const firstKey = String(save?.request.idempotencyKey);
    expect((save?.request.methods as Record<string, string> | undefined)?.sepa_debit).toBe('on');
    expect((save?.request.methods as Record<string, string> | undefined)?.ideal).toBe('off');
    const created = calls.find((entry) => entry.fn === 'createPayment');
    expect(String(created?.request.paymentMethodConfigurationObjectId)).toStartWith('pmc_fake_');
    expect(created?.request.paymentMethodTypes).toBeUndefined();

    // Unchanged configuration: not pushed again.
    calls.length = 0;
    const usd = await call('POST', '/v1/payment_intents', {
      amount: '2500',
      rail: 'card',
      currency: 'USD',
    });
    expect(usd.json.payment_method_types).toEqual(['card']);
    expect(calls.filter((entry) => entry.fn === 'savePaymentMethodConfiguration')).toHaveLength(0);

    // Changed: pushed to the SAME provider object before the next payment.
    await call('POST', `/v1/payment_method_configurations/${String(config.id)}`, {
      eps: { display_preference: { preference: 'on' } },
    });
    calls.length = 0;
    await call('POST', '/v1/payment_intents', { amount: '2500', rail: 'card', currency: 'EUR' });
    const pushed = calls.find((entry) => entry.fn === 'savePaymentMethodConfiguration');
    expect(String(pushed?.request.providerObjectId)).toStartWith('pmc_fake_');
    // A new version is a new provider write, never a replay of the old one.
    expect(String(pushed?.request.idempotencyKey)).not.toBe(firstKey);
  });

  test('named types are exactly those, and refused when one cannot take the currency', async () => {
    const ideal = await call('POST', '/v1/payment_intents', {
      amount: '1000',
      rail: 'card',
      currency: 'EUR',
      payment_method_types: ['ideal', 'card'],
    });
    expect(ideal.status).toBe(201);
    expect(ideal.json.payment_method_types).toEqual(['ideal', 'card']);
    expect(ideal.json.payment_method_configuration_details).toBeNull();
    const created = calls.find((entry) => entry.fn === 'createPayment');
    expect(created?.request.paymentMethodTypes).toEqual(['ideal', 'card']);

    const usd = await call('POST', '/v1/payment_intents', {
      amount: '1000',
      rail: 'card',
      currency: 'USD',
      payment_method_types: ['ideal'],
    });
    expect(usd.status).toBe(400);
    expect(usd.json.error?.param).toBe('payment_method_types');

    const both = await call('POST', '/v1/payment_intents', {
      amount: '1000',
      rail: 'card',
      currency: 'EUR',
      payment_method_types: ['card'],
      payment_method_configuration: 'pmc_000000000000000000000000',
    });
    expect(both.status).toBe(400);
  });

  test('a configuration that offers nothing in the currency is refused by name', async () => {
    const created = await call('POST', '/v1/payment_method_configurations', {
      name: 'Bank only',
      card: { display_preference: { preference: 'off' } },
      sepa_debit: { display_preference: { preference: 'on' } },
    });
    expect(created.status).toBe(200);
    expect(created.json.is_default).toBe(false);
    const gbp = await call('POST', '/v1/payment_intents', {
      amount: '1000',
      rail: 'card',
      currency: 'GBP',
      payment_method_configuration: created.json.id,
    });
    expect(gbp.status).toBe(400);
    expect(gbp.json.error?.param).toBe('payment_method_configuration');
    const eur = await call('POST', '/v1/payment_intents', {
      amount: '1000',
      rail: 'card',
      currency: 'EUR',
      payment_method_configuration: created.json.id,
    });
    expect(eur.json.payment_method_types).toEqual(['sepa_debit']);
  });

  test('takes the wider currency set, JPY as a zero-decimal amount', async () => {
    for (const currency of ['GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD']) {
      const answer = await call('POST', '/v1/payment_intents', {
        amount: '1999',
        rail: 'card',
        currency,
      });
      expect([currency, answer.status]).toEqual([currency, 201]);
    }
    calls.length = 0;
    const jpy = await call('POST', '/v1/payment_intents', {
      amount: '1500',
      rail: 'card',
      currency: 'JPY',
    });
    expect(jpy.status).toBe(201);
    expect(jpy.json.currency).toBe('JPY');
    expect(jpy.json.amount).toBe('1500');
    const created = calls.find((entry) => entry.fn === 'createPayment');
    expect(created?.request.amount).toEqual({ amount: '1500', currency: 'JPY' });
    const fair = await call('POST', '/v1/payment_intents', {
      amount: '1500',
      rail: 'card',
      currency: 'FAIR',
    });
    expect(fair.status).toBe(400);
  });

  test('wallet domains: validated, registered at the provider, re-validated, toggled', async () => {
    for (const bad of [
      'https://shop.example.com',
      'shop.example.com:443',
      '10.0.0.1',
      'localhost',
      'checkout.peable.to',
    ]) {
      const refused = await call('POST', '/v1/payment_method_domains', { domain_name: bad });
      expect([bad, refused.status]).toEqual([bad, 400]);
    }
    expect(calls).toHaveLength(0);

    const created = await call('POST', '/v1/payment_method_domains', {
      domain_name: 'Shop.Example.com.',
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      object: 'payment_method_domain',
      domain_name: 'shop.example.com',
      enabled: true,
      apple_pay: { status: 'inactive' },
      google_pay: { status: 'active', status_details: null },
    });
    expect(
      (created.json.apple_pay as { status_details: { error_message: string } }).status_details
        .error_message,
    ).toContain('Apple Pay');
    const again = await call('POST', '/v1/payment_method_domains', {
      domain_name: 'shop.example.com',
    });
    expect(again.json.id).toBe(created.json.id);
    expect(calls.filter((entry) => entry.fn === 'createPaymentMethodDomain')).toHaveLength(1);

    applePayVerified = true;
    const validated = await call(
      'POST',
      `/v1/payment_method_domains/${String(created.json.id)}/validate`,
      {},
    );
    expect((validated.json.apple_pay as { status: string }).status).toBe('active');
    const disabled = await call('POST', `/v1/payment_method_domains/${String(created.json.id)}`, {
      enabled: false,
    });
    expect(disabled.json.enabled).toBe(false);
    const list = await call('GET', '/v1/payment_method_domains?enabled=false');
    expect((list.json.data as Json[]).map((row) => row.id)).toEqual([created.json.id]);

    // Another merchant naming the same provider object is refused.
    const other = await seedMerchant();
    actingAs = () => other;
    const taken = await call('POST', '/v1/payment_method_domains', {
      domain_name: 'shop.example.com',
    });
    expect(taken.status).toBe(409);
  });
  test('FairCoin is an always-on, locked entry, available once the owner Peable wallet can receive', async () => {
    const config = await defaultConfiguration();
    expect(config.faircoin).toEqual({
      available: true,
      display_preference: { preference: 'on', value: 'on' },
      locked: true,
      unavailable_reason: null,
      currencies: [
        'FAIR',
        'EUR',
        'USD',
        'GBP',
        'CHF',
        'SEK',
        'NOK',
        'DKK',
        'PLN',
        'CZK',
        'CAD',
        'AUD',
        'JPY',
      ],
    });
    // Every other entry is the merchant's to change.
    for (const type of ['card', 'apple_pay', 'google_pay', 'sepa_debit', 'bizum']) {
      expect([type, (config[type] as Entry).locked]).toEqual([type, false]);
    }

    // A merchant whose owning account has no Peable wallet (no identity key):
    // still listed and locked on, but not available, and it says why.
    const id = crypto.randomUUID();
    const keyless = must(
      await insertMerchant(gatewayDb(), {
        publicId: `merch_${id}`,
        oxyAppId: `app_${id}`,
        environment: 'development',
        ownerAccountId: `keyless_${id}`,
      }),
    );
    actingAs = () => keyless;
    const keylessConfig = await defaultConfiguration();
    expect(keylessConfig.faircoin).toMatchObject({
      available: false,
      display_preference: { preference: 'on', value: 'on' },
      locked: true,
      unavailable_reason: 'faircoin_wallet_missing',
    });
    expect((keylessConfig.card as Entry).available).toBe(true);
  });

  test('turning FairCoin off is refused; on and none store nothing', async () => {
    const config = await defaultConfiguration();
    const path = `/v1/payment_method_configurations/${String(config.id)}`;
    const off = await call('POST', path, {
      faircoin: { display_preference: { preference: 'off' } },
      ideal: { display_preference: { preference: 'on' } },
    });
    expect(off.status).toBe(400);
    expect(off.json.error).toMatchObject({
      type: 'invalid_request_error',
      code: 'payment_method_locked',
      param: 'faircoin',
    });
    expect(off.json.error?.message).toContain('cannot be turned off');
    // Refused whole: the other method in the same body did not change.
    expect((await defaultConfiguration()).ideal).toEqual(config.ideal);

    const created = await call('POST', '/v1/payment_method_configurations', {
      name: 'No FairCoin',
      faircoin: { display_preference: { preference: 'off' } },
    });
    expect(created.status).toBe(400);
    expect(created.json.error?.code).toBe('payment_method_locked');
    expect(created.json.error?.param).toBe('faircoin');

    for (const preference of ['on', 'none'] as const) {
      const accepted = await call('POST', path, {
        faircoin: { display_preference: { preference } },
      });
      expect([preference, accepted.status]).toEqual([preference, 200]);
      expect((accepted.json.faircoin as Entry).locked).toBe(true);
      expect((accepted.json.faircoin as Entry).display_preference.value).toBe('on');
    }
    const withOn = await call('POST', '/v1/payment_method_configurations', {
      name: 'FairCoin named',
      faircoin: { display_preference: { preference: 'on' } },
    });
    expect(withOn.status).toBe(200);
    for (const publicId of [String(config.id), String(withOn.json.id)]) {
      const row = must(await findConfigurationByPublicId(gatewayDb(), merchant.id, publicId));
      expect(Object.keys(row.preferences)).not.toContain('faircoin');
    }
  });

  test('the dashboard refuses FairCoin off the same way and shows it locked', async () => {
    const dashboard = (path: string, init: { method?: string; body?: unknown } = {}) =>
      fetch(
        `${dashboardUrl}/v1/dashboard/applications/${merchant.oxyAppId}${path}?environment=development`,
        {
          method: init.method ?? 'GET',
          headers: { 'Content-Type': 'application/json' },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        },
      ).then(async (response) => ({
        status: response.status,
        json: (await response.json()) as Json,
      }));
    const list = await dashboard('/payment_method_configurations');
    expect(list.status).toBe(200);
    const config = must((list.json.data as Json[]).find((row) => row.is_default === true));
    expect((config.faircoin as Entry).locked).toBe(true);
    const off = await dashboard(`/payment_method_configurations/${String(config.id)}`, {
      method: 'POST',
      body: { faircoin: { display_preference: { preference: 'off' } } },
    });
    expect(off.status).toBe(400);
    expect(off.json.error).toMatchObject({ code: 'payment_method_locked', param: 'faircoin' });
    const created = await dashboard('/payment_method_configurations', {
      method: 'POST',
      body: { faircoin: { display_preference: { preference: 'off' } } },
    });
    expect(created.status).toBe(400);
    expect(created.json.error).toMatchObject({ code: 'payment_method_locked', param: 'faircoin' });
  });

  test('FairCoin never reaches the provider push nor a card payment’s types', async () => {
    const config = await defaultConfiguration();
    // A new version, so the next card payment pushes the configuration.
    await call('POST', `/v1/payment_method_configurations/${String(config.id)}`, {
      faircoin: { display_preference: { preference: 'on' } },
      bancontact: { display_preference: { preference: 'on' } },
    });
    calls.length = 0;
    for (const currency of ['EUR', 'USD']) {
      const intent = await call('POST', '/v1/payment_intents', {
        amount: '2500',
        rail: 'card',
        currency,
      });
      expect(intent.status).toBe(201);
      expect(intent.json.payment_method_types as string[]).not.toContain('faircoin');
    }
    const pushes = calls.filter((entry) => entry.fn === 'savePaymentMethodConfiguration');
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes) {
      expect(Object.keys(push.request.methods as Record<string, string>)).not.toContain('faircoin');
    }
    for (const created of calls.filter((entry) => entry.fn === 'createPayment')) {
      expect((created.request.paymentMethodTypes as string[] | undefined) ?? []).not.toContain(
        'faircoin',
      );
    }
  });
});
