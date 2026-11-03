/**
 * Files, disputes, payment method configurations and domains — the routes and
 * the bodies, which is what an integrator would otherwise have to guess.
 */
import { describe, expect, test } from 'bun:test';
import type {
  Dispute,
  FileObject,
  PaymentMethodConfigurationEntry,
  PaymentMethodDomain,
} from '@peable.to/shared-types';
import { DisputesResource } from '../../src/resources/disputes';
import { FilesResource } from '../../src/resources/files';
import {
  PaymentMethodConfigurationsResource,
  PaymentMethodDomainsResource,
} from '../../src/resources/paymentMethodConfigurations';
import { MerchantsResource } from '../../src/resources/merchants';
import { Peable } from '../../src';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const FILE: FileObject = {
  id: 'file_1',
  object: 'file',
  livemode: false,
  purpose: 'dispute_evidence',
  filename: 'receipt.pdf',
  size: 4,
  type: 'pdf',
  status: 'available',
  url: null,
  created: 1789776000,
};

const DISPUTE: Dispute = {
  id: 'dp_1',
  object: 'dispute',
  livemode: false,
  amount: '5000',
  currency: 'EUR',
  charge: 'ch_1',
  payment_intent: 'pi_1',
  status: 'needs_response',
  reason: 'fraudulent',
  is_charge_refundable: true,
  evidence_details: {
    due_by: 1789900000,
    has_evidence: false,
    past_due: false,
    submission_count: 0,
    submitted_at: null,
  },
  metadata: {},
  created: 1789776000,
  updated_at: 1789776000,
};

const ENTRY: PaymentMethodConfigurationEntry = {
  available: true,
  display_preference: { preference: 'none', value: 'on' },
  unavailable_reason: null,
  currencies: ['EUR'],
};

const DOMAIN: PaymentMethodDomain = {
  id: 'pmd_1',
  object: 'payment_method_domain',
  livemode: false,
  domain_name: 'shop.example.com',
  enabled: true,
  apple_pay: { status: 'active', status_details: null },
  google_pay: { status: 'active', status_details: null },
  created: 1789776000,
};

function gateway(body: unknown, status = 200) {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return { status, json: body };
  });
}

function callOf(requests: CapturedRequest[]): CapturedRequest | undefined {
  return requests.find((r) => !r.url.includes('/auth/service-token'));
}

describe('FilesResource', () => {
  /**
   * Bytes go as multipart with NO hand-set Content-Type — `fetch` writes the
   * boundary — and the POST still carries an Idempotency-Key, which the gateway
   * binds to the purpose and the bytes' hash.
   */
  test('uploads bytes as multipart/form-data with an idempotency key', async () => {
    const { fetch: fetchImpl, requests } = gateway(FILE, 201);
    const files = new FilesResource(buildTestClient(fetchImpl));

    const file = await files.create(
      {
        purpose: 'dispute_evidence',
        file: new TextEncoder().encode('%PDF'),
        filename: 'receipt.pdf',
      },
      { idempotencyKey: 'upload-1' },
    );

    expect(file).toEqual(FILE);
    const call = callOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/files`);
    expect(call?.headers.get('Content-Type')).toBeNull();
    expect(call?.headers.get('Idempotency-Key')).toBe('upload-1');
    expect(call?.form?.get('purpose')).toBe('dispute_evidence');
    const part = call?.form?.get('file');
    expect(part).toBeInstanceOf(Blob);
    expect((part as File).name).toBe('receipt.pdf');
    expect(await (part as Blob).text()).toBe('%PDF');
  });

  test("keeps a File's own name and mints a key when none is given", async () => {
    const { fetch: fetchImpl, requests } = gateway(FILE, 201);
    const files = new FilesResource(buildTestClient(fetchImpl));

    await files.create({
      purpose: 'business_logo',
      file: new File([new Uint8Array([0x89, 0x50])], 'logo.png'),
    });

    const call = callOf(requests);
    const part = call?.form?.get('file');
    expect(part instanceof File ? part.name : undefined).toBe('logo.png');
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
  });

  test('makes a file from an Oxy file as JSON', async () => {
    const { fetch: fetchImpl, requests } = gateway(FILE, 201);
    const files = new FilesResource(buildTestClient(fetchImpl));

    await files.create({ purpose: 'business_logo', oxy_file: 'oxyfile_1' });

    const call = callOf(requests);
    expect(call?.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      purpose: 'business_logo',
      oxy_file: 'oxyfile_1',
    });
  });

  test('retrieves one and lists by purpose', async () => {
    const one = gateway(FILE);
    await new FilesResource(buildTestClient(one.fetch)).retrieve('file_1');
    expect(callOf(one.requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/files/file_1`);

    const many = gateway({ object: 'list', data: [FILE], has_more: false, url: '/v1/files' });
    const page = await new FilesResource(buildTestClient(many.fetch)).list({
      purpose: 'dispute_evidence',
      limit: 5,
    });
    expect(page.data).toEqual([FILE]);
    expect(callOf(many.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/files?limit=5&purpose=dispute_evidence`,
    );
  });
});

describe('DisputesResource', () => {
  test('stages evidence without submitting', async () => {
    const { fetch: fetchImpl, requests } = gateway(DISPUTE);
    const disputes = new DisputesResource(buildTestClient(fetchImpl));

    await disputes.update('dp_1', {
      evidence: { product_description: 'A mug', shipping_documentation: 'file_2' },
      metadata: { case: '42' },
    });

    const call = callOf(requests);
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/disputes/dp_1`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      evidence: { product_description: 'A mug', shipping_documentation: 'file_2' },
      metadata: { case: '42' },
    });
  });

  test('closes (accepts) a dispute', async () => {
    const { fetch: fetchImpl, requests } = gateway({ ...DISPUTE, status: 'lost' });
    const disputes = new DisputesResource(buildTestClient(fetchImpl));

    const closed = await disputes.close('dp_1', { idempotencyKey: 'close-1' });

    expect(closed.status).toBe('lost');
    const call = callOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/disputes/dp_1/close`);
    expect(call?.body).toBeUndefined();
    expect(call?.headers.get('Idempotency-Key')).toBe('close-1');
  });

  test('retrieves with expand and lists by charge', async () => {
    const one = gateway(DISPUTE);
    await new DisputesResource(buildTestClient(one.fetch)).retrieve('dp_1', {
      expand: ['charge'],
    });
    expect(callOf(one.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/disputes/dp_1?expand%5B%5D=charge`,
    );

    const many = gateway({ object: 'list', data: [], has_more: false, url: '/v1/disputes' });
    await new DisputesResource(buildTestClient(many.fetch)).list({ charge: 'ch_1' });
    expect(callOf(many.requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/disputes?charge=ch_1`);
  });
});

describe('PaymentMethodConfigurationsResource', () => {
  test('turns a method on through the configuration update', async () => {
    const { fetch: fetchImpl, requests } = gateway({ id: 'pmc_1', ideal: ENTRY });
    const configurations = new PaymentMethodConfigurationsResource(buildTestClient(fetchImpl));

    await configurations.update('pmc_1', { ideal: { display_preference: { preference: 'on' } } });

    const call = callOf(requests);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_method_configurations/pmc_1`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      ideal: { display_preference: { preference: 'on' } },
    });
  });

  test('creates, retrieves and lists', async () => {
    const created = gateway({ id: 'pmc_2' }, 201);
    await new PaymentMethodConfigurationsResource(buildTestClient(created.fetch)).create({
      name: 'Checkout EU',
    });
    expect(callOf(created.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_method_configurations`,
    );
    expect(JSON.parse(callOf(created.requests)?.body ?? '{}')).toEqual({ name: 'Checkout EU' });

    const one = gateway({ id: 'pmc_2' });
    await new PaymentMethodConfigurationsResource(buildTestClient(one.fetch)).retrieve('pmc_2');
    expect(callOf(one.requests)?.method).toBe('GET');

    const many = gateway({ object: 'list', data: [], has_more: false, url: '' });
    await new PaymentMethodConfigurationsResource(buildTestClient(many.fetch)).list();
    expect(callOf(many.requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_method_configurations`);
  });
});

