import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PaymentIntent } from '@peable.to/shared-types';

// Reuse-if-open (spec §6) never exercises the real `@peable.to/sdk/checkout`
// stub — mock this app's one SDK touchpoint instead; `App.test.tsx` covers
// the real (unmocked) stub behavior.
const getPaymentIntentMock = mock(async (): Promise<PaymentIntent> => {
  throw new Error('getPaymentIntentMock not configured for this test');
});
mock.module('../../lib/intentClient', () => ({
  getPaymentIntent: getPaymentIntentMock,
  subscribe: mock(async () => () => undefined),
  submitTx: mock(async () => {
    throw new Error('submitTx is not exercised by IntentRoute');
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
// a real <canvas> 2D context — unsupported by happy-dom. Stub it out; `Qr`
// itself isn't exercised here (see LinkRoute.test.tsx for the same stub).
mock.module('qr-creator/dist/qr-creator.es6.min.js', () => ({
  default: { render: () => undefined },
}));

const { IntentRoute } = await import('../IntentRoute');

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

function renderIntentRoute(pathAndSearch: string, hash: string) {
  window.history.pushState({}, '', `${pathAndSearch}${hash}`);
  render(
    <MemoryRouter initialEntries={[pathAndSearch]}>
      <Routes>
        <Route path="/i/:intentId" element={<IntentRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('reads client_secret from the URL fragment and loads the intent', async () => {
  const intent = makeIntent();
  getPaymentIntentMock.mockImplementation(async () => intent);

  renderIntentRoute('/i/pi_test123', '#client_secret=pi_test123_secret_abc');

  expect(await screen.findByText('1 FAIR')).toBeDefined();
  expect(getPaymentIntentMock).toHaveBeenCalledWith('pi_test123', 'pi_test123_secret_abc');
  expect(getPaymentIntentMock).toHaveBeenCalledTimes(1);
});

test('ignores a client_secret placed in the query string — the fragment is the only accepted source', async () => {
  renderIntentRoute('/i/pi_test123?client_secret=pi_test123_secret_abc', '');

  expect(
    await screen.findByText('This payment page is missing required parameters.'),
  ).toBeDefined();
  expect(getPaymentIntentMock).not.toHaveBeenCalled();
});
