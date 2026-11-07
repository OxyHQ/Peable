import { beforeEach, describe, expect, it } from 'bun:test';
import {
  assertList,
  createDashboardApi,
  dashboardPath,
  isAccountMissing,
  isMerchantMissing,
  type DashboardScope,
} from './dashboard';
import {
  OrbitApiError,
  type HttpMethod,
  type OrbitTransport,
  type RequestOptions,
} from './transport';

const scope: DashboardScope = { applicationId: 'app 1', environment: 'development' };
const live: DashboardScope = { applicationId: 'app_live', environment: 'production' };

type Call = { method: HttpMethod; path: string; options?: RequestOptions };
let calls: Call[] = [];
let answer: (call: Call) => unknown = () => undefined;

const transport: OrbitTransport = {
  async request<T>(method: HttpMethod, path: string, options?: RequestOptions) {
    const call = { method, path, ...(options ? { options } : {}) };
    calls.push(call);
    return answer(call) as T;
  },
};
const api = createDashboardApi(transport);

beforeEach(() => {
  calls = [];
  answer = () => undefined;
});

describe('dashboardPath', () => {
  it('scopes every path to the application and the environment', () => {
    expect(dashboardPath(scope, '/merchant')).toBe(
      '/v1/dashboard/applications/app%201/merchant?environment=development',
    );
  });

  it('adds defined query values after the environment', () => {
    expect(
      dashboardPath(live, '/payment_intents', {
        status: 'succeeded',
        limit: 25,
        starting_after: undefined,
      }),
    ).toBe(
      '/v1/dashboard/applications/app_live/payment_intents?environment=production&status=succeeded&limit=25',
    );
  });
});

describe('assertList', () => {
  it('accepts a list envelope and normalises has_more', () => {
    expect(assertList({ object: 'list', data: [1] })).toEqual({
      object: 'list',
      data: [1],
      has_more: false,
      url: '',
    });
    expect(assertList({ object: 'list', data: [], has_more: true, url: '/v1/x' }).url).toBe(
      '/v1/x',
    );
  });

  it('refuses a bare array or an error body rather than showing an empty list', () => {
    expect(() => assertList([])).toThrow('not a list');
    expect(() => assertList({ error: { message: 'nope' } })).toThrow('not a list');
  });
});

describe('payment intents', () => {
  it('lists with the status filter and the cursor', async () => {
    answer = () => ({ object: 'list', data: [{ id: 'pi_2' }], has_more: true });
    const page = await api.paymentIntents.list(scope, {
      status: 'canceled',
      limit: 20,
      starting_after: 'pi_1',
    });
    expect(page.has_more).toBe(true);
    expect(page.data).toEqual([{ id: 'pi_2' } as never]);
    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/v1/dashboard/applications/app%201/payment_intents?environment=development&status=canceled&limit=20&starting_after=pi_1',
      },
    ]);
  });

  it('retrieves one by its public id', async () => {
    answer = () => ({ id: 'pi_1' });
    await api.paymentIntents.retrieve(live, 'pi_1');
    expect(calls[0]?.path).toBe(
      '/v1/dashboard/applications/app_live/payment_intents/pi_1?environment=production',
    );
  });
});

describe('webhook deliveries', () => {
  it('lists a page and redelivers by id with a POST', async () => {
    answer = (call) =>
      call.method === 'GET' ? { object: 'list', data: [], has_more: false } : { id: 'wd_1' };
    await api.webhookDeliveries.list(scope, { starting_after: 'wd_0' });
    await api.webhookDeliveries.redeliver(scope, 'wd/1');
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      [
        'GET',
        '/v1/dashboard/applications/app%201/webhook_deliveries?environment=development&starting_after=wd_0',
      ],
      [
        'POST',
        '/v1/dashboard/applications/app%201/webhook_deliveries/wd%2F1/redeliver?environment=development',
      ],
    ]);
  });
});

