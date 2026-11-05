import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { PublicInvoice } from '@peable.to/shared-types';
import { InvoiceRoute } from '../InvoiceRoute';

const INVOICE: PublicInvoice = {
  object: 'public_invoice',
  livemode: false,
  number: 'ABCD1234-0007',
  status: 'open',
  currency: 'EUR',
  merchant: { name: 'Seller Ltd', avatar_url: null },
  customer_name: 'Payer',
  customer_email: 'payer@example.test',
  description: null,
  lines: [
    {
      description: '1 × Pro',
      quantity: 1,
      amount: '3000',
      period: { start: 1_800_000_000, end: 1_802_592_000 },
      proration: false,
    },
    {
      description: 'Unused time on 1 × Basic',
      quantity: 1,
      amount: '-500',
      period: { start: 1_800_000_000, end: 1_802_592_000 },
      proration: true,
    },
  ],
  subtotal: '2500',
  total_discount: '0',
  tax: '500',
  total: '3000',
  amount_due: '3000',
  amount_paid: '0',
  amount_remaining: '3000',
  due_date: 1_800_864_000,
  created: 1_800_000_000,
  finalized_at: 1_800_000_000,
  paid_at: null,
  payment_method_types: ['card', 'faircoin'],
  faircoin: { available: true, unavailable_reason: null },
  invoice_pdf: 'https://api.peable.to/v1/invoices/public/inv_tok_x/pdf',
};

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function respond(invoice: PublicInvoice | null, status = 200) {
  fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/pay') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          object: 'public_invoice_payment',
          payment_intent: 'pi_123',
          client_secret: 'pi_123_secret_abc',
        }),
        { status: 200 },
      );
    }
    if (url.includes('/v1/invoices/public/')) {
      return invoice
        ? new Response(JSON.stringify(invoice), { status })
        : new Response(JSON.stringify({ error: { message: 'invoice not found' } }), {
            status: 404,
          });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function Landing() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.hash}`}</p>;
}

function renderRoute() {
  render(
    <MemoryRouter initialEntries={['/invoice/inv_tok_x']}>
      <Routes>
        <Route path="/invoice/:token" element={<InvoiceRoute />} />
        <Route path="/i/:intentId" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => respond(INVOICE));
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test('renders the invoice: lines, signed credit, totals and the PDF link', async () => {
  renderRoute();
  expect(await screen.findByText('Seller Ltd')).toBeDefined();
  expect(screen.getByTestId('invoice-status').textContent).toBe('Due');
  expect(screen.getByText('-5.00 EUR')).toBeDefined();
  expect(screen.getByTestId('invoice-remaining').textContent).toBe('30.00 EUR');
  expect(screen.getByText('Download PDF').getAttribute('href')).toBe(INVOICE.invoice_pdf);
});

test('Pay hands off to the payment page for the invoice’s intent, secret in the fragment', async () => {
  renderRoute();
  fireEvent.click(await screen.findByRole('button', { name: /pay 30.00 eur/i }));
  expect((await screen.findByTestId('landed')).textContent).toBe(
    '/i/pi_123#client_secret=pi_123_secret_abc',
  );
});

test('a paid invoice is read-only', async () => {
  respond({
    ...INVOICE,
    status: 'paid',
    amount_paid: '3000',
    amount_remaining: '0',
    paid_at: 1_800_100_000,
  });
  renderRoute();
  expect(await screen.findByText(/Paid on/)).toBeDefined();
  expect(screen.queryByRole('button', { name: /pay/i })).toBeNull();
});

test('an unknown token says the invoice was not found', async () => {
  respond(null);
  renderRoute();
  expect(await screen.findByText(/could not be found/)).toBeDefined();
});
