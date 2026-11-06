/**
 * Checkout Sessions v2 (Orbit Phase 3), against a real Postgres: pricing,
 * discounts and their redemption races, collection, tax, confirm, completion
 * driven by the payment's own transitions, expiry, events, receipts.
 *
 * Most flows run on the FairCoin rail, which needs no provider: a confirm
 * reserves a real watch-only address, and `reportFaircoinBroadcast` /
 * `simulateFaircoinPayment` move the payment through the real state machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import express from 'express';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { uuidv7 } from '@oxy.so/db';
import { insertCoupon } from '../../db/catalog/couponRepository';
import { insertPromotionCode } from '../../db/catalog/promotionCodeRepository';
import { upsertBranding, upsertEmailSettings } from '../../db/merchants/brandingRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
import { findSessionByPublicId } from '../../db/payments/checkoutSessionRepository';
import {
  checkoutSessions,
  coupons,
  customerEmails,
  paymentIntents,
  promotionCodes,
} from '../../db/schema';
import { newId } from '../../lib/ids';
import { createFaircoinPayerLimit } from '../../lib/faircoinPayerLimit';
import { requestIdMiddleware } from '../../lib/requestId';
import { reportFaircoinBroadcast } from '../../services/faircoinBroadcast';
import { simulateFaircoinPayment } from '../../services/testHelpers';
import { runSessionExpirySweep } from '../../services/checkout/sessionSweeper';
import { expireSessionNow } from '../../services/checkout/sessionService';
import { useIdentityKeyResolver } from '../../services/socialReceive';
import { testIdentityPublicKey } from '../../__tests__/setup/identityKeys';
import { MemoryMailer } from '../../services/email/mailer';
import { dispatchCustomerEmails } from '../../services/email/dispatcher';
import { registerSubscriptionCheckoutFulfiller } from '../../services/checkout/subscriptionFulfiller';
import type { TaxService } from '../../services/tax/taxService';
import { exclusiveTaxOf } from '../../__tests__/helpers/fakeTax';
import { must } from '../../__tests__/helpers/must';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  seedMerchant,
  seedPrice,
  storedEvents,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { createCheckoutSessionsRouter } from '../checkoutSessions';
import { createBrandingRouter } from '../branding';
import { createCustomersRouter } from '../customers';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read structurally by the assertions
type Json = Record<string, any>;

const APP_ID = 'app_checkout_v2';
let server: Server;
let baseUrl = '';
let merchant: MerchantRow;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 't',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: 'development',
    tier: 'external',
  };
  next();
};
const passthrough: RequestHandler = (_req, _res, next) => next();
let payerLimit = createFaircoinPayerLimit();

/**
 * Peable Tax, faked at its service boundary: active settings, every billing
 * address sufficient, 21% exclusive on every taxable line — except a payer in
 * `XX`, whom the provider cannot price (fail closed).
 */
const fakeTax = {
  async getSettings() {
    return { status: 'active' };
  },
  async recordEvidence(_m: unknown, raw: { evidence: { address: { country: string } }[] }) {
    return { id: `taxloc_${raw.evidence[0]?.address.country}` };
  },
  async calculate(
    _m: unknown,
    raw: {
      customer_location_evidence_id: string;
      line_items: { reference: string; amount: string; tax_behavior?: string }[];
    },
  ) {
    if (raw.customer_location_evidence_id === 'taxloc_XX') {
      const { TaxError } = await import('../../services/tax/taxService');
      throw new TaxError('tax_calculation_unavailable', 'provider_failed');
    }
    return {
      id: newId('taxcalc'),
      line_items: raw.line_items.map((line) => ({
        reference: line.reference,
        amount_tax: exclusiveTaxOf(BigInt(line.amount), 21n).toString(),
        tax_behavior: line.tax_behavior ?? 'exclusive',
      })),
    };
  },
} as unknown as TaxService;

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const SUCCESS = 'https://shop.example/thanks?cs={CHECKOUT_SESSION_ID}';

async function createSession(body: Json) {
  return call('POST', '/v1/checkout_sessions', { success_url: SUCCESS, ...body });
}

function secretOf(session: Json): string {
  return decodeURIComponent(String(session.url).split('#cs=')[1] ?? '');
}

async function payer(session: Json, method: 'GET' | 'POST', suffix = '', body?: unknown) {
  return call(method, `/v1/checkout_sessions/${session.id}/public${suffix}`, body, {
    'X-Peable-Client-Secret': secretOf(session),
  });
}

