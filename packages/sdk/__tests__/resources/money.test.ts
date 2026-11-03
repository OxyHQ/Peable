/**
 * Connect & money (ADR 0015): the merchant's own account, its onboarding link,
 * the balance and its ledger, payouts, application fees, the payout
 * reconciliation report and the refund additions.
 *
 * Each case asserts the ROUTE (method, path, query, body) and the
 * `Peable-Account` header — the half an integrator would otherwise guess, and
 * the half whose mistake moves money for the wrong account.
 */
import { describe, expect, test } from 'bun:test';
import { Peable } from '../../src';
import { AccountResource } from '../../src/resources/account';
import { ApplicationFeesResource } from '../../src/resources/applicationFees';
import { BalanceResource, BalanceTransactionsResource } from '../../src/resources/balance';
import {
  AccountLinksResource,
  ConnectedAccountsResource,
} from '../../src/resources/connectedAccounts';
import { PayoutsResource } from '../../src/resources/payouts';
import { RefundsResource } from '../../src/resources/refunds';
import { ReportsResource } from '../../src/resources/reports';
import { PeableInvalidRequestError } from '../../src/core/errors';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  accountFixture,
  applicationFeeFixture,
  balanceFixture,
  balanceTransactionFixture,
  payoutFixture,
  payoutReconciliationFixture,
  refundFixture,
} from '../support/moneyFixtures';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

function gateway(body: unknown, status = 200) {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return { status, json: body };
  });
}

function callsOf(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter((r) => !r.url.includes('/auth/service-token'));
}

function callOf(requests: CapturedRequest[]): CapturedRequest {
  const call = callsOf(requests)[0];
  if (!call) throw new Error('no gateway call was made');
  return call;
}

function bodyOf(request: CapturedRequest): unknown {
  return request.body === undefined ? undefined : JSON.parse(request.body);
}

function list<T>(data: T[], has_more = false, url = '/v1/x') {
  return { object: 'list', data, has_more, url };
}

describe('Peable — the money namespaces', () => {
  test('are wired on the client', () => {
    const peable = new Peable({ publicKey: 'oxy_dk_test', secret: 'sk_test' });
    expect(peable.account).toBeInstanceOf(AccountResource);
    expect(peable.balance).toBeInstanceOf(BalanceResource);
    expect(peable.balanceTransactions).toBeInstanceOf(BalanceTransactionsResource);
    expect(peable.payouts).toBeInstanceOf(PayoutsResource);
    expect(peable.applicationFees).toBeInstanceOf(ApplicationFeesResource);
    expect(peable.reports).toBeInstanceOf(ReportsResource);
    expect(peable.accountLinks).toBeInstanceOf(AccountLinksResource);
  });
});

describe('Peable-Account', () => {
  test('is sent only when the caller names a connected account', async () => {
    const own = gateway(accountFixture());
    await new AccountResource(buildTestClient(own.fetch)).retrieve();
    expect(callOf(own.requests).headers.get('Peable-Account')).toBeNull();

    const seller = gateway(accountFixture({ id: 'ca_seller', type: 'connected' }));
    await new AccountResource(buildTestClient(seller.fetch)).retrieve({
      peableAccount: 'ca_seller',
    });
    expect(callOf(seller.requests).headers.get('Peable-Account')).toBe('ca_seller');
  });
});

describe('account', () => {
  test('retrieves the merchant account', async () => {
    const { fetch: fetchImpl, requests } = gateway(accountFixture());
    const account = await new AccountResource(buildTestClient(fetchImpl)).retrieve();

    expect(account.requirements.currently_due).toEqual([]);
    const call = callOf(requests);
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${TEST_GATEWAY_URL}/v1/account`);
  });

  test('a merchant without a fiat account is account_missing, not an empty account', async () => {
    const { fetch: fetchImpl } = gateway(
      {
        error: {
          type: 'invalid_request_error',
          code: 'account_missing',
          message: 'No fiat account',
        },
      },
      404,
    );
    const error = await new AccountResource(buildTestClient(fetchImpl))
      .retrieve()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PeableInvalidRequestError);
    expect((error as PeableInvalidRequestError).code).toBe('account_missing');
  });

  test('opens or updates the account with the payout schedule in the body', async () => {
    const { fetch: fetchImpl, requests } = gateway(accountFixture(), 201);
    await new AccountResource(buildTestClient(fetchImpl)).update(
      {
        country: 'ES',
        business_type: 'company',
        settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'friday' } } },
      },
      { peableAccount: 'ca_seller', idempotencyKey: 'open_ca_seller' },
    );

    const call = callOf(requests);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${TEST_GATEWAY_URL}/v1/account`);
    expect(bodyOf(call)).toEqual({
      country: 'ES',
      business_type: 'company',
      settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'friday' } } },
    });
    expect(call.headers.get('Peable-Account')).toBe('ca_seller');
    expect(call.headers.get('Idempotency-Key')).toBe('open_ca_seller');
  });
});

