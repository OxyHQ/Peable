import { findIntentByPublicId, linkProviderObject, updateIntentState } from '../../../db/payments/paymentIntentRepository';
import { redactProviderPayload } from '../../providers/redact';
import {relayRecurringObservations} from '../recurringDelivery';
import {Peable} from '@peable.to/sdk';
import {signWebhook} from '@peable.to/shared-types';
import type Stripe from 'stripe';
import { createPrivateStripeRecurringReader } from '../stripeRecurringReader';
import { STRIPE_API_VERSION } from '../../providers/stripe/client';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq,sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { gatewayDb, POSTGRES_TESTS_ENABLED, resetGatewayTables, seedMerchant, seedIntent, useGatewayDatabase } from '../../../__tests__/helpers/gatewayTestDatabase';
import { bindRecurringObject, findRecurringMirror } from '../../../db/recurring/recurringMirrorRepository';
import { findProviderEventById, insertProviderEvent } from '../../../db/providers/providerEventRepository';
import { recurringMirrors, recurringObservationOutbox,merchants,webhookDeliveries } from '../../../db/schema';
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

  it('defaults relay off before DB, fences cohorts, atomically enqueues once under concurrent replay, and verifies SDK signature',async()=>{
    expect(await relayRecurringObservations({db:undefined as never,cohorts:[]})).toEqual({kind:'disabled',enqueued:0});
    const sub=await bind();await gatewayDb().update(merchants).set({webhookUrl:'https://example.invalid/fixture',webhookSecret:'synthetic-only'}).where(eq(merchants.id,sub.merchantId));
    await observeRecurringEvent(await event(),options);
    const cohort={...deployment,merchantId:sub.merchantId,oxyAppId:sub.oxyAppId,evidenceRef:'fixture-approved'};
    expect((await relayRecurringObservations({db:gatewayDb(),enabled:true,cohorts:[{...cohort,oxyAppId:'other'}]})).enqueued).toBe(0);
    const results=await Promise.all([relayRecurringObservations({db:gatewayDb(),enabled:true,cohorts:[cohort]}),relayRecurringObservations({db:gatewayDb(),enabled:true,cohorts:[cohort]})]);expect(results.reduce((n,v)=>n+v.enqueued,0)).toBe(1);
    const [delivery]=await gatewayDb().select().from(webhookDeliveries);const [privateRow]=await rows();expect(privateRow!.deliveryId).toBe(delivery!.id);
    const sdk=new Peable({publicKey:'synthetic',secret:'synthetic'});const raw=JSON.stringify(delivery!.payload),timestamp=Math.floor(Date.now()/1000),signature=signWebhook('synthetic-only',raw,timestamp);
    expect(sdk.webhooks.constructEvent(raw,signature,'synthetic-only')).toMatchObject({type:'billing.observation.updated',data:{object:{resourceKind:'subscription',resourceId:'sub_1',revision:1}}});
    expect(()=>sdk.webhooks.constructEvent(raw,signature,'other-secret')).toThrow();
  });
  it.each(['historical-v0', null])('preserves opted-in one-off refund processing for API version %s', async (apiVersion) => {
    const merchant = await seedMerchant();
    const intent = await seedIntent(merchant, { rail: 'card', amount: '100', currency: 'USD' });
    const paymentRef = `pi_oneoff_${randomUUID()}`;
    await linkProviderObject(gatewayDb(), intent.id, 'stripe', paymentRef);
    await updateIntentState(gatewayDb(), intent.id, { from: 'created', status: 'settled' });
    const eventId = await event('invoice', 'unused', { type: 'refund.created', apiVersion,
      objectIds: { refund: `re_oneoff_${randomUUID()}`, payment_intent: paymentRef },
      payload: redactProviderPayload({ data: { object: { amount: 100, status: 'succeeded' } } }),
    });
    const stored = await findProviderEventById(gatewayDb(), eventId);
    if (!stored) throw new Error('Expected stored refund');
    expect(await processProviderEvent(stored, options)).toMatchObject({ kind: 'applied', intentId: intent.id, status: 'refunded' });
    expect((await findIntentByPublicId(gatewayDb(), intent.publicId))?.status).toBe('refunded');
    expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).not.toBeNull();
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it('rejects bound recurring refund version mismatches before any provider read', async () => {
    const parent = await bind(); await bind('invoice', 'in_1', parent.merchantId);
    readSnapshot.mockResolvedValue({ ...invoice(), paymentIntentRef: 'pi_owned', chargeRef: 'ch_owned', amountRefunded: '0' });
    await observeRecurringEvent(await event('invoice', 'in_1'), options);
    readSnapshot.mockClear();
    for (const apiVersion of ['historical-v0', null]) {
      const eventId = await event('invoice', 'unused', { type: 'refund.updated', apiVersion,
        objectIds: { charge: 'ch_owned', payment_intent: 'pi_owned' },
      });
      const stored = await findProviderEventById(gatewayDb(), eventId);
      if (!stored) throw new Error('Expected stored recurring refund');
      expect(await processProviderEvent(stored, options)).toMatchObject({ kind: 'failed', error: 'recurring_observation_failed' });
      expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).toBeNull();
    }
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
  });

  it('refund wake-ups follow previously proven lineage and delayed paid events cannot rewind current refunds',async()=>{
    const sub=await bind();await bind('invoice','in_1',sub.merchantId);
    const paid={...invoice(),paymentIntentRef:'pi_owned',chargeRef:'ch_owned',amountRefunded:'0'};readSnapshot.mockResolvedValue(paid);await observeRecurringEvent(await event('invoice','in_1'),options);
    const full={...paid,amountRefunded:'100'};readSnapshot.mockResolvedValue(full);
    const refund=await event('invoice','in_1',{type:'charge.refunded',objectIds:{charge:'ch_owned',payment_intent:'pi_owned'}});expect(await observeRecurringEvent(refund,options)).toMatchObject({kind:'observed',revision:2});
    expect(await observeRecurringEvent(await event('invoice','in_1',{type:'invoice.paid',payload:{created:0}}),options)).toMatchObject({kind:'unchanged'});
    expect(await observeRecurringEvent(await event('invoice','in_1',{type:'charge.refunded',objectIds:{charge:'ch_foreign'}}),options)).toMatchObject({kind:'unmatched'});
    expect(await rows()).toHaveLength(2);
  });

  it('rolls back public enqueue and pointer together after a SQL failure, then retries once',async()=>{
    const sub=await bind();await gatewayDb().update(merchants).set({webhookUrl:'https://example.invalid/fixture',webhookSecret:'synthetic-only'}).where(eq(merchants.id,sub.merchantId));await observeRecurringEvent(await event(),options);
    const cohort={...deployment,merchantId:sub.merchantId,oxyAppId:sub.oxyAppId,evidenceRef:'fixture-approved'};
    await gatewayDb().execute(sql`CREATE FUNCTION fixture_relay_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic relay failure'; END $$`);
    await gatewayDb().execute(sql`CREATE TRIGGER fixture_relay_reject BEFORE UPDATE ON recurring_observation_outbox FOR EACH ROW EXECUTE FUNCTION fixture_relay_reject()`);
    try{await expect(relayRecurringObservations({db:gatewayDb(),cohorts:[cohort],enabled:true})).rejects.toThrow();expect(await gatewayDb().select().from(webhookDeliveries)).toHaveLength(0);expect((await rows())[0]!.deliveryId).toBeNull();}finally{await gatewayDb().execute(sql`DROP TRIGGER fixture_relay_reject ON recurring_observation_outbox`);await gatewayDb().execute(sql`DROP FUNCTION fixture_relay_reject()`);}
    expect((await relayRecurringObservations({db:gatewayDb(),cohorts:[cohort],enabled:true})).enqueued).toBe(1);
  });

  it('bounds invoice discovery too and leaves the stored event pending after timeout',async()=>{
    const id=await event('invoice','in_unknown');const result=await observeRecurringEvent(id,{...options,timeoutMs:10,bindOwnedInvoice:async()=>new Promise<void>(()=>{})});expect(result).toMatchObject({kind:'failed'});expect((await findProviderEventById(gatewayDb(),id))?.processedAt).toBeNull();expect(await rows()).toHaveLength(0);
  });

});
