import { describe, expect, test } from 'bun:test';
import {
  signWebhook,
  type WebhookEvent,
  type WebhookEventPayload,
  type WebhookEventType,
  type Charge,
  type ConnectedAccount,
  type Coupon,
  type Price,
  type Product,
  type PromotionCode,
  type Customer,
  type Dispute,
  type PaymentMethod,
  type Refund,
  type SetupIntent,
  type TaxReviewItem,
} from '@peable.to/shared-types';
import { WebhooksResource } from '../../src/resources/webhooks';
import { PeableSignatureVerificationError } from '../../src/core/errors';
import { processingFixture } from '../support/intentFixture';
import {
  accountFixture,
  applicationFeeFixture,
  balanceFixture,
  payoutFixture,
  requirementsFixture,
} from '../support/moneyFixtures';
import { checkoutSessionFixture, paymentLinkFixture } from '../support/checkoutFixture';
import { BILLING_EVENT_PAYLOADS } from '../support/billingFixtures';

/** A verification session as an event carries it: no credentials, no person (ADR 0023). */
const VERIFICATION_SESSION = {
  id: 'vs_fixture',
  object: 'identity.verification_session' as const,
  livemode: false,
  type: 'document' as const,
  status: 'requires_input' as const,
  options: { id_number: {} },
  client_secret: null,
  url: null,
  return_url: null,
  client_reference_id: null,
  last_error: null,
  last_verification_report: null,
  redaction: null,
  metadata: {},
  created: 1_700_000_000,
};

const SECRET = 'whsec_test_secret';
const TIMESTAMP = 1700000000;

function reviewItemFixture(): TaxReviewItem {
  return {
    object: 'tax.review_item',
    id: 'taxrev_fixture',
    livemode: false,
    code: 'registration_status_unknown',
    severity: 'review',
    status: 'open',
    rule: 'us_tx_sales_tax',
    country: 'US',
    state: 'TX',
    message: 'The registration status here is recorded as unknown.',
    first_assessment: 'taxasm_fixture',
    latest_assessment: 'taxasm_fixture',
    decision: null,
    created: TIMESTAMP,
    updated: TIMESTAMP,
  };
}

const EVENT: WebhookEvent = {
  id: 'evt_1',
  object: 'event',
  livemode: false,
  type: 'payment_intent.succeeded',
  created: TIMESTAMP,
  api_version: '2026-11-03',
  request: { id: 'req_1', idempotency_key: null },
  data: {
    object: processingFixture({
      id: 'pi_1',
      status: 'succeeded',
      amount_received: '100000',
      faircoin: {
        network: 'testnet',
        address: 'addr1',
        outputs: [{ address: 'addr1', amount: '100000', connected_account: null }],
        txid: 'tx1',
        confirmations: 6,
        required_confirmations: 6,
        quote: null,
        recipient_key_replaced_at: null,
      },
      expires_at: TIMESTAMP,
      created: TIMESTAMP,
      updated_at: TIMESTAMP,
    }),
  },
};

const RAW_BODY = JSON.stringify(EVENT);