describe('webhook endpoints and events', () => {
  it('manages endpoints under the dashboard scope', async () => {
    answer = (call) =>
      call.method === 'GET' ? { object: 'list', data: [], has_more: false } : { id: 'we_1' };
    await api.webhookEndpoints.list(scope);
    await api.webhookEndpoints.create(scope, {
      url: 'https://shop.example/hook',
      enabled_events: ['*'],
    });
    await api.webhookEndpoints.update(scope, 'we_1', { disabled: true });
    await api.webhookEndpoints.rollSecret(scope, 'we_1', 3600);
    await api.webhookEndpoints.sendTest(scope, 'we_1');
    await api.webhookEndpoints.delete(scope, 'we_1');
    await api.events.list(scope, { type: 'payment_intent.*' });
    await api.webhookDeliveries.list(scope, { webhook_endpoint: 'we_1' });
    const base = '/v1/dashboard/applications/app%201';
    expect(calls.map((call) => [call.method, call.path, call.options?.body])).toEqual([
      ['GET', `${base}/webhook_endpoints?environment=development`, undefined],
      [
        'POST',
        `${base}/webhook_endpoints?environment=development`,
        { url: 'https://shop.example/hook', enabled_events: ['*'] },
      ],
      ['POST', `${base}/webhook_endpoints/we_1?environment=development`, { disabled: true }],
      [
        'POST',
        `${base}/webhook_endpoints/we_1/roll_secret?environment=development`,
        { expires_in_seconds: 3600 },
      ],
      ['POST', `${base}/webhook_endpoints/we_1/test?environment=development`, {}],
      ['DELETE', `${base}/webhook_endpoints/we_1?environment=development`, undefined],
      ['GET', `${base}/events?environment=development&type=payment_intent.*`, undefined],
      [
        'GET',
        `${base}/webhook_deliveries?environment=development&webhook_endpoint=we_1`,
        undefined,
      ],
    ]);
  });
});

describe('catalog', () => {
  it('manages products and their prices under the dashboard scope', async () => {
    answer = (call) =>
      call.method === 'GET' && !call.path.includes('/products/prod_1')
        ? { object: 'list', data: [], has_more: false }
        : { id: 'prod_1' };
    await api.products.list(scope, { active: false, limit: 25, starting_after: 'prod_0' });
    await api.products.retrieve(scope, 'prod_1');
    await api.products.create(scope, {
      name: 'Plus',
      default_price_data: { currency: 'EUR', unit_amount: '499' },
    });
    await api.products.update(scope, 'prod_1', { active: false, description: '' });
    await api.products.delete(scope, 'prod_1');
    await api.prices.list(scope, { product: 'prod_1', limit: 100 });
    await api.prices.create(scope, {
      product: 'prod_1',
      currency: 'FAIR',
      unit_amount: '100000000',
      recurring: { interval: 'month' },
    });
    await api.prices.update(scope, 'price_1', { active: false });
    const base = '/v1/dashboard/applications/app%201';
    expect(calls.map((call) => [call.method, call.path, call.options?.body])).toEqual([
      [
        'GET',
        `${base}/products?environment=development&active=false&limit=25&starting_after=prod_0`,
        undefined,
      ],
      ['GET', `${base}/products/prod_1?environment=development`, undefined],
      [
        'POST',
        `${base}/products?environment=development`,
        { name: 'Plus', default_price_data: { currency: 'EUR', unit_amount: '499' } },
      ],
      [
        'POST',
        `${base}/products/prod_1?environment=development`,
        { active: false, description: '' },
      ],
      ['DELETE', `${base}/products/prod_1?environment=development`, undefined],
      ['GET', `${base}/prices?environment=development&product=prod_1&limit=100`, undefined],
      [
        'POST',
        `${base}/prices?environment=development`,
        {
          product: 'prod_1',
          currency: 'FAIR',
          unit_amount: '100000000',
          recurring: { interval: 'month' },
        },
      ],
      ['POST', `${base}/prices/price_1?environment=development`, { active: false }],
    ]);
  });
});

describe('merchant', () => {
  it('answers null when the application has no merchant in this environment', async () => {
    answer = () => {
      throw new OrbitApiError({ status: 404, type: 'invalid_request_error', message: 'none' });
    };
    expect(await api.merchant.retrieve(scope)).toBeNull();
  });

  it('does not swallow any other refusal', async () => {
    answer = () => {
      throw new OrbitApiError({ status: 403, type: 'permission_error', message: 'not a member' });
    };
    await expect(api.merchant.retrieve(scope)).rejects.toThrow('not a member');
  });

  it('registers with POST and updates with PATCH, sending the body as given', async () => {
    await api.merchant.register(scope, { display_name: 'Shop', required_confirmations: 3 });
    await api.merchant.update(scope, { description: null });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/dashboard/applications/app%201/merchant?environment=development',
        options: { body: { display_name: 'Shop', required_confirmations: 3 } },
      },
      {
        method: 'PATCH',
        path: '/v1/dashboard/applications/app%201/merchant?environment=development',
        options: { body: { description: null } },
      },
    ]);
  });
});

