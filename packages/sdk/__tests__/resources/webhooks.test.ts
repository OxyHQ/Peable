import { describe, expect, test } from 'bun:test';
import { signWebhook, type WebhookEvent, type WebhookEventPayload, type WebhookEventType, type Dispute, type ConnectedAccount } from '@peable.to/shared-types';
import { WebhooksResource } from '../../src/resources/webhooks';
import { PeableSignatureVerificationError } from '../../src/core/errors';

const SECRET = 'whsec_test_secret';
const TIMESTAMP = 1700000000;

const EVENT: WebhookEvent = {
  id: 'evt_1',
  object: 'event',
  type: 'payment_intent.settled',
  created: new Date(TIMESTAMP * 1000).toISOString(),
  data: {
    object: {
      id: 'pi_1',
      object: 'payment_intent',
      status: 'settled',
  rail: 'faircoin',
      amount: '100000',
      currency: 'FAIR',
      network: 'testnet',
      address: 'addr1',
      merchantId: 'merch_1',
      txid: 'tx1',
      confirmations: 6,
      clientSecret: 'pi_1_secret_x',
      metadata: {},
      expiresAt: new Date(TIMESTAMP * 1000).toISOString(),
      createdAt: new Date(TIMESTAMP * 1000).toISOString(),
      updatedAt: new Date(TIMESTAMP * 1000).toISOString(),
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
  id: 'dp_fixture', object: 'dispute', paymentIntentId: 'pi_1', amount: '100',
  currency: 'EUR', status: 'needs_response', reason: null, evidenceDueAt: null,
  evidenceSubmittedAt: null, createdAt: EVENT.created, updatedAt: EVENT.created,
};
const account: ConnectedAccount = {
  id: 'ca_fixture', object: 'connected_account', externalRef: 'store_fixture',
  country: 'ES', defaultCurrency: 'EUR', payable: false, payoutsEnabled: false,
  chargesEnabled: false, transfersCapability: 'pending', cardPaymentsCapability: null,
  requirements: { currentlyDue: 1, eventuallyDue: 1, pastDue: 0, pendingVerification: 0 },
  disabledReasonCodes: [], lastSyncedAt: null, createdAt: EVENT.created, updatedAt: EVENT.created,
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
} satisfies WebhookEventPayload;

describe('published event family parity', () => {
  for (const type of Object.keys(payloads) as WebhookEventType[]) {
    test(`accepts signed ${type} without replacing its resource`, () => {
      const expected = { id: `evt_${type}`, object: 'event', type, created: EVENT.created,
        data: { object: payloads[type] } };
      const raw = JSON.stringify(expected);
      const timestamp = Math.floor(Date.now() / 1000);
      const resource = new WebhooksResource();
      expect(JSON.stringify(resource.constructEvent(raw, signWebhook(SECRET, raw, timestamp), SECRET))).toBe(raw);
      expect(() => resource.constructEvent(raw, signWebhook('wrong', raw, timestamp), SECRET)).toThrow(PeableSignatureVerificationError);
      expect(() => resource.constructEvent(raw, signWebhook(SECRET, raw, timestamp - 301), SECRET)).toThrow(PeableSignatureVerificationError);
      expect(() => resource.constructEvent(raw, signWebhook(SECRET, raw, timestamp + 301), SECRET)).toThrow(PeableSignatureVerificationError);
    });
  }
  test.each(['unknown.event', 'transfer.created', 'toString', '__proto__'])('rejects signed unknown type %s', type => {
    const raw = JSON.stringify({ ...EVENT, type });
    const timestamp = Math.floor(Date.now() / 1000);
    expect(() => new WebhooksResource().constructEvent(raw, signWebhook(SECRET, raw, timestamp), SECRET)).toThrow(PeableSignatureVerificationError);
  });
});
