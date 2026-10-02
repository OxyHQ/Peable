import type Stripe from 'stripe';
import { describe, expect, test } from 'bun:test';
import { recurringSnapshotSchema } from '../contracts';

const identity = { schemaVersion: 1, provider: 'stripe', platformAccountId: 'acct_platform', providerAccountId: null, livemode: false, objectRef: 'in_1', apiVersion: '2026-07-29.dahlia' };
const point = { itemRef: 'il_1', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' };
describe('private recurring reader', () => {
  test('invoice permits an inclusive point period, subscription still requires positive duration', () => {
    expect(recurringSnapshotSchema.safeParse({ ...identity, kind: 'invoice', subscriptionRef: 'sub_1', status: 'paid', currency: 'USD', amountDue: '0', amountPaid: '0', amountRemaining: '0', periods: [point], hasMorePeriods: false }).success).toBe(true);
    expect(recurringSnapshotSchema.safeParse({ ...identity, kind: 'subscription', status: 'active', cancelAtPeriodEnd: false, periods: [point], hasMorePeriods: false }).success).toBe(false);
  });
});

import { afterEach, beforeEach, spyOn } from 'bun:test';
import type { DeploymentIdentity, RecurringReadRequest } from '../contracts';
import { createPrivateStripeRecurringReader, type RecurringStripeReadClient, type RecurringStripeReadOptions } from '../stripeRecurringReader';
import { STRIPE_API_VERSION } from '../../providers/stripe/client';

const deployment: DeploymentIdentity = { provider: 'stripe', platformAccountId: 'acct_platform', livemode: false, environment: 'development', apiVersion: STRIPE_API_VERSION };
const sub = () => ({ id: 'sub_1', object: 'subscription', livemode: false, status: 'active', cancel_at_period_end: false, metadata: { email: 'synthetic@example.invalid' }, items: { data: [{ id: 'ignored_preview' }], has_more: true } } satisfies Pick<Stripe.Subscription, 'id' | 'object' | 'livemode' | 'status' | 'cancel_at_period_end'> & { metadata: unknown; items: unknown });
const inv = () => ({ id: 'in_1', object: 'invoice', livemode: false, status: 'paid', currency: 'usd', amount_due: 10, amount_paid: 10, amount_remaining: 0, parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: 'sub_1', metadata: { ignored: 'yes' } } }, customer_email: 'synthetic@example.invalid' } satisfies Pick<Stripe.Invoice, 'id' | 'object' | 'livemode' | 'status' | 'currency' | 'amount_due' | 'amount_paid' | 'amount_remaining' | 'parent' | 'customer_email'>);
const subItem = (id = 'si_1') => ({ id, object: 'subscription_item', subscription: 'sub_1', current_period_start: 1000, current_period_end: 2000 } satisfies Pick<Stripe.SubscriptionItem, 'id' | 'object' | 'subscription' | 'current_period_start' | 'current_period_end'>);
const invoiceLine = (id = 'il_1') => ({ id, object: 'line_item', invoice: 'in_1', livemode: false, subscription: 'sub_1', parent: { type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: { subscription: 'sub_1', subscription_item: 'si_1', proration: false, invoice_item: null, proration_details: null } }, period: { start: 1000, end: 1000 } } satisfies Pick<Stripe.InvoiceLineItem, 'id' | 'object' | 'invoice' | 'livemode' | 'subscription' | 'parent' | 'period'>);
const list = (data: unknown[], has_more = false) => ({ object: 'list', data, has_more });
function fixture(kind: 'subscription' | 'invoice' = 'subscription', account: string | null = null) {
  const calls: Array<{ method: string; params: unknown; options: RecurringStripeReadOptions }> = [];
  const client: RecurringStripeReadClient = {
    async retrieveSubscription(id, options) { calls.push({ method: 'subscription', params: id, options }); return sub(); },
    async retrieveInvoice(id, options) { calls.push({ method: 'invoice', params: id, options }); return inv(); },
    async listSubscriptionItems(params, options) { calls.push({ method: 'items', params, options }); return list([subItem()]); },
    async listInvoiceLines(id, params, options) { calls.push({ method: 'lines', params: { id, ...params }, options }); return list([invoiceLine()]); },
  };
  const controller = new AbortController();
  const request: RecurringReadRequest = { deployment, providerAccountId: account, kind, objectRef: kind === 'subscription' ? 'sub_1' : 'in_1', signal: controller.signal };
  const reader = createPrivateStripeRecurringReader(client, { deployment, providerAccountId: account });
  return { calls, client, controller, request, reader, run: () => reader.readSnapshot(request) };
}