describe('tax', () => {
  it('keeps the wallet screen routes, including the report range', async () => {
    answer = (call) => (call.path.includes('/codes') ? { object: 'list', data: [] } : {});
    await api.tax.codes(scope);
    await api.tax.report(scope, 100, 200);
    await api.tax.endRegistration(scope, 'taxreg_1', 300);
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/dashboard/applications/app%201/tax/codes?environment=development',
      '/v1/dashboard/applications/app%201/tax/reports/summary?environment=development&from=100&to=200',
      '/v1/dashboard/applications/app%201/tax/registrations/taxreg_1/end?environment=development',
    ]);
    expect(calls[2]?.options).toEqual({ body: { expires_at: 300 } });
  });
});

describe('isMerchantMissing', () => {
  it("is the gateway's 404 merchant_missing and nothing else", () => {
    expect(
      isMerchantMissing(
        new OrbitApiError({
          status: 404,
          type: 'invalid_request_error',
          code: 'merchant_missing',
          message: 'no merchant registered for this application in this environment',
        }),
      ),
    ).toBe(true);
    // A payment that does not exist is not a first run.
    expect(
      isMerchantMissing(
        new OrbitApiError({
          status: 404,
          type: 'invalid_request_error',
          message: 'payment intent not found',
        }),
      ),
    ).toBe(false);
    expect(isMerchantMissing(new OrbitApiError({ status: 403, type: 'x', message: '' }))).toBe(
      false,
    );
    expect(isMerchantMissing(new Error('404'))).toBe(false);
  });
});

const base = '/v1/dashboard/applications/app%201';

describe('disputes', () => {
  it('lists, retrieves, updates and closes under the scope', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path.includes('/disputes?')
        ? { object: 'list', data: [{ id: 'dp_1' }], has_more: false }
        : { id: 'dp_1' };
    await api.disputes.list(scope, { payment_intent: 'pi_1', limit: 25 });
    await api.disputes.retrieve(scope, 'dp_1');
    await api.disputes.update(scope, 'dp_1', {
      evidence: { uncategorized_text: 'Signed for.', receipt: 'file_1' },
      submit: false,
    });
    await api.disputes.close(scope, 'dp/1');
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', `${base}/disputes?environment=development&payment_intent=pi_1&limit=25`],
      ['GET', `${base}/disputes/dp_1?environment=development`],
      ['POST', `${base}/disputes/dp_1?environment=development`],
      ['POST', `${base}/disputes/dp%2F1/close?environment=development`],
    ]);
    expect(calls[2]?.options).toEqual({
      body: { evidence: { uncategorized_text: 'Signed for.', receipt: 'file_1' }, submit: false },
    });
    // `close` takes no body at all.
    expect(calls[3]?.options).toBeUndefined();
  });
});

describe('files', () => {
  it('uploads as a form with the purpose and the file, never as JSON', async () => {
    answer = () => ({ id: 'file_1', object: 'file' });
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    const file = await api.files.upload(scope, {
      purpose: 'dispute_evidence',
      file: blob,
      filename: 'receipt.pdf',
    });
    expect(file.id).toBe('file_1');
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe(`${base}/files?environment=development`);
    expect(call?.options?.body).toBeUndefined();
    const form = call?.options?.form?.();
    expect(form?.get('purpose')).toBe('dispute_evidence');
    const part = form?.get('file');
    expect(part).toBeInstanceOf(Blob);
    expect((part as File).name).toBe('receipt.pdf');
  });

  it('lists by purpose and retrieves by id', async () => {
    answer = (call) => (call.path.includes('/files?') ? { object: 'list', data: [] } : {});
    await api.files.list(scope, { purpose: 'business_logo' });
    await api.files.retrieve(scope, 'file_9');
    expect(calls.map((call) => call.path)).toEqual([
      `${base}/files?environment=development&purpose=business_logo`,
      `${base}/files/file_9?environment=development`,
    ]);
  });
});

