import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { installCheckoutMocks, mocks, resetMocks } from '../../__tests__/checkoutMocks';
import { sessionFixture } from '../../__tests__/sessionFixture';

installCheckoutMocks();
const { SessionRoute } = await import('../SessionRoute');

const SECRET = 'cs_0123456789abcdef01234567_secret_00112233445566778899aabbccddeeff';

beforeEach(() => {
  resetMocks();
});
afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
});

function renderAt(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/c/:sessionId" element={<SessionRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('reads the secret from the fragment and loads the session with it', async () => {
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture());
  renderAt(`/c/cs_0123456789abcdef01234567#cs=${SECRET}`);
  expect(await screen.findByText('Notebook')).toBeTruthy();
  expect(mocks.getCheckoutSession).toHaveBeenCalledWith('cs_0123456789abcdef01234567', SECRET);
});

test('never loads without a fragment secret — a query-string secret is not accepted', async () => {
  renderAt(`/c/cs_0123456789abcdef01234567?cs=${SECRET}`);
  expect(
    await screen.findByText('This checkout link is missing required parameters.'),
  ).toBeTruthy();
  expect(mocks.getCheckoutSession).not.toHaveBeenCalled();
});

test("renders in the session's locale and sets the document language", async () => {
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture({ locale: 'es' }));
  renderAt(`/c/cs_0123456789abcdef01234567#cs=${SECRET}`);
  expect(await screen.findByText('Resumen del pedido')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Pagar/ })).toBeTruthy();
  expect(document.documentElement.lang).toBe('es');
});

test('a ?locale= override wins over the merchant locale', async () => {
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture({ locale: 'es' }));
  window.history.pushState({}, '', '/c/cs_0123456789abcdef01234567?locale=de');
  renderAt(`/c/cs_0123456789abcdef01234567?locale=de#cs=${SECRET}`);
  expect(await screen.findByText('Bestellübersicht')).toBeTruthy();
  window.history.pushState({}, '', '/');
});

test('a load failure is shown', async () => {
  mocks.getCheckoutSession.mockImplementation(async () => {
    throw new Error('checkout session not found');
  });
  renderAt(`/c/cs_0123456789abcdef01234567#cs=${SECRET}`);
  expect((await screen.findByRole('alert')).textContent).toBe('checkout session not found');
});

test('merchant account contact omits email without removing required billing details', async () => {
  const session = sessionFixture({
    contact_collection: 'merchant_account',
    billing_address_collection: 'required',
  });
  session.customer_details.email = null;
  mocks.getCheckoutSession.mockImplementation(async () => session);
  renderAt(`/c/cs_0123456789abcdef01234567#cs=${SECRET}`);
  expect(await screen.findByText('Order summary')).toBeTruthy();
  expect(screen.queryByLabelText(/^Email/)).toBeNull();
  expect(screen.getByLabelText(/^Country/)).toBeTruthy();
});