describe('private recurring reader', () => {
  let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
  beforeEach(() => { network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden')); });
  afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });
  test('normalizes complete subscription pages, orders ordinally and strips previews/PII', async () => {
    const f = fixture('subscription', 'acct_connected');
    f.client.listSubscriptionItems = async (params, options) => {
      f.calls.push({ method: 'items', params, options });
      return params.starting_after ? list([subItem('si_A')]) : list([subItem('si_z')], true);
    };
    const snapshot = await f.run();
    expect(snapshot).toEqual({ ...identity, objectRef: 'sub_1', providerAccountId: 'acct_connected', kind: 'subscription', status: 'active', cancelAtPeriodEnd: false, periods: [{ itemRef: 'si_A', start: new Date(1000000).toISOString(), end: new Date(2000000).toISOString() }, { itemRef: 'si_z', start: new Date(1000000).toISOString(), end: new Date(2000000).toISOString() }], hasMorePeriods: false });
    expect(f.calls.map(c => c.method)).toEqual(['subscription', 'items', 'items', 'subscription']);
    expect(f.calls[2]?.params).toEqual({ subscription: 'sub_1', limit: 100, starting_after: 'si_z' });
    for (const call of f.calls) { expect(call.options.apiVersion).toBe(STRIPE_API_VERSION); expect(call.options.stripeAccount).toBe('acct_connected'); expect(call.options.signal === f.calls[0]?.options.signal).toBe(true); }
  });
  test('normalizes invoice point periods and observed amounts without calculating', async () => {
    const f = fixture('invoice');
    expect(await f.run()).toMatchObject({ kind: 'invoice', subscriptionRef: 'sub_1', currency: 'USD', amountDue: '10', amountPaid: '10', amountRemaining: '0', periods: [{ itemRef: 'il_1', start: new Date(1000000).toISOString(), end: new Date(1000000).toISOString() }] });
    expect(f.calls.every(c => !('stripeAccount' in c.options))).toBe(true);
  });
  for (const change of ['platformAccountId', 'apiVersion', 'livemode', 'environment', 'providerAccountId'] as const) {
    test(`rejects configured ${change} mismatch before requesting`, async () => {
      const f = fixture();
      const changed = change === 'providerAccountId' ? { ...f.request, providerAccountId: 'acct_other' } : { ...f.request, deployment: { ...deployment, [change]: change === 'livemode' ? true : change === 'environment' ? 'staging' : 'other' } };
      await expect(f.reader.readSnapshot(changed)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
    });
  }
  test('rejects an unsupported configured API version at construction', () => {
    const f = fixture(); expect(() => createPrivateStripeRecurringReader(f.client, { deployment: { ...deployment, apiVersion: 'other' }, providerAccountId: null })).toThrow();
  });
  for (const malformed of [list([], true), list([subItem(), subItem()]), list([subItem('si_1')], true), { data: [], has_more: false }, list(Array.from({ length: 101 }, (_, i) => subItem(`si_${i}`)))]) {
    test('rejects malformed, duplicate or repeated-cursor pages without a snapshot', async () => {
      const f = fixture(); f.client.listSubscriptionItems = async () => malformed;
      await expect(f.run()).rejects.toThrow('Recurring read rejected');
    });
  }
  test('rejects the page cap without request 21', async () => {
    const f = fixture(); let pages = 0;
    f.client.listSubscriptionItems = async () => list([subItem(`si_${++pages}`)], true);
    await expect(f.run()).rejects.toThrow(); expect(pages).toBe(20);
  });
  test('rejects more than 1000 periods without a partial snapshot', async () => {
    const f = fixture(); let pages = 0;
    f.client.listSubscriptionItems = async () => { const n = pages++; return list(Array.from({ length: 100 }, (_, i) => subItem(`si_${n}_${i}`)), true); };
    await expect(f.run()).rejects.toThrow(); expect(pages).toBe(10);
  });
  test('accepts the exact 1000-item boundary when exhausted', async () => {
    const f = fixture(); let pages = 0;
    f.client.listSubscriptionItems = async () => { const n = pages++; return list(Array.from({ length: 100 }, (_, i) => subItem(`si_${n}_${i}`)), pages < 10); };
    expect(recurringSnapshotSchema.parse(await f.run()).periods).toHaveLength(1000);
  });
  for (const patch of [{ id: 'sub_other' }, { livemode: true }, { status: 'unknown' }]) {
    test('rejects inconsistent subscription identity/mode/status', async () => {
      const f = fixture(); f.client.retrieveSubscription = async () => ({ ...sub(), ...patch }); await expect(f.run()).rejects.toThrow();
    });
  }
  for (const patch of [{ subscription: 'sub_other' }, { current_period_end: 1000 }, { current_period_start: Number.MAX_SAFE_INTEGER }, { current_period_start: 0.5 }]) {
    test('rejects inconsistent subscription items and invalid timestamps', async () => {
      const f = fixture(); f.client.listSubscriptionItems = async () => list([{ ...subItem(), ...patch }]); await expect(f.run()).rejects.toThrow();
    });
  }
  for (const patch of [{ invoice: 'in_other' }, { livemode: true }, { subscription: 'sub_other' }, { parent: null }, { parent: { type: 'invoice_item_details' } }, { parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_other', subscription_item: 'si_1', proration: false } } }, { parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_1', subscription_item: 'si_1', proration: true } } }]) {
    test('rejects invoice lines without consistent explicit subscription attribution', async () => {
      const f = fixture('invoice'); f.client.listInvoiceLines = async () => list([{ ...invoiceLine(), ...patch }]); await expect(f.run()).rejects.toThrow();
    });
  }
  for (const patch of [{ amount_due: Number.MAX_SAFE_INTEGER + 1 }, { amount_paid: -1 }, { amount_remaining: 0.5 }, { status: null }, { parent: null }, { currency: 'USD' }]) {
    test('rejects unsupported invoice roots and unsafe quantities', async () => {
      const f = fixture('invoice'); f.client.retrieveInvoice = async () => ({ ...inv(), ...patch }); await expect(f.run()).rejects.toThrow();
    });
  }
  test('root recheck rejects an observed change during pagination', async () => {
    const f = fixture(); let reads = 0;
    f.client.retrieveSubscription = async () => ({ ...sub(), cancel_at_period_end: ++reads > 1 });
    await expect(f.run()).rejects.toThrow(); expect(reads).toBe(2);
  });
  test('already aborted request never calls the client', async () => {
    const f = fixture(); f.controller.abort(); await expect(f.run()).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  test('abort interrupts a client that ignores the signal and prevents later pages', async () => {
    const f = fixture(); let release!: (v: unknown) => void; let entered!: () => void; const enteredPromise = new Promise<void>(r => { entered = r; });
    let pages = 0;
    f.client.listSubscriptionItems = async () => { pages++; entered(); return new Promise(r => { release = r; }); };
    const pending = f.run(); await enteredPromise; f.controller.abort(); await expect(pending).rejects.toThrow();
    release(list([subItem()], true)); await new Promise(r => setTimeout(r, 0)); expect(pages).toBe(1); expect(f.calls.filter(c => c.method === 'subscription')).toHaveLength(1);
  });
  test('one global deadline bounds an uncooperative client without an upstream abort', async () => {
    const f = fixture(); f.client.retrieveSubscription = async () => new Promise(() => {});
    const start = Date.now(); await expect(f.run()).rejects.toThrow(); expect(Date.now() - start).toBeLessThan(3000);
  });
  test('provider errors are sanitized', async () => {
    const f = fixture(); f.client.retrieveSubscription = async () => { throw new Error('synthetic@example.invalid'); };
    await expect(f.run()).rejects.toThrow('Recurring read rejected');
  });
});
