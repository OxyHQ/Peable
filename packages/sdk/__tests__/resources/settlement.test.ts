/**
 * The namespaces this SDK did not have.
 *
 * It published four — intents, links, checkout and webhooks — while the gateway
 * has always served merchants, connected accounts, refunds, transfers and
 * disputes too. So every integrator reaching those wrote their own HTTP client
 * and their own partial types for responses this package already knew, which is
 * how one wire format came to have two descriptions in two repositories with
 * nothing comparing them.
 *
 * These cases assert the ROUTES and the shapes, because that is the half an
 * integrator would otherwise have had to guess.
 */
import { describe, expect, test } from 'bun:test';
import type { ConnectedAccount, Refund, Transfer } from '@peable.to/shared-types';
import { ConnectedAccountsResource } from '../../src/resources/connectedAccounts';
import { RefundsResource } from '../../src/resources/refunds';
import { TransfersResource } from '../../src/resources/transfers';
import { DisputesResource, MerchantsResource } from '../../src/resources/merchants';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const ACCOUNT: ConnectedAccount = {
  id: 'ca_1',
  object: 'connected_account',
  livemode: false,
  external_ref: 'store_1',
  rails: ['card'],
  faircoin: null,
  country: 'ES',
  default_currency: 'EUR',
  payable: true,
  payouts_enabled: true,
  charges_enabled: true,
  transfers_capability: 'active',
  card_payments_capability: 'active',
  requirements: { currently_due: 0, eventually_due: 0, past_due: 0, pending_verification: 0 },
  disabled_reason_codes: [],
  last_synced_at: 1789776000,
  created: 1789776000,
  updated_at: 1789776000,
};

const TRANSFER: Transfer = {
  id: 'tr_1',
  object: 'transfer',
  livemode: false,
  external_ref: 'order_1',
  connected_account: 'ca_1',
  payment_intent: 'pi_1',
  amount: '5000',
  currency: 'EUR',
  amount_reversed: '0',
  status: 'paid',
  failure_message: null,
  created: 1789776000,
  updated_at: 1789776000,
};

const REFUND: Refund = {
  id: 're_1',
  object: 'refund',
  livemode: false,
  external_ref: 'refund_1',
  origin: 'merchant',
  payment_intent: 'pi_1',
  amount: '2500',
  currency: 'EUR',
  status: 'succeeded',
  failure_code: null,
  created: 1789776000,
  updated_at: 1789776000,
};

function gateway(body: unknown, status = 200) {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return { status, json: body };
  });
}

/** The one request that is not the service-token mint. */
function callOf(requests: CapturedRequest[]): CapturedRequest | undefined {
  return requests.find((r) => !r.url.includes('/auth/service-token'));
}

