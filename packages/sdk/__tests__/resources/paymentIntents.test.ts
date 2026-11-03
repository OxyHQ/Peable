import { describe, expect, test } from 'bun:test';
import type { PaymentIntent } from '@peable.to/shared-types';
import { PaymentIntentsResource } from '../../src/resources/paymentIntents';
import { PeableCardError, PeableInvalidRequestError } from '../../src/core/errors';
import { cardIntentFixture, paymentIntentFixture } from '../support/intentFixture';
import { createMockFetch } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const SAMPLE_INTENT: PaymentIntent = paymentIntentFixture({ id: 'pi_1' });

describe('PaymentIntentsResource', () => {
  test('create() POSTs /v1/payment_intents with body + Idempotency-Key + bearer, returns the DTO', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 201, json: SAMPLE_INTENT };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    const intent = await resource.create(
      { amount: '100000', network: 'testnet' },
      { idempotencyKey: 'idem-abc' },
    );

    expect(intent).toEqual(SAMPLE_INTENT);
    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents`);
    expect(call?.headers.get('Idempotency-Key')).toBe('idem-abc');
    expect(call?.headers.get('Authorization')).toBe('Bearer svc_test_token');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ amount: '100000', network: 'testnet' });
  });

  test('create() without options sends a minted Idempotency-Key — the key is optional', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 201, json: SAMPLE_INTENT };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    await resource.create({ amount: '100000', network: 'testnet' });

    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('retrieve() GETs /v1/payment_intents/:id', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { id: 'pi_1', object: 'payment_intent', status: 'succeeded' } };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    await resource.retrieve('pi_1');

    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1`);
  });

  test('list() GETs /v1/payment_intents with status/limit/starting_after query params', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return { status: 200, json: { object: 'list', data: [], has_more: false } };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    await resource.list({ status: 'succeeded', limit: 5, customer: 'cus_1' });

    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    const url = new URL(call?.url ?? '');
    expect(url.pathname).toBe('/v1/payment_intents');
    expect(url.searchParams.get('status')).toBe('succeeded');
    expect(url.searchParams.get('customer')).toBe('cus_1');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.has('starting_after')).toBe(false);
  });

  test('cancel() POSTs /v1/payment_intents/:id/cancel with the reason', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 200,
        json: paymentIntentFixture({
          id: 'pi_1',
          status: 'canceled',
          cancellation_reason: 'duplicate',
          canceled_at: 1767225100,
        }),
      };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    const intent = await resource.cancel('pi_1', { cancellation_reason: 'duplicate' });

    expect(intent.status).toBe('canceled');
    expect(intent.cancellation_reason).toBe('duplicate');
    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/cancel`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ cancellation_reason: 'duplicate' });
  });

  test('capture() POSTs amount_to_capture to /capture', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 200,
        json: cardIntentFixture({ id: 'pi_1', status: 'succeeded', amount_received: '700' }),
      };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    const intent = await resource.capture('pi_1', { amount_to_capture: '700' });

    expect(intent.amount_received).toBe('700');
    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/capture`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ amount_to_capture: '700' });
  });

  test('confirm() POSTs the payment method; a decline is a PeableCardError carrying the intent', async () => {
    const declined = cardIntentFixture({
      id: 'pi_1',
      payment_method: 'pm_1',
      last_payment_error: {
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'The card has insufficient funds.',
      },
    });
    const { fetch: fetchImpl, requests } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 402,
        json: {
          error: {
            type: 'card_error',
            code: 'card_declined',
            decline_code: 'insufficient_funds',
            message: 'The card has insufficient funds.',
            payment_intent: declined,
            request_id: 'req_1',
          },
        },
      };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    const error = await resource
      .confirm('pi_1', { payment_method: 'pm_1', off_session: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeableCardError);
    const card = error as PeableCardError;
    expect(card.statusCode).toBe(402);
    expect(card.code).toBe('card_declined');
    expect(card.declineCode).toBe('insufficient_funds');
    expect(card.paymentIntent?.status).toBe('requires_payment_method');
    const call = requests.find((r) => !r.url.includes('/auth/service-token'));
    expect(call?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_intents/pi_1/confirm`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ payment_method: 'pm_1', off_session: true });
  });

  test('there is no reject(): /cancel replaced it (ADR 0019)', () => {
    expect('reject' in PaymentIntentsResource.prototype).toBe(false);
  });

  test('propagates a mapped PeableError on a non-2xx Gateway response', async () => {
    const { fetch: fetchImpl } = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 404,
        json: { error: { type: 'invalid_request_error', message: 'payment intent not found' } },
      };
    });
    const resource = new PaymentIntentsResource(buildTestClient(fetchImpl));

    await expect(resource.retrieve('pi_missing')).rejects.toBeInstanceOf(PeableInvalidRequestError);
  });
});
