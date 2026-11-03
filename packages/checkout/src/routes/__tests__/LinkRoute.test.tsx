import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { installCheckoutMocks, mocks, resetMocks } from '../../__tests__/checkoutMocks';
import { linkFixture, sessionFixture } from '../../__tests__/sessionFixture';

installCheckoutMocks();
const { LinkRoute } = await import('../LinkRoute');

const LINK = 'link_0123456789abcdef01234567';
const SESSION = 'cs_0123456789abcdef01234567';
const SECRET = `${SESSION}_secret_00112233445566778899aabbccddeeff`;

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.hash}`}</p>;
}

function renderLink() {
  render(
    <MemoryRouter initialEntries={[`/l/${LINK}`]}>
      <Routes>
        <Route path="/l/:linkId" element={<LinkRoute />} />
        <Route path="/c/:sessionId" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMocks();
  sessionStorage.clear();
  mocks.startPaymentLinkSession.mockImplementation(async () => ({
    object: 'checkout_session_start',
    id: SESSION,
    client_secret: SECRET,
    url: `https://checkout.peable.to/c/${SESSION}#cs=${SECRET}`,
  }));
});
afterEach(() => {
  cleanup();
});

test('a price link starts a checkout session and lands on it', async () => {
  mocks.getPaymentLink.mockImplementation(async () => linkFixture());
  renderLink();
  const landed = await screen.findByTestId('landed');
  expect(landed.textContent).toBe(`/c/${SESSION}#cs=${encodeURIComponent(SECRET)}`);
  expect(mocks.startPaymentLinkSession).toHaveBeenCalledWith(LINK, {}, undefined);
});

test('a revisit reuses the open session this tab already has', async () => {
  sessionStorage.setItem(
    `peable:link-session:${LINK}`,
    JSON.stringify({ id: SESSION, clientSecret: SECRET }),
  );
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture());
  mocks.getPaymentLink.mockImplementation(async () => linkFixture());
  renderLink();
  await screen.findByTestId('landed');
  expect(mocks.getCheckoutSession).toHaveBeenCalledWith(SESSION, SECRET);
  expect(mocks.startPaymentLinkSession).not.toHaveBeenCalled();
});

test('a remembered session that is no longer open is replaced', async () => {
  sessionStorage.setItem(
    `peable:link-session:${LINK}`,
    JSON.stringify({ id: 'cs_old', clientSecret: 'cs_old_secret_x' }),
  );
  mocks.getCheckoutSession.mockImplementation(async () => sessionFixture({ status: 'complete' }));
  mocks.getPaymentLink.mockImplementation(async () => linkFixture());
  renderLink();
  await screen.findByTestId('landed');
  expect(mocks.startPaymentLinkSession).toHaveBeenCalledTimes(1);
});

test('an inactive link says so and starts nothing', async () => {
  mocks.getPaymentLink.mockImplementation(async () => linkFixture({ active: false }));
  renderLink();
  expect(await screen.findByText('This payment link is no longer active.')).toBeTruthy();
  expect(mocks.startPaymentLinkSession).not.toHaveBeenCalled();
});

test('a free contribution waits for the amount and starts with a durable operation key', async () => {
  mocks.getPaymentLink.mockImplementation(async () =>
    linkFixture({
      currency: 'FAIR',
      rail: 'faircoin',
      network: 'testnet',
      line_items: [],
      contribution: {
        organization_id: 'org_1',
        purpose: 'Community garden',
        amount_mode: 'free',
        expires_at: null,
      },
    }),
  );
  renderLink();
  expect(await screen.findByText('Community garden')).toBeTruthy();
  expect(mocks.startPaymentLinkSession).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Contribution amount (FAIR)'), {
    target: { value: '2.5' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Contribute once' }));
  await screen.findByTestId('landed');

  const [linkId, params, key] = mocks.startPaymentLinkSession.mock.calls[0] ?? [];
  expect(linkId).toBe(LINK);
  expect(params).toEqual({ amount: '250000000' });
  // Written BEFORE the request: a retry after a lost answer is the same contribution.
  const stored = JSON.parse(sessionStorage.getItem(`peable:contribution:${LINK}`) ?? '{}');
  expect(key).toBe(stored.key);
  expect(stored.amount).toBe('250000000');
});

test('a failed start can be retried', async () => {
  mocks.getPaymentLink.mockImplementation(async () => linkFixture());
  mocks.startPaymentLinkSession.mockImplementation(async () => {
    throw new Error('payment link is no longer active');
  });
  renderLink();
  expect((await screen.findByRole('alert')).textContent).toBe('payment link is no longer active');
  mocks.startPaymentLinkSession.mockImplementation(async () => ({
    object: 'checkout_session_start',
    id: SESSION,
    client_secret: SECRET,
    url: '',
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => {
    expect(screen.getByTestId('landed')).toBeTruthy();
  });
});
