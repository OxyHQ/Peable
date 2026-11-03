/** The payer client's checkout-session, payment-link and setup calls (Orbit Phase 3). */
import { afterEach, describe, expect, test } from 'bun:test';
import { createPeableCheckout } from '../../src/browser/payerClient';
import { PeableInvalidRequestError } from '../../src/core/errors';
import { createMockFetch } from '../support/mockFetch';
import { TEST_GATEWAY_URL } from '../support/testGateway';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SESSION_SECRET = 'cs_0123456789abcdef01234567_secret_00112233445566778899aabbccddeeff';

describe('checkout session and payment link payer calls', () => {
  test('getCheckoutSession sends the session secret as a header, never in the URL', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: { id: 'cs_1', object: 'checkout_session' },
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await client.getCheckoutSession('cs_1', SESSION_SECRET);

    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(`${TEST_GATEWAY_URL}/v1/checkout_sessions/cs_1/public`);
    expect(requests[0]?.headers.get('X-Peable-Client-Secret')).toBe(SESSION_SECRET);
  });

  test('updateCheckoutSession POSTs the payer changes; confirm POSTs to /confirm', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: { id: 'cs_1', object: 'checkout_session' },
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await client.updateCheckoutSession('cs_1', SESSION_SECRET, {
      line_items: [{ id: 'li_1', quantity: 3 }],
      promotion_code: 'SUMMER',
    });
    await client.confirmCheckoutSession('cs_1', SESSION_SECRET);

    expect(requests[0]?.method).toBe('POST');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      line_items: [{ id: 'li_1', quantity: 3 }],
      promotion_code: 'SUMMER',
    });
    expect(requests[1]?.url).toBe(`${TEST_GATEWAY_URL}/v1/checkout_sessions/cs_1/public/confirm`);
    expect(requests[1]?.headers.get('X-Peable-Client-Secret')).toBe(SESSION_SECRET);
  });

  test('a refusal surfaces as a typed error', async () => {
    const { fetch: fetchImpl } = createMockFetch(() => ({
      status: 400,
      json: {
        error: {
          type: 'invalid_request_error',
          code: 'promotion_code_invalid',
          param: 'promotion_code',
          message: 'This code is not valid.',
        },
      },
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await expect(
      client.updateCheckoutSession('cs_1', SESSION_SECRET, { promotion_code: 'NOPE' }),
    ).rejects.toBeInstanceOf(PeableInvalidRequestError);
  });

  test('startPaymentLinkSession POSTs with the operation key; getPaymentLink is anonymous', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch((req) => ({
      status: req.method === 'POST' ? 201 : 200,
      json: { id: 'cs_1', object: 'checkout_session_start' },
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await client.getPaymentLink('link_1');
    await client.startPaymentLinkSession(
      'link_1',
      { amount: '500000000' },
      '6f1d0c8e-2b4a-4c1e-9f3a-0a1b2c3d4e5f',
    );

    expect(requests[0]?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_links/link_1/public`);
    expect(requests[0]?.headers.get('X-Peable-Client-Secret')).toBe(null);
    expect(requests[1]?.url).toBe(`${TEST_GATEWAY_URL}/v1/payment_links/link_1/checkout_sessions`);
    expect(requests[1]?.headers.get('Idempotency-Key')).toBe(
      '6f1d0c8e-2b4a-4c1e-9f3a-0a1b2c3d4e5f',
    );
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({ amount: '500000000' });
  });

  test('getSetupIntent and getSetupClientAction authorize with the SetupIntent secret', async () => {
    const { fetch: fetchImpl, requests } = createMockFetch(() => ({
      status: 200,
      json: { object: 'client_action', kind: 'client_secret', value: 'x' },
    }));
    globalThis.fetch = fetchImpl;
    const client = createPeableCheckout({ gatewayUrl: TEST_GATEWAY_URL });

    await client.getSetupIntent('seti_1', 'seti_1_secret_x');
    await client.getSetupClientAction('seti_1', 'seti_1_secret_x');

    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(`${TEST_GATEWAY_URL}/v1/setup_intents/seti_1`);
    expect(requests[1]?.method).toBe('POST');
    expect(requests[1]?.url).toBe(`${TEST_GATEWAY_URL}/v1/setup_intents/seti_1/client_action`);
    expect(requests[1]?.headers.get('X-Peable-Client-Secret')).toBe('seti_1_secret_x');
  });
});
