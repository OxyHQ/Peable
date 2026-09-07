import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { PaymentIntent } from '@peable.to/shared-types';

// Separate file from `CheckoutView.test.tsx` because it needs the OPPOSITE
// stub: a `subscribe` that rejects, so the degraded REST path is what runs.
const subscribeMock = mock(async () => {
  throw new Error('websocket refused');
});
let polled: PaymentIntent | null = null;
const getPaymentIntentMock = mock(async () => {
  if (!polled) throw new Error('gateway unreachable');
  return polled;
});

mock.module('../../lib/intentClient', () => ({
  getPaymentIntent: getPaymentIntentMock,
  subscribe: subscribeMock,
  submitTx: mock(async () => {
    throw new Error('not used by CheckoutView');
  }),
}));

const { CheckoutView } = await import('../CheckoutView');

/** Matches `FALLBACK_POLL_MS` in CheckoutView, plus a margin. */
const ONE_TICK_MS = 5_100;

function makeIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_fallback1',
    object: 'payment_intent',
    // `rail` became a required discriminator on the contract (ADR 0001): it is
    // what decides whether `address`/`network` mean anything. This fixture has
    // both and a txid, so it is a chain payment.
    rail: 'faircoin',
    status: 'broadcast',
    amount: '150000000',
    currency: 'FAIR',
    network: 'testnet',
    address: 'TAddressExample1111111111111111111',
    merchantId: 'merch_1',
    txid: 'deadbeef',
    confirmations: 0,
    clientSecret: 'pi_fallback1_secret',
    metadata: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Drain the microtask queue inside `act`. Timers are faked, but promise jobs
 * are not — the rejected `subscribe` and each poll's `then` settle here.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ONE_TICK_MS);
  });
  await flush();
}

beforeEach(() => {
  polled = null;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  subscribeMock.mockClear();
  getPaymentIntentMock.mockClear();
});

test('a failed subscribe starts polling and the payer sees the settlement', async () => {
  render(<CheckoutView intent={makeIntent()} />);
  await flush();

  // Handing over to the poller costs no immediate request; the initial REST
  // snapshot the route already loaded is the current truth.
  expect(getPaymentIntentMock).toHaveBeenCalledTimes(0);

  polled = makeIntent({ status: 'settled' });
  await tick();

  expect(getPaymentIntentMock.mock.calls.length).toBeGreaterThan(0);
  // The whole point: the page moved off the frozen snapshot on its own, with
  // no refresh from the payer.
  expect(screen.getByText('Payment settled')).toBeTruthy();
});

test('polling stops once the intent is terminal', async () => {
  render(<CheckoutView intent={makeIntent({ status: 'settled' })} />);
  await flush();
  await tick();

  // Nothing can follow `settled`, so re-reading the row is pure waste.
  expect(getPaymentIntentMock).toHaveBeenCalledTimes(0);
});

test('a failed poll is retried on the next tick, not given up on', async () => {
  render(<CheckoutView intent={makeIntent()} />);
  await flush();

  // `polled` is null, so the first read rejects.
  await tick();
  const afterFailure = getPaymentIntentMock.mock.calls.length;
  expect(afterFailure).toBeGreaterThan(0);

  polled = makeIntent({ status: 'settled' });
  await tick();

  expect(getPaymentIntentMock.mock.calls.length).toBeGreaterThan(afterFailure);
  expect(screen.getByText('Payment settled')).toBeTruthy();
});

test('a successful subscribe never polls', async () => {
  subscribeMock.mockImplementationOnce(
    (async () => () => undefined) as unknown as typeof subscribeMock,
  );
  render(<CheckoutView intent={makeIntent()} />);
  await flush();
  await tick();

  expect(getPaymentIntentMock).toHaveBeenCalledTimes(0);
});
