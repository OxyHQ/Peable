import { describe, expect, test } from 'bun:test';
import {
  signWebhook,
  type WebhookEvent,
  type WebhookEventPayload,
  type WebhookEventType,
  type Dispute,
  type ConnectedAccount,
} from '@peable.to/shared-types';
import { WebhooksResource } from '../../src/resources/webhooks';
import { PeableSignatureVerificationError } from '../../src/core/errors';

const SECRET = 'whsec_test_secret';
const TIMESTAMP = 1700000000;

const EVENT: WebhookEvent = {
  id: 'evt_1',
  object: 'event',
  livemode: false,
  type: 'payment_intent.settled',
  created: TIMESTAMP,
  data: {
    object: {
      id: 'pi_1',
      object: 'payment_intent',
      livemode: false,
      status: 'settled',
      rail: 'faircoin',
      amount: '100000',
      currency: 'FAIR',
      network: 'testnet',
      address: 'addr1',
      merchant_id: 'merch_1',
      connected_account: null,
      txid: 'tx1',
      confirmations: 6,
      client_secret: 'pi_1_secret_x',
      metadata: {},
      expires_at: TIMESTAMP,
      created: TIMESTAMP,
      updated_at: TIMESTAMP,
    },
  },
};

const RAW_BODY = JSON.stringify(EVENT);