describe('WebhooksResource.constructEvent', () => {
  test('a byte payload verifies when it is exactly the signed UTF-8 body', () => {
    const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
    const event = new WebhooksResource().constructEvent(
      new TextEncoder().encode(RAW_BODY),
      header,
      SECRET,
      Number.MAX_SAFE_INTEGER,
    );
    expect(event.id).toBe(EVENT.id);
  });

  test('invalid UTF-8 bytes are refused even when their lenient decoding would match the signature', () => {
    // A lenient decoder maps the lone 0xff to U+FFFD, so these bytes would decode
    // to exactly the text that was signed.
    const signedText = `${RAW_BODY.slice(0, -1)}\ufffd}`;
    const header = signWebhook(SECRET, signedText, TIMESTAMP);
    const encoded = new TextEncoder().encode(RAW_BODY.slice(0, -1));
    const bytes = new Uint8Array([...encoded, 0xff, 0x7d]);
    expect(() =>
      new WebhooksResource().constructEvent(bytes, header, SECRET, Number.MAX_SAFE_INTEGER),
    ).toThrow(PeableSignatureVerificationError);
  });

  test('a leading BOM is part of the bytes, not silently dropped', () => {
    const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(RAW_BODY)]);
    expect(() =>
      new WebhooksResource().constructEvent(bytes, header, SECRET, Number.MAX_SAFE_INTEGER),
    ).toThrow(PeableSignatureVerificationError);
  });

  test('verifies a payload signed by shared-types signWebhook and returns the typed event', () => {
    const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
    const resource = new WebhooksResource();

    // Freeze "now" close to the signed timestamp so it is within tolerance.
    const event = resource.constructEvent(RAW_BODY, header, SECRET, Number.MAX_SAFE_INTEGER);

    expect(event).toEqual(EVENT);
  });

  test('rejects a tampered body', () => {
    const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
    const tampered = JSON.stringify({ ...EVENT, id: 'evt_evil' });
    const resource = new WebhooksResource();

    expect(() =>
      resource.constructEvent(tampered, header, SECRET, Number.MAX_SAFE_INTEGER),
    ).toThrow(PeableSignatureVerificationError);
  });

  test('rejects a signature produced with the wrong secret', () => {
    const header = signWebhook('whsec_wrong', RAW_BODY, TIMESTAMP);
    const resource = new WebhooksResource();

    expect(() =>
      resource.constructEvent(RAW_BODY, header, SECRET, Number.MAX_SAFE_INTEGER),
    ).toThrow(PeableSignatureVerificationError);
  });

  test('rejects a stale timestamp beyond the default tolerance', () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10_000;
    const header = signWebhook(SECRET, RAW_BODY, staleTimestamp);
    const resource = new WebhooksResource();

    expect(() => resource.constructEvent(RAW_BODY, header, SECRET)).toThrow(
      PeableSignatureVerificationError,
    );
  });

  test('respects a custom tolerance', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 120;
    const header = signWebhook(SECRET, RAW_BODY, timestamp);
    const resource = new WebhooksResource();

    expect(() => resource.constructEvent(RAW_BODY, header, SECRET, 60)).toThrow(
      PeableSignatureVerificationError,
    );
    expect(() => resource.constructEvent(RAW_BODY, header, SECRET, 300)).not.toThrow();
  });

  test('rejects a signature-valid but non-JSON body', () => {
    const rawBody = 'not json';
    const header = signWebhook(SECRET, rawBody, TIMESTAMP);
    const resource = new WebhooksResource();

    expect(() => resource.constructEvent(rawBody, header, SECRET, Number.MAX_SAFE_INTEGER)).toThrow(
      PeableSignatureVerificationError,
    );
  });

  test('rejects a signature-valid JSON body that does not match the event shape', () => {
    const rawBody = JSON.stringify({ hello: 'world' });
    const header = signWebhook(SECRET, rawBody, TIMESTAMP);
    const resource = new WebhooksResource();

    expect(() => resource.constructEvent(rawBody, header, SECRET, Number.MAX_SAFE_INTEGER)).toThrow(
      PeableSignatureVerificationError,
    );
  });

  test('rejects a malformed signature header', () => {
    const resource = new WebhooksResource();

    expect(() => resource.constructEvent(RAW_BODY, 'not-a-signature', SECRET)).toThrow(
      PeableSignatureVerificationError,
    );
  });

  /**
   * A `roll_secret` overlap: Peable signs with the new AND the previous
   * secret, so a receiver still holding only the old one, and one already
   * switched, both accept the same delivery.
   */
  test('accepts a dual-signed delivery with either secret of a rotation', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhook(['whsec_new', 'whsec_old'], RAW_BODY, timestamp);
    const resource = new WebhooksResource();

    expect(resource.constructEvent(RAW_BODY, header, 'whsec_old')).toEqual(EVENT);
    expect(resource.constructEvent(RAW_BODY, header, 'whsec_new')).toEqual(EVENT);
    expect(() => resource.constructEvent(RAW_BODY, header, 'whsec_other')).toThrow(
      PeableSignatureVerificationError,
    );
  });

  test('accepts the receiver-side list of secrets when any one matches', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhook('whsec_new', RAW_BODY, timestamp);
    const resource = new WebhooksResource();

    expect(resource.constructEvent(RAW_BODY, header, ['whsec_old', 'whsec_new'])).toEqual(EVENT);
    expect(() => resource.constructEvent(RAW_BODY, header, ['whsec_old'])).toThrow(
      PeableSignatureVerificationError,
    );
  });
  test('verifies the raw body as bytes (a Buffer or Uint8Array) exactly as as text', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhook('whsec_new', RAW_BODY, timestamp);
    const resource = new WebhooksResource();
    const bytes = new TextEncoder().encode(RAW_BODY);

    expect(resource.constructEvent(bytes, header, 'whsec_new')).toEqual(EVENT);
    expect(resource.constructEvent(Buffer.from(RAW_BODY), header, 'whsec_new')).toEqual(EVENT);
  });

  test('refuses a negative tolerance', () => {
    const header = signWebhook('whsec_new', RAW_BODY, Math.floor(Date.now() / 1000));
    expect(() => new WebhooksResource().constructEvent(RAW_BODY, header, 'whsec_new', -1)).toThrow(
      /tolerance/,
    );
  });
});

