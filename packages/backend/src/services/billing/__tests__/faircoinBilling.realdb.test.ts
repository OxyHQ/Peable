import { SettlementWatcher } from '../../settlementWatcher';
import { findIntentById } from '../../../db/payments/paymentIntentRepository';
import { beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { canonicalBillingTaxQuote, type BillingTaxQuote } from '@peable.to/shared-types';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../../__tests__/helpers/gatewayTestDatabase';
import { faircoinBillingInvoices, paymentIntents } from '../../../db/schema';
import { transitionIntent } from '../../intentTransition';
import { createFaircoinBillingService } from '../faircoinBillingService';
import type { BillingTaxQuoteCalculator } from '../tax-quote';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing fixture value');
  return value;
}

async function fixture() {
  const merchant = await seedMerchant({ environment: 'development', network: 'testnet' });
  const owner = {
    merchantId: merchant.id,
    oxyAppId: merchant.oxyAppId,
    environment: merchant.environment,
  };
  let clock = new Date();
  const keys = generateKeyPairSync('ed25519');
  const offer = {
    providerPriceId: 'price_fairone',
    planId: 'one',
    offerId: 'one',
    offerVersion: 1,
    interval: 'month' as const,
    intervalCount: 1 as const,
    currency: 'USD' as const,
    grossMinorUnits: 2999,
    taxTreatment: 'inclusive' as const,
  };
  const calculator: BillingTaxQuoteCalculator = {
    verificationKeys: { fiscal: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    resolveProduct: async () => ({
      configurationApproved: true,
      planId: 'one',
      currency: 'USD',
      grossMinorUnits: 2999,
      taxTreatment: 'inclusive',
      sellerId: 'seller',
      invoiceIssuerId: 'issuer',
      taxRemitterId: 'remitter',
      taxServiceRef: 'fixture',
      allowedCountries: ['RO'],
      coverageEvidenceId: 'coverage',
    }),
    readCustomerLocation: async () => ({
      id: 'location',
      storeId: 'payer',
      appId: owner.oxyAppId,
      mode: 'test',
      environment: 'development',
      country: 'RO',
      observedAt: new Date(+clock - 1000).toISOString(),
      expiresAt: new Date(+clock + 600_000).toISOString(),
    }),
    calculate: async ({ source }) => {
      const quote: BillingTaxQuote = {
        schemaVersion: 1,
        source,
        quote: {
          id: `tax_${randomUUID()}`,
          currency: 'USD',
          grossMinorUnits: 2999,
          netMinorUnits: 2500,
          taxMinorUnits: 499,
          taxTreatment: 'inclusive',
          sellerId: 'seller',
          invoiceIssuerId: 'issuer',
          taxRemitterId: 'remitter',
          taxServiceRef: 'fixture',
          country: 'RO',
          coverageEvidenceId: 'coverage',
          taxRateEvidenceId: 'rate',
          customerLocationEvidenceId: 'location',
          quotedAt: new Date(+clock - 1000).toISOString(),
          expiresAt: new Date(+clock + 600_000).toISOString(),
        },
        signature: { algorithm: 'Ed25519', keyId: 'fiscal', value: '' },
      };
      quote.signature.value = sign(
        null,
        Buffer.from(canonicalBillingTaxQuote(quote)),
        keys.privateKey,
      ).toString('base64url');
      return quote;
    },
  };
  const service = createFaircoinBillingService({
    db: gatewayDb(),
    configuration: {
      cohorts: [{ ...owner, offers: [offer] }],
      priceSource: 'faircoin_explorer_indexed_usd',
      taxQuoteAdapterRef: 'fiscal',
      invoiceSigningKeyId: 'invoice',
    },
    taxQuoteCalculator: calculator,
    invoiceSigningKey: keys.privateKey,
    now: () => clock,
    quote: async () => ({
      id: `fx_${randomUUID()}`,
      currency: 'USD',
      grossMinorUnits: 2999,
      amountBaseUnits: '2999000000',
      usdPerFair: '1',
      source: 'synthetic_test_quote',
      observedAt: clock.toISOString(),
      quotedAt: new Date(+clock - 1000).toISOString(),
      expiresAt: new Date(+clock + 300_000).toISOString(),
      rounding: 'ceil_to_base_unit',
    }),
  });
  const customer = await service.ensureCustomer(
    owner,
    { storeId: 'payer', storeName: 'payer' },
    'customer',
  );
  async function input() {
    return {
      ...customer,
      providerPriceId: 'price_fairone',
      trialDays: 0,
      returnUrl: 'https://example.invalid/return',
      storeId: 'payer',
      planId: 'one',
      taxQuote: await service.createTaxQuote(owner, {
        storeId: 'payer',
        planId: 'one',
        customerLocationEvidenceId: 'location',
      }),
    };
  }
  async function invoice(checkout: { id: string }) {
    const [row] = await gatewayDb()
      .select()
      .from(faircoinBillingInvoices)
      .where(eq(faircoinBillingInvoices.checkoutRef, checkout.id));
    if (!row?.paymentIntentId) throw new Error('Missing persisted payment');
    return row;
  }
  async function submit(row: Awaited<ReturnType<typeof invoice>>) {
    await transitionIntent(must(row.paymentIntentId), {
      from: 'created',
      status: 'broadcast',
      txid: 'a'.repeat(64),
    });
  }
  async function confirm(row: Awaited<ReturnType<typeof invoice>>) {
    const intent = await findIntentById(gatewayDb(), must(row.paymentIntentId));
    if (!intent?.address || !intent.txid) throw new Error('Missing broadcast');
    const watcher = new SettlementWatcher({
      getTransaction: async () => ({
        txid: must(intent.txid),
        confirmations: 2,
        outputs: [{ address: must(intent.address), valueSat: BigInt(intent.amount) }],
      }),
      onChange: () => {},
    });
    await watcher.check();
  }
  return {
    service,
    owner,
    input,
    invoice,
    submit,
    confirm,
    advance: (ms: number) => {
      clock = new Date(+clock + ms);
    },
  };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('native FairCoin billing / real PostgreSQL', () => {
  useGatewayDatabase();
  beforeEach(resetGatewayTables);
  it('converges concurrent checkout retries and grants only confirmed payments', async () => {
    const f = await fixture();
    const input = await f.input();
    const [a, b] = await Promise.all([
      f.service.createCheckoutSession(f.owner, input, 'first'),
      f.service.createCheckoutSession(f.owner, input, 'first'),
    ]);
    expect(a).toEqual(b);
    const row = await f.invoice(a);
    expect((await f.service.retrieveCheckout(f.owner, a.id)).status).toBe('open');
    await expect(
      f.service.retrievePaidInvoice(f.owner, row.subscriptionId, row.id),
    ).rejects.toThrow();
    await f.submit(row);
    const [reported] = await gatewayDb()
      .select()
      .from(faircoinBillingInvoices)
      .where(eq(faircoinBillingInvoices.id, row.id));
    expect(reported?.acceptedAt).toBeNull();
    await f.confirm(row);
    f.advance(600_000);
    const paid = await f.service.retrievePaidInvoice(f.owner, row.subscriptionId, row.id);
    expect(paid.amountPaid).toBe('2999');
    expect(
      (await f.service.retrieveFinalInvoiceAuthority(f.owner, row.subscriptionId, row.id)).invoice
        .faircoinQuote?.amountBaseUnits,
    ).toBe('2999000000');
    expect((await f.service.retrieveSubscription(f.owner, row.subscriptionId)).status).toBe(
      'active',
    );
    await expect(
      f.service.createCheckoutSession(
        f.owner,
        { ...input, returnUrl: 'https://other.invalid' },
        'first',
      ),
    ).rejects.toThrow('idempotency_conflict');
  });
  it('refuses an early reported hash whose actual payment appears after the quote expires', async () => {
    const f = await fixture();
    const checkout = await f.service.createCheckoutSession(f.owner, await f.input(), 'late');
    const row = await f.invoice(checkout);
    await f.submit(row);
    // Simulate the trusted first node observation after the quote, not a caller timestamp.
    await gatewayDb()
      .update(faircoinBillingInvoices)
      .set({ fxQuote: { ...row.fxQuote, expiresAt: new Date(Date.now() - 1).toISOString() } })
      .where(eq(faircoinBillingInvoices.id, row.id));
    await f.confirm(row);
    await expect(
      f.service.retrievePaidInvoice(f.owner, row.subscriptionId, row.id),
    ).rejects.toThrow();
    expect((await f.service.retrieveSubscription(f.owner, row.subscriptionId)).status).toBe(
      'incomplete',
    );
    await expect(f.service.retrieveCheckout(f.owner, checkout.id)).rejects.toThrow(
      'reconciliation_required',
    );
  });
  it('replaces only terminal unpaid initial attempts, serializing concurrent fresh checkouts', async () => {
    const f = await fixture();
    const first = await f.service.createCheckoutSession(f.owner, await f.input(), 'abandoned');
    const row = await f.invoice(first);
    await transitionIntent(must(row.paymentIntentId), { from: 'created', status: 'expired' });
    const results = await Promise.allSettled([
      f.service.createCheckoutSession(f.owner, await f.input(), 'retry-one'),
      f.service.createCheckoutSession(f.owner, await f.input(), 'retry-two'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await f.service.retrieveSubscription(f.owner, row.subscriptionId)).status).toBe(
      'canceled',
    );
    expect((await f.service.retrieveCheckout(f.owner, first.id)).status).toBe('expired');
    // A stale watcher cannot revive the terminal payment after a replacement exists.
    expect(
      (
        await transitionIntent(must(row.paymentIntentId), {
          from: 'broadcast',
          status: 'confirming',
        })
      ).kind,
    ).toBe('stale');
    await expect(
      f.service.retrievePaidInvoice(f.owner, row.subscriptionId, row.id),
    ).rejects.toThrow();
    expect(await gatewayDb().select().from(paymentIntents)).toHaveLength(2);
  });

  it('does not replace a confirming first payment merely because its quote expired', async () => {
    const f = await fixture();
    const first = await f.service.createCheckoutSession(f.owner, await f.input(), 'confirming');
    const row = await f.invoice(first);
    await f.submit(row);
    await transitionIntent(must(row.paymentIntentId), { from: 'broadcast', status: 'confirming' });
    f.advance(600_000);
    expect((await f.service.retrieveCheckout(f.owner, first.id)).status).toBe('open');
    await expect(
      f.service.createCheckoutSession(f.owner, await f.input(), 'replacement'),
    ).rejects.toThrow('identity_conflict');
    expect(await gatewayDb().select().from(paymentIntents)).toHaveLength(1);
  });

  it('does not claim an unseen broadcast is expired merely because its quote elapsed', async () => {
    const f = await fixture();
    const checkout = await f.service.createCheckoutSession(f.owner, await f.input(), 'unseen');
    const row = await f.invoice(checkout);
    await f.submit(row);
    f.advance(600_000);
    await expect(f.service.retrieveCheckout(f.owner, checkout.id)).rejects.toThrow(
      'reconciliation_required',
    );
    expect(must(await findIntentById(gatewayDb(), must(row.paymentIntentId))).status).toBe(
      'broadcast',
    );
    expect((await f.service.retrieveSubscription(f.owner, row.subscriptionId)).status).toBe(
      'incomplete',
    );
  });

  it('requires review for failed chain observations instead of proposing another charge', async () => {
    const f = await fixture();
    const checkout = await f.service.createCheckoutSession(f.owner, await f.input(), 'partial');
    const row = await f.invoice(checkout);
    await f.submit(row);
    const intent = must(await findIntentById(gatewayDb(), must(row.paymentIntentId)));
    await new SettlementWatcher({
      getTransaction: async () => ({
        txid: must(intent.txid),
        confirmations: 2,
        outputs: [{ address: must(intent.address), valueSat: 1n }],
      }),
      onChange: () => {},
    }).check();
    expect(must(await findIntentById(gatewayDb(), intent.id)).status).toBe('failed');
    await expect(f.service.retrieveCheckout(f.owner, checkout.id)).rejects.toThrow(
      'reconciliation_required',
    );
    await expect(
      f.service.createCheckoutSession(f.owner, await f.input(), 'fresh'),
    ).rejects.toThrow('reconciliation_required');
    await expect(
      f.service.renew(f.owner, row.subscriptionId, await f.input(), 'renew'),
    ).rejects.toThrow('reconciliation_required');
    expect(await gatewayDb().select().from(paymentIntents)).toHaveLength(1);
  });

  it('serializes independent initial checkouts and binds merchant ownership', async () => {
    const f = await fixture();
    const input = await f.input();
    const result = await Promise.allSettled([
      f.service.createCheckoutSession(f.owner, input, 'one'),
      f.service.createCheckoutSession(f.owner, input, 'two'),
    ]);
    expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const winner = result.find((x) => x.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('No checkout');
    const row = await f.invoice(winner.value);
    await expect(
      f.service.retrieveSubscription({ ...f.owner, merchantId: 'foreign' }, row.subscriptionId),
    ).rejects.toThrow('not_found');
    await expect(
      f.service.cancelAtPeriodEnd(
        { ...f.owner, oxyAppId: 'foreign' },
        row.subscriptionId,
        'cancel',
      ),
    ).rejects.toThrow('not_found');
    const all = await gatewayDb().select().from(paymentIntents);
    expect(all.filter((x) => x.merchantId === f.owner.merchantId)).toHaveLength(1);
  });
  it('preserves paid history and ends access without automatic renewal; cancellation forbids new invoices', async () => {
    const f = await fixture();
    const first = await f.service.createCheckoutSession(f.owner, await f.input(), 'first');
    const row = await f.invoice(first);
    await f.submit(row);
    await f.confirm(row);
    expect(
      (await f.service.cancelAtPeriodEnd(f.owner, row.subscriptionId, 'cancel')).cancelAtPeriodEnd,
    ).toBe(true);
    expect((await f.service.retrieveSubscription(f.owner, row.subscriptionId)).status).toBe(
      'active',
    );
    f.advance(32 * 86_400_000);
    expect((await f.service.retrieveSubscription(f.owner, row.subscriptionId)).status).toBe(
      'canceled',
    );
    await expect(
      f.service.renew(f.owner, row.subscriptionId, await f.input(), 'renew'),
    ).rejects.toThrow('identity_conflict');
    expect(
      (await f.service.retrievePaidInvoice(f.owner, row.subscriptionId, row.id)).invoiceId,
    ).toBe(row.id);
  });
  it('renews one explicit paid period without suspending today or duplicating a lost reply', async () => {
    const f = await fixture();
    const first = await f.service.createCheckoutSession(f.owner, await f.input(), 'first');
    const row = await f.invoice(first);
    await f.submit(row);
    await f.confirm(row);
    // Put the paid period in its renewal window without moving the trusted node clock.
    const start = new Date(Date.now() - 24 * 86_400_000),
      end = new Date(Date.now() + 6 * 86_400_000);
    await gatewayDb()
      .update(faircoinBillingInvoices)
      .set({ periodStart: start, periodEnd: end })
      .where(eq(faircoinBillingInvoices.id, row.id));
    const request = await f.input();
    const next = await f.service.renew(f.owner, row.subscriptionId, request, 'next');
    expect(await f.service.renew(f.owner, row.subscriptionId, request, 'next')).toEqual(next);
    const nextRow = await f.invoice(next);
    expect(nextRow.periodStart.toISOString()).toBe(end.toISOString());
    const intent = await findIntentById(gatewayDb(), must(nextRow.paymentIntentId));
    expect(+must(intent).expiresAt).toBeLessThanOrEqual(Date.parse(nextRow.fxQuote.expiresAt));
    await f.submit(nextRow);
    await f.confirm(nextRow);
    const current = await f.service.retrieveSubscription(f.owner, row.subscriptionId);
    expect(current.status).toBe('active');
    expect(current.currentPeriodStart).toBe(start.toISOString());
    expect(current.currentPeriodEnd).toBe(nextRow.periodEnd.toISOString());
    expect((await f.service.retrieveCheckout(f.owner, first.id)).initialInvoiceId).toBe(row.id);
    expect((await f.service.retrieveCheckout(f.owner, next.id)).initialInvoiceId).toBe(nextRow.id);
    const recovered = await f.service.retrieveCheckoutOperation(f.owner, {
      idempotencyKey: 'next',
      providerCustomerId: request.providerCustomerId,
      providerPriceId: request.providerPriceId,
      storeId: request.storeId,
      planId: request.planId,
    });
    expect(recovered.state).toBe('succeeded');
    expect(await gatewayDb().select().from(paymentIntents)).toHaveLength(2);
  });

  it('renews a lapsed paid source from today without charging missed months', async () => {
    const f = await fixture();
    const first = await f.service.createCheckoutSession(f.owner, await f.input(), 'first');
    const row = await f.invoice(first);
    await f.submit(row);
    await f.confirm(row);
    await gatewayDb()
      .update(faircoinBillingInvoices)
      .set({
        periodStart: new Date(Date.now() - 120 * 86_400_000),
        periodEnd: new Date(Date.now() - 90 * 86_400_000),
      })
      .where(eq(faircoinBillingInvoices.id, row.id));
    // Existing paid history must use the owned renewal path, not replacement.
    await expect(
      f.service.createCheckoutSession(f.owner, await f.input(), 'replacement'),
    ).rejects.toThrow('identity_conflict');
    const renewed = await f.service.renew(
      f.owner,
      row.subscriptionId,
      await f.input(),
      'after-lapse',
    );
    const next = await f.invoice(renewed);
    expect(Math.abs(+next.periodStart - Date.now())).toBeLessThan(5000);
    expect(+next.periodEnd).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect((await f.service.retrieveSubscription(f.owner, row.subscriptionId)).status).toBe(
      'past_due',
    );
    await f.submit(next);
    await f.confirm(next);
    expect((await f.service.retrieveSubscription(f.owner, row.subscriptionId)).status).toBe(
      'active',
    );
  });

  it('refuses reuse of a signed single-use tax quote after cancellation', async () => {
    const f = await fixture();
    const input = await f.input();
    const first = await f.service.createCheckoutSession(f.owner, input, 'first');
    const row = await f.invoice(first);
    await f.service.cancelAtPeriodEnd(f.owner, row.subscriptionId, 'cancel');
    await expect(f.service.createCheckoutSession(f.owner, input, 'second')).rejects.toThrow();
    expect(await gatewayDb().select().from(paymentIntents)).toHaveLength(1);
  });
});
