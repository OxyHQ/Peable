/**
 * The native billing engine's resources (ADR 0018): the routes, methods,
 * query spellings and bodies an integrator would otherwise guess.
 */
import { resources } from '../support/testGateway';
import { describe, expect, test } from 'bun:test';
import { Peable } from '../../src/index';
import {
  CREDIT_NOTE,
  ENTITLEMENT_SUMMARY,
  INVOICE,
  INVOICE_ITEM,
  METER,
  PORTAL_CONFIGURATION,
  PORTAL_SESSION,
  QUOTE,
  SUBSCRIPTION,
  TEST_CLOCK,
} from '../support/billingFixtures';
import { type CapturedRequest, createMockFetch } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

function harness(reply: unknown) {
  const gateway: CapturedRequest[] = [];
  const mock = createMockFetch((request) => {
    if (!request.url.startsWith(TEST_GATEWAY_URL)) return serviceTokenMintResponse();
    gateway.push(request);
    return { status: 200, json: reply };
  });
  return { client: buildTestClient(mock.fetch), gateway };
}

function last(gateway: CapturedRequest[]): CapturedRequest {
  const request = gateway.at(-1);
  if (!request) throw new Error('no gateway request was made');
  return request;
}

/** `[method, path]` of the last request, the gateway origin stripped, query kept. */
function route(gateway: CapturedRequest[]): [string, string] {
  const request = last(gateway);
  return [request.method, decodeURIComponent(request.url.slice(TEST_GATEWAY_URL.length))];
}

const body = (gateway: CapturedRequest[]) => JSON.parse(last(gateway).body ?? '{}');
const list = <T>(data: T[]) => ({ object: 'list', data, has_more: false, url: '/v1/x' });

describe('Peable wires the billing engine', () => {
  test('every resource is on the client; billing keeps the proxy and gains meters', () => {
    const peable = new Peable({
      tokenProvider: { getToken: async () => 'token', invalidate: () => undefined },
    });
    expect(typeof peable.subscriptions).toBe('object');
    expect(typeof peable.subscriptionItems).toBe('object');
    expect(typeof peable.invoices).toBe('object');
    expect(typeof peable.invoiceItems).toBe('object');
    expect(typeof peable.creditNotes).toBe('object');
    expect(typeof peable.quotes).toBe('object');
    expect(typeof peable.customerBalanceTransactions).toBe('object');
    expect(typeof peable.testHelpers).toBe('object');
    expect(typeof peable.testHelpers.testClocks).toBe('object');
    expect(typeof peable.billingSettings).toBe('object');
    expect(typeof peable.entitlements).toBe('object');
    expect(typeof peable.billingPortal).toBe('object');
    expect(typeof peable.billing).toBe('object');
    expect(typeof peable.billing.meters).toBe('object');
    expect(typeof peable.billing.meterEvents).toBe('object');
  });
});

