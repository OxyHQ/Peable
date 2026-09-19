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
  externalRef: 'store_1',
  country: 'ES',
  defaultCurrency: 'EUR',
  payable: true,
  payoutsEnabled: true,
  chargesEnabled: true,
  transfersCapability: 'active',
  cardPaymentsCapability: 'active',
  requirements: { currentlyDue: 0, eventuallyDue: 0, pastDue: 0, pendingVerification: 0 },
  disabledReasonCodes: [],
  lastSyncedAt: '2026-09-19T00:00:00.000Z',
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
};

const TRANSFER: Transfer = {
  id: 'tr_1',
  object: 'transfer',
  externalRef: 'order_1',
  connectedAccountId: 'ca_1',
  paymentIntentId: 'pi_1',
  amount: '5000',
  currency: 'EUR',
  amountReversed: '0',
  status: 'paid',
  failureMessage: null,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
};

const REFUND: Refund = {
  id: 're_1',
  object: 'refund',
  externalRef: 'refund_1',
  origin: 'merchant',
  paymentIntentId: 'pi_1',
  amount: '2500',
  currency: 'EUR',
  status: 'succeeded',
  paymentStatus: 'partially_refunded',
  failureCode: null,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
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
  test('creates a seller account by the merchant\'s own reference', async () => {
    const { fetch: fetchImpl, requests } = gateway(ACCOUNT, 201);
    const resource = new ConnectedAccountsResource(buildTestClient(fetchImpl));

    const account = await resource.create({
      externalRef: 'store_1',
      country: 'es',
      businessType: 'individual',
    });

    expect(account).toEqual(ACCOUNT);
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/connected_accounts`);
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
      paymentIntentId: 'pi_1',
      connectedAccountId: 'ca_1',
      externalRef: 'order_1',
      amount: '5000',
    });

    expect(transfer).toEqual(TRANSFER);
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/transfers`);
  });

  /**
   * A reversal without an identity is refused HERE, before a request is made.
   *
   * An amount is not an identity: two reversals of one settlement for the same
   * amount are two operations. A gateway keyed by amount answers the first to
   * the second request, so the seller keeps money that was taken back — and
   * nothing records that it was asked for. Failing in the caller's own process
   * is the earliest this can be said.
   */
  test('refuses to reverse without an operation identity', () => {
    const { fetch: fetchImpl, requests } = gateway(TRANSFER, 201);
    const resource = new TransfersResource(buildTestClient(fetchImpl));

    expect(() => resource.reverse('tr_1', { amount: '500' })).toThrow(TypeError);
    // Nothing was sent.
    expect(requests).toHaveLength(0);
  });

  test('accepts the identity as an idempotency key or as an explicit ref', async () => {
    const withKey = gateway({ ...TRANSFER, reversal: {} }, 201);
    await new TransfersResource(buildTestClient(withKey.fetch)).reverse(
      'tr_1',
      { amount: '500' },
      { idempotencyKey: 'leg_a' },
    );
    const keyed = withKey.requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(keyed?.headers.get('Idempotency-Key')).toBe('leg_a');

    const withRef = gateway({ ...TRANSFER, reversal: {} }, 201);
    await new TransfersResource(buildTestClient(withRef.fetch)).reverse('tr_1', {
      amount: '500',
      externalRef: 'leg_b',
    });
    expect(callOf(withRef.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/transfers/tr_1/reversals`,
    );
  });
});

describe('RefundsResource', () => {
  test('refunds a payment and reports where the payment now stands', async () => {
    const { fetch: fetchImpl, requests } = gateway(REFUND, 201);
    const resource = new RefundsResource(buildTestClient(fetchImpl));

    const refund = await resource.create({
      paymentIntentId: 'pi_1',
      externalRef: 'refund_1',
      amount: '2500',
    });

    // `status` is the REFUND's lifecycle and `paymentStatus` is the payment's.
    // Two different questions on one response, so a caller needs no second read
    // whose answer can move on before it arrives.
    expect(refund.status).toBe('succeeded');
    expect(refund.paymentStatus).toBe('partially_refunded');
    expect(callOf(requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/refunds`);
  });

  test('lists refunds with what is still refundable', async () => {
    const { fetch: fetchImpl, requests } = gateway({
      object: 'list',
      data: [REFUND],
      remainingRefundable: '7500',
    });
    const resource = new RefundsResource(buildTestClient(fetchImpl));

    const list = await resource.listForPaymentIntent('pi_1');

    expect(list.remainingRefundable).toBe('7500');
    expect(callOf(requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/refunds`,
    );
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
      paymentIntentId: 'pi_1',
      status: 'unknown',
      gross: null,
      fee: null,
      net: null,
      currency: null,
      availableOn: null,
      exchangeRate: null,
    });
    const resource = new RefundsResource(buildTestClient(fetchImpl));

    const settlement = await resource.settlement('pi_1');

    expect(settlement.status).toBe('unknown');
    expect(settlement.fee).toBeNull();
    expect(settlement.net).toBeNull();
    expect(callOf(requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/settlement`,
    );
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
      uncategorizedText: 'Collected in person.',
      shippingTrackingNumber: 'TRACK-1',
    });

    const call = callOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/disputes/dp_1/evidence`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      uncategorizedText: 'Collected in person.',
      shippingTrackingNumber: 'TRACK-1',
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

    await resource.register();

    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/merchants`);
    expect(call?.body).toBe('{}');
  });

  test('disputes are read-only and scoped to one payment', async () => {
    const { fetch: fetchImpl, requests } = gateway({ object: 'list', data: [] });
    const resource = new DisputesResource(buildTestClient(fetchImpl));

    await resource.listForPaymentIntent('pi_1');

    expect(callOf(requests)?.method).toBe('GET');
    expect(callOf(requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/disputes`,
    );
  });
});