describe('accountLinks', () => {
  const link = {
    object: 'account_link',
    livemode: false,
    url: 'https://connect.example/onboard',
    expires_at: 1792112400,
  };

  test("without `account`, onboards the merchant's own account", async () => {
    const { fetch: fetchImpl, requests } = gateway(link, 201);
    // Wired as `Peable` wires it, against the injected fetch.
    const client = buildTestClient(fetchImpl);
    const links = new AccountLinksResource(
      new ConnectedAccountsResource(client),
      new AccountResource(client),
    );

    const created = await links.create(
      {
        return_url: 'https://orbit.example/account',
        refresh_url: 'https://orbit.example/account?refresh=1',
        type: 'account_onboarding',
      },
      { peableAccount: 'ca_seller' },
    );

    expect(created.url).toBe('https://connect.example/onboard');
    const call = callOf(requests);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${TEST_GATEWAY_URL}/v1/account_links`);
    expect(bodyOf(call)).toEqual({
      return_url: 'https://orbit.example/account',
      refresh_url: 'https://orbit.example/account?refresh=1',
      type: 'account_onboarding',
    });
    expect(call.headers.get('Peable-Account')).toBe('ca_seller');
  });

  test('with `account`, still onboards that seller through its own route', async () => {
    const { fetch: fetchImpl, requests } = gateway(link, 201);
    const client = buildTestClient(fetchImpl);
    await new AccountLinksResource(
      new ConnectedAccountsResource(client),
      new AccountResource(client),
    ).create({
      account: 'ca_seller',
      return_url: 'https://m.example/done',
      refresh_url: 'https://m.example/refresh',
    });
    expect(callOf(requests).url).toBe(
      `${TEST_GATEWAY_URL}/v1/connected_accounts/ca_seller/account_links`,
    );
  });

  test('refuses a merchant link when built without an AccountResource', async () => {
    const { fetch: fetchImpl, requests } = gateway(link, 201);
    const links = new AccountLinksResource(
      new ConnectedAccountsResource(buildTestClient(fetchImpl)),
    );
    await expect(
      links.create({ return_url: 'https://m.example/r', refresh_url: 'https://m.example/f' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(callsOf(requests)).toHaveLength(0);
  });
});

describe('balance', () => {
  test('retrieves available, pending and informational funds', async () => {
    const { fetch: fetchImpl, requests } = gateway(balanceFixture());
    const balance = await new BalanceResource(buildTestClient(fetchImpl)).retrieve({
      peableAccount: 'ca_seller',
    });

    expect(balance.informational[0]?.currency).toBe('FAIR');
    const call = callOf(requests);
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${TEST_GATEWAY_URL}/v1/balance`);
    expect(call.headers.get('Peable-Account')).toBe('ca_seller');
  });
});

describe('balanceTransactions', () => {
  test('retrieves one by id', async () => {
    const { fetch: fetchImpl, requests } = gateway(balanceTransactionFixture());
    await new BalanceTransactionsResource(buildTestClient(fetchImpl)).retrieve('txn_1');
    expect(callOf(requests).url).toBe(`${TEST_GATEWAY_URL}/v1/balance_transactions/txn_1`);
  });

  test('lists with filters and carries Peable-Account onto every page', async () => {
    let page = 0;
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      page += 1;
      return page === 1
        ? { status: 200, json: list([balanceTransactionFixture({ id: 'txn_2' })], true) }
        : { status: 200, json: list([balanceTransactionFixture({ id: 'txn_1' })], false) };
    });
    const resource = new BalanceTransactionsResource(buildTestClient(fetchImpl));

    const all = await resource
      .list(
        { type: 'payout', payout: 'po_1', source: 'ch_1', currency: 'eur', limit: 1 },
        { peableAccount: 'ca_seller' },
      )
      .autoPagingToArray({ limit: 10 });

    expect(all.map((t) => t.id)).toEqual(['txn_2', 'txn_1']);
    const [first, second] = callsOf(requests);
    expect(first?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/balance_transactions?limit=1&type=payout&payout=po_1&source=ch_1&currency=eur`,
    );
    expect(second?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/balance_transactions?limit=1&starting_after=txn_2&type=payout&payout=po_1&source=ch_1&currency=eur`,
    );
    expect(first?.headers.get('Peable-Account')).toBe('ca_seller');
    expect(second?.headers.get('Peable-Account')).toBe('ca_seller');
  });
});