describe('subscriptions', () => {
  test('create, retrieve, update, cancel, resume and list', async () => {
    const { client, gateway } = harness(SUBSCRIPTION);
    const subscriptions = resources(client).subscriptions;
    const params = {
      customer: 'cus_1',
      items: [{ price: 'price_1', quantity: 2 }],
      trial_period_days: 7,
    };
    await subscriptions.create(params, { idempotencyKey: 'sub-1' });
    expect(route(gateway)).toEqual(['POST', '/v1/subscriptions']);
    expect(last(gateway).headers.get('Idempotency-Key')).toBe('sub-1');
    expect(body(gateway)).toEqual(params);

    await subscriptions.retrieve('sub_1', { expand: ['latest_invoice'] });
    expect(route(gateway)).toEqual(['GET', '/v1/subscriptions/sub_1?expand[]=latest_invoice']);

    await subscriptions.update('sub_1', {
      items: [{ id: 'si_1', price: 'price_2' }],
      proration_behavior: 'always_invoice',
    });
    expect(route(gateway)).toEqual(['POST', '/v1/subscriptions/sub_1']);
    expect(body(gateway).proration_behavior).toBe('always_invoice');

    await subscriptions.cancel('sub_1', { invoice_now: true, prorate: true });
    expect(route(gateway)).toEqual(['DELETE', '/v1/subscriptions/sub_1']);
    expect(body(gateway)).toEqual({ invoice_now: true, prorate: true });

    await subscriptions.resume('sub_1', { billing_cycle_anchor: 'now' });
    expect(route(gateway)).toEqual(['POST', '/v1/subscriptions/sub_1/resume']);
  });

  test('list spells its filters, ranges included', async () => {
    const { client, gateway } = harness(list([SUBSCRIPTION]));
    await resources(client).subscriptions.list({
      customer: 'cus_1',
      status: 'all',
      current_period_end: { lt: 100 },
      limit: 5,
    });
    expect(route(gateway)).toEqual([
      'GET',
      '/v1/subscriptions?customer=cus_1&status=all&current_period_end[lt]=100&limit=5',
    ]);
  });

  test('items are their own resource', async () => {
    const item = SUBSCRIPTION.items.data[0];
    const { client, gateway } = harness(item);
    const items = resources(client).subscriptionItems;
    await items.create({ subscription: 'sub_1', price: 'price_2', proration_behavior: 'none' });
    expect(route(gateway)).toEqual(['POST', '/v1/subscription_items']);
    await items.update('si_1', { quantity: 3 });
    expect(route(gateway)).toEqual(['POST', '/v1/subscription_items/si_1']);
    await items.del('si_1', { proration_behavior: 'none' });
    expect(route(gateway)).toEqual(['DELETE', '/v1/subscription_items/si_1']);
    await items.list({ subscription: 'sub_1' });
    expect(route(gateway)).toEqual(['GET', '/v1/subscription_items?subscription=sub_1']);
  });
});

describe('invoices', () => {
  test('the lifecycle actions are POSTs on the invoice', async () => {
    const { client, gateway } = harness(INVOICE);
    const invoices = resources(client).invoices;
    await invoices.create({ customer: 'cus_1', currency: 'EUR', auto_advance: false });
    expect(route(gateway)).toEqual(['POST', '/v1/invoices']);
    await invoices.finalizeInvoice('in_1', { auto_advance: true });
    expect(route(gateway)).toEqual(['POST', '/v1/invoices/in_1/finalize']);
    await invoices.pay('in_1', { payment_method: 'pm_1' });
    expect(route(gateway)).toEqual(['POST', '/v1/invoices/in_1/pay']);
    expect(body(gateway)).toEqual({ payment_method: 'pm_1' });
    await invoices.sendInvoice('in_1');
    expect(route(gateway)).toEqual(['POST', '/v1/invoices/in_1/send']);
    await invoices.voidInvoice('in_1');
    expect(route(gateway)).toEqual(['POST', '/v1/invoices/in_1/void']);
    await invoices.markUncollectible('in_1');
    expect(route(gateway)).toEqual(['POST', '/v1/invoices/in_1/mark_uncollectible']);
    await invoices.del('in_1');
    expect(route(gateway)).toEqual(['DELETE', '/v1/invoices/in_1']);
    await invoices.listLineItems('in_1');
    expect(route(gateway)).toEqual(['GET', '/v1/invoices/in_1/lines']);
  });

  test('upcoming previews a change as an indexed query', async () => {
    const { client, gateway } = harness(INVOICE);
    await resources(client).invoices.retrieveUpcoming({
      customer: 'cus_1',
      subscription: 'sub_1',
      subscription_items: [{ id: 'si_1', price: 'price_2' }],
      subscription_proration_behavior: 'create_prorations',
    });
    expect(route(gateway)).toEqual([
      'GET',
      '/v1/invoices/upcoming?customer=cus_1&subscription=sub_1&subscription_items[0][id]=si_1&subscription_items[0][price]=price_2&subscription_proration_behavior=create_prorations',
    ]);
  });

  test('list, and invoice items', async () => {
    const { client, gateway } = harness(list([INVOICE]));
    await resources(client).invoices.list({
      customer: 'cus_1',
      status: 'open',
      due_date: { lte: 9 },
    });
    expect(route(gateway)).toEqual([
      'GET',
      '/v1/invoices?customer=cus_1&status=open&due_date[lte]=9',
    ]);
    const items = harness(list([INVOICE_ITEM]));
    await resources(items.client).invoiceItems.list({ customer: 'cus_1', pending: true });
    expect(route(items.gateway)).toEqual(['GET', '/v1/invoiceitems?customer=cus_1&pending=true']);
  });

  test('invoice items create, update, delete', async () => {
    const { client, gateway } = harness(INVOICE_ITEM);
    const items = resources(client).invoiceItems;
    await items.create(
      { customer: 'cus_1', amount: '700', currency: 'EUR' },
      { idempotencyKey: 'ii' },
    );
    expect(route(gateway)).toEqual(['POST', '/v1/invoiceitems']);
    await items.update('ii_1', { quantity: 2 });
    expect(route(gateway)).toEqual(['POST', '/v1/invoiceitems/ii_1']);
    await items.del('ii_1');
    expect(route(gateway)).toEqual(['DELETE', '/v1/invoiceitems/ii_1']);
  });
});