describe('ConnectedAccountsResource', () => {
  test("creates a seller account by the merchant's own reference", async () => {
    const { fetch: fetchImpl, requests } = gateway(ACCOUNT, 201);
    const resource = new ConnectedAccountsResource(buildTestClient(fetchImpl));

    const account = await resource.create({
      external_ref: 'store_1',
      country: 'es',
      business_type: 'individual',
    });

    expect(account).toEqual(ACCOUNT);
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/connected_accounts`);
    expect(JSON.parse(callOf(requests)?.body ?? '{}')).toEqual({
      external_ref: 'store_1',
      country: 'es',
      business_type: 'individual',
    });
    // The provider's own account id is on NO shape this SDK publishes — ADR
    // 0001 D3, and a reviewer should be able to check it by what is absent.
    expect(JSON.stringify(account)).not.toContain('acct_');
  });

  test('pages with a cursor', async () => {
    const { fetch: fetchImpl, requests } = gateway({
      object: 'list',
      data: [ACCOUNT],
      has_more: true,
    });
    const resource = new ConnectedAccountsResource(buildTestClient(fetchImpl));

    const page = await resource.list({ limit: 2, starting_after: 'ca_0' });

    expect(page.has_more).toBe(true);
    expect(callOf(requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/connected_accounts?limit=2&starting_after=ca_0`,
    );
  });

  /**
   * The RECOVERY read. A merchant whose create response never arrived does not
   * have the `ca_…` and does have the reference they chose.
   */
  test('reads a seller back by the reference the merchant chose', async () => {
    const { fetch: fetchImpl, requests } = gateway(ACCOUNT);
    const resource = new ConnectedAccountsResource(buildTestClient(fetchImpl));

    await resource.retrieveByRef('store 1/a');

    // Encoded, so a reference containing a slash addresses one account rather
    // than a path that does not exist.
    expect(callOf(requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/connected_accounts/by_ref/store%201%2Fa`,
    );
  });
});

describe('TransfersResource', () => {
  test('settles a seller out of a payment', async () => {
    const { fetch: fetchImpl, requests } = gateway(TRANSFER, 201);
    const resource = new TransfersResource(buildTestClient(fetchImpl));

    const transfer = await resource.create({
      payment_intent: 'pi_1',
      connected_account: 'ca_1',
      external_ref: 'order_1',
      amount: '5000',
    });

    expect(transfer).toEqual(TRANSFER);
    expect(JSON.parse(callOf(requests)?.body ?? '{}')).toEqual({
      payment_intent: 'pi_1',
      connected_account: 'ca_1',
      external_ref: 'order_1',
      amount: '5000',
    });
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/transfers`);
  });

  /**
   * A reversal's identity is its `external_ref`, in the body — and the
   * `Idempotency-Key` is a separate thing beside it.
   *
   * An amount is not an identity: two reversals of one settlement for the same
   * amount are two operations, and only the ref tells them apart for as long as
   * they exist. The key is the 24-hour request-retry layer; this client mints
   * one per call, so it could never stand in for the ref.
   */
  test('sends the external_ref in the body and a request key beside it', async () => {
    const minted = gateway({ ...TRANSFER, reversal: {} }, 201);
    await new TransfersResource(buildTestClient(minted.fetch)).reverse('tr_1', {
      amount: '500',
      external_ref: 'leg_b',
    });
    const call = callOf(minted.requests);
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/transfers/tr_1/reversals`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ amount: '500', external_ref: 'leg_b' });
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);

    const keyed = gateway({ ...TRANSFER, reversal: {} }, 201);
    await new TransfersResource(buildTestClient(keyed.fetch)).reverse(
      'tr_1',
      { amount: '500', external_ref: 'leg_a' },
      { idempotencyKey: 'req_leg_a' },
    );
    expect(callOf(keyed.requests)?.headers.get('Idempotency-Key')).toBe('req_leg_a');
  });
});

describe('RefundsResource', () => {
  test('refunds a payment and reports where the payment now stands', async () => {
    const { fetch: fetchImpl, requests } = gateway(REFUND, 201);
    const resource = new RefundsResource(buildTestClient(fetchImpl));

    const refund = await resource.create({
      payment_intent: 'pi_1',
      external_ref: 'refund_1',
      amount: '2500',
    });
    expect(JSON.parse(callOf(requests)?.body ?? '{}')).toEqual({
      payment_intent: 'pi_1',
      external_ref: 'refund_1',
      amount: '2500',
    });

    // `status` is the REFUND's lifecycle; the payment does not change status
    // with a refund (ADR 0019), so the response carries no payment status.
    expect(refund.status).toBe('succeeded');
    expect('payment_status' in refund).toBe(false);
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/refunds`);
  });

  test('lists refunds with what is still refundable', async () => {
    const { fetch: fetchImpl, requests } = gateway({
      object: 'list',
      data: [REFUND],
      remaining_refundable: '7500',
    });
    const resource = new RefundsResource(buildTestClient(fetchImpl));

    const list = await resource.listForPaymentIntent('pi_1');

    expect(list.remaining_refundable).toBe('7500');
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/refunds`);
  });
});

describe('settlement reporting', () => {
  /**
   * `unknown` is a FIGURE-LESS answer, not a zero one.
   *
   * The distinction is the whole reason the shape is nullable: a report that
   * renders a not-yet-known fee as `0` is one a merchant reconciles against and
   * cannot explain, and zero is a number somebody will subtract.
   */
  test('carries nulls with a status rather than zeros', async () => {
    const { fetch: fetchImpl, requests } = gateway({
      object: 'settlement',
      livemode: false,
      payment_intent: 'pi_1',
      status: 'unknown',
      gross: null,
      fee: null,
      net: null,
      currency: null,
      available_on: null,
      exchange_rate: null,
    });
    const resource = new RefundsResource(buildTestClient(fetchImpl));

    const settlement = await resource.settlement('pi_1');

    expect(settlement.status).toBe('unknown');
    expect(settlement.fee).toBeNull();
    expect(settlement.net).toBeNull();
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/settlement`);
  });
});

describe('MerchantsResource and DisputesResource', () => {
  /**
   * Answering a dispute is ONE SHOT — submitting is one-way at the card
   * network — so everything the merchant has goes in the first call.
   */
  test('submits dispute evidence as text, to the dispute itself', async () => {
    const { fetch: fetchImpl, requests } = gateway({ id: 'dp_1', object: 'dispute' }, 201);
    const resource = new DisputesResource(buildTestClient(fetchImpl));

    await resource.submitEvidence('dp_1', {
      uncategorized_text: 'Collected in person.',
      shipping_tracking_number: 'TRACK-1',
    });

    const call = callOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/disputes/dp_1/evidence`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      uncategorized_text: 'Collected in person.',
      shipping_tracking_number: 'TRACK-1',
    });
  });

  /**
   * A CARD-ONLY merchant registers with no chain fields at all. They used to be
   * required, so a merchant who only wanted a card form had to supply a
   * watch-only key for a chain they never intended to use.
   */
  test('registers a card-only merchant with an empty body', async () => {
    const { fetch: fetchImpl, requests } = gateway({ id: 'merch_1' }, 201);
    const resource = new MerchantsResource(buildTestClient(fetchImpl));

    await resource.register({}, { idempotencyKey: 'merchant-registration-stable' });

    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/merchants`);
    expect(call?.body).toBe('{}');
    expect(new Headers(call?.headers).get('Idempotency-Key')).toBe('merchant-registration-stable');
  });

  test('disputes are read-only and scoped to one payment', async () => {
    const { fetch: fetchImpl, requests } = gateway({ object: 'list', data: [] });
    const resource = new DisputesResource(buildTestClient(fetchImpl));

    await resource.listForPaymentIntent('pi_1');

    expect(callOf(requests)?.method).toBe('GET');
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/disputes`);
  });
});