describe('payouts', () => {
  test('creates a manual payout with the instruction in the body', async () => {
    const { fetch: fetchImpl, requests } = gateway(payoutFixture(), 201);
    const payout = await new PayoutsResource(buildTestClient(fetchImpl)).create(
      { amount: '10000', currency: 'EUR', description: 'Weekly' },
      { idempotencyKey: 'payout_week_45', peableAccount: 'ca_seller' },
    );

    expect(payout.status).toBe('pending');
    const call = callOf(requests);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${TEST_GATEWAY_URL}/v1/payouts`);
    expect(bodyOf(call)).toEqual({ amount: '10000', currency: 'EUR', description: 'Weekly' });
    expect(call.headers.get('Idempotency-Key')).toBe('payout_week_45');
    expect(call.headers.get('Peable-Account')).toBe('ca_seller');
  });

  test('mints an idempotency key when the caller gives none', async () => {
    const { fetch: fetchImpl, requests } = gateway(payoutFixture(), 201);
    await new PayoutsResource(buildTestClient(fetchImpl)).create({
      amount: '10000',
      currency: 'EUR',
    });
    expect(callOf(requests).headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('retrieves, lists by status and cancels', async () => {
    const one = gateway(payoutFixture());
    await new PayoutsResource(buildTestClient(one.fetch)).retrieve('po_1');
    expect(callOf(one.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/payouts/po_1`);

    const page = gateway(list([payoutFixture()]));
    await new PayoutsResource(buildTestClient(page.fetch)).list(
      { status: 'pending', limit: 5 },
      { peableAccount: 'ca_seller' },
    );
    expect(callOf(page.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/payouts?limit=5&status=pending`);
    expect(callOf(page.requests).headers.get('Peable-Account')).toBe('ca_seller');

    const canceled = gateway(payoutFixture({ status: 'canceled' }));
    const result = await new PayoutsResource(buildTestClient(canceled.fetch)).cancel('po_1');
    expect(result.status).toBe('canceled');
    expect(callOf(canceled.requests).method).toBe('POST');
    expect(callOf(canceled.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/payouts/po_1/cancel`);
    expect(callOf(canceled.requests).body).toBeUndefined();
  });
});

describe('applicationFees', () => {
  test('retrieves, lists by payment and lists refunds', async () => {
    const one = gateway(applicationFeeFixture());
    await new ApplicationFeesResource(buildTestClient(one.fetch)).retrieve('fee_1');
    expect(callOf(one.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/application_fees/fee_1`);

    const page = gateway(list([applicationFeeFixture()]));
    await new ApplicationFeesResource(buildTestClient(page.fetch)).list({
      payment_intent: 'pi_1',
      charge: 'ch_1',
    });
    expect(callOf(page.requests).url).toBe(
      `${TEST_GATEWAY_URL}/v1/application_fees?payment_intent=pi_1&charge=ch_1`,
    );

    const refunds = gateway(list([]));
    await new ApplicationFeesResource(buildTestClient(refunds.fetch)).listRefunds('fee_1', {
      limit: 3,
    });
    expect(callOf(refunds.requests).url).toBe(
      `${TEST_GATEWAY_URL}/v1/application_fees/fee_1/refunds?limit=3`,
    );
  });
});

describe('reports.payoutReconciliation', () => {
  test('reads the report for one payout, with its summary beside the page', async () => {
    const { fetch: fetchImpl, requests } = gateway(payoutReconciliationFixture());
    const report = await new ReportsResource(buildTestClient(fetchImpl)).payoutReconciliation(
      { payout: 'po_1', limit: 50 },
      { peableAccount: 'ca_seller' },
    );

    expect(report.summary).toEqual({ count: 1, amount: '2500', fee: '105', net: '2395' });
    expect(report.data[0]?.payout).toBe('po_1');
    const call = callOf(requests);
    expect(call.url).toBe(
      `${TEST_GATEWAY_URL}/v1/reports/payout_reconciliation?limit=50&payout=po_1`,
    );
    expect(call.headers.get('Peable-Account')).toBe('ca_seller');
  });
});

describe('refunds — Connect & money additions', () => {
  test('creates with reason, metadata and the Connect reversals', async () => {
    const { fetch: fetchImpl, requests } = gateway(refundFixture(), 201);
    await new RefundsResource(buildTestClient(fetchImpl)).create({
      payment_intent: 'pi_1',
      external_ref: 'refund_1',
      amount: '2500',
      reason: 'requested_by_customer',
      metadata: { ticket: 'T-1' },
      refund_application_fee: true,
      reverse_transfer: true,
    });
    expect(bodyOf(callOf(requests))).toEqual({
      payment_intent: 'pi_1',
      external_ref: 'refund_1',
      amount: '2500',
      reason: 'requested_by_customer',
      metadata: { ticket: 'T-1' },
      refund_application_fee: true,
      reverse_transfer: true,
    });
  });

  test('retrieves, updates metadata and cancels', async () => {
    const one = gateway(refundFixture());
    await new RefundsResource(buildTestClient(one.fetch)).retrieve('re_1');
    expect(callOf(one.requests).method).toBe('GET');
    expect(callOf(one.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/refunds/re_1`);

    const updated = gateway(refundFixture({ metadata: { ticket: 'T-2' } }));
    await new RefundsResource(buildTestClient(updated.fetch)).update('re_1', {
      metadata: { ticket: 'T-2' },
    });
    expect(callOf(updated.requests).method).toBe('POST');
    expect(callOf(updated.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/refunds/re_1`);
    expect(bodyOf(callOf(updated.requests))).toEqual({ metadata: { ticket: 'T-2' } });

    const canceled = gateway(refundFixture({ status: 'canceled' }));
    const refund = await new RefundsResource(buildTestClient(canceled.fetch)).cancel('re_1');
    expect(refund.status).toBe('canceled');
    expect(callOf(canceled.requests).method).toBe('POST');
    expect(callOf(canceled.requests).url).toBe(`${TEST_GATEWAY_URL}/v1/refunds/re_1/cancel`);
  });
});