/** The `checkout.session.*` events recorded about one session, in order. */
async function sessionEventTypes(sessionId: string): Promise<string[]> {
  return (await storedEvents({ merchantId: merchant.id }))
    .filter(({ event }) => (event.data.object as { id?: string }).id === sessionId)
    .map(({ event }) => event.type);
}

async function seedCoupon(values: {
  percentOffBps?: number | null;
  amountOff?: string | null;
  maxRedemptions?: number | null;
}) {
  return gatewayDb().transaction(async (tx) => {
    const coupon = await insertCoupon(tx, {
      publicId: newId('coupon'),
      merchantId: merchant.id,
      name: 'Launch',
      percentOffBps: values.percentOffBps ?? null,
      amountOff: values.amountOff ?? null,
      currency: values.amountOff ? 'FAIR' : null,
      duration: 'once',
      durationInMonths: null,
      maxRedemptions: values.maxRedemptions ?? null,
      redeemBy: null,
      metadata: {},
      appliesToProductIds: [],
    });
    if (coupon === 'id_taken') throw new Error('coupon id taken');
    return coupon;
  });
}

async function seedCode(
  couponId: string,
  values: { code: string; maxRedemptions?: number; minimumAmount?: string },
) {
  return gatewayDb().transaction(async (tx) => {
    const code = await insertPromotionCode(tx, {
      publicId: newId('promo'),
      merchantId: merchant.id,
      couponId,
      customerId: null,
      code: values.code,
      active: true,
      maxRedemptions: values.maxRedemptions ?? null,
      expiresAt: null,
      firstTimeTransaction: false,
      minimumAmount: values.minimumAmount ?? null,
      minimumAmountCurrency: values.minimumAmount ? 'FAIR' : null,
      metadata: {},
    });
    if (code === 'code_taken') throw new Error('code taken');
    return code;
  });
}

useGatewayDatabase();