describe('credit notes and balances', () => {
  test('create, preview (a query), void', async () => {
    const { client, gateway } = harness(CREDIT_NOTE);
    const notes = resources(client).creditNotes;
    await notes.create({ invoice: 'in_1', amount: '300', refund_amount: '300' });
    expect(route(gateway)).toEqual(['POST', '/v1/credit_notes']);
    await notes.preview({
      invoice: 'in_1',
      lines: [{ type: 'invoice_line_item', invoice_line_item: 'il_1' }],
    });
    expect(route(gateway)).toEqual([
      'GET',
      '/v1/credit_notes/preview?invoice=in_1&lines[0][type]=invoice_line_item&lines[0][invoice_line_item]=il_1',
    ]);
    await notes.voidCreditNote('cn_1');
    expect(route(gateway)).toEqual(['POST', '/v1/credit_notes/cn_1/void']);
  });

  test('balance transactions live under the customer', async () => {
    const { client, gateway } = harness({ id: 'cbtxn_1' });
    const balance = resources(client).customerBalanceTransactions;
    await balance.create('cus_1', { amount: '-500', currency: 'EUR' });
    expect(route(gateway)).toEqual(['POST', '/v1/customers/cus_1/balance_transactions']);
    expect(body(gateway)).toEqual({ amount: '-500', currency: 'EUR' });
    await balance.retrieve('cus_1', 'cbtxn_1');
    expect(route(gateway)).toEqual(['GET', '/v1/customers/cus_1/balance_transactions/cbtxn_1']);
  });
});

describe('quotes', () => {
  test('create, update, finalize, accept, cancel, list and the line items', async () => {
    const { client, gateway } = harness(QUOTE);
    const quotes = resources(client).quotes;
    await quotes.create({
      customer: 'cus_1',
      line_items: [{ price: 'price_1', quantity: 2 }],
      discounts: [{ coupon: 'coupon_1' }],
      subscription_data: { trial_period_days: 14 },
    });
    expect(route(gateway)).toEqual(['POST', '/v1/quotes']);
    expect(body(gateway)).toEqual({
      customer: 'cus_1',
      line_items: [{ price: 'price_1', quantity: 2 }],
      discounts: [{ coupon: 'coupon_1' }],
      subscription_data: { trial_period_days: 14 },
    });
    await quotes.update('qt_1', { header: 'Annual support' });
    expect(route(gateway)).toEqual(['POST', '/v1/quotes/qt_1']);
    await quotes.finalizeQuote('qt_1', { expires_at: 1800000000 });
    expect(route(gateway)).toEqual(['POST', '/v1/quotes/qt_1/finalize']);
    await quotes.accept('qt_1');
    expect(route(gateway)).toEqual(['POST', '/v1/quotes/qt_1/accept']);
    await quotes.cancel('qt_1');
    expect(route(gateway)).toEqual(['POST', '/v1/quotes/qt_1/cancel']);
    await quotes.retrieve('qt_1', { expand: ['invoice'] });
    expect(route(gateway)).toEqual(['GET', '/v1/quotes/qt_1?expand[]=invoice']);
  });

  test('the list and the line items are pages', async () => {
    const { client, gateway } = harness(list([QUOTE]));
    const quotes = resources(client).quotes;
    await quotes.list({ customer: 'cus_1', status: 'open' });
    expect(route(gateway)).toEqual(['GET', '/v1/quotes?customer=cus_1&status=open']);
    await quotes.listLineItems('qt_1', { limit: 5 });
    expect(route(gateway)).toEqual(['GET', '/v1/quotes/qt_1/line_items?limit=5']);
  });
});

