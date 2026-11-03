import { intentDTO } from '../../__tests__/helpers/intentFixture';
import { test, expect } from 'bun:test';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { SsrfRejection, type SafeFetchResult } from '@oxy.so/core/server';
import { verifyWebhook, type PaymentIntent, type WebhookEvent } from '@peable.to/shared-types';
import { attemptDelivery, type SafeFetchFn, type WebhookTarget } from '../webhookDispatcher';

const TOLERANCE_SEC = 300;

const SECRET = 'whsec_test_secret';
const TARGET: WebhookTarget = {
  url: 'https://merchant.example/peable/webhook',
  secrets: [SECRET],
};

const INTENT: PaymentIntent = intentDTO();

/** A stored event as the dispatcher renders it (`toEventDTO`). */
function buildEvent(
  type: 'payment_intent.succeeded' | 'payment_intent.payment_failed',
  object: PaymentIntent,
): WebhookEvent {
  return {
    id: 'evt_0000000000000000000000a1',
    object: 'event',
    type,
    created: 1_784_332_800,
    livemode: false,
    api_version: '2026-11-03',
    data: { object },
    request: { id: null, idempotency_key: null },
  };
}

// Build a SafeFetchResult backed by a REAL IncomingMessage so `response`
// satisfies the type without a cast, while letting us observe destroy().
function fakeResult(status: number): {
  result: SafeFetchResult;
  wasDestroyed: () => boolean;
} {
  const response = new IncomingMessage(new Socket());
  let destroyed = false;
  response.destroy = (_error?: Error) => {
    destroyed = true;
    return response;
  };
  return {
    result: { response, status, headers: {}, finalUrl: TARGET.url },
    wasDestroyed: () => destroyed,
  };
}

test('delivers a correctly-signed webhook and destroys the response on 2xx', async () => {
  const captured: { body?: string; signature?: string; contentType?: string } = {};
  const { result, wasDestroyed } = fakeResult(200);
  const fakeSafeFetch: SafeFetchFn = async (_url, options) => {
    captured.body = typeof options?.body === 'string' ? options.body : undefined;
    captured.signature = options?.headers?.['Peable-Signature'];
    captured.contentType = options?.headers?.['Content-Type'];
    return result;
  };

  const event = buildEvent('payment_intent.succeeded', INTENT);
  const outcome = await attemptDelivery(event, TARGET, { safeFetch: fakeSafeFetch });

  expect(outcome).toEqual({ kind: 'delivered' });
  expect(captured.contentType).toBe('application/json');
  if (captured.body === undefined || captured.signature === undefined) {
    throw new Error('safeFetch was not called with a body + signature header');
  }
  expect(captured.body).toBe(JSON.stringify(event));
  expect(
    verifyWebhook(
      SECRET,
      captured.body,
      captured.signature,
      TOLERANCE_SEC,
      Math.floor(Date.now() / 1000),
    ),
  ).toBe(true);
  expect(wasDestroyed()).toBe(true);
});

/**
 * ONE request per call, whatever happens.
 *
 * This function used to loop internally — three attempts inside 150ms — and
 * that loop is what made a merchant's brief outage a lost event: it could only
 * retry for as long as one caller was willing to wait. The retry schedule now
 * belongs to the outbox, so the property to pin here is that this makes exactly
 * one attempt and reports what it saw.
 */
test('makes exactly one request, whatever the response', async () => {
  for (const status of [200, 500, 422]) {
    let calls = 0;
    const fakeSafeFetch: SafeFetchFn = async () => {
      calls += 1;
      return fakeResult(status).result;
    };
    await attemptDelivery(buildEvent('payment_intent.succeeded', INTENT), TARGET, {
      safeFetch: fakeSafeFetch,
    });
    expect(calls).toBe(1);
  }
});

/**
 * The classification IS the retry policy — the outbox reschedules a `retry` and
 * closes a `refused`, so getting these the wrong way round either abandons a
 * recoverable endpoint or hammers one that will never accept the payload.
 */
test('classifies a 5xx as retryable and a 4xx as refused', async () => {
  const { result: serverError, wasDestroyed: serverDestroyed } = fakeResult(503);
  const retry = await attemptDelivery(buildEvent('payment_intent.succeeded', INTENT), TARGET, {
    safeFetch: async () => serverError,
  });
  expect(retry.kind).toBe('retry');
  expect(serverDestroyed()).toBe(true);

  const { result: rejected, wasDestroyed: rejectedDestroyed } = fakeResult(422);
  const refused = await attemptDelivery(
    buildEvent('payment_intent.payment_failed', INTENT),
    TARGET,
    {
      safeFetch: async () => rejected,
    },
  );
  expect(refused.kind).toBe('refused');
  expect(rejectedDestroyed()).toBe(true);
});

test('an SsrfRejection is refused, not retried', async () => {
  const outcome = await attemptDelivery(buildEvent('payment_intent.succeeded', INTENT), TARGET, {
    safeFetch: async () => {
      throw new SsrfRejection('blocked');
    },
  });

  expect(outcome.kind).toBe('refused');
});

/**
 * An unrecognised failure is RETRYABLE, and the direction is deliberate:
 * assuming an unknown defect is permanent is how a recoverable outage becomes
 * an abandoned event, and the attempt budget bounds the cost of being wrong
 * this way round.
 */
test('an unrecognised error is retryable', async () => {
  const outcome = await attemptDelivery(buildEvent('payment_intent.succeeded', INTENT), TARGET, {
    safeFetch: async () => {
      throw new Error('something nobody anticipated');
    },
  });

  expect(outcome.kind).toBe('retry');
});

/**
 * During a secret's rotation overlap the target carries BOTH secrets, and the
 * header carries one `v1=` per secret: a receiver that has not switched yet and
 * one that has both verify the same delivery.
 */
test('signs with every secret of the target, one v1 each', async () => {
  let signature: string | undefined;
  let body: string | undefined;
  await attemptDelivery(
    buildEvent('payment_intent.succeeded', INTENT),
    { url: TARGET.url, secrets: ['whsec_new', 'whsec_old'] },
    {
      safeFetch: async (_url, options) => {
        signature = options?.headers?.['Peable-Signature'];
        body = typeof options?.body === 'string' ? options.body : undefined;
        return fakeResult(200).result;
      },
    },
  );
  if (signature === undefined || body === undefined) throw new Error('nothing was sent');
  expect(signature.split(',').filter((part) => part.startsWith('v1='))).toHaveLength(2);
  const now = Math.floor(Date.now() / 1000);
  expect(verifyWebhook('whsec_new', body, signature, TOLERANCE_SEC, now)).toBe(true);
  expect(verifyWebhook('whsec_old', body, signature, TOLERANCE_SEC, now)).toBe(true);
  expect(verifyWebhook('whsec_other', body, signature, TOLERANCE_SEC, now)).toBe(false);
});