describe('WebhooksResource.constructEvent', () => {
  test('verifies a payload signed by shared-types signWebhook and returns the typed event', () => {
    const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
    const resource = new WebhooksResource();

    // Freeze "now" close to the signed timestamp so it is within tolerance.
    const event = resource.constructEvent(RAW_BODY, header, SECRET, {
      // Explicit generous tolerance since the real clock has moved on since
      // the fixed TIMESTAMP above.
      toleranceSec: Number.MAX_SAFE_INTEGER,
    });

    expect(event).toEqual(EVENT);
  });

  test('rejects a tampered body', () => {
    const header = signWebhook(SECRET, RAW_BODY, TIMESTAMP);
    const tampered = JSON.stringify({ ...EVENT, id: 'evt_evil' });
    const resource = new WebhooksResource();

    expect(() =>
      resource.constructEvent(tampered, header, SECRET, { toleranceSec: Number.MAX_SAFE_INTEGER }),
    ).toThrow(PeableSignatureVerificationError);
  });

  test('rejects a signature produced with the wrong secret', () => {
    const header = signWebhook('whsec_wrong', RAW_BODY, TIMESTAMP);
    const resource = new WebhooksResource();

    expect(() =>
      resource.constructEvent(RAW_BODY, header, SECRET, { toleranceSec: Number.MAX_SAFE_INTEGER }),
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

  test('respects a custom toleranceSec', () => {
    const timestamp = Math.floor(Date.now() / 1000) - 120;
    const header = signWebhook(SECRET, RAW_BODY, timestamp);
    const resource = new WebhooksResource();

    expect(() => resource.constructEvent(RAW_BODY, header, SECRET, { toleranceSec: 60 })).toThrow(
      PeableSignatureVerificationError,
    );
    expect(() =>
      resource.constructEvent(RAW_BODY, header, SECRET, { toleranceSec: 300 }),
    ).not.toThrow();
  });

  test('rejects a signature-valid but non-JSON body', () => {
    const rawBody = 'not json';
    const header = signWebhook(SECRET, rawBody, TIMESTAMP);
    const resource = new WebhooksResource();

    expect(() =>
      resource.constructEvent(rawBody, header, SECRET, { toleranceSec: Number.MAX_SAFE_INTEGER }),
    ).toThrow(PeableSignatureVerificationError);
  });

  test('rejects a signature-valid JSON body that does not match the event shape', () => {
    const rawBody = JSON.stringify({ hello: 'world' });
    const header = signWebhook(SECRET, rawBody, TIMESTAMP);
    const resource = new WebhooksResource();

    expect(() =>
      resource.constructEvent(rawBody, header, SECRET, { toleranceSec: Number.MAX_SAFE_INTEGER }),
    ).toThrow(PeableSignatureVerificationError);
  });

  test('rejects a malformed signature header', () => {
    const resource = new WebhooksResource();

    expect(() => resource.constructEvent(RAW_BODY, 'not-a-signature', SECRET)).toThrow(
      PeableSignatureVerificationError,
    );
  });
});

// Full published payloads, matching backend intentTransition's three producers.
const dispute: Dispute = {
  id: 'dp_fixture',
  object: 'dispute',
  livemode: false,
  payment_intent: 'pi_1',
  amount: '100',
  currency: 'EUR',
  status: 'needs_response',
  reason: null,
  evidence_due_at: null,
  evidence_submitted_at: null,
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
  requirements: { currently_due: 1, eventually_due: 1, past_due: 0, pending_verification: 0 },
  disabled_reason_codes: [],
  last_synced_at: null,
  created: EVENT.created,
  updated_at: EVENT.created,
};
const payloads = {
  'payment_intent.confirming': EVENT.data.object,
  'payment_intent.settled': EVENT.data.object,
  'payment_intent.failed': EVENT.data.object,
  'payment_intent.rejected': EVENT.data.object,
  'payment_intent.expired': EVENT.data.object,
  'payment_intent.refunded': EVENT.data.object,
  'payment_intent.partially_refunded': EVENT.data.object,
  'payment_intent.disputed': dispute,
  'payment_intent.dispute_closed': { ...dispute, status: 'won' },
  'connected_account.updated': account,
  'billing.observation.updated': {
    object: 'billing_observation',
    livemode: false,
    resource_kind: 'invoice',
    resource_id: 'in_fixture',
    revision: 1,
    observed_at: EVENT.created,
  },
} satisfies WebhookEventPayload;

describe('published event family parity', () => {
  for (const type of Object.keys(payloads) as WebhookEventType[]) {
    test(`accepts signed ${type} without replacing its resource`, () => {
      const expected = {
        id: `evt_${type}`,
        object: 'event',
        livemode: false,
        type,
        created: EVENT.created,
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

test('rejects signed malformed recurring wake-ups rather than treating them as paid evidence', () => {
  const timestamp = Math.floor(Date.now() / 1000);
  for (const mutation of [
    { revision: 0 },
    { revision: 1.5 },
    { resource_kind: 'payer' },
    { resource_id: '' },
    { subscription_id: '' },
    { subscription_id: 42 },
    { subscription_id: 'sub_unsafe/path' },
    { observed_at: '2026-10-01T00:00:00Z' },
    { observed_at: 1.5 },
    { amount_paid: '2999' },
    { resourceKind: 'invoice' },
    // A wake-up must name the same mode as its envelope (ADR 0017).
    { livemode: true },
    { livemode: undefined },
  ]) {
    const raw = JSON.stringify({
      id: 'evt_fixture',
      object: 'event',
      livemode: false,
      type: 'billing.observation.updated',
      created: EVENT.created,
      data: { object: { ...payloads['billing.observation.updated'], ...mutation } },
    });
    expect(() =>
      new WebhooksResource().constructEvent(raw, signWebhook(SECRET, raw, timestamp), SECRET),
    ).toThrow(PeableSignatureVerificationError);
  }
});

test('accepts an optional signed subscription hint without requiring it on older deliveries', () => {
  const timestamp = Math.floor(Date.now() / 1000);
  for (const hint of [undefined, 'sub_owned']) {
    const raw = JSON.stringify({
      ...EVENT,
      type: 'billing.observation.updated',
      data: {
        object: {
          ...payloads['billing.observation.updated'],
          ...(hint ? { subscription_id: hint } : {}),
        },
      },
    });
    const event = new WebhooksResource().constructEvent(
      raw,
      signWebhook(SECRET, raw, timestamp),
      SECRET,
    );
    expect(event.data.object).toMatchObject(payloads['billing.observation.updated']);
  }
});