// Full published payloads, matching backend intentTransition's three producers.
const dispute: Dispute = {
  id: 'dp_fixture',
  object: 'dispute',
  livemode: false,
  payment_intent: 'pi_1',
  charge: 'ch_fixture',
  amount: '100',
  currency: 'EUR',
  status: 'needs_response',
  reason: 'general',
  is_charge_refundable: true,
  evidence_details: {
    due_by: null,
    has_evidence: false,
    past_due: false,
    submission_count: 0,
    submitted_at: null,
  },
  metadata: {},
  created: EVENT.created,
  updated_at: EVENT.created,
};
const account: ConnectedAccount = {
  id: 'ca_fixture',
  object: 'connected_account',
  livemode: false,
  external_ref: 'store_fixture',
  rails: ['card'],
  faircoin: null,
  country: 'ES',
  default_currency: 'EUR',
  payable: false,
  payouts_enabled: false,
  charges_enabled: false,
  transfers_capability: 'pending',
  card_payments_capability: null,
  requirements: requirementsFixture({
    currently_due: ['external_account'],
    eventually_due: ['external_account'],
  }),
  last_synced_at: null,
  created: EVENT.created,
  updated_at: EVENT.created,
};
const charge: Charge = {
  id: 'ch_1',
  object: 'charge',
  livemode: false,
  payment_intent: 'pi_1',
  customer: null,
  payment_method: null,
  amount: '2500',
  amount_captured: '2500',
  amount_refunded: '500',
  currency: 'EUR',
  status: 'succeeded',
  paid: true,
  captured: true,
  refunded: false,
  disputed: false,
  outcome: null,
  billing_details: null,
  payment_method_details: null,
  receipt_url: null,
  balance_transaction: null,
  application_fee: null,
  application_fee_amount: null,
  description: null,
  receipt_email: null,
  metadata: {},
  created: EVENT.created,
};
const refund: Refund = {
  id: 're_1',
  object: 'refund',
  livemode: false,
  external_ref: 'refund_1',
  origin: 'merchant',
  payment_intent: 'pi_1',
  amount: '500',
  currency: 'EUR',
  status: 'succeeded',
  reason: null,
  failure_code: null,
  metadata: {},
  created: EVENT.created,
  updated_at: EVENT.created,
};
const customer: Customer = {
  id: 'cus_1',
  object: 'customer',
  livemode: false,
  email: 'payer@example.com',
  name: null,
  phone: null,
  description: null,
  address: null,
  shipping: null,
  preferred_locales: [],
  invoice_settings: { default_payment_method: null },
  metadata: {},
  balance: '0',
  currency: null,
  test_clock: null,
  created: EVENT.created,
};
const paymentMethod: PaymentMethod = {
  id: 'pm_1',
  object: 'payment_method',
  livemode: false,
  type: 'card',
  card: {
    brand: 'visa',
    last4: '4242',
    exp_month: 12,
    exp_year: 2030,
    country: 'ES',
    funding: 'credit',
  },
  billing_details: { address: null, email: null, name: null, phone: null },
  customer: 'cus_1',
  metadata: {},
  created: EVENT.created,
};
const setupIntent: SetupIntent = {
  id: 'seti_1',
  object: 'setup_intent',
  livemode: false,
  status: 'succeeded',
  usage: 'off_session',
  payment_method_types: ['card'],
  customer: 'cus_1',
  payment_method: 'pm_1',
  client_secret: 'seti_1_secret_x',
  next_action: null,
  last_setup_error: null,
  cancellation_reason: null,
  description: null,
  metadata: {},
  created: EVENT.created,
};
const product: Product = {
  id: 'prod_fixture',
  object: 'product',
  livemode: false,
  active: true,
  name: 'Plus',
  description: null,
  images: [],
  metadata: {},
  tax_code: null,
  default_price: 'price_fixture',
  unit_label: null,
  url: null,
  statement_descriptor: null,
  marketing_features: [],
  created: EVENT.created,
  updated: EVENT.created,
};
const price: Price = {
  id: 'price_fixture',
  object: 'price',
  livemode: false,
  active: true,
  product: 'prod_fixture',
  currency: 'EUR',
  unit_amount: '999',
  billing_scheme: 'per_unit',
  tiers: null,
  tiers_mode: null,
  transform_quantity: null,
  type: 'recurring',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null },
  tax_behavior: 'exclusive',
  lookup_key: 'plus_monthly',
  nickname: null,
  metadata: {},
  created: EVENT.created,
};
const coupon: Coupon = {
  id: 'SUMMER25',
  object: 'coupon',
  livemode: false,
  name: null,
  percent_off: 25,
  amount_off: null,
  currency: null,
  duration: 'once',
  duration_in_months: null,
  max_redemptions: null,
  redeem_by: null,
  times_redeemed: 0,
  valid: true,
  applies_to: null,
  metadata: {},
  created: EVENT.created,
};
const promotionCode: PromotionCode = {
  id: 'promo_fixture',
  object: 'promotion_code',
  livemode: false,
  code: 'SUMMER',
  coupon: 'SUMMER25',
  customer: null,
  active: true,
  max_redemptions: null,
  expires_at: null,
  times_redeemed: 0,
  restrictions: {
    first_time_transaction: false,
    minimum_amount: null,
    minimum_amount_currency: null,
  },
  metadata: {},
  created: EVENT.created,
};

