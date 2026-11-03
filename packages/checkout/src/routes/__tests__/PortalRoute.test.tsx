import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PublicPortalSession } from '@peable.to/shared-types';
import { PortalRoute } from '../PortalRoute';

const SESSION: PublicPortalSession = {
  object: 'billing_portal.public_session',
  livemode: false,
  merchant: { name: 'Seller Ltd', avatar_url: null },
  business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
  features: {
    customer_update: { enabled: true, allowed_updates: ['email', 'name'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ['price'],
      proration_behavior: 'create_prorations',
      products: [{ product: 'prod_pro', prices: ['price_pro'] }],
    },
  },
  return_url: 'https://app.example/account',
  expires_at: 1_900_000_000,
  customer: {
    id: 'cus_1',
    email: 'payer@example.test',
    name: 'Payer',
    phone: null,
    address: null,
    default_payment_method: {
      id: 'pm_1',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    },
  },
  subscriptions: [
    {
      id: 'sub_1',
      status: 'active',
      currency: 'EUR',
      current_period_end: 1_802_592_000,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: null,
      collection_method: 'charge_automatically',
      items: [
        {
          id: 'si_1',
          price: 'price_basic',
          product: 'prod_basic',
          product_name: 'Basic',
          quantity: 1,
          unit_amount: '1000',
          interval: 'month',
        },
      ],
    },
  ],
  invoices: [
    {
      id: 'in_1',
      number: 'ABCD-0001',
      status: 'paid',
      currency: 'EUR',
      total: '1000',
      amount_due: '1000',
      created: 1_800_000_000,
      hosted_invoice_url: 'https://checkout.peable.to/invoice/inv_tok_1',
      invoice_pdf: 'https://api.peable.to/v1/invoices/public/inv_tok_1/pdf',
    },
  ],
  plans: [
    {
      product: 'prod_pro',
      product_name: 'Pro',
      prices: [
        {
          id: 'price_pro',
          unit_amount: '3000',
          currency: 'EUR',
          interval: 'month',
          interval_count: 1,
        },
      ],
    },
  ],
};

const originalFetch = globalThis.fetch;
const posts: { url: string; body: unknown }[] = [];

function respond(session: PublicPortalSession | null) {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!session)
      return new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 404 });
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      if (url.endsWith('/cancel')) {
        return new Response(
          JSON.stringify({
            ...session,
            subscriptions: session.subscriptions.map((s) => ({ ...s, cancel_at_period_end: true })),
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(session), { status: 200 });
    }
    return new Response(JSON.stringify(session), { status: 200 });
  }) as unknown as typeof fetch;
}

function renderRoute() {
  render(
    <MemoryRouter initialEntries={['/portal/bps_tok_x']}>
      <Routes>
        <Route path="/portal/:token" element={<PortalRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  posts.length = 0;
  respond(SESSION);
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test('shows the customer’s subscription, card, invoices and return link', async () => {
  renderRoute();
  expect(await screen.findByText('Basic')).toBeDefined();
  expect(screen.getByTestId('payment-method').textContent).toContain('4242');
  expect(screen.getByText('View').getAttribute('href')).toBe(
    'https://checkout.peable.to/invoice/inv_tok_1',
  );
  expect(screen.getByText('← Return').getAttribute('href')).toBe('https://app.example/account');
});

test('cancels at period end, then offers to keep it', async () => {
  renderRoute();
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel subscription' }));
  expect(await screen.findByRole('button', { name: 'Keep subscription' })).toBeDefined();
  expect(posts).toEqual([
    {
      url: expect.stringContaining('/v1/billing_portal/public/bps_tok_x/cancel'),
      body: { subscription: 'sub_1' },
    },
  ]);
});

test('switches plan to one the configuration offers', async () => {
  renderRoute();
  fireEvent.click(await screen.findByRole('button', { name: /Switch to Pro/ }));
  await screen.findByText('Basic');
  expect(posts[0]).toEqual({
    url: expect.stringContaining('/change_plan'),
    body: { subscription: 'sub_1', price: 'price_pro' },
  });
});

test('edits only the allowed billing details', async () => {
  renderRoute();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit billing details' }));
  expect(screen.queryByText('Phone')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Edit billing details' });
  expect(posts[0]).toEqual({
    url: expect.stringContaining('/customer'),
    body: { email: 'payer@example.test', name: 'Payer' },
  });
});

test('an expired session says so', async () => {
  respond(null);
  renderRoute();
  expect(await screen.findByText(/has expired/)).toBeDefined();
});