describe('payment method configurations', () => {
  it('maps list, create, retrieve and update', async () => {
    answer = (call) =>
      call.method === 'GET' && !call.path.includes('/pmc_')
        ? { object: 'list', data: [] }
        : { id: 'pmc_1' };
    await api.paymentMethodConfigurations.list(scope);
    await api.paymentMethodConfigurations.create(scope, { name: 'EU' });
    await api.paymentMethodConfigurations.retrieve(scope, 'pmc_1');
    await api.paymentMethodConfigurations.update(scope, 'pmc_1', {
      ideal: { display_preference: { preference: 'on' } },
    });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', `${base}/payment_method_configurations?environment=development`],
      ['POST', `${base}/payment_method_configurations?environment=development`],
      ['GET', `${base}/payment_method_configurations/pmc_1?environment=development`],
      ['POST', `${base}/payment_method_configurations/pmc_1?environment=development`],
    ]);
    expect(calls[3]?.options).toEqual({
      body: { ideal: { display_preference: { preference: 'on' } } },
    });
  });
});

describe('payment method domains', () => {
  it('maps list, create, update and validate', async () => {
    answer = (call) =>
      call.method === 'GET' ? { object: 'list', data: [] } : { id: 'pmd_1', object: 'x' };
    await api.paymentMethodDomains.list(scope, { enabled: true });
    await api.paymentMethodDomains.create(scope, { domain_name: 'shop.example.com' });
    await api.paymentMethodDomains.update(scope, 'pmd_1', { enabled: false });
    await api.paymentMethodDomains.validate(scope, 'pmd_1');
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', `${base}/payment_method_domains?environment=development&enabled=true`],
      ['POST', `${base}/payment_method_domains?environment=development`],
      ['POST', `${base}/payment_method_domains/pmd_1?environment=development`],
      ['POST', `${base}/payment_method_domains/pmd_1/validate?environment=development`],
    ]);
    expect(calls[1]?.options).toEqual({ body: { domain_name: 'shop.example.com' } });
    expect(calls[2]?.options).toEqual({ body: { enabled: false } });
  });
});