describe('test clocks, settings, meters', () => {
  test('test clocks', async () => {
    const { client, gateway } = harness(TEST_CLOCK);
    const clocks = resources(client).testHelpers.testClocks;
    await clocks.create({ frozen_time: 100, name: 'trial' });
    expect(route(gateway)).toEqual(['POST', '/v1/test_helpers/test_clocks']);
    await clocks.advance('clock_1', { frozen_time: 200 });
    expect(route(gateway)).toEqual(['POST', '/v1/test_helpers/test_clocks/clock_1/advance']);
    expect(body(gateway)).toEqual({ frozen_time: 200 });
    await clocks.retrieve('clock_1');
    expect(route(gateway)).toEqual(['GET', '/v1/test_helpers/test_clocks/clock_1']);
    await clocks.del('clock_1');
    expect(route(gateway)).toEqual(['DELETE', '/v1/test_helpers/test_clocks/clock_1']);
  });

  test('billing settings', async () => {
    const { client, gateway } = harness({ object: 'billing_settings' });
    const settings = resources(client).billingSettings;
    await settings.update({ dunning: { retry_schedule_days: [1, 3], final_action: 'unpaid' } });
    expect(route(gateway)).toEqual(['POST', '/v1/billing_settings']);
    await settings.retrieve();
    expect(route(gateway)).toEqual(['GET', '/v1/billing_settings']);
  });

  test('meters and meter events', async () => {
    const { client, gateway } = harness(METER);
    const meters = resources(client).billing.meters;
    await meters.create({
      display_name: 'API',
      event_name: 'api_call',
      default_aggregation: { formula: 'sum' },
    });
    expect(route(gateway)).toEqual(['POST', '/v1/billing/meters']);
    await meters.deactivate('mtr_1');
    expect(route(gateway)).toEqual(['POST', '/v1/billing/meters/mtr_1/deactivate']);
    await meters.listEventSummaries('mtr_1', { customer: 'cus_1', start_time: 1, end_time: 2 });
    expect(route(gateway)).toEqual([
      'GET',
      '/v1/billing/meters/mtr_1/event_summaries?customer=cus_1&start_time=1&end_time=2',
    ]);
    await resources(client).billing.meterEvents.create(
      {
        event_name: 'api_call',
        identifier: 'e1',
        payload: { peable_customer_id: 'cus_1', value: '3' },
      },
      { idempotencyKey: 'e1' },
    );
    expect(route(gateway)).toEqual(['POST', '/v1/billing/meter_events']);
  });
});

describe('entitlements and the portal', () => {
  test('features, product features, active entitlements', async () => {
    const { client, gateway } = harness(ENTITLEMENT_SUMMARY.entitlements);
    const entitlements = resources(client).entitlements;
    await entitlements.features.create({ lookup_key: 'mention_plus', name: 'Mention Plus' });
    expect(route(gateway)).toEqual(['POST', '/v1/entitlements/features']);
    await entitlements.productFeatures.attach('prod_1', { entitlement_feature: 'feat_1' });
    expect(route(gateway)).toEqual(['POST', '/v1/products/prod_1/features']);
    expect(body(gateway)).toEqual({ entitlement_feature: 'feat_1' });
    await entitlements.productFeatures.detach('prod_1', 'prodft_1');
    expect(route(gateway)).toEqual(['DELETE', '/v1/products/prod_1/features/prodft_1']);
    const active = await entitlements.activeEntitlements.list({ customer: 'cus_1' });
    expect(route(gateway)).toEqual(['GET', '/v1/entitlements/active_entitlements?customer=cus_1']);
    expect(active.data[0]?.lookup_key).toBe('mention_plus');
  });

  test('portal configurations and sessions', async () => {
    const { client, gateway } = harness(PORTAL_CONFIGURATION);
    const portal = resources(client).billingPortal;
    await portal.configurations.create({ features: { invoice_history: { enabled: true } } });
    expect(route(gateway)).toEqual(['POST', '/v1/billing_portal/configurations']);
    await portal.configurations.update('bpc_1', { active: true });
    expect(route(gateway)).toEqual(['POST', '/v1/billing_portal/configurations/bpc_1']);
    const sessions = harness(PORTAL_SESSION);
    await resources(sessions.client).billingPortal.sessions.create({ customer: 'cus_1' });
    expect(route(sessions.gateway)).toEqual(['POST', '/v1/billing_portal/sessions']);
  });
});
