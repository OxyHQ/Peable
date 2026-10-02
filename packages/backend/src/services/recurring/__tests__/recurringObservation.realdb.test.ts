import type Stripe from 'stripe';
import { createPrivateStripeRecurringReader } from '../stripeRecurringReader';
import { STRIPE_API_VERSION } from '../../providers/stripe/client';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { gatewayDb, POSTGRES_TESTS_ENABLED, resetGatewayTables, seedMerchant, useGatewayDatabase } from '../../../__tests__/helpers/gatewayTestDatabase';
import { bindRecurringObject, findRecurringMirror } from '../../../db/recurring/recurringMirrorRepository';
import { findProviderEventById, insertProviderEvent } from '../../../db/providers/providerEventRepository';
import { recurringMirrors, recurringObservationOutbox } from '../../../db/schema';
import type { DeploymentIdentity, RecurringSnapshot } from '../contracts';
import { processProviderEvent } from '../../providers/eventProcessor';
import { observeRecurringEvent } from '../recurringObservation';

const deployment: DeploymentIdentity = { provider: 'stripe', platformAccountId: 'acct_platform', livemode: false, environment: 'development', apiVersion: 'fixture-v1' };
const periods = [{ itemRef: 'item_1', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' }];
function subscription(objectRef = 'sub_1'): RecurringSnapshot {
  return { schemaVersion: 1, provider: 'stripe', platformAccountId: deployment.platformAccountId,
    providerAccountId: null, livemode: false, objectRef, apiVersion: deployment.apiVersion,
    kind: 'subscription', status: 'active', cancelAtPeriodEnd: false, periods, hasMorePeriods: false };
}
function invoice(): RecurringSnapshot {
  return { schemaVersion: 1, provider: 'stripe', platformAccountId: deployment.platformAccountId,
    providerAccountId: null, livemode: false, objectRef: 'in_1', apiVersion: deployment.apiVersion,
    kind: 'invoice', subscriptionRef: 'sub_1', status: 'paid', currency: 'USD',
    amountDue: '100', amountPaid: '100', amountRemaining: '0', periods, hasMorePeriods: false };
}
async function bind(kind: 'subscription' | 'invoice' = 'subscription', objectRef = 'sub_1', merchantId?: string) {
  const ownerId = merchantId ?? (await seedMerchant()).id;
  return bindRecurringObject(gatewayDb(), deployment, { merchantId: ownerId,
    providerAccountId: null, kind, objectRef, bindingEvidenceRef: 'fixture:approved-import' });
}
async function event(kind: 'subscription' | 'invoice' = 'subscription', objectRef = 'sub_1', overrides = {}) {
  const id = await insertProviderEvent(gatewayDb(), { provider: 'stripe', providerEventId: `evt_${randomUUID()}`,
    providerAccountId: null, type: kind === 'subscription' ? 'customer.subscription.updated' : 'invoice.paid',
    livemode: false, apiVersion: deployment.apiVersion, objectIds: { [kind]: objectRef },
    payload: { created: 1 }, ...overrides });
  if (!id) throw new Error('Fixture event duplicate');
  return id;
}
async function rows() { return gatewayDb().select().from(recurringObservationOutbox); }

describe.skipIf(!POSTGRES_TESTS_ENABLED)('inactive recurring observation / real PostgreSQL', () => {
  useGatewayDatabase();
  const readSnapshot = mock(async () => subscription() as unknown);
  const options = { deployment, reader: { readSnapshot }, timeoutMs: 1000 };
  let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
  beforeEach(async () => {
    await resetGatewayTables();
    readSnapshot.mockReset();
    readSnapshot.mockImplementation(async () => subscription());
    network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider network permitted'));
  });
  afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

  it('keeps explicit binding insert-only, including concurrent repeats and conflicting merchants/environments', async () => {
    const merchant = await seedMerchant();
    const first = await bind('subscription', 'sub_1', merchant.id);
    const repeats = await Promise.all([bind('subscription', 'sub_1', merchant.id), bind('subscription', 'sub_1', merchant.id)]);
    expect(repeats.map((row) => row.id)).toEqual([first.id, first.id]);
    await expect(bind('subscription', 'sub_1')).rejects.toThrow('identity conflict');
    const staging = await seedMerchant({ environment: 'staging' });
    await expect(bindRecurringObject(gatewayDb(), { ...deployment, environment: 'staging' }, {
      merchantId: staging.id, providerAccountId: null, kind: 'subscription', objectRef: 'sub_1', bindingEvidenceRef: 'fixture:other',
    })).rejects.toThrow('identity conflict');
    expect(await findRecurringMirror(gatewayDb(), deployment, 'subscription', 'sub_1', null)).toEqual(first);
  });

  it('observes subscription and invoice periods with the same merchant binding and atomic outbox', async () => {
    const sub = await bind();
    const inv = await bind('invoice', 'in_1', sub.merchantId);
    const subEvent = await event();
    expect(await observeRecurringEvent(subEvent, options)).toMatchObject({ kind: 'observed', revision: 1 });
    readSnapshot.mockResolvedValue(invoice());
    const invEvent = await event('invoice', 'in_1');
    expect(await observeRecurringEvent(invEvent, options)).toMatchObject({ kind: 'observed', revision: 1 });
    expect(await rows()).toHaveLength(2);
    const stored = await findRecurringMirror(gatewayDb(), deployment, 'invoice', 'in_1', null);
    expect(stored?.snapshot).toEqual(invoice());
    expect(stored?.merchantId).toBe(inv.merchantId);
    expect(stored?.observedAt).toBeInstanceOf(Date);
    expect((await findProviderEventById(gatewayDb(), invEvent))?.processedAt).toBeInstanceOf(Date);
  });

  it('rejects invoice attribution to another merchant subscription', async () => {
    await bind();
    await bind('invoice', 'in_1');
    readSnapshot.mockResolvedValue(invoice());
    expect(await observeRecurringEvent(await event('invoice', 'in_1'), options)).toMatchObject({ kind: 'failed' });
    expect(await rows()).toHaveLength(0);
  });

  it('absorbs concurrent replay and post-commit replay without another read or outbox', async () => {
    await bind(); const id = await event();
    const results = await Promise.all([observeRecurringEvent(id, options), observeRecurringEvent(id, options)]);
    expect(results.map((value) => value.kind).sort()).toEqual(['already_processed', 'observed']);
    expect(await observeRecurringEvent(id, options)).toEqual({ kind: 'already_processed' });
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it('reads current snapshots for reversed/equal event times, without ordering state by event id', async () => {
    await bind();
    await observeRecurringEvent(await event('subscription', 'sub_1', { providerEventId: 'evt_z', payload: { created: 9 } }), options);
    readSnapshot.mockResolvedValue({ ...subscription(), status: 'canceled' });
    await observeRecurringEvent(await event('subscription', 'sub_1', { providerEventId: 'evt_a', payload: { created: 1 } }), options);
    expect(await observeRecurringEvent(await event('subscription', 'sub_1', { providerEventId: 'evt_0', payload: { created: 1 } }), options)).toMatchObject({ kind: 'unchanged' });
    expect((await findRecurringMirror(gatewayDb(), deployment, 'subscription', 'sub_1', null))?.snapshot).toMatchObject({ status: 'canceled' });
    expect(await rows()).toHaveLength(2);
  });

  it('leaves an unknown object pending without attribution, read, or outbox', async () => {
    const id = await event();
    expect(await observeRecurringEvent(id, options)).toEqual({ kind: 'unmatched' });
    expect(readSnapshot).not.toHaveBeenCalled(); expect(await rows()).toHaveLength(0);
    expect((await findProviderEventById(gatewayDb(), id))?.processedAt).toBeNull();
    expect(await gatewayDb().select().from(recurringMirrors)).toHaveLength(0);
  });

  it('rolls back snapshot/revision/processedAt when outbox insertion fails, then retries once', async () => {
    const binding = await bind(); const id = await event();
    // Deliberately occupy the upcoming unique revision: a real SQL failure after the state write.
    await gatewayDb().insert(recurringObservationOutbox).values({ id: uuidv7(), mirrorId: binding.id,
      revision: 1, sourceEventId: id, snapshot: subscription(), observedAt: new Date() });
    expect(await observeRecurringEvent(id, options)).toMatchObject({ kind: 'failed' });
    expect((await findRecurringMirror(gatewayDb(), deployment, 'subscription', 'sub_1', null))?.revision).toBe(0);
    expect((await findProviderEventById(gatewayDb(), id))?.processedAt).toBeNull();
    await gatewayDb().delete(recurringObservationOutbox).where(eq(recurringObservationOutbox.mirrorId, binding.id));
    expect(await observeRecurringEvent(id, options)).toMatchObject({ kind: 'observed', revision: 1 });
    expect(await rows()).toHaveLength(1);
  });

  it('times out a stalled reader and releases locks without processing or changing state', async () => {
    await bind(); const id = await event();
    let signal: AbortSignal | undefined;
    const stalled = { readSnapshot: async (request: { signal: AbortSignal }) => {
      signal = request.signal; return new Promise(() => {});
    } };
    expect(await observeRecurringEvent(id, { ...options, reader: stalled, timeoutMs: 20 })).toMatchObject({ kind: 'failed' });
    expect(signal?.aborted).toBe(true);
    expect((await findProviderEventById(gatewayDb(), id))?.processedAt).toBeNull();
    expect(await observeRecurringEvent(id, options)).toMatchObject({ kind: 'observed' });
  });

  it('keeps default routing inactive; opt-in unknown does not stop a later bound object', async () => {
    await bind();
    const id = await event(); const stored = await findProviderEventById(gatewayDb(), id);
    if (!stored) throw new Error('Missing event');
    expect(await processProviderEvent(stored)).toEqual({ kind: 'no_mapping' });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(await observeRecurringEvent(id, options)).toEqual({ kind: 'already_processed' });
    const unknownId = await event('subscription', 'sub_unknown');
    expect(await observeRecurringEvent(unknownId, options)).toEqual({ kind: 'unmatched' });
    const next = await findProviderEventById(gatewayDb(), await event());
    if (!next) throw new Error('Missing event');
    expect(await processProviderEvent(next, options)).toMatchObject({ kind: 'observed' });
  });

  it('serializes distinct event reads under the binding lock and timestamps after reading', async () => {
    const binding = await bind(); const first = await event(); const second = await event();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    const reader = { readSnapshot: async () => {
      count += 1;
      if (count === 1) { entered?.(); await barrier; return subscription(); }
      return { ...subscription(), status: 'canceled' };
    } };
    const firstWork = observeRecurringEvent(first, { ...options, reader });
    await enteredPromise;
    const secondWork = observeRecurringEvent(second, { ...options, reader });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count).toBe(1);
    const releasedAt = Date.now(); release?.();
    expect(await firstWork).toMatchObject({ kind: 'observed', revision: 1 });
    expect(await secondWork).toMatchObject({ kind: 'observed', revision: 2 });
    const stored = await findRecurringMirror(gatewayDb(), deployment, 'subscription', 'sub_1', null);
    expect(stored?.observedAt?.getTime()).toBeGreaterThanOrEqual(releasedAt);
    expect(stored?.snapshot).toMatchObject({ status: 'canceled' });
    expect(stored).toMatchObject({ merchantId: binding.merchantId, oxyAppId: binding.oxyAppId,
      environment: binding.environment, objectRef: binding.objectRef, bindingEvidenceRef: binding.bindingEvidenceRef });
    expect(await rows()).toHaveLength(2);
  });

  it('enforces merchant/application/environment ownership in the database', async () => {
    const binding = await bind();
    await expect(gatewayDb().insert(recurringMirrors).values({ ...binding, id: uuidv7(), objectRef: 'sub_bad', oxyAppId: 'foreign-app' }).execute()).rejects.toThrow();
    await expect(gatewayDb().insert(recurringMirrors).values({ ...binding, id: uuidv7(), objectRef: 'sub_bad', environment: 'staging' }).execute()).rejects.toThrow();
    expect(await gatewayDb().select().from(recurringMirrors)).toHaveLength(1);
  });

  it('refuses stored event scope/mode/version mismatches before the reader', async () => {
    await bind();
    for (const overrides of [{ providerAccountId: 'acct_other' }, { livemode: true }, { apiVersion: 'other' }]) {
      const id = await event('subscription', 'sub_1', overrides);
      expect((await observeRecurringEvent(id, options)).kind).not.toBe('observed');
      expect((await findProviderEventById(gatewayDb(), id))?.processedAt).toBeNull();
    }
    expect(readSnapshot).not.toHaveBeenCalled(); expect(await rows()).toHaveLength(0);
  });

  for (const [name, invalid] of Object.entries({
    pii: { email: 'never-store@example.test' }, partial: { hasMorePeriods: true },
    wrongAccount: { platformAccountId: 'acct_other' }, wrongScope: { providerAccountId: 'acct_connected' },
    wrongMode: { livemode: true }, wrongObject: { objectRef: 'sub_other' },
    wrongVersion: { apiVersion: 'unsupported' }, duplicateItems: { periods: [periods[0], periods[0]] },
  })) {
    it(`refuses invalid snapshot ${name} without state, event completion or outbox`, async () => {
      await bind(); const id = await event(); readSnapshot.mockResolvedValue({ ...subscription(), ...invalid });
      expect(await observeRecurringEvent(id, options)).toMatchObject({ kind: 'failed' });
      expect(await rows()).toHaveLength(0);
      expect((await findProviderEventById(gatewayDb(), id))?.processedAt).toBeNull();
      expect((await findRecurringMirror(gatewayDb(), deployment, 'subscription', 'sub_1', null))?.snapshot).toBeNull();
    });
  }
  it('persists the private reader invoice projection and outbox through real SQL, replaying unchanged', async () => {
    const sub = await bind();
    await bind('invoice', 'in_1', sub.merchantId);
    const pinned = { ...deployment, apiVersion: STRIPE_API_VERSION };
    let incomplete = false;
    const root = { id: 'in_1', object: 'invoice', livemode: false, status: 'paid', currency: 'usd', amount_due: 12, amount_paid: 12, amount_remaining: 0,
      parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: 'sub_1', metadata: null } },
    } satisfies Pick<Stripe.Invoice, 'id' | 'object' | 'livemode' | 'status' | 'currency' | 'amount_due' | 'amount_paid' | 'amount_remaining' | 'parent'>;
    const line = { id: 'il_point', object: 'line_item', invoice: 'in_1', livemode: false, subscription: 'sub_1', period: { start: 1000, end: 1000 },
      parent: { type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: { subscription: 'sub_1', subscription_item: 'si_1', invoice_item: null, proration: false, proration_details: null } },
    } satisfies Pick<Stripe.InvoiceLineItem, 'id' | 'object' | 'invoice' | 'livemode' | 'subscription' | 'period' | 'parent'>;
    const reader = createPrivateStripeRecurringReader({
      async retrieveSubscription() { throw new Error('Unexpected read'); },
      async listSubscriptionItems() { throw new Error('Unexpected read'); },
      async retrieveInvoice() { return { ...root, customer_email: 'synthetic@example.invalid' }; },
      async listInvoiceLines() { return { object: 'list', data: [line], has_more: incomplete }; },
    }, { deployment: pinned, providerAccountId: null });
    const observe = { deployment: pinned, reader, timeoutMs: 1000 };
    const process = async (id: string) => {
      const row = await findProviderEventById(gatewayDb(), id);
      if (!row) throw new Error('Missing fixture event');
      return processProviderEvent(row, observe);
    };
    const id = await event('invoice', 'in_1', { apiVersion: STRIPE_API_VERSION });
    expect(await process(id)).toMatchObject({ kind: 'observed', revision: 1 });
    const stored = await findRecurringMirror(gatewayDb(), pinned, 'invoice', 'in_1', null);
    expect(stored?.snapshot).toMatchObject({ amountDue: '12', amountPaid: '12', periods: [{ itemRef: 'il_point', start: new Date(1000000).toISOString(), end: new Date(1000000).toISOString() }] });
    expect(stored?.snapshot).not.toHaveProperty('customer_email');
    expect(stored?.snapshot).toEqual((await rows())[0]?.snapshot ?? null);
    expect((await findProviderEventById(gatewayDb(), id))?.processedAt).toBeInstanceOf(Date);
    expect(await process(await event('invoice', 'in_1', { apiVersion: STRIPE_API_VERSION }))).toMatchObject({ kind: 'unchanged' });
    incomplete = true;
    const rejected = await event('invoice', 'in_1', { apiVersion: STRIPE_API_VERSION });
    expect(await process(rejected)).toMatchObject({ kind: 'failed' });
    expect((await findProviderEventById(gatewayDb(), rejected))?.processedAt).toBeNull();
    expect((await findRecurringMirror(gatewayDb(), pinned, 'invoice', 'in_1', null))?.revision).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

});