describe('money (ADR 0015)', () => {
  const base = '/v1/dashboard/applications/app%201';
  const accountMissing = () => {
    throw new OrbitApiError({
      status: 404,
      type: 'invalid_request_error',
      code: 'account_missing',
      message: 'No fiat account',
    });
  };

  it('answers null for account_missing on the account and the balance, never zeros', async () => {
    answer = accountMissing;
    expect(await api.account.retrieve(scope)).toBeNull();
    expect(await api.balance.retrieve(scope)).toBeNull();
    expect(calls.map((call) => call.path)).toEqual([
      `${base}/account?environment=development`,
      `${base}/balance?environment=development`,
    ]);
  });

  it('does not take a missing merchant for a missing account', async () => {
    answer = () => {
      throw new OrbitApiError({ status: 404, type: 'invalid_request_error', message: 'none' });
    };
    await expect(api.balance.retrieve(scope)).rejects.toThrow('none');
  });

  it('opens or updates the account and mints an onboarding link', async () => {
    answer = () => ({ id: 'ca_1' });
    await api.account.update(scope, { country: 'ES', business_type: 'company' });
    await api.account.createLink(scope, {
      return_url: 'https://orbit.example/account',
      refresh_url: 'https://orbit.example/account?refresh=1',
      type: 'account_onboarding',
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `${base}/account?environment=development`,
        options: { body: { country: 'ES', business_type: 'company' } },
      },
      {
        method: 'POST',
        path: `${base}/account_links?environment=development`,
        options: {
          body: {
            return_url: 'https://orbit.example/account',
            refresh_url: 'https://orbit.example/account?refresh=1',
            type: 'account_onboarding',
          },
        },
      },
    ]);
  });

  it('lists balance transactions with their filters and the cursor', async () => {
    answer = () => ({ object: 'list', data: [], has_more: false });
    await api.balanceTransactions.list(live, {
      type: 'payout',
      limit: 25,
      starting_after: 'txn_9',
    });
    await api.balanceTransactions.retrieve(live, 'txn_1');
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/dashboard/applications/app_live/balance_transactions?environment=production&type=payout&limit=25&starting_after=txn_9',
      '/v1/dashboard/applications/app_live/balance_transactions/txn_1?environment=production',
    ]);
  });

  it('lists, creates with the form key, retrieves and cancels payouts', async () => {
    answer = (call) =>
      call.method === 'GET' && !call.path.includes('/po_')
        ? { object: 'list', data: [], has_more: false }
        : { id: 'po_1' };
    await api.payouts.list(scope, { status: 'pending' });
    await api.payouts.create(scope, { amount: '1000', currency: 'EUR' }, 'key-1');
    await api.payouts.retrieve(scope, 'po_1');
    await api.payouts.cancel(scope, 'po_1');
    expect(calls).toEqual([
      { method: 'GET', path: `${base}/payouts?environment=development&status=pending` },
      {
        method: 'POST',
        path: `${base}/payouts?environment=development`,
        options: { body: { amount: '1000', currency: 'EUR' }, idempotencyKey: 'key-1' },
      },
      { method: 'GET', path: `${base}/payouts/po_1?environment=development` },
      { method: 'POST', path: `${base}/payouts/po_1/cancel?environment=development` },
    ]);
  });

  it('reads the payout reconciliation report and keeps its summary beside the page', async () => {
    answer = () => ({
      object: 'list',
      data: [{ id: 'txn_1' }],
      has_more: false,
      url: '/v1/reports/payout_reconciliation',
      payout: 'po_1',
      status: 'complete',
      currency: 'eur',
      summary: { count: 1, amount: '100', fee: '3', net: '97' },
    });
    const report = await api.reports.payoutReconciliation(scope, 'po_1', { limit: 100 });
    expect(report.summary).toEqual({ count: 1, amount: '100', fee: '3', net: '97' });
    expect(report.data).toEqual([{ id: 'txn_1' } as never]);
    expect(calls[0]?.path).toBe(
      `${base}/reports/payout_reconciliation?environment=development&payout=po_1&limit=100`,
    );
  });

  it('refuses a reconciliation report that is not a list', async () => {
    answer = () => ({ summary: {} });
    await expect(api.reports.payoutReconciliation(scope, 'po_1')).rejects.toThrow('not a list');
  });

  it('lists reconciliation mismatches', async () => {
    answer = () => ({ object: 'list', data: [], has_more: false });
    await api.reconciliationMismatches.list(scope, { limit: 100 });
    expect(calls[0]?.path).toBe(
      `${base}/reconciliation_mismatches?environment=development&limit=100`,
    );
  });
});

describe('isAccountMissing', () => {
  it('is the account_missing 404 only, and is not a missing merchant', () => {
    const missing = new OrbitApiError({
      status: 404,
      type: 'invalid_request_error',
      code: 'account_missing',
      message: '',
    });
    expect(isAccountMissing(missing)).toBe(true);
    expect(isMerchantMissing(missing)).toBe(false);
    expect(
      isAccountMissing(
        new OrbitApiError({ status: 404, type: 'invalid_request_error', message: '' }),
      ),
    ).toBe(false);
  });
});

describe('payment links', () => {
  it('lists with the active filter and the cursor, and reads a link and its line items', async () => {
    answer = (call) =>
      call.path.includes('/line_items') || !call.path.includes('/payment_links/')
        ? { object: 'list', data: [{ id: 'li_1' }], has_more: false }
        : { id: 'link_1' };
    await api.paymentLinks.list(scope, { active: false, limit: 25, starting_after: 'link_0' });
    await api.paymentLinks.retrieve(scope, 'link_1');
    const items = await api.paymentLinks.lineItems(scope, 'link_1');
    expect(items.data.map((item) => item.id)).toEqual(['li_1']);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/dashboard/applications/app%201/payment_links?environment=development&active=false&limit=25&starting_after=link_0',
      'GET /v1/dashboard/applications/app%201/payment_links/link_1?environment=development',
      'GET /v1/dashboard/applications/app%201/payment_links/link_1/line_items?environment=development',
    ]);
  });

  it('creates and updates with POST bodies', async () => {
    answer = () => ({ id: 'link_1' });
    await api.paymentLinks.create(scope, { line_items: [{ price: 'price_1', quantity: 2 }] });
    await api.paymentLinks.update(scope, 'link 1', { active: false });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/dashboard/applications/app%201/payment_links?environment=development',
      options: { body: { line_items: [{ price: 'price_1', quantity: 2 }] } },
    });
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/v1/dashboard/applications/app%201/payment_links/link%201?environment=development',
      options: { body: { active: false } },
    });
  });
});