beforeAll(async () => {
  if (!POSTGRES_TESTS_ENABLED) return;
  merchant = await seedMerchant({ oxyAppId: APP_ID, network: 'testnet' });
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    createCheckoutSessionsRouter({
      requireMerchant: stubRequireMerchant,
      publicRateLimit: passthrough,
      faircoinPayerLimit: (req, res, next) => payerLimit(req, res, next),
      checkout: { tax: fakeTax },
    }),
  );
  app.use(createBrandingRouter({ requireMerchant: stubRequireMerchant }));
  app.use(createCustomersRouter({ requireMerchant: stubRequireMerchant }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  registerSubscriptionCheckoutFulfiller(null);
  // Each case is an independent payer journey; retain the real per-payer limiter.
  payerLimit = createFaircoinPayerLimit();
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('create', () => {
  test('default email collection cannot be disabled by the payer', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '250000000' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    expect(session.contact_collection).toBe('email');
    // Pre-policy sessions stored no collection: they must still require email.
    await gatewayDb()
      .update(checkoutSessions)
      .set({ collection: null })
      .where(eq(checkoutSessions.publicId, session.id));
    expect((await payer(session, 'GET')).body.contact_collection).toBe('email');
    for (const suffix of ['', '/confirm']) {
      const override = await payer(session, 'POST', suffix, {
        contact_collection: 'merchant_account',
      });
      expect(override.status).toBe(400);
    }
    const missing = await payer(session, 'POST', '/confirm', {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.param).toBe('customer_details[email]');
    await payer(session, 'POST', '', {
      customer_details: { name: 'Guest Buyer', address: { country: 'GB' } },
    });
    const collected = await payer(session, 'POST', '', {
      customer_details: { email: 'guest@example.test' },
    });
    expect(collected.body.customer_details.name).toBe('Guest Buyer');
    expect(collected.body.customer_details.address.country).toBe('GB');
    expect((await payer(session, 'POST', '/confirm', {})).status).toBe(200);
  });

  test('merchant account contact persists through retry and completion without invented email', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '250000000' });
    const { body: session } = await createSession({
      contact_collection: 'merchant_account',
      billing_address_collection: 'required',
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    expect(session.contact_collection).toBe('merchant_account');
    const initial = await payer(session, 'GET');
    expect(initial.body.contact_collection).toBe('merchant_account');
    expect(initial.body.customer_details.email).toBeNull();
    const missingBilling = await payer(session, 'POST', '/confirm', {});
    expect(missingBilling.status).toBe(400);
    expect(missingBilling.body.error.param).toBe('customer_details[address]');
    await payer(session, 'POST', '', {
      customer_details: { name: 'Account Buyer', address: { country: 'US' } },
    });
    const confirmed = await payer(session, 'POST', '/confirm', {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.contact_collection).toBe('merchant_account');
    const retry = await payer(session, 'POST', '/confirm', {});
    expect(retry.body.payment_intent.id).toBe(confirmed.body.payment_intent.id);
    expect(retry.body.contact_collection).toBe('merchant_account');
    const intent = must(await findIntentByPublicId(gatewayDb(), confirmed.body.payment_intent.id));
    expect(intent.receiptEmail).toBeNull();
    expect((await reportFaircoinBroadcast(intent, 'e'.repeat(64))).kind).toBe('updated');
    expect(
      (
        await simulateFaircoinPayment(
          must(await findIntentByPublicId(gatewayDb(), intent.publicId)),
          'settled',
        )
      ).kind,
    ).toBe('ok');
    const completed = await payer(session, 'GET');
    expect(completed.body.payment_status).toBe('paid');
    expect(completed.body.customer_details.email).toBeNull();
    const row = must(await findSessionByPublicId(gatewayDb(), session.id));
    const owed = await gatewayDb()
      .select()
      .from(customerEmails)
      .where(eq(customerEmails.checkoutSessionId, row.id));
    expect(owed).toEqual([]);
    expect(await sessionEventTypes(session.id)).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
    ]);
  });

  test('prices per-unit and tiered lines by quantity, with a hosted url and no client secret', async () => {
    const unit = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '150000000' });
    const tiered = await seedPrice(merchant, {
      currency: 'FAIR',
      tiers: [
        { up_to: 5, unit_amount: '100', flat_amount: null },
        { up_to: null, unit_amount: '80', flat_amount: '10' },
      ],
      tiersMode: 'volume',
    });
    const { status, body } = await createSession({
      line_items: [
        { price: unit.publicId, quantity: 2 },
        { price: tiered.publicId, quantity: 7 },
      ],
      metadata: { order: 'o1' },
    });
    expect(status).toBe(201);
    expect(body.object).toBe('checkout_session');
    expect(body.mode).toBe('payment');
    expect(body.status).toBe('open');
    expect(body.payment_status).toBe('unpaid');
    expect(body.currency).toBe('FAIR');
    expect(body.rail).toBe('faircoin');
    // 2 × 150000000 + (7 × 80 + 10).
    expect(body.amount_subtotal).toBe('300000570');
    expect(body.amount_total).toBe('300000570');
    expect(body.payment_intent).toBeNull();
    expect(body.client_secret).toBeNull();
    expect(String(body.url)).toMatch(/\/c\/cs_[0-9a-f]{24}#cs=cs_[0-9a-f]{24}_secret_/);
    const lines = await call(
      'GET',
      `/v1/checkout_sessions/${body.id}/line_items?expand[]=data.price`,
    );
    expect(lines.status).toBe(200);
    expect(lines.body.data.map((line: Json) => [line.quantity, line.amount_total])).toEqual([
      [2, '300000000'],
      [7, '570'],
    ]);
    expect(lines.body.data[0].price.id).toBe(unit.publicId);
    expect(lines.body.data[1].unit_amount).toBeNull();
  });

  test('embedded mode answers a client secret and no url', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { status, body } = await call('POST', '/v1/checkout_sessions', {
      ui_mode: 'embedded',
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    expect(status).toBe(201);
    expect(body.url).toBeNull();
    expect(String(body.client_secret)).toMatch(/^cs_[0-9a-f]{24}_secret_/);
  });

  test('a session takes every payer locale, and refuses one Peable does not speak', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    for (const locale of ['ar', 'zh', 'pt']) {
      const { status, body } = await createSession({
        locale,
        line_items: [{ price: price.publicId, quantity: 1 }],
      });
      expect([locale, status, body.locale]).toEqual([locale, 201, locale]);
    }
    const refused = await createSession({
      locale: 'nl',
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.param).toBe('locale');
  });

  test('refuses what is not an order, naming the field', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const recurring = await seedPrice(merchant, { currency: 'FAIR', recurring: 'month' });
    const cases: [Json, string][] = [
      [{ line_items: [{ price: recurring.publicId, quantity: 1 }] }, 'line_items[0][price]'],
      [{ mode: 'subscription', line_items: [{ price: recurring.publicId, quantity: 1 }] }, 'mode'],
      [
        {
          line_items: [{ price: price.publicId, quantity: 1 }],
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
        'expires_at',
      ],
      [
        {
          line_items: [{ price: price.publicId, quantity: 1 }],
          consent_collection: { terms_of_service: 'required' },
        },
        'consent_collection[terms_of_service]',
      ],
      [
        {
          line_items: [
            {
              price: price.publicId,
              quantity: 5,
              adjustable_quantity: { enabled: true, maximum: 3 },
            },
          ],
        },
        'line_items[0][quantity]',
      ],
      [
        { line_items: [{ price: price.publicId, quantity: 1 }], discounts: [{ coupon: 'nope' }] },
        'discounts[0][coupon]',
      ],
      [{ mode: 'setup', currency: 'FAIR' }, 'currency'],
    ];
    for (const [body, param] of cases) {
      const res = await createSession(body);
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe(param);
    }
    const hosted = await call('POST', '/v1/checkout_sessions', {
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    expect(hosted.body.error.param).toBe('success_url');
  });

  test('subscription mode is refused until the billing engine registers its fulfiller', async () => {
    const recurring = await seedPrice(merchant, { currency: 'FAIR', recurring: 'month' });
    const refused = await createSession({
      mode: 'subscription',
      line_items: [{ price: recurring.publicId, quantity: 1 }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('mode_unavailable');
    registerSubscriptionCheckoutFulfiller({
      validate: async () => {},
      start: async () => {
        throw new Error('not used here');
      },
      repay: async () => {
        throw new Error('not used here');
      },
      complete: async () => {},
    });
    const accepted = await createSession({
      mode: 'subscription',
      line_items: [{ price: recurring.publicId, quantity: 1 }],
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.mode).toBe('subscription');
  });

  test('a merchant coupon discounts the order at creation', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '333' });
    const coupon = await seedCoupon({ percentOffBps: 1500 });
    const { body } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
      discounts: [{ coupon: coupon.publicId }],
    });
    // 15% of 333 = 49.95 → 50, half up.
    expect(body.total_details.amount_discount).toBe('50');
    expect(body.amount_total).toBe('283');
    expect(body.discounts).toEqual([{ coupon: coupon.publicId, promotion_code: null }]);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the payer', () => {
  test('reads the session only with its secret', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    const none = await call('GET', `/v1/checkout_sessions/${session.id}/public`);
    expect(none.status).toBe(401);
    const wrong = await call('GET', `/v1/checkout_sessions/${session.id}/public`, undefined, {
      'X-Peable-Client-Secret': `${session.id}_secret_00000000000000000000000000000000`,
    });
    expect(wrong.status).toBe(403);
    const ok = await payer(session, 'GET');
    expect(ok.status).toBe(200);
    expect(ok.body.line_items).toHaveLength(1);
    expect(ok.body.success_url).toBeNull();
    expect(ok.body.branding.primary_color).toBe('#1f6feb');
    expect(ok.body.metadata).toBeUndefined();
  });

  test('adjusts a quantity within bounds and is refused outside them', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '100' });
    const { body: session } = await createSession({
      line_items: [
        {
          price: price.publicId,
          quantity: 2,
          adjustable_quantity: { enabled: true, minimum: 1, maximum: 5 },
        },
      ],
    });
    const view = await payer(session, 'GET');
    const lineId = view.body.line_items[0].id;
    const ok = await payer(session, 'POST', '', { line_items: [{ id: lineId, quantity: 4 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.amount_total).toBe('400');
    const out = await payer(session, 'POST', '', { line_items: [{ id: lineId, quantity: 6 }] });
    expect(out.status).toBe(400);
    expect(out.body.error.param).toBe('line_items[0][quantity]');
  });

  test('applies and removes a promotion code; refuses an unknown one and a minimum not reached', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '1000' });
    const coupon = await seedCoupon({ amountOff: '300' });
    await seedCode(coupon.id, { code: 'SAVE300' });
    await seedCode(coupon.id, { code: 'BIGORDER', minimumAmount: '5000' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
      allow_promotion_codes: true,
    });
    const applied = await payer(session, 'POST', '', { promotion_code: 'save300' });
    expect(applied.status).toBe(200);
    expect(applied.body.total_details.amount_discount).toBe('300');
    expect(applied.body.amount_total).toBe('700');
    expect(applied.body.discount.promotion_code).toBe('SAVE300');
    const unknown = await payer(session, 'POST', '', { promotion_code: 'NOPE' });
    expect(unknown.body.error.code).toBe('promotion_code_invalid');
    expect(unknown.body.error.param).toBe('promotion_code');
    const minimum = await payer(session, 'POST', '', { promotion_code: 'BIGORDER' });
    expect(minimum.body.error.code).toBe('promotion_code_minimum_amount');
    const removed = await payer(session, 'POST', '', { promotion_code: '' });
    expect(removed.body.amount_total).toBe('1000');
    expect(removed.body.discount).toBeNull();
  });

  test('validates collected fields and refuses what this checkout does not collect', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
      customer_email: 'locked@example.com',
      custom_fields: [
        {
          key: 'size',
          label: { type: 'custom', custom: 'Size' },
          type: 'dropdown',
          dropdown: {
            options: [
              { label: 'S', value: 'S' },
              { label: 'M', value: 'M' },
            ],
          },
        },
        {
          key: 'ref',
          label: { type: 'custom', custom: 'Ref' },
          type: 'numeric',
          optional: true,
          numeric: { maximum_length: 4 },
        },
      ],
    });
    const phone = await payer(session, 'POST', '', {
      customer_details: { phone: '+34 600 000 000' },
    });
    expect(phone.body.error.param).toBe('customer_details[phone]');
    const email = await payer(session, 'POST', '', {
      customer_details: { email: 'other@example.com' },
    });
    expect(email.body.error.param).toBe('customer_details[email]');
    const dropdown = await payer(session, 'POST', '', {
      custom_fields: [{ key: 'size', value: 'XL' }],
    });
    expect(dropdown.body.error.param).toBe('custom_fields[0][value]');
    const numeric = await payer(session, 'POST', '', {
      custom_fields: [{ key: 'ref', value: '12a' }],
    });
    expect(numeric.body.error.param).toBe('custom_fields[0][value]');
    // The required dropdown is still empty: confirm names it.
    const missing = await payer(session, 'POST', '/confirm', {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.param).toBe('custom_fields[size]');
    const filled = await payer(session, 'POST', '', {
      custom_fields: [{ key: 'size', value: 'M' }],
    });
    expect(filled.status).toBe(200);
    expect(filled.body.custom_fields[0].dropdown.value).toBe('M');
  });

  test('automatic tax prices the address and fails closed where it cannot', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '1000' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
      automatic_tax: { enabled: true },
    });
    expect(session.automatic_tax).toEqual({ enabled: true, status: 'requires_location_inputs' });
    const noAddress = await payer(session, 'POST', '/confirm', {});
    expect(noAddress.body.error.param).toBe('customer_details[email]');
    const taxed = await payer(session, 'POST', '', {
      customer_details: {
        email: 'p@example.com',
        address: { country: 'ES', postal_code: '28001' },
      },
    });
    expect(taxed.body.automatic_tax.status).toBe('complete');
    expect(taxed.body.total_details.amount_tax).toBe('210');
    expect(taxed.body.amount_total).toBe('1210');
    const failed = await payer(session, 'POST', '', {
      customer_details: { address: { country: 'XX' } },
    });
    expect(failed.body.automatic_tax.status).toBe('failed');
    expect(failed.body.amount_total).toBe('1000');
    const refused = await payer(session, 'POST', '/confirm', {});
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('tax_calculation_failed');
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('confirm and completion', () => {
  test('a confirm whose session moved meanwhile cancels the FairCoin payment it created (ADR 0021 D9)', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '120000000' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    await payer(session, 'POST', '', { customer_details: { email: 'buyer@example.com' } });
    // The session expires while the confirm is creating its payment: the
    // recipient's key is read between the order write and the link.
    const row = must(await findSessionByPublicId(gatewayDb(), session.id));
    let expiredOnce = false;
    const previous = useIdentityKeyResolver(async (accountId) => {
      if (!expiredOnce) {
        expiredOnce = true;
        await expireSessionNow(must(await findSessionByPublicId(gatewayDb(), row.publicId)));
      }
      return testIdentityPublicKey(accountId);
    });
    try {
      const refused = await payer(session, 'POST', '/confirm', {});
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('checkout_session_changed');
    } finally {
      useIdentityKeyResolver(previous);
    }
    const [orphan] = await gatewayDb()
      .select({
        status: paymentIntents.status,
        cancellationReason: paymentIntents.cancellationReason,
      })
      .from(paymentIntents)
      .where(eq(paymentIntents.idempotencyKey, `checkout:${session.id}:120000000`));
    // Cancelled in the transaction that found it orphaned, not left payable.
    expect(orphan).toEqual({ status: 'canceled', cancellationReason: 'abandoned' });
  });

  test('creates the FairCoin payment, locks the order, and completes only with the payment', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '250000000' });
    await upsertEmailSettings(gatewayDb(), merchant.id, { checkoutConfirmations: true });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    await payer(session, 'POST', '', { customer_details: { email: 'buyer@example.com' } });
    const confirmed = await payer(session, 'POST', '/confirm', {});
    expect(confirmed.status).toBe(200);
    const intent = confirmed.body.payment_intent;
    expect(intent.amount).toBe('250000000');
    expect(intent.status).toBe('requires_action');
    expect(intent.next_action.type).toBe('faircoin_payment');
    expect(confirmed.body.status).toBe('open');
    expect(confirmed.body.cancel_url).toBeNull();
    // Idempotent: a second confirm names the same payment.
    const again = await payer(session, 'POST', '/confirm', {});
    expect(again.body.payment_intent.id).toBe(intent.id);
    // Locked.
    const locked = await payer(session, 'POST', '', { customer_details: { name: 'Late' } });
    expect(locked.body.error.code).toBe('checkout_session_locked');

    // The payer broadcasts: FairCoin completes the session, still unpaid.
    const row = must(await findIntentByPublicId(gatewayDb(), intent.id));
    const broadcast = await reportFaircoinBroadcast(row, 'a'.repeat(64));
    expect(broadcast.kind).toBe('updated');
    const processing = await payer(session, 'GET');
    expect(processing.body.status).toBe('complete');
    expect(processing.body.payment_status).toBe('unpaid');
    expect(processing.body.success_url).toBe(`https://shop.example/thanks?cs=${session.id}`);

    // The chain confirms: paid, and the async success is announced.
    const settled = await simulateFaircoinPayment(
      must(await findIntentByPublicId(gatewayDb(), intent.id)),
      'settled',
    );
    expect(settled.kind).toBe('ok');
    const paid = await call('GET', `/v1/checkout_sessions/${session.id}`);
    expect(paid.body.payment_status).toBe('paid');
    const sessionRow = must(await findSessionByPublicId(gatewayDb(), session.id));
    expect(await sessionEventTypes(session.id)).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
    ]);

    // What is owed: a receipt (the payment) and a confirmation (the session).
    const owed = await gatewayDb()
      .select()
      .from(customerEmails)
      .where(eq(customerEmails.merchantId, merchant.id));
    const kinds = owed
      .filter(
        (row2) =>
          row2.paymentIntentId === sessionRow.paymentIntentId ||
          row2.checkoutSessionId === sessionRow.id,
      )
      .map((row2) => row2.kind)
      .sort();
    expect(kinds).toEqual(['checkout_confirmation', 'payment_receipt']);

    const mailer = new MemoryMailer();
    await upsertBranding(gatewayDb(), merchant.id, { primaryColor: '#aa0000' });
    await dispatchCustomerEmails(mailer);
    const receipt = must(
      mailer.sent.find((email) => email.headers['X-Peable-Email-Kind'] === 'payment_receipt'),
    );
    expect(receipt.to).toBe('buyer@example.com');
    expect(receipt.subject).toContain('receipt');
    expect(receipt.text).toContain('2.5 FAIR');
    expect(receipt.text).toMatch(/R-\d{6}/);
    expect(receipt.html).toContain('#aa0000');
    expect(receipt.html).toContain('<html lang="en" dir="ltr">');
    expect(receipt.html).not.toContain(intent.client_secret);
    expect(receipt.html).not.toContain(row.address ?? 'no-address');
    // Sent once: a second pass sends nothing.
    await dispatchCustomerEmails(mailer);
    expect(
      mailer.sent.filter((e) => e.headers['X-Peable-Email-Kind'] === 'payment_receipt'),
    ).toHaveLength(1);
  });

  test('an underpaid FairCoin payment fails the completed session asynchronously', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    await payer(session, 'POST', '', { customer_details: { email: 'u@example.com' } });
    const confirmed = await payer(session, 'POST', '/confirm', {});
    const row = must(await findIntentByPublicId(gatewayDb(), confirmed.body.payment_intent.id));
    await simulateFaircoinPayment(row, 'underpaid');
    expect(await sessionEventTypes(session.id)).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_failed',
    ]);
  });

  test('a code with one redemption left goes to exactly one of two racing payers, and completion counts it', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '1000' });
    const coupon = await seedCoupon({ percentOffBps: 1000 });
    const code = await seedCode(coupon.id, {
      code: `LAST${uuidv7().slice(-6)}`,
      maxRedemptions: 1,
    });
    const sessions = await Promise.all(
      [0, 1].map(async () => {
        const { body } = await createSession({
          line_items: [{ price: price.publicId, quantity: 1 }],
          allow_promotion_codes: true,
        });
        await payer(body, 'POST', '', {
          promotion_code: code.code,
          customer_details: { email: 'r@example.com' },
        });
        return body;
      }),
    );
    const results = await Promise.all(sessions.map((s) => payer(s, 'POST', '/confirm', {})));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    const loser = must(results.find((r) => r.status === 400));
    expect(loser.body.error.code).toBe('promotion_code_max_redemptions');
    const winner = must(results.find((r) => r.status === 200));
    await simulateFaircoinPayment(
      must(await findIntentByPublicId(gatewayDb(), winner.body.payment_intent.id)),
      'settled',
    );
    const [counted] = await gatewayDb()
      .select()
      .from(promotionCodes)
      .where(eq(promotionCodes.id, code.id));
    expect(counted?.timesRedeemed).toBe(1);
    const [couponRow] = await gatewayDb().select().from(coupons).where(eq(coupons.id, coupon.id));
    expect(couponRow?.timesRedeemed).toBe(1);
  });

  test('a discount that takes the order to zero completes on confirm with no payment', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '500' });
    const coupon = await seedCoupon({ percentOffBps: 10000 });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
      discounts: [{ coupon: coupon.publicId }],
    });
    await payer(session, 'POST', '', { customer_details: { email: 'z@example.com' } });
    const done = await payer(session, 'POST', '/confirm', {});
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('complete');
    expect(done.body.payment_status).toBe('no_payment_required');
    expect(done.body.payment_intent).toBeNull();
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the payer locale', () => {
  /** A FAIR order a 100% coupon takes to zero: it completes on confirm, with no payment. */
  async function freeOrder(extra: Json) {
    const price = await seedPrice(merchant, { currency: 'FAIR', unitAmount: '500' });
    const coupon = await seedCoupon({ percentOffBps: 10000 });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
      discounts: [{ coupon: coupon.publicId }],
      ...extra,
    });
    return session;
  }

  async function confirmationTo(email: string) {
    const mailer = new MemoryMailer();
    await dispatchCustomerEmails(mailer);
    return must(
      mailer.sent.find(
        (sent) =>
          sent.to === email && sent.headers['X-Peable-Email-Kind'] === 'checkout_confirmation',
      ),
    );
  }

  test('the customer checkout creates keeps the language the payer confirmed in, and its emails speak it', async () => {
    await upsertEmailSettings(gatewayDb(), merchant.id, { checkoutConfirmations: true });
    const session = await freeOrder({ customer_creation: 'always' });
    await payer(session, 'POST', '', { customer_details: { email: 'ja@example.com' } });
    const refused = await payer(session, 'POST', '/confirm', { locale: 'nl' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.param).toBe('locale');

    const done = await payer(session, 'POST', '/confirm', { locale: 'ja' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('complete');
    // The merchant's `locale` is untouched: the payer's is recorded beside it.
    const merchantView = await call('GET', `/v1/checkout_sessions/${session.id}`);
    expect(merchantView.body.locale).toBeNull();
    expect(must(await findSessionByPublicId(gatewayDb(), session.id)).payerLocale).toBe('ja');

    const customer = await call('GET', `/v1/customers/${merchantView.body.customer}`);
    expect(customer.body.preferred_locales).toEqual(['ja']);
    const email = await confirmationTo('ja@example.com');
    expect(email.html).toContain('<html lang="ja" dir="ltr">');
    expect(email.subject).not.toContain('confirmed');
  });

  test("a customer's own preferred language wins over the payer's, and checkout never rewrites it", async () => {
    await upsertEmailSettings(gatewayDb(), merchant.id, { checkoutConfirmations: true });
    const created = await call('POST', '/v1/customers', {
      email: 'de@example.com',
      preferred_locales: ['de', 'en'],
    });
    const session = await freeOrder({ customer: created.body.id, locale: 'fr' });
    await payer(session, 'POST', '', { customer_details: { email: 'de@example.com' } });
    const done = await payer(session, 'POST', '/confirm', { locale: 'ar' });
    expect(done.body.status).toBe('complete');
    const customer = await call('GET', `/v1/customers/${created.body.id}`);
    expect(customer.body.preferred_locales).toEqual(['de', 'en']);
    const email = await confirmationTo('de@example.com');
    expect(email.html).toContain('<html lang="de" dir="ltr">');
  });

  test('with no customer language, the email speaks the one the payer confirmed in, else the session’s', async () => {
    await upsertEmailSettings(gatewayDb(), merchant.id, { checkoutConfirmations: true });
    const confirmedIn = await freeOrder({ locale: 'fr' });
    await payer(confirmedIn, 'POST', '', { customer_details: { email: 'ar@example.com' } });
    await payer(confirmedIn, 'POST', '/confirm', { locale: 'ar' });
    expect((await confirmationTo('ar@example.com')).html).toContain('<html lang="ar" dir="rtl">');

    const sessionOnly = await freeOrder({ locale: 'fr' });
    await payer(sessionOnly, 'POST', '', { customer_details: { email: 'fr@example.com' } });
    await payer(sessionOnly, 'POST', '/confirm', {});
    expect((await confirmationTo('fr@example.com')).html).toContain('<html lang="fr" dir="ltr">');
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('expiry', () => {
  test('the merchant expires an open session; a second expire is refused', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    const expired = await call('POST', `/v1/checkout_sessions/${session.id}/expire`, {});
    expect(expired.status).toBe(200);
    expect(expired.body.status).toBe('expired');
    const again = await call('POST', `/v1/checkout_sessions/${session.id}/expire`, {});
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('checkout_session_not_open');
    const confirm = await payer(session, 'POST', '/confirm', {});
    expect(confirm.body.status).toBe('expired');
  });

  test('expiring a confirmed session cancels its payment and expires with it', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    await payer(session, 'POST', '', { customer_details: { email: 'x@example.com' } });
    const confirmed = await payer(session, 'POST', '/confirm', {});
    expect(confirmed.body.error).toBeUndefined();
    const expired = await call('POST', `/v1/checkout_sessions/${session.id}/expire`, {});
    expect(expired.body.status).toBe('expired');
    const intent = must(await findIntentByPublicId(gatewayDb(), confirmed.body.payment_intent.id));
    expect(intent.status).toBe('canceled');
  });

  test('the sweeper expires an unconfirmed session past its deadline, once', async () => {
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    await gatewayDb()
      .update(checkoutSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(checkoutSessions.publicId, session.id));
    expect(await runSessionExpirySweep()).toBeGreaterThanOrEqual(1);
    expect(must(await findSessionByPublicId(gatewayDb(), session.id)).status).toBe('expired');
    expect(await sessionEventTypes(session.id)).toEqual(['checkout.session.expired']);
    await runSessionExpirySweep();
    expect(await sessionEventTypes(session.id)).toEqual(['checkout.session.expired']);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('branding', () => {
  test('normalizes colours, refuses an unknown font, and reaches the payer view', async () => {
    const refused = await call('POST', '/v1/merchants/me/branding', { font: 'comic_sans' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.param).toBe('font');
    const saved = await call('POST', '/v1/merchants/me/branding', {
      primary_color: '#ABC',
      font: 'serif',
      border_style: 'pill',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.primary_color).toBe('#aabbcc');
    const price = await seedPrice(merchant, { currency: 'FAIR' });
    const { body: session } = await createSession({
      line_items: [{ price: price.publicId, quantity: 1 }],
    });
    const view = await payer(session, 'GET');
    expect(view.body.branding).toMatchObject({
      primary_color: '#aabbcc',
      font: 'serif',
      border_style: 'pill',
    });
  });

  test('email settings default on for receipts and off for confirmations', async () => {
    const other = await seedMerchant({ oxyAppId: `app_${uuidv7()}` });
    const { findEmailSettings } = await import('../../db/merchants/brandingRepository');
    const settings = await findEmailSettings(gatewayDb(), other.id);
    expect(settings.paymentReceipts).toBe(true);
    expect(settings.refundNotices).toBe(true);
    expect(settings.checkoutConfirmations).toBe(false);
  });
});
