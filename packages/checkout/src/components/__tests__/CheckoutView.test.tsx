import { afterEach, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
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
}));

const { CheckoutView } = await import('../CheckoutView');

function makeIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_live123',
    object: 'payment_intent',
    status: 'broadcast',
    rail: 'faircoin',
    amount: '150000000',
    currency: 'FAIR',
    network: 'testnet',
    address: 'TAddressExample1111111111111111111',
    merchantId: 'merch_1',
    txid: 'deadbeef',
    confirmations: 0,
    clientSecret: 'pi_live123_secret',
    metadata: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  capturedOnUpdate = null;
  subscribeMock.mockClear();
  unsubscribeMock.mockClear();
});

test('renders the initial snapshot, advances on a socket update, and shows the success CTA once settled', async () => {
  const initialIntent = makeIntent({ status: 'broadcast' });
  const { unmount } = render(
    <CheckoutView intent={initialIntent} successUrl="https://merchant.example/thanks" />,
  );

  // First frame is the REST snapshot the route already loaded, not a fetch.
  expect(screen.getByText(/payment sent/i)).toBeDefined();

  await screen.findByText(/payment sent/i);
  expect(subscribeMock).toHaveBeenCalledWith(
    initialIntent.id,
    initialIntent.clientSecret,
    expect.any(Function),
    // The connection-state callback. Asserted here as well as in
    // `CheckoutViewReconnect.test.tsx` because a change that dropped it would
    // otherwise only break the file that is about it, and this is the case that
    // pins the whole call shape.
    expect.any(Function),
  );
  expect(capturedOnUpdate).not.toBeNull();

  // Simulate a `confirming` push from the socket.
  const confirmingIntent = makeIntent({ status: 'confirming', confirmations: 2 });
  act(() => {
    capturedOnUpdate?.(confirmingIntent);
  });
  expect(await screen.findByText(/confirming/i)).toBeDefined();
  expect(screen.getByText(/2 confirmation\(s\) so far/i)).toBeDefined();

  // Simulate the terminal `settled` push.
  const settledIntent = makeIntent({ status: 'settled', confirmations: 6 });
  act(() => {
    capturedOnUpdate?.(settledIntent);
  });
  expect(await screen.findByText(/payment settled/i)).toBeDefined();
  const cta = screen.getByRole('link', { name: /continue/i });
  expect(cta.getAttribute('href')).toBe('https://merchant.example/thanks');

  unmount();
  expect(unsubscribeMock).toHaveBeenCalledTimes(1);
});

test('does not show a success CTA without a successUrl', async () => {
  const settledIntent = makeIntent({ status: 'settled' });
  render(<CheckoutView intent={settledIntent} />);

  expect(await screen.findByText(/payment settled/i)).toBeDefined();
  expect(screen.queryByRole('link', { name: /continue/i })).toBeNull();
});