const payloads = {
  'payment_intent.created': EVENT.data.object,
  'payment_intent.requires_action': EVENT.data.object,
  'payment_intent.processing': EVENT.data.object,
  'payment_intent.amount_capturable_updated': EVENT.data.object,
  'payment_intent.succeeded': EVENT.data.object,
  'payment_intent.payment_failed': EVENT.data.object,
  'payment_intent.canceled': EVENT.data.object,
  'charge.refunded': charge,
  'charge.dispute.created': dispute,
  'charge.dispute.updated': { ...dispute, status: 'under_review' },
  'charge.dispute.closed': { ...dispute, status: 'won' },
  'charge.dispute.funds_withdrawn': { ...dispute, is_charge_refundable: false },
  'charge.dispute.funds_reinstated': { ...dispute, status: 'won' },
  'refund.created': refund,
  'refund.updated': refund,
  'refund.failed': { ...refund, status: 'failed', failure_code: 'expired_or_canceled_card' },
  'customer.created': customer,
  'customer.updated': customer,
  'customer.deleted': customer,
  'payment_method.attached': paymentMethod,
  'payment_method.detached': { ...paymentMethod, customer: null },
  'payment_method.updated': paymentMethod,
  'setup_intent.created': {
    ...setupIntent,
    status: 'requires_payment_method',
    payment_method: null,
  },
  'setup_intent.requires_action': {
    ...setupIntent,
    status: 'requires_action',
    next_action: { type: 'use_peable_sdk' },
  },
  'setup_intent.succeeded': setupIntent,
  'setup_intent.setup_failed': { ...setupIntent, status: 'requires_payment_method' },
  'setup_intent.canceled': { ...setupIntent, status: 'canceled' },
  'product.created': product,
  'product.updated': product,
  'product.deleted': product,
  'price.created': price,
  'price.updated': { ...price, active: false },
  'coupon.created': coupon,
  'coupon.updated': { ...coupon, name: 'Summer' },
  'coupon.deleted': { ...coupon, valid: false },
  'promotion_code.created': promotionCode,
  'promotion_code.updated': { ...promotionCode, active: false },
  'checkout.session.completed': {
    ...checkoutSessionFixture,
    status: 'complete',
    payment_status: 'paid',
    payment_intent: 'pi_fixture',
  },
  'checkout.session.expired': { ...checkoutSessionFixture, status: 'expired' },
  'checkout.session.async_payment_succeeded': {
    ...checkoutSessionFixture,
    status: 'complete',
    payment_status: 'paid',
  },
  'checkout.session.async_payment_failed': {
    ...checkoutSessionFixture,
    status: 'complete',
    payment_status: 'unpaid',
  },
  'payment_link.created': paymentLinkFixture,
  'payment_link.updated': { ...paymentLinkFixture, active: false },
  ...BILLING_EVENT_PAYLOADS,
  'connected_account.updated': account,
  'account.updated': accountFixture(),
  'application_fee.created': applicationFeeFixture(),
  'application_fee.refunded': applicationFeeFixture({ amount_refunded: '150', refunded: true }),
  'payout.created': payoutFixture(),
  'payout.updated': payoutFixture({ status: 'in_transit' }),
  'payout.paid': payoutFixture({ status: 'paid' }),
  'payout.failed': payoutFixture({ status: 'failed', failure_code: 'account_closed' }),
  'payout.canceled': payoutFixture({ status: 'canceled' }),
  'balance.available': balanceFixture(),
  'reporting.report_run.succeeded': {
    id: 'frr_fixture',
    object: 'reporting.report_run',
    livemode: false,
    created: EVENT.created,
    report_type: 'payments.itemized.1',
    parameters: { interval_start: EVENT.created - 86_400, interval_end: EVENT.created },
    status: 'succeeded',
    error: null,
    result: {
      id: 'file_fixture',
      object: 'file',
      livemode: false,
      purpose: 'finance_report_run',
      filename: 'payments.itemized.1-frr_fixture.csv',
      size: 120,
      type: 'csv',
      status: 'available',
      url: 'https://api.peable.to/v1/files/file_fixture/contents',
      created: EVENT.created,
    },
    succeeded_at: EVENT.created,
    report_schedule: null,
  },
  'reporting.report_run.failed': {
    id: 'frr_failed',
    object: 'reporting.report_run',
    livemode: false,
    created: EVENT.created,
    report_type: 'balance.summary.1',
    parameters: { interval_start: EVENT.created - 86_400, interval_end: EVENT.created },
    status: 'failed',
    error: 'this merchant has no fiat account, so there is no ledger to report on',
    result: null,
    succeeded_at: null,
    report_schedule: null,
  },
  'tax.assessment.created': {
    object: 'tax.assessment',
    id: 'taxasm_fixture',
    livemode: false,
    rule_set_version: '2026-11-03.1',
    as_of: EVENT.created,
    inputs_digest: 'a'.repeat(64),
    results: [],
    summary: {
      registration_declared: 0,
      likely_required: 0,
      approaching_threshold: 0,
      not_indicated: 0,
      uncertain: 0,
      unsupported: 0,
    },
    created_by: { type: 'service', id: null },
    created: EVENT.created,
  },
  'tax.review_item.created': reviewItemFixture(),
  'tax.review_item.updated': reviewItemFixture(),
  'identity.verification_session.created': VERIFICATION_SESSION,
  'identity.verification_session.processing': { ...VERIFICATION_SESSION, status: 'processing' },
  'identity.verification_session.verified': { ...VERIFICATION_SESSION, status: 'verified' },
  'identity.verification_session.requires_input': {
    ...VERIFICATION_SESSION,
    last_error: { code: 'document_expired', reason: 'The identity document has expired.' },
  },
  'identity.verification_session.canceled': { ...VERIFICATION_SESSION, status: 'canceled' },
  'identity.verification_session.redacted': {
    ...VERIFICATION_SESSION,
    status: 'canceled',
    redaction: { status: 'redacted' },
  },
  'webhook_endpoint.test': {
    id: 'we_fixture',
    object: 'webhook_endpoint',
    livemode: false,
    url: 'https://merchant.example/hook',
    description: null,
    enabled_events: ['*'],
    status: 'enabled',
    disabled_reason: null,
    api_version: '2026-11-03',
    metadata: {},
    created: EVENT.created,
    updated_at: EVENT.created,
  },
} satisfies WebhookEventPayload;

