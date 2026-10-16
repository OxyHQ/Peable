import { afterEach, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DisplayCurrency } from '../DisplayCurrency';
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});
/** The Explorer's real `/api/price` shape: a flat USD price, no EUR quote. */
function explorerPrice(price: number | string, updatedAt: Date) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ price, source: 'wfair-base', updatedAt: updatedAt.toISOString() }),
    )) as unknown as typeof fetch;
}
test('anonymous selection restores and never changes payable base units', async () => {
  explorerPrice('0.3', new Date());
  const view = render(<DisplayCurrency amount="100000000" />);
  fireEvent.change(screen.getByLabelText('Display currency'), { target: { value: 'USD' } });
  await waitFor(() => expect(screen.getByText('Approx. 0.30 USD')).toBeTruthy());
  expect(localStorage.getItem('peable.displayCurrency')).toBe('USD');
  view.unmount();
  render(<DisplayCurrency amount="200000000" />);
  await waitFor(() => expect(screen.getByText('Approx. 0.60 USD')).toBeTruthy());
  expect(
    screen.getByText('The payment amount is fixed in FAIR. Display equivalents are estimates.'),
  ).toBeTruthy();
});
test('unavailable and stale sources retain selected currency without fabricated equivalent', async () => {
  // A fresh USD-only source never yields a EUR figure.
  localStorage.setItem('peable.displayCurrency', 'EUR');
  explorerPrice(1, new Date());
  const view = render(<DisplayCurrency amount="123456789" />);
  await waitFor(() => expect(screen.getByText('Equivalent in EUR unavailable')).toBeTruthy());
  expect((screen.getByLabelText('Display currency') as HTMLSelectElement).value).toBe('EUR');
  view.unmount();
  // A stale USD price is refused rather than shown.
  localStorage.setItem('peable.displayCurrency', 'USD');
  explorerPrice(1, new Date(Date.now() - 300000));
  render(<DisplayCurrency amount="123456789" />);
  await waitFor(() => expect(screen.getByText('Equivalent in USD unavailable')).toBeTruthy());
  expect(screen.queryByText(/Approx\./)).toBeNull();
});
