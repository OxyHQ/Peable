/**
 * A socket that drops AFTER `subscribe` has already resolved.
 *
 * Its own file for the same reason `CheckoutViewFallback.test.tsx` is: it needs
 * a `subscribe` that SUCCEEDS and then hands back a connection-state callback,
 * which is the opposite stub from both neighbours.
 *
 * ## The gap this covers
 *
 * The fallback only ever ran when `subscribe` REJECTED. Once it resolved, a
 * later drop set nothing: `realtimeUnavailable` stayed false, the poll never
 * started, and socket.io — which reconnects the transport on its own but
 * replays no frames — silently lost every update emitted during the gap. A
 * payment that settled during a thirty-second blip never reached the page, and
 * the payer watched a snapshot that could no longer change.
 */
import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { PaymentIntent } from '@peable.to/shared-types';

type ConnectionListener = (state: 'live' | 'lost') => void;

/** The callback `CheckoutView` hands the SDK, captured so a test can fire it. */
let onConnectionChange: ConnectionListener | null = null;
let unsubscribed = 0;

const subscribeMock = mock(
  async (
    _id: string,
    _clientSecret: string,
    _onUpdate: (intent: PaymentIntent) => void,
    onChange?: ConnectionListener,
  ) => {
    onConnectionChange = onChange ?? null;
    return () => {
      unsubscribed += 1;
    };
  },
);

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
    id: 'pi_reconnect1',
    object: 'payment_intent',
    rail: 'faircoin',
    status: 'broadcast',
    amount: '150000000',
    currency: 'FAIR',
    network: 'testnet',
    address: 'TAddressExample1111111111111111111',
    merchantId: 'merch_1',
    txid: 'deadbeef',
    confirmations: 0,
    clientSecret: 'pi_reconnect1_secret',
    metadata: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

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

async function fire(state: 'live' | 'lost'): Promise<void> {
  await act(async () => {
    onConnectionChange?.(state);
  });
  await flush();
}

beforeEach(() => {
  polled = null;
  unsubscribed = 0;
  onConnectionChange = null;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  subscribeMock.mockClear();
  getPaymentIntentMock.mockClear();
});

/**
 * The SDK is only useful here if the view actually asks for the reports, so
 * this is the floor under every case below: without a callback passed, every
 * assertion that follows would be about a listener nobody installed.
 */
test('the view subscribes with a connection-state callback', async () => {
  render(<CheckoutView intent={makeIntent()} />);
  await flush();

  expect(subscribeMock).toHaveBeenCalledTimes(1);
  expect(onConnectionChange).toBeInstanceOf(Function);
});

test('a drop after a successful subscribe starts polling', async () => {
  render(<CheckoutView intent={makeIntent()} />);
  await flush();

  // Live: nothing polls, which is the behaviour a working socket must keep.
  await tick();
  expect(getPaymentIntentMock).toHaveBeenCalledTimes(0);

  await fire('lost');
  polled = makeIntent({ status: 'settled' });
  await tick();

  expect(getPaymentIntentMock.mock.calls.length).toBeGreaterThan(0);
  expect(screen.getByText('Payment settled')).toBeTruthy();
});

/**
 * The ordering, which is the actual fix.
 *
 * socket.io replays nothing, so a transition during the outage exists only in
 * the gateway. Standing the poll down on `'live'` without re-reading would
 * leave the page on a snapshot from before the drop, with the poll off and no
 * frame coming — a payer stuck on "waiting" for a payment that settled.
 */
test('recovery re-reads the intent rather than trusting the socket', async () => {
  render(<CheckoutView intent={makeIntent()} />);
  await flush();

  await fire('lost');
  // Settled while nothing was listening.
  polled = makeIntent({ status: 'settled' });
  await fire('live');

  expect(getPaymentIntentMock.mock.calls.length).toBeGreaterThan(0);
  expect(screen.getByText('Payment settled')).toBeTruthy();
});

/**
 * And the poll stands down once that read lands — otherwise every recovered
 * socket would leave a permanent 5s poll behind it, on every open tab.
 */
test('polling stops once the recovery read has landed', async () => {
  render(<CheckoutView intent={makeIntent()} />);
  await flush();

  await fire('lost');
  polled = makeIntent({ status: 'confirming' });
  await fire('live');

  getPaymentIntentMock.mockClear();
  await tick();
  expect(getPaymentIntentMock).toHaveBeenCalledTimes(0);
});

/**
 * A recovery whose re-read fails must NOT stand the poll down: that read is the
 * only thing that would have caught up on the outage, and dropping both leaves
 * the same frozen page the whole change is about.
 */
test('a failed recovery read keeps polling', async () => {
  render(<CheckoutView intent={makeIntent()} />);
  await flush();

  await fire('lost');
  // `polled` is null, so the recovery read rejects.
  await fire('live');

  polled = makeIntent({ status: 'settled' });
  await tick();

  expect(screen.getByText('Payment settled')).toBeTruthy();
});

/** Unmounting still tears the subscription down; none of the above leaks one. */
test('unmounting unsubscribes', async () => {
  const { unmount } = render(<CheckoutView intent={makeIntent()} />);
  await flush();

  unmount();
  expect(unsubscribed).toBe(1);
});
