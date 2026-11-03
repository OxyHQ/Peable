import { describe, expect, it } from 'bun:test';
import type {
  Charge,
  Customer,
  Invoice,
  Price,
  Product,
  Refund,
  Subscription,
} from '@peable.to/shared-types';
import type { DashboardSearchGroup } from '../api/dashboard';
import { cardIntentFixture } from '../payments/fixtures';
import { searchGroupTitle, searchRows, searchTerm } from './results';

const group = <G extends DashboardSearchGroup>(resource: G['resource'], data: unknown[]) =>
  ({ resource, object: resource, data, has_more: false }) as unknown as G;

describe('searchRows', () => {
  it('opens a payment on its own page', () => {
    const [row] = searchRows(
      group('payment_intents', [
        cardIntentFixture({ id: 'pi_1', amount: '1250', currency: 'EUR', receipt_email: 'a@b.c' }),
      ]),
    );
    expect(row?.href).toEqual({ pathname: '/payments/[id]', params: { id: 'pi_1' } });
    expect(row?.label).toBe('12.50 EUR');
    expect(row?.sublabel).toContain('a@b.c');
    expect(row?.sublabel).toContain('pi_1');
  });

  it('opens a charge and a refund on their payment, expanded or not', () => {
    const charge = {
      id: 'ch_1',
      payment_intent: { id: 'pi_2' },
      amount: '500',
      currency: 'USD',
      billing_details: { email: 'jenny@example.com', name: null, phone: null, address: null },
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    } as unknown as Charge;
    const [chargeRow] = searchRows(group('charges', [charge]));
    expect(chargeRow?.href).toEqual({ pathname: '/payments/[id]', params: { id: 'pi_2' } });
    expect(chargeRow?.sublabel).toBe('jenny@example.com · visa ···· 4242 · ch_1');

    const refund = {
      id: 're_1',
      payment_intent: 'pi_3',
      amount: '100',
      currency: 'EUR',
      status: 'succeeded',
    } as unknown as Refund;
    const [refundRow] = searchRows(group('refunds', [refund]));
    expect(refundRow?.href).toEqual({ pathname: '/payments/[id]', params: { id: 'pi_3' } });
    expect(refundRow?.label).toBe('1.00 EUR');
  });

  it('opens a customer on itself, and names it by name, then email, then id', () => {
    const rows = searchRows(
      group('customers', [
        { id: 'cus_1', name: 'Jenny Rosen', email: 'jenny@example.com', phone: null },
        { id: 'cus_2', name: null, email: 'only@example.com', phone: null },
        { id: 'cus_3', name: null, email: null, phone: null },
      ] as Partial<Customer>[]),
    );
    expect(rows.map((row) => row.href?.pathname)).toEqual([
      '/customers/[id]',
      '/customers/[id]',
      '/customers/[id]',
    ]);
    expect(rows[2]?.href?.params.id).toBe('cus_3');
    expect(rows.map((row) => row.label)).toEqual(['Jenny Rosen', 'only@example.com', 'cus_3']);
    expect(rows[0]?.sublabel).toBe('jenny@example.com · cus_1');
  });

  it('opens a subscription and an invoice on themselves', () => {
    const [subscriptionRow] = searchRows(
      group('subscriptions', [
        {
          id: 'sub_1',
          status: 'past_due',
          customer: { id: 'cus_1' },
          description: null,
        } as unknown as Partial<Subscription>,
      ]),
    );
    expect(subscriptionRow?.href).toEqual({
      pathname: '/subscriptions/[id]',
      params: { id: 'sub_1' },
    });
    expect(subscriptionRow?.label).toBe('sub_1');
    expect(subscriptionRow?.sublabel).toContain('cus_1');

    const [invoiceRow] = searchRows(
      group('invoices', [
        {
          id: 'in_1',
          number: 'ABCD-0001',
          status: 'open',
          total: '1250',
          currency: 'EUR',
          customer_email: 'jenny@example.com',
        } as Partial<Invoice>,
      ]),
    );
    expect(invoiceRow?.href).toEqual({ pathname: '/invoices/[id]', params: { id: 'in_1' } });
    expect(invoiceRow?.label).toBe('ABCD-0001');
    expect(invoiceRow?.sublabel).toContain('12.50 EUR');
    expect(invoiceRow?.sublabel).toContain('jenny@example.com');
    expect(invoiceRow?.sublabel).toContain('in_1');
  });

  it('opens a product on itself and a price on its product', () => {
    const [productRow] = searchRows(
      group('products', [{ id: 'prod_1', name: 'Shirt', active: false } as Partial<Product>]),
    );
    expect(productRow?.href).toEqual({ pathname: '/products/[id]', params: { id: 'prod_1' } });
    expect(productRow?.sublabel).toBe('Archived · prod_1');

    const [priceRow] = searchRows(
      group('prices', [
        {
          id: 'price_1',
          product: 'prod_1',
          unit_amount: '2000',
          currency: 'EUR',
          nickname: null,
          lookup_key: 'shirt_monthly',
        } as Partial<Price>,
      ]),
    );
    expect(priceRow?.href).toEqual({ pathname: '/products/[id]', params: { id: 'prod_1' } });
    expect(priceRow?.label).toBe('shirt_monthly');
    expect(priceRow?.sublabel).toBe('20.00 EUR · price_1');
  });

  it('labels a nameless price by its amount', () => {
    const [row] = searchRows(
      group('prices', [
        {
          id: 'price_2',
          product: { id: 'prod_2' },
          unit_amount: '300',
          currency: 'USD',
          nickname: null,
          lookup_key: null,
        } as unknown as Price,
      ]),
    );
    expect(row?.label).toBe('3.00 USD');
    expect(row?.sublabel).toBe('price_2');
    expect(row?.href?.params.id).toBe('prod_2');
  });
});

describe('searchTerm', () => {
  it('sends trimmed input, and nothing for blank or over-long input', () => {
    expect(searchTerm('  pi_1 ')).toBe('pi_1');
    expect(searchTerm('   ')).toBeNull();
    expect(searchTerm('x'.repeat(1001))).toBeNull();
  });
});

describe('searchGroupTitle', () => {
  it('words every searchable resource', () => {
    for (const resource of [
      'payment_intents',
      'charges',
      'customers',
      'products',
      'prices',
      'refunds',
      'subscriptions',
      'invoices',
    ] as const) {
      expect(searchGroupTitle(resource)).not.toBe(`search.group.${resource}`);
    }
  });
});
