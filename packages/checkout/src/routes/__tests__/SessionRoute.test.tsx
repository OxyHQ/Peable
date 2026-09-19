import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CheckoutSessionPublic, PaymentIntent } from '@peable.to/shared-types';

// SessionRoute never touches `../lib/intentClient` directly, but
// CheckoutView -> subscribe() does — mock it the same way LinkRoute.test.tsx
// does so the realtime subscription doesn't hit a real socket.
mock.module('../../lib/intentClient', () => ({
  getPaymentIntent: mock(async () => {
    throw new Error('not used by SessionRoute');
  }),
  subscribe: mock(async () => () => undefined),
  submitTx: mock(async () => {
    throw new Error('not used by SessionRoute');
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
// a real <canvas> 2D context — unsupported by happy-dom. Stub it out (same
// as LinkRoute.test.tsx/IntentRoute.test.tsx).
mock.module('qr-creator/dist/qr-creator.es6.min.js', () => ({
  default: { render: () => undefined },
}));

const { SessionRoute } = await import('../SessionRoute');

function makeIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_wrapped456',
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
    clientSecret: 'session_secret_abc',
    metadata: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const SESSION: CheckoutSessionPublic = {
  id: 'cs_test123',
  object: 'checkout_session',
  successUrl: 'https://merchant.example/thanks',
  merchant: { name: 'Test Merchant', avatarUrl: null, description: null },
  paymentIntent: makeIntent(),
};

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;
let capturedUrl: string | undefined;
let capturedInit: RequestInit | undefined;

beforeEach(() => {
  capturedUrl = undefined;
  capturedInit = undefined;
  fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = typeof input === 'string' ? input : input.toString();
    capturedInit = init;
    return new Response(JSON.stringify(SESSION), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderSessionRoute(hash: string) {
  window.history.pushState({}, '', `/c/cs_test123${hash}`);
  render(
    <MemoryRouter initialEntries={['/c/cs_test123']}>
      <Routes>
        <Route path="/c/:sessionId" element={<SessionRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('sends the fragment client_secret via the X-Peable-Client-Secret header, never a query param', async () => {
  renderSessionRoute('#cs=session_secret_abc');

  expect(await screen.findByText('1 FAIR')).toBeDefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(capturedUrl).not.toContain('client_secret');
  expect(capturedUrl?.endsWith('/v1/checkout_sessions/cs_test123/public')).toBe(true);
  expect(new Headers(capturedInit?.headers).get('X-Peable-Client-Secret')).toBe(
    'session_secret_abc',
  );
});

test('shows an error and never calls the Gateway when the fragment has no client_secret', async () => {
  renderSessionRoute('');

  expect(
    await screen.findByText('This checkout link is missing required parameters.'),
  ).toBeDefined();
  expect(fetchMock).not.toHaveBeenCalled();
});
