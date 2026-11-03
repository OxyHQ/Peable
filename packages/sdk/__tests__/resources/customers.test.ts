/**
 * Customers, payment methods and SetupIntents (ADR 0016) — the routes and the
 * shapes an integrator would otherwise have to guess.
 */
import { describe, expect, test } from 'bun:test';
import type { Customer, PaymentMethod, SetupIntent } from '@peable.to/shared-types';
import { GeneratedClient } from '../../src/generated/resources';
import { SetupIntentsResource } from '../../src/resources/setupIntents';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const CUSTOMER: Customer = {
  id: 'cus_1',
  object: 'customer',
  livemode: false,
  email: 'ada@example.test',
  name: 'Ada',
  phone: null,
  description: null,
  address: null,
  shipping: null,
  invoice_settings: { default_payment_method: null },
  metadata: {},
  balance: '0',
  currency: null,
  test_clock: null,
  created: 1789776000,
};

const METHOD: PaymentMethod = {
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
  billing_details: { address: null, email: null, name: 'Ada', phone: null },
  customer: 'cus_1',
  metadata: {},
  created: 1789776000,
};

const SETUP: SetupIntent = {
  id: 'seti_1',
  object: 'setup_intent',
  livemode: false,
  status: 'requires_payment_method',
  usage: 'off_session',
  payment_method_types: ['card'],
  customer: 'cus_1',
  payment_method: null,
  client_secret: 'seti_1_secret_x',
  next_action: null,
  last_setup_error: null,
  cancellation_reason: null,
  description: null,
  metadata: {},
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

describe('customers (generated)', () => {
  test('creates with an idempotency key on the POST', async () => {
    const { fetch: fetchImpl, requests } = gateway(CUSTOMER, 201);
    const resource = new GeneratedClient(buildTestClient(fetchImpl)).customers;
    const customer = await resource.create({ email: 'ada@example.test', name: 'Ada' });
    expect(customer).toEqual(CUSTOMER);
    const req = callOf(requests);
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe(`${TEST_GATEWAY_URL}/v1/customers`);
    expect(req?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ email: 'ada@example.test', name: 'Ada' });
  });

  test('updates by POST to the object, and deletes with DELETE', async () => {
    const updated = gateway(CUSTOMER);
    await new GeneratedClient(buildTestClient(updated.fetch)).customers.update('cus_1', {
      phone: '',
    });
    expect(callOf(updated.requests)?.method).toBe('POST');
    expect(callOf(updated.requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/customers/cus_1`);

    const deleted = gateway({ id: 'cus_1', object: 'customer', deleted: true });
    const answer = await new GeneratedClient(buildTestClient(deleted.fetch)).customers.del('cus_1');
    expect(answer.deleted).toBe(true);
    expect(callOf(deleted.requests)?.method).toBe('DELETE');
  });

  test('lists by email', async () => {
    const { fetch: fetchImpl, requests } = gateway({
      object: 'list',
      data: [CUSTOMER],
      has_more: false,
    });
    const page = await new GeneratedClient(buildTestClient(fetchImpl)).customers.list({
      email: 'ada@example.test',
      limit: 5,
    });
    expect(page.data).toEqual([CUSTOMER]);
    expect(callOf(requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/customers?email=ada%40example.test&limit=5`,
    );
  });
});

describe('paymentMethods (generated)', () => {
  test("lists a customer's methods and detaches one", async () => {
    const listed = gateway({ object: 'list', data: [METHOD], has_more: false });
    const resource = new GeneratedClient(buildTestClient(listed.fetch)).paymentMethods;
    await resource.list({ customer: 'cus_1' });
    expect(callOf(listed.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_methods?customer=cus_1`,
    );

    const detached = gateway({ ...METHOD, customer: null });
    const answer = await new GeneratedClient(buildTestClient(detached.fetch)).paymentMethods.detach(
      'pm_1',
    );
    expect(answer.customer).toBeNull();
    expect(callOf(detached.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/payment_methods/pm_1/detach`,
    );
    expect(callOf(detached.requests)?.method).toBe('POST');
  });

  test('the card shape carries no number and no provider id', () => {
    expect(JSON.stringify(METHOD)).not.toMatch(/number|cvc|pm_stripe/);
  });
});

describe('SetupIntentsResource', () => {
  test('creates for a customer, retrieves, lists and cancels', async () => {
    const created = gateway(SETUP, 201);
    await new SetupIntentsResource(buildTestClient(created.fetch)).create({
      customer: 'cus_1',
      usage: 'off_session',
    });
    expect(callOf(created.requests)?.url).toBe(`${TEST_GATEWAY_URL}/v1/setup_intents`);
    expect(JSON.parse(callOf(created.requests)?.body ?? '{}')).toEqual({
      customer: 'cus_1',
      usage: 'off_session',
    });

    const retrieved = gateway(SETUP);
    await new SetupIntentsResource(buildTestClient(retrieved.fetch)).retrieve('seti_1', {
      expand: ['payment_method'],
    });
    expect(callOf(retrieved.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/setup_intents/seti_1?expand%5B%5D=payment_method`,
    );

    const listed = gateway({ object: 'list', data: [SETUP], has_more: false });
    await new SetupIntentsResource(buildTestClient(listed.fetch)).list({ customer: 'cus_1' });
    expect(callOf(listed.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/setup_intents?customer=cus_1`,
    );

    const canceled = gateway({ ...SETUP, status: 'canceled', cancellation_reason: 'abandoned' });
    const answer = await new SetupIntentsResource(buildTestClient(canceled.fetch)).cancel(
      'seti_1',
      {
        cancellation_reason: 'abandoned',
      },
    );
    expect(answer.status).toBe('canceled');
    expect(callOf(canceled.requests)?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/setup_intents/seti_1/cancel`,
    );
  });
});