describe('PaymentMethodDomainsResource', () => {
  test('registers, validates, updates and lists a domain', async () => {
    const created = gateway(DOMAIN, 201);
    await new PaymentMethodDomainsResource(buildTestClient(created.fetch)).create({
      domain_name: 'shop.example.com',
    });
    expect(callOf(created.requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_method_domains`);
    expect(JSON.parse(callOf(created.requests)?.body ?? '{}')).toEqual({
      domain_name: 'shop.example.com',
    });

    const validated = gateway(DOMAIN);
    await new PaymentMethodDomainsResource(buildTestClient(validated.fetch)).validate('pmd_1');
    expect(callOf(validated.requests)?.method).toBe('POST');
    expect(callOf(validated.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_method_domains/pmd_1/validate`,
    );

    const updated = gateway({ ...DOMAIN, enabled: false });
    await new PaymentMethodDomainsResource(buildTestClient(updated.fetch)).update('pmd_1', {
      enabled: false,
    });
    expect(JSON.parse(callOf(updated.requests)?.body ?? '{}')).toEqual({ enabled: false });

    const many = gateway({ object: 'list', data: [DOMAIN], has_more: false, url: '' });
    await new PaymentMethodDomainsResource(buildTestClient(many.fetch)).list({ enabled: true });
    expect(callOf(many.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_method_domains?enabled=true`,
    );
  });
});

describe('merchant branding and the client surface', () => {
  test('sets and clears the business logo beside the avatar', async () => {
    const { fetch: fetchImpl, requests } = gateway({ id: 'merch_1' });
    const merchants = new MerchantsResource(buildTestClient(fetchImpl));

    await merchants.update({ business_logo: 'file_logo' });
    await merchants.update({ business_logo: null });

    const calls = requests.filter((r) => !r.url.includes('/auth/service-token'));
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ business_logo: 'file_logo' });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ business_logo: null });
  });

  test('Peable exposes the new namespaces', () => {
    const peable = new Peable({ tokenProvider: { getToken: async () => 't', invalidate() {} } });
    expect(peable.files).toBeInstanceOf(FilesResource);
    expect(peable.disputes).toBeInstanceOf(DisputesResource);
    expect(peable.paymentMethodConfigurations).toBeInstanceOf(PaymentMethodConfigurationsResource);
    expect(peable.paymentMethodDomains).toBeInstanceOf(PaymentMethodDomainsResource);
  });
});
