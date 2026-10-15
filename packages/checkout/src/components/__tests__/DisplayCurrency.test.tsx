import { afterEach, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DisplayCurrency } from '../DisplayCurrency';
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});
test('anonymous selection restores and never changes payable base units', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ price: { usd: '0.3', eur: '0.27' }, timestamp: new Date().toISOString() }),
    )) as unknown as typeof fetch;
  const view = render(<DisplayCurrency amount="100000000" />);
  fireEvent.change(screen.getByLabelText('Display currency'), { target: { value: 'EUR' } });
  await waitFor(() => expect(screen.getByText('Approx. 0.27 EUR')).toBeTruthy());
  expect(localStorage.getItem('peable.displayCurrency')).toBe('EUR');
  view.unmount();
  render(<DisplayCurrency amount="200000000" />);
  await waitFor(() => expect(screen.getByText('Approx. 0.54 EUR')).toBeTruthy());
  expect(
    screen.getByText('The payment amount is fixed in FAIR. Display equivalents are estimates.'),
  ).toBeTruthy();
});
test('unavailable and stale sources retain selected currency without fabricated equivalent', async () => {
  localStorage.setItem('peable.displayCurrency', 'EUR');
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        price: { usd: 1, eur: 2 },
        timestamp: new Date(Date.now() - 300000).toISOString(),
      }),
    )) as unknown as typeof fetch;
  render(<DisplayCurrency amount="123456789" />);
  await waitFor(() => expect(screen.getByText('Equivalent in EUR unavailable')).toBeTruthy());
  expect((screen.getByLabelText('Display currency') as HTMLSelectElement).value).toBe('EUR');
  expect(screen.queryByText(/Approx\./)).toBeNull();
});
