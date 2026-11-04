import { afterEach, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { intentFixture } from '../../__tests__/intentFixture';
import type { PaymentIntent } from '@peable.to/shared-types';

// Stubbed `@peable.to/sdk/checkout` client (via this app's one touchpoint,
// `intentClient.ts`) — captures the `onUpdate` callback `subscribe` was
// given so the test can simulate a socket push directly, and tracks the
// returned unsubscribe so unmount-cleanup is verifiable.
let capturedOnUpdate: ((intent: PaymentIntent) => void) | null = null;
const unsubscribeMock = mock(() => undefined);
const subscribeMock = mock(
  async (_id: string, _clientSecret: string, onUpdate: (intent: PaymentIntent) => void) => {
    capturedOnUpdate = onUpdate;
    return unsubscribeMock;
  },
);
mock.module('../../lib/intentClient', () => ({
  getPaymentIntent: mock(async () => {
    throw new Error('not used by CheckoutView');
  }),
  subscribe: subscribeMock,
  submitTx: mock(async () => {
    throw new Error('not used by CheckoutView');
  }),
  /**
   * Present because `mock.module` replaces the WHOLE module, process-wide.
   *
   * A factory that omits an export makes every OTHER file importing it fail
   * with `Export named 'x' not found` — and which file that is depends on bun's
   * run order, so the symptom appears in a file that never mentioned the name.
   * Throwing rather than stubbing keeps it honest: nothing here renders a card
   * form, so a call would be a surprise worth seeing.
   */
  getClientAction: mock(async () => {
    throw new Error('getClientAction is not exercised by this suite');
  }),
}));

const { CheckoutView } = await import('../CheckoutView');

function makeIntent(
  overrides: Partial<PaymentIntent> = {},
  chain: Partial<NonNullable<PaymentIntent['faircoin']>> = { txid: 'deadbeef' },
): PaymentIntent {
  return intentFixture(
    {
      id: 'pi_live123',
      rail: 'faircoin',
      status: 'processing',
      amount: '150000000',
      client_secret: 'pi_live123_secret',
      expires_at: Math.floor((Date.now() + 60_000) / 1000),
      ...overrides,
    },
    chain,
  );
}

afterEach(() => {
  cleanup();
  capturedOnUpdate = null;
  subscribeMock.mockClear();
  unsubscribeMock.mockClear();
});

test('renders the initial snapshot and advances on every socket update', async () => {
  const initialIntent = makeIntent({ status: 'processing' });
  const { unmount } = render(<CheckoutView intent={initialIntent} />);

  // First frame is the REST snapshot the route already loaded, not a fetch.
  expect(screen.getByText(/payment sent/i)).toBeDefined();

  await screen.findByText(/payment sent/i);
  expect(subscribeMock).toHaveBeenCalledWith(
    initialIntent.id,
    initialIntent.client_secret,
    expect.any(Function),
    // The connection-state callback. Asserted here as well as in
    // `CheckoutViewReconnect.test.tsx` because a change that dropped it would
    // otherwise only break the file that is about it, and this is the case that
    // pins the whole call shape.
    expect.any(Function),
  );
  expect(capturedOnUpdate).not.toBeNull();

  // Simulate a confirmation-count push from the socket.
  const confirmingIntent = makeIntent(
    { status: 'processing' },
    { txid: 'deadbeef', confirmations: 2 },
  );
  act(() => {
    capturedOnUpdate?.(confirmingIntent);
  });
  expect(await screen.findByText(/confirming/i)).toBeDefined();
  expect(screen.getByText(/2 of 6 confirmation\(s\) so far/i)).toBeDefined();

  // Simulate the terminal `succeeded` push.
  const settledIntent = makeIntent({ status: 'succeeded' }, { txid: 'deadbeef', confirmations: 6 });
  act(() => {
    capturedOnUpdate?.(settledIntent);
  });
  expect(await screen.findByText(/payment complete/i)).toBeDefined();
  // Leaving for the merchant is the SESSION's decision, never this view's.
  expect(screen.queryByRole('link')).toBeNull();

  unmount();
  expect(unsubscribeMock).toHaveBeenCalledTimes(1);
});

test('a succeeded payment offers no link of its own', async () => {
  const settledIntent = makeIntent({ status: 'succeeded' });
  render(<CheckoutView intent={settledIntent} />);

  expect(await screen.findByText(/payment complete/i)).toBeDefined();
  expect(screen.queryByRole('link', { name: /continue/i })).toBeNull();
});