describe('connect', () => {
  it('lists, opens and onboards sellers on the dashboard routes', async () => {
    answer = () => ({ object: 'list', data: [], has_more: false });
    await api.connectedAccounts.list(scope, { limit: 25, starting_after: 'ca_1' });
    answer = () => ({ id: 'ca_2' });
    await api.connectedAccounts.create(
      scope,
      { external_ref: 'store-1', country: 'ES', business_type: 'company' },
      'key-1',
    );
    await api.connectedAccounts.refresh(scope, 'ca_2');
    await api.connectedAccounts.createLink(scope, 'ca_2', {
      refresh_url: 'https://orbit.peable.to/connect/ca_2',
      return_url: 'https://orbit.peable.to/connect/ca_2',
      rail: 'faircoin',
    });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      [
        'GET',
        '/v1/dashboard/applications/app%201/connected_accounts?environment=development&limit=25&starting_after=ca_1',
      ],
      ['POST', '/v1/dashboard/applications/app%201/connected_accounts?environment=development'],
      [
        'POST',
        '/v1/dashboard/applications/app%201/connected_accounts/ca_2/refresh?environment=development',
      ],
      [
        'POST',
        '/v1/dashboard/applications/app%201/connected_accounts/ca_2/account_links?environment=development',
      ],
    ]);
    expect(calls[1]?.options).toEqual({
      body: { external_ref: 'store-1', country: 'ES', business_type: 'company' },
      idempotencyKey: 'key-1',
    });
    expect(calls[3]?.options?.body).toMatchObject({ rail: 'faircoin' });
  });

  it('lists transfers by seller, their reversals, and reverses under a kept key', async () => {
    answer = () => ({ object: 'list', data: [], has_more: false });
    await api.transfers.list(scope, { connected_account: 'ca_2' });
    await api.transfers.reversals(scope, 'tr_1');
    answer = () => ({ id: 'tr_1', reversal: { id: 'trr_1' } });
    await api.transfers.reverse(scope, 'tr_1', { amount: '100', external_ref: 'rev-1' }, 'rev-1');
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/dashboard/applications/app%201/transfers?environment=development&connected_account=ca_2',
      '/v1/dashboard/applications/app%201/transfers/tr_1/reversals?environment=development',
      '/v1/dashboard/applications/app%201/transfers/tr_1/reversals?environment=development',
    ]);
    expect(calls[2]?.options).toEqual({
      body: { amount: '100', external_ref: 'rev-1' },
      idempotencyKey: 'rev-1',
    });
  });
});

describe('branding and email settings', () => {
  it('reads and writes both on their own paths', async () => {
    answer = () => ({});
    await api.branding.retrieve(live);
    await api.branding.update(live, { primary_color: '#112233' });
    await api.emailSettings.retrieve(live);
    await api.emailSettings.update(live, { refund_notices: false });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/dashboard/applications/app_live/branding?environment=production',
      'POST /v1/dashboard/applications/app_live/branding?environment=production',
      'GET /v1/dashboard/applications/app_live/email_settings?environment=production',
      'POST /v1/dashboard/applications/app_live/email_settings?environment=production',
    ]);
    expect(calls[1]?.options).toEqual({ body: { primary_color: '#112233' } });
    expect(calls[3]?.options).toEqual({ body: { refund_notices: false } });
  });
});