describe('catalog events', () => {
  test('a signed product.created verifies and narrows to a Product', () => {
    const raw = JSON.stringify({ ...EVENT, type: 'product.created', data: { object: product } });
    const timestamp = Math.floor(Date.now() / 1000);
    const event = new WebhooksResource().constructEvent(
      raw,
      signWebhook(SECRET, raw, timestamp),
      SECRET,
    );
    if (event.type !== 'product.created') throw new Error(`narrowed to ${event.type}`);
    // `default_price` exists on Product only: this compiles because of the narrowing.
    expect(event.data.object.default_price).toBe('price_fixture');
    expect(event.data.object.object).toBe('product');
  });
});

describe('published event family parity', () => {
  for (const type of Object.keys(payloads) as WebhookEventType[]) {
    test(`accepts signed ${type} without replacing its resource`, () => {
      const expected = {
        id: `evt_${type}`,
        object: 'event',
        livemode: false,
        type,
        created: EVENT.created,
        api_version: '2026-11-03',
        request: { id: null, idempotency_key: null },
        data: { object: payloads[type] },
      };
      const raw = JSON.stringify(expected);
      const timestamp = Math.floor(Date.now() / 1000);
      const resource = new WebhooksResource();
      expect(
        JSON.stringify(resource.constructEvent(raw, signWebhook(SECRET, raw, timestamp), SECRET)),
      ).toBe(raw);
      expect(() =>
        resource.constructEvent(raw, signWebhook('wrong', raw, timestamp), SECRET),
      ).toThrow(PeableSignatureVerificationError);
      expect(() =>
        resource.constructEvent(raw, signWebhook(SECRET, raw, timestamp - 301), SECRET),
      ).toThrow(PeableSignatureVerificationError);
      expect(() =>
        resource.constructEvent(raw, signWebhook(SECRET, raw, timestamp + 301), SECRET),
      ).toThrow(PeableSignatureVerificationError);
    });
  }
  test('rejects a signed event whose envelope carries no api_version or request', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const { api_version: _version, ...withoutVersion } = EVENT;
    const { request: _request, ...withoutRequest } = EVENT;
    for (const shape of [withoutVersion, withoutRequest, { ...EVENT, request: { id: 1 } }]) {
      const raw = JSON.stringify(shape);
      expect(() =>
        new WebhooksResource().constructEvent(raw, signWebhook(SECRET, raw, timestamp), SECRET),
      ).toThrow(PeableSignatureVerificationError);
    }
  });
  test('rejects a signed event whose envelope carries no livemode', () => {
    const { livemode: _omitted, ...withoutMode } = EVENT;
    const raw = JSON.stringify(withoutMode);
    const timestamp = Math.floor(Date.now() / 1000);
    expect(() =>
      new WebhooksResource().constructEvent(raw, signWebhook(SECRET, raw, timestamp), SECRET),
    ).toThrow(PeableSignatureVerificationError);
  });
  test.each(['unknown.event', 'transfer.created', 'toString', '__proto__'])(
    'rejects signed unknown type %s',
    (type) => {
      const raw = JSON.stringify({ ...EVENT, type });
      const timestamp = Math.floor(Date.now() / 1000);
      expect(() =>
        new WebhooksResource().constructEvent(raw, signWebhook(SECRET, raw, timestamp), SECRET),
      ).toThrow(PeableSignatureVerificationError);
    },
  );
});
