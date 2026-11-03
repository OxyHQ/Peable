import { beforeEach, describe, expect, it } from 'bun:test';
import {
  assertList,
  createDashboardApi,
  dashboardPath,
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
  it('is a 404 from the gateway and nothing else', () => {
    expect(
      isMerchantMissing(
        new OrbitApiError({ status: 404, type: 'invalid_request_error', message: '' }),
      ),
    ).toBe(true);
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