describe('the billing engine (ADR 0018)', () => {
  const list = () => ({ object: 'list', data: [], has_more: false });

  it('lists customers by email and reads their balance and entitlements', async () => {
    answer = list;
    await api.customers.list(scope, { email: 'a@b.test', limit: 25 });
    await api.customers.balanceTransactions(scope, 'cus_1', { limit: 25 });
    await api.customers.activeEntitlements(scope, 'cus_1');
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/dashboard/applications/app%201/customers?environment=development&email=a%40b.test&limit=25',
      '/v1/dashboard/applications/app%201/customers/cus_1/balance_transactions?environment=development&limit=25',
      '/v1/dashboard/applications/app%201/entitlements/active_entitlements?environment=development&customer=cus_1',
    ]);
  });

  it("sets a customer's preferred languages through the contract's update", async () => {
    answer = () => ({ id: 'cus_1' });
    await api.customers.update(scope, 'cus_1', { preferred_locales: ['fr'] });
    await api.customers.update(scope, 'cus_1', { preferred_locales: [] });
    const path = '/v1/dashboard/applications/app%201/customers/cus_1?environment=development';
    expect(calls.map((call) => [call.method, call.path, call.options?.body])).toEqual([
      ['POST', path, { preferred_locales: ['fr'] }],
      ['POST', path, { preferred_locales: [] }],
    ]);
  });

  it('reads a subscription with its latest invoice expanded, and acts on it', async () => {
    answer = () => ({ id: 'sub_1' });
    await api.subscriptions.retrieve(scope, 'sub_1');
    await api.subscriptions.update(scope, 'sub_1', { cancel_at_period_end: true });
    await api.subscriptions.update(scope, 'sub_1', { pause_collection: '' });
    await api.subscriptions.cancel(scope, 'sub_1', { prorate: true });
    await api.subscriptions.resume(scope, 'sub_1');
    const base = '/v1/dashboard/applications/app%201/subscriptions/sub_1';
    expect(calls.map((call) => [call.method, call.path, call.options?.body])).toEqual([
      ['GET', `${base}?environment=development&expand%5B%5D=latest_invoice`, undefined],
      ['POST', `${base}?environment=development`, { cancel_at_period_end: true }],
      ['POST', `${base}?environment=development`, { pause_collection: '' }],
      ['DELETE', `${base}?environment=development`, { prorate: true }],
      ['POST', `${base}/resume?environment=development`, {}],
    ]);
  });

  it('filters subscriptions and invoices, and posts invoice actions', async () => {
    answer = list;
    await api.subscriptions.list(live, { status: 'all', customer: 'cus_9' });
    await api.invoices.list(live, { status: 'open', starting_after: 'in_1' });
    answer = () => ({ id: 'in_1' });
    for (const action of ['finalize', 'void', 'send', 'mark_uncollectible'] as const) {
      await api.invoices.act(live, 'in_1', action);
    }
    const base = '/v1/dashboard/applications/app_live';
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', `${base}/subscriptions?environment=production&status=all&customer=cus_9`],
      ['GET', `${base}/invoices?environment=production&status=open&starting_after=in_1`],
      ['POST', `${base}/invoices/in_1/finalize?environment=production`],
      ['POST', `${base}/invoices/in_1/void?environment=production`],
      ['POST', `${base}/invoices/in_1/send?environment=production`],
      ['POST', `${base}/invoices/in_1/mark_uncollectible?environment=production`],
    ]);
  });

  it('lists, writes and acts on quotes, and downloads their PDF as a blob', async () => {
    answer = list;
    await api.quotes.list(live, { status: 'open', customer: 'cus_9' });
    await api.quotes.lineItems(live, 'qt_1');
    answer = () => ({ id: 'qt_1' });
    await api.quotes.retrieve(live, 'qt_1');
    await api.quotes.create(live, { customer: 'cus_9', line_items: [{ price: 'price_1' }] });
    await api.quotes.update(live, 'qt_1', { header: '' });
    for (const action of ['finalize', 'accept', 'cancel'] as const) {
      await api.quotes.act(live, 'qt_1', action);
    }
    await api.quotes.pdf(live, 'qt_1');
    const base = '/v1/dashboard/applications/app_live/quotes';
    expect(calls.map((call) => [call.method, call.path, call.options?.body])).toEqual([
      ['GET', `${base}?environment=production&status=open&customer=cus_9`, undefined],
      [
        'GET',
        `${base}/qt_1/line_items?environment=production&limit=100&expand%5B%5D=data.price`,
        undefined,
      ],
      ['GET', `${base}/qt_1?environment=production`, undefined],
      [
        'POST',
        `${base}?environment=production`,
        { customer: 'cus_9', line_items: [{ price: 'price_1' }] },
      ],
      ['POST', `${base}/qt_1?environment=production`, { header: '' }],
      ['POST', `${base}/qt_1/finalize?environment=production`, {}],
      ['POST', `${base}/qt_1/accept?environment=production`, {}],
      ['POST', `${base}/qt_1/cancel?environment=production`, {}],
      ['GET', `${base}/qt_1/pdf?environment=production`, undefined],
    ]);
    expect(calls.at(-1)?.options).toEqual({ responseType: 'blob' });
  });

  it('reads and updates billing settings', async () => {
    answer = () => ({ object: 'billing_settings' });
    await api.billingSettings.retrieve(scope);
    await api.billingSettings.update(scope, { dunning: { retry_schedule_days: [2] } });
    const path = '/v1/dashboard/applications/app%201/billing_settings?environment=development';
    expect(calls.map((call) => [call.method, call.path, call.options?.body])).toEqual([
      ['GET', path, undefined],
      ['POST', path, { dunning: { retry_schedule_days: [2] } }],
    ]);
  });

  it('creates, archives, attaches and detaches features', async () => {
    answer = () => ({ object: 'list', data: [], has_more: false, id: 'x' });
    await api.features.list(scope, { limit: 100 });
    await api.features.create(scope, { lookup_key: 'mention_plus', name: 'Mention Plus' });
    await api.features.update(scope, 'feat_1', { active: false });
    await api.features.ofProduct(scope, 'prod_1');
    await api.features.attach(scope, 'prod_1', 'feat_1');
    await api.features.detach(scope, 'prod_1', 'prodft_1');
    const base = '/v1/dashboard/applications/app%201';
    expect(calls.map((call) => [call.method, call.path, call.options?.body])).toEqual([
      ['GET', `${base}/entitlements/features?environment=development&limit=100`, undefined],
      [
        'POST',
        `${base}/entitlements/features?environment=development`,
        { lookup_key: 'mention_plus', name: 'Mention Plus' },
      ],
      ['POST', `${base}/entitlements/features/feat_1?environment=development`, { active: false }],
      ['GET', `${base}/products/prod_1/features?environment=development&limit=100`, undefined],
      [
        'POST',
        `${base}/products/prod_1/features?environment=development`,
        { entitlement_feature: 'feat_1' },
      ],
      ['DELETE', `${base}/products/prod_1/features/prodft_1?environment=development`, undefined],
    ]);
  });
});
describe('developers', () => {
  it('filters request logs by status class, method and created', async () => {
    answer = () => ({ object: 'list', data: [], has_more: false });
    await api.requestLogs.list(scope, { status: '4xx', method: 'POST', created: { gte: 10 } });
    await api.requestLogs.retrieve(scope, 'req_1');
    expect(calls.map((call) => decodeURIComponent(call.path))).toEqual([
      '/v1/dashboard/applications/app 1/request_logs?environment=development&status=4xx&method=POST&created[gte]=10',
      '/v1/dashboard/applications/app 1/request_logs/req_1?environment=development',
    ]);
  });

  it('reads one event and the events of one payment', async () => {
    answer = () => ({ object: 'list', data: [], has_more: false });
    await api.events.list(scope, { payment_intent: 'pi_1', limit: 100 });
    await api.events.retrieve(scope, 'evt_1');
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/dashboard/applications/app%201/events?environment=development&payment_intent=pi_1&limit=100',
      '/v1/dashboard/applications/app%201/events/evt_1?environment=development',
    ]);
  });
});

describe('report downloads', () => {
  it('streams the same report a run would store, as a blob', async () => {
    answer = () => new Blob(['id\r\n'], { type: 'text/csv' });
    await api.reporting.download(live, {
      report_type: 'balance_transactions.itemized.1',
      parameters: { interval_start: 100, interval_end: 200, columns: ['amount', 'fee'] },
    });
    expect(calls.map((call) => [call.method, decodeURIComponent(call.path)])).toEqual([
      [
        'GET',
        '/v1/dashboard/applications/app_live/reporting/report_types/balance_transactions.itemized.1/csv?environment=production&interval_start=100&interval_end=200&columns[]=amount&columns[]=fee',
      ],
    ]);
    expect(calls[0]?.options).toEqual({ responseType: 'blob' });
  });
});
