import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { PaymentIntent } from '@peable.to/shared-types';

// App renders IntentRoute for `/i/:intentId`, which touches
// `@peable.to/sdk/checkout` through this app's one touchpoint,
// `lib/intentClient.ts`. Mock it here the same way every route suite does
// (see routes/__tests__/IntentRoute.test.tsx) so this suite exercises App's
// own routing/rendering behavior, independent of whatever state the SDK's
// `dist/` build happens to be in.
const getPaymentIntentMock = mock(async (): Promise<PaymentIntent> => {
  throw new Error('getPaymentIntentMock not configured for this test');
});
mock.module('../lib/intentClient', () => ({
  getPaymentIntent: getPaymentIntentMock,
  subscribe: mock(async () => () => undefined),
  submitTx: mock(async () => {
    throw new Error('submitTx is not exercised by App');
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

// Renders the full CheckoutView -> PayWithPeable -> Qr chain, which draws to
// a real <canvas> 2D context — unsupported by happy-dom (no canvas rendering
// engine), unrelated to what this suite tests. Stub it out (same pattern as
// IntentRoute.test.tsx / LinkRoute.test.tsx).
mock.module('qr-creator/dist/qr-creator.es6.min.js', () => ({
  default: { render: () => undefined },
}));

const { App } = await import('../App');

function makeIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_test123',
    object: 'payment_intent',
    status: 'created',
    rail: 'faircoin',
    amount: '100000000',
    currency: 'FAIR',
    network: 'testnet',
    address: 'TAddressExample1111111111111111111',
    merchantId: 'merch_1',
    txid: null,
    confirmations: 0,
    clientSecret: 'pi_test123_secret_abc',
    metadata: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  getPaymentIntentMock.mockReset();
});

afterEach(() => {
  cleanup();
});

test('renders the payment intent route shell, then the CheckoutView once the client resolves an intent', async () => {
  const intent = makeIntent();
  getPaymentIntentMock.mockImplementation(async () => intent);

  window.history.pushState({}, '', '/i/pi_test123#client_secret=pi_test123_secret_abc');
  render(<App />);

  expect(screen.getByText(/loading payment intent pi_test123/i)).toBeDefined();
  expect(await screen.findByText('1 FAIR')).toBeDefined();
  expect(getPaymentIntentMock).toHaveBeenCalledWith('pi_test123', 'pi_test123_secret_abc');
});

test('shows the error state once the client rejects', async () => {
  getPaymentIntentMock.mockImplementation(async () => {
    throw new Error('Payment intent not found.');
  });

  window.history.pushState({}, '', '/i/pi_test123#client_secret=pi_test123_secret_abc');
  render(<App />);

  expect(await screen.findByText('Payment intent not found.')).toBeDefined();
});

test('renders a not-found shell for an unknown route', () => {
  window.history.pushState({}, '', '/does-not-exist');
  render(<App />);

  expect(screen.getByText(/page not found/i)).toBeDefined();
});
