import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PaymentIntent, PublicPaymentLink } from '@peable.to/shared-types';

// Reuse-if-open (spec §6) never exercises the real `@peable.to/sdk/checkout`
// stub — it's frozen to always reject, so it can't produce the open/terminal
// fixtures this suite needs. Mock this app's one SDK touchpoint instead;
// `App.test.tsx` is the file that covers the real (unmocked) stub behavior.
const getPaymentIntentMock = mock(async (): Promise<PaymentIntent> => {
  throw new Error('getPaymentIntentMock not configured for this test');
});
mock.module('../../lib/intentClient', () => ({
  getPaymentIntent: getPaymentIntentMock,
  subscribe: mock(async () => () => undefined),
  submitTx: mock(async () => {
    throw new Error('submitTx is not exercised by LinkRoute');
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

// A resolved intent now renders the full CheckoutView -> PayWithPeable ->
// Qr chain (Task 9), which draws to a real <canvas> 2D context — unsupported
// by happy-dom (no canvas rendering engine), unrelated to what this suite
// tests (reuse-if-open, not QR rendering). Stub it out; `Qr` itself isn't
// exercised here.
mock.module('qr-creator/dist/qr-creator.es6.min.js', () => ({
  default: { render: () => undefined },
}));

const { LinkRoute } = await import('../LinkRoute');

const LINK: PublicPaymentLink = {
  id: 'link_test123',
  object: 'payment_link',
  amount: '100000000',
  currency: 'FAIR',
  rail: 'faircoin',
  network: 'testnet',
  active: true,
  merchant: { name: 'Test Merchant', avatarUrl: null, description: null },
};

function makeIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_open789',
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
    clientSecret: 'pi_open789_secret',
    metadata: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  sessionStorage.clear();
  getPaymentIntentMock.mockReset();
  fetchMock = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/public')) {
      return new Response(JSON.stringify(LINK), { status: 200 });
    }
    throw new Error(`Unexpected fetch in this test: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderLinkRoute() {
  render(
    <MemoryRouter initialEntries={['/l/link_test123']}>
      <Routes>
        <Route path="/l/:linkId" element={<LinkRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('reuses an open intent without minting a fresh one', async () => {
  sessionStorage.setItem(
    'peable:link-intent:link_test123',
    JSON.stringify({ id: 'pi_open789', clientSecret: 'pi_open789_secret' }),
  );
  const openIntent = makeIntent();
  getPaymentIntentMock.mockImplementation(async () => openIntent);

  renderLinkRoute();
  fireEvent.click(await screen.findByRole('button', { name: /pay/i }));

  // status 'created' is an awaiting-payment state — CheckoutView renders
  // PayWithPeable (amount + deep link/QR), not StatusPanel yet.
  expect(await screen.findByText('1 FAIR')).toBeDefined();
  expect(getPaymentIntentMock).toHaveBeenCalledWith('pi_open789', 'pi_open789_secret');
  // Only the link-details GET should have hit the Gateway — no mint POST.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('mints a fresh intent once the remembered one is terminal', async () => {
  sessionStorage.setItem(
    'peable:link-intent:link_test123',
    JSON.stringify({ id: 'pi_settled999', clientSecret: 'pi_settled999_secret' }),
  );
  const terminalIntent = makeIntent({ id: 'pi_settled999', status: 'settled' });
  getPaymentIntentMock.mockImplementation(async () => terminalIntent);
  const freshIntent = makeIntent({ id: 'pi_fresh456', clientSecret: 'pi_fresh456_secret' });

  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/public')) {
      return new Response(JSON.stringify(LINK), { status: 200 });
    }
    if (url.endsWith('/payment_intent') && init?.method === 'POST') {
      return new Response(JSON.stringify(freshIntent), { status: 200 });
    }
    throw new Error(`Unexpected fetch in this test: ${url}`);
  });

  renderLinkRoute();
  fireEvent.click(await screen.findByRole('button', { name: /pay/i }));

  // status 'created' is an awaiting-payment state — CheckoutView renders
  // PayWithPeable (amount + deep link/QR), not StatusPanel yet.
  expect(await screen.findByText('1 FAIR')).toBeDefined();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem('peable:link-intent:link_test123')).toContain('pi_fresh456');
});
