import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  canonicalBillingAuthority,
  type BillingCheckoutObservation,
  type BillingFinalInvoiceAuthority,
  type BillingInvoiceState,
  type BillingPaidInvoice,
  type BillingSubscription,
  type CreateBillingCheckoutParams,
} from '@peable.to/shared-types';
import type { Database } from '../../db/postgres';
import {
  faircoinBillingInvoices as invoices,
  faircoinBillingSubscriptions as subscriptions,
} from '../../db/schema/faircoinBilling';
import { paymentIntents } from '../../db/schema/payments';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import {
  findIntentById,
  findIntentByIdempotencyKey,
} from '../../db/payments/paymentIntentRepository';
import {
  findSessionByIntentId,
  insertCheckoutSession,
} from '../../db/payments/checkoutSessionRepository';
import { createIntent } from '../createIntent';
import { config } from '../../config';
import {
  BillingError,
  billingIdempotencyKey,
  checkoutSchema,
  ensureCustomerSchema,
  type BillingOwner,
} from './contracts';
import { createVerifiedBillingTaxQuote, type BillingTaxQuoteCalculator } from './tax-quote';
import { prepareBillingTaxCheckout, type BillingTaxCheckoutAdapter } from './tax-checkout';
import { verifyFinalInvoiceAuthority } from './invoice-authority';
import { createExplorerFaircoinQuote, type FaircoinFxQuote } from './faircoin-fx';
import type { BillingService } from './billingService';
import { invoiceTaxLines } from '../tax/billingTaxQuotes';

const offerSchema = z
  .object({
    providerPriceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
    planId: z.string().min(1),
    offerId: z.string().min(1),
    offerVersion: z.number().int().positive(),
    interval: z.enum(['month', 'year']),
    intervalCount: z.literal(1),
    currency: z.literal('USD'),
    grossMinorUnits: z.number().int().positive().safe(),
    /** Inclusive: the payer pays the listed price. Exclusive: tax is added and
     * the FairCoin amount converts price plus tax. */
    taxTreatment: z.enum(['inclusive', 'exclusive']),
  })
  .strict();
export const faircoinBillingConfigurationSchema = z
  .object({
    cohorts: z
      .array(
        z
          .object({
            merchantId: z.string().min(1),
            oxyAppId: z.string().min(1),
            environment: z.enum(['development', 'staging', 'production']),
            offers: z.array(offerSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    /** Operator opt-in to the existing indexed FAIR/USD source, not an invented rate. */
    priceSource: z.literal('faircoin_explorer_indexed_usd'),
    taxQuoteAdapterRef: z.string().min(1),
    invoiceSigningKeyId: z.string().min(1),
  })
  .strict();
export type FaircoinBillingConfiguration = z.infer<typeof faircoinBillingConfigurationSchema>;
type Subscription = typeof subscriptions.$inferSelect;
type Invoice = typeof invoices.$inferSelect;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const customerRef = (owner: BillingOwner, subject: string) =>
  `cus_fair${digest([owner.merchantId, owner.oxyAppId, owner.environment, subject])}`;
function periodAfter(start: Date, interval: 'month' | 'year') {
  const next = new Date(start);
  const day = start.getUTCDate();
  next.setUTCMonth(next.getUTCMonth() + (interval === 'year' ? 12 : 1), 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

/** Concrete watch-only recurring billing. Each renewal is an explicit checkout;
 * no automatic debit, mandate, Stripe key, wallet seed or signing of transfers.
 * Fiscal quotes must come from the already reviewed, pinned tax authority. */
export function createFaircoinBillingService(options: {
  db: Database;
  configuration: FaircoinBillingConfiguration;
  taxQuoteCalculator: BillingTaxQuoteCalculator;
  invoiceSigningKey: string | KeyObject;
  quote?: (grossMinorUnits: number) => Promise<FaircoinFxQuote>;
  now?: () => Date;
}): BillingService & {
  renew(
    owner: BillingOwner,
    subscriptionId: string,
    input: CreateBillingCheckoutParams,
    key: string,
  ): Promise<{ id: string; url: string; expiresAt: string }>;
} {
  const { db } = options;
  const configuration = faircoinBillingConfigurationSchema.parse(options.configuration);
  const now = options.now ?? (() => new Date());
  const privateKey =
    typeof options.invoiceSigningKey === 'string'
      ? createPrivateKey(options.invoiceSigningKey)
      : options.invoiceSigningKey;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Invoice authority requires an Ed25519 signing key');
  const verificationKeys = {
    [configuration.invoiceSigningKeyId]: createPublicKey(privateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  };
  function authorize(owner: BillingOwner) {
    const matches = configuration.cohorts.filter(
      (c) =>
        c.merchantId === owner.merchantId &&
        c.oxyAppId === owner.oxyAppId &&
        c.environment === owner.environment,
    );
    if (matches.length !== 1 || !matches[0]) throw new BillingError('not_found', 404);
    return matches[0];
  }
  async function merchant(owner: BillingOwner) {
    authorize(owner);
    const value = await findMerchantById(db, owner.merchantId);
    if (
      !value ||
      value.oxyAppId !== owner.oxyAppId ||
      value.environment !== owner.environment ||
      !value.xpub ||
      !value.network
    )
      throw new BillingError('not_found', 404);
    if ((owner.environment === 'production') !== (value.network === 'mainnet'))
      throw new BillingError('identity_conflict');
    return value;
  }
  async function owned(owner: BillingOwner, id: string) {
    authorize(owner);
    const [value] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, id),
          eq(subscriptions.merchantId, owner.merchantId),
          eq(subscriptions.oxyAppId, owner.oxyAppId),
          eq(subscriptions.environment, owner.environment),
        ),
      );
    if (!value) throw new BillingError('not_found', 404);
    return value;
  }
  async function ownedInvoice(owner: BillingOwner, subscriptionId: string, invoiceId: string) {
    const subscription = await owned(owner, subscriptionId);
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.subscriptionId, subscription.id)));
    if (!invoice) throw new BillingError('not_found', 404);
    return { subscription, invoice };
  }
  async function rows(subscription: Subscription) {
    return db
      .select({ invoice: invoices, intent: paymentIntents })
      .from(invoices)
      .leftJoin(paymentIntents, eq(invoices.paymentIntentId, paymentIntents.id))
      .where(eq(invoices.subscriptionId, subscription.id))
      .orderBy(desc(invoices.periodStart));
  }
  async function project(subscription: Subscription): Promise<BillingSubscription> {
    const periods = await rows(subscription);
    const paid = periods.filter(
      (row) =>
        row.intent?.status === 'settled' &&
        row.intent.rail === 'faircoin' &&
        row.intent.amount === row.invoice.fxQuote.amountBaseUnits &&
        row.invoice.acceptedAt &&
        +row.invoice.acceptedAt >= Date.parse(row.invoice.fxQuote.quotedAt) &&
        +row.invoice.acceptedAt < Date.parse(row.invoice.fxQuote.expiresAt),
    );
    const activePeriods = paid.filter(
      (row) => +row.invoice.periodStart <= +now() && +row.invoice.periodEnd > +now(),
    );
    const current = activePeriods[0]?.invoice ?? paid[0]?.invoice ?? periods.at(-1)?.invoice;
    // A paid renewal may begin next month. Keep today's paid start while extending
    // the end through contiguous paid periods; do not suspend current access.
    let paidThrough = current?.periodEnd;
    for (const row of [...paid].reverse()) {
      if (
        paidThrough &&
        +row.invoice.periodStart <= +paidThrough &&
        +row.invoice.periodEnd > +paidThrough
      )
        paidThrough = row.invoice.periodEnd;
    }
    if (!current) throw new BillingError('reconciliation_required');
    const active = paid.some(
      (row) => +row.invoice.periodStart <= +now() && +row.invoice.periodEnd > +now(),
    );
    return {
      providerSubscriptionId: subscription.id,
      latestInvoiceId: periods[0]?.invoice.id ?? null,
      providerCustomerId: subscription.customerRef,
      providerPriceId: subscription.priceRef,
      storeId: subscription.subjectRef,
      planId: subscription.planRef,
      livemode: subscription.environment === 'production',
      status: active
        ? 'active'
        : subscription.cancelAtPeriodEnd
          ? 'canceled'
          : paid.length
            ? 'past_due'
            : 'incomplete',
      interval: subscription.billingInterval,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodStart: current.periodStart.toISOString(),
      currentPeriodEnd: (paidThrough ?? current.periodEnd).toISOString(),
      trialEndsAt: null,
      cancelAt: subscription.cancelAtPeriodEnd
        ? (paidThrough ?? current.periodEnd).toISOString()
        : null,
      cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
    };
  }
  async function paidInvoice(
    owner: BillingOwner,
    subscriptionId: string,
    invoiceId: string,
  ): Promise<BillingPaidInvoice> {
    const { subscription, invoice } = await ownedInvoice(owner, subscriptionId, invoiceId);
    const intent = invoice.paymentIntentId
      ? await findIntentById(db, invoice.paymentIntentId)
      : null;
    // A submitted txid, a success redirect or an unconfirmed transfer awards nothing.
    if (
      intent?.status !== 'settled' ||
      intent.rail !== 'faircoin' ||
      !intent.txid ||
      !invoice.acceptedAt ||
      intent.amount !== invoice.fxQuote.amountBaseUnits ||
      intent.merchantId !== owner.merchantId ||
      +invoice.acceptedAt < Date.parse(invoice.fxQuote.quotedAt) ||
      +invoice.acceptedAt >= Date.parse(invoice.fxQuote.expiresAt)
    )
      throw new BillingError('not_found', 404);
    const tax = invoice.taxSnapshot.taxQuote.quote;
    return {
      invoiceId: invoice.id,
      lineId: `${invoice.id}_line`,
      paymentIntentId: intent.publicId,
      providerSubscriptionId: subscription.id,
      providerCustomerId: subscription.customerRef,
      providerPriceId: subscription.priceRef,
      storeId: subscription.subjectRef,
      planId: subscription.planRef,
      livemode: subscription.environment === 'production',
      currency: 'USD',
      amountPaid: String(tax.grossMinorUnits),
      netAmount: String(tax.netMinorUnits),
      taxAmount: String(tax.taxMinorUnits),
      periodStart: invoice.periodStart.toISOString(),
      periodEnd: invoice.periodEnd.toISOString(),
      paidAt: invoice.acceptedAt.toISOString(),
      observedAt: now().toISOString(),
    };
  }
  /** The frozen Peable Tax lines behind an invoice's tax amount. */
  async function requireTaxLines(owner: BillingOwner, calculationId: string) {
    const lines = await invoiceTaxLines(db, owner.merchantId, calculationId);
    if (!lines) throw new BillingError('not_found', 404);
    return lines;
  }
  async function materialize(
    owner: BillingOwner,
    invoice: Invoice,
    input: CreateBillingCheckoutParams,
  ) {
    const m = await merchant(owner);
    const expires = new Date(invoice.fxQuote.expiresAt);
    let intent = invoice.paymentIntentId
      ? await findIntentById(db, invoice.paymentIntentId)
      : await findIntentByIdempotencyKey(db, owner.merchantId, `faircoin-period:${invoice.id}`);
    if (!intent) {
      const remaining = Math.floor((+expires - +now()) / 1000);
      if (remaining <= 0) throw new BillingError('reconciliation_required');
      intent = (
        await createIntent({
          merchant: m,
          amount: invoice.fxQuote.amountBaseUnits,
          rail: 'faircoin',
          currency: 'FAIR',
          network: m.network ?? undefined,
          expiresInSeconds: remaining,
          idempotencyKey: `faircoin-period:${invoice.id}`,
        })
      ).intent;
    }
    // Address reservation/network work can outlast the seconds rounded above.
    // The persisted gateway deadline is bounded by the frozen signed quote too.
    if (+intent.expiresAt > +expires) {
      const [bounded] = await db
        .update(paymentIntents)
        .set({ expiresAt: expires })
        .where(eq(paymentIntents.id, intent.id))
        .returning();
      if (!bounded) throw new BillingError('reconciliation_required');
      intent = { ...intent, expiresAt: bounded.expiresAt };
    }
    if (!invoice.paymentIntentId)
      await db
        .update(invoices)
        .set({ paymentIntentId: intent.id })
        .where(eq(invoices.id, invoice.id));
    let session = await findSessionByIntentId(db, intent.id);
    if (!session) {
      session = await insertCheckoutSession(db, {
        publicId: invoice.checkoutRef,
        merchantId: owner.merchantId,
        oxyAppId: owner.oxyAppId,
        environment: owner.environment,
        paymentIntentId: intent.id,
        amount: intent.amount,
        currency: 'FAIR',
        rail: 'faircoin',
        network: intent.network,
        metadata: {},
        successUrl: input.returnUrl,
        cancelUrl: input.returnUrl,
      });
      session ??= await findSessionByIntentId(db, intent.id);
    }
    if (!session) throw new BillingError('reconciliation_required');
    return {
      id: session.publicId,
      url: `${config.checkoutBaseUrl}/c/${session.publicId}#cs=${encodeURIComponent(intent.clientSecret)}`,
      expiresAt: expires.toISOString(),
    };
  }
  async function checkout(
    owner: BillingOwner,
    raw: CreateBillingCheckoutParams,
    rawKey: string,
    renewal?: string,
  ) {
    const key = billingIdempotencyKey.parse(rawKey);
    const input = checkoutSchema.parse(raw);
    const cohort = authorize(owner);
    const m = await merchant(owner);
    const offers = cohort.offers.filter(
      (o) => o.providerPriceId === input.providerPriceId && o.planId === input.planId,
    );
    if (
      offers.length !== 1 ||
      !offers[0] ||
      !input.taxQuote ||
      input.trialDays !== 0 ||
      input.providerCustomerId !== customerRef(owner, input.storeId)
    )
      throw new BillingError('identity_conflict');
    const offer = offers[0];
    const subscriptionId = renewal ?? `sub_fair${digest([owner.merchantId, key])}`;
    const invoiceId = `in_fair${digest([subscriptionId, key])}`;
    const requestDigest = digest([input, renewal ?? null]);
    const [previous] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (previous) {
      await owned(owner, previous.subscriptionId);
      if (previous.requestDigest !== requestDigest) throw new BillingError('idempotency_conflict');
      return materialize(owner, previous, input);
    }
    const adapter: BillingTaxCheckoutAdapter = {
      resolveOffer: async () => offer,
      createCheckout: async () => {
        throw new Error('Not used by native billing');
      },
    };
    const snapshot = await prepareBillingTaxCheckout(
      options.taxQuoteCalculator,
      adapter,
      owner,
      m.publicId,
      { ...input, taxQuote: input.taxQuote },
      now,
    );
    // The payer pays the quote's total: the price, plus tax when it is added.
    const payable = snapshot.taxQuote.quote.grossMinorUnits;
    const fx = await (
      options.quote ?? ((gross) => createExplorerFaircoinQuote(gross, { now: now() }))
    )(payable);
    if (
      fx.currency !== 'USD' ||
      fx.grossMinorUnits !== payable ||
      Date.parse(fx.quotedAt) > +now() ||
      Date.parse(fx.expiresAt) <= +now()
    )
      throw new BillingError('invalid_provider_response', 502);
    // No quote may outlive its fiscal authority.
    fx.expiresAt = new Date(
      Math.min(Date.parse(fx.expiresAt), Date.parse(snapshot.taxQuote.quote.expiresAt)),
    ).toISOString();
    const invoice = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${[owner.merchantId, input.storeId, input.planId].join(':')}, 0))`,
      );
      if (!renewal) {
        const [live] = await tx
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.merchantId, owner.merchantId),
              eq(subscriptions.subjectRef, input.storeId),
              eq(subscriptions.planRef, input.planId),
              eq(subscriptions.cancelAtPeriodEnd, false),
            ),
          )
          .for('update');
        if (live && live.id !== subscriptionId) {
          const attempts = await tx
            .select()
            .from(invoices)
            .where(eq(invoices.subscriptionId, live.id));
          const intentIds = attempts.flatMap((attempt) =>
            attempt.paymentIntentId ? [attempt.paymentIntentId] : [],
          );
          const payments = intentIds.length
            ? await tx
                .select()
                .from(paymentIntents)
                .where(inArray(paymentIntents.id, intentIds))
                .for('update')
            : [];
          if (payments.some((payment) => payment.status === 'failed'))
            throw new BillingError('reconciliation_required');
          // An expired/rejected initial attempt has no source to renew in
          // Oxy. Retire it atomically so the payer can request a fresh quote.
          // Missing materialization, confirming transfers and all paid history
          // still hold the slot; elapsed quote time alone never releases it.
          if (
            !attempts.length ||
            intentIds.length !== attempts.length ||
            payments.length !== attempts.length ||
            attempts.some((attempt) => attempt.acceptedAt !== null) ||
            payments.some(
              (payment) =>
                payment.rail !== 'faircoin' || !['expired', 'rejected'].includes(payment.status),
            )
          )
            throw new BillingError('identity_conflict');
          await tx
            .update(subscriptions)
            .set({ cancelAtPeriodEnd: true, cancelledAt: now() })
            .where(eq(subscriptions.id, live.id));
        }
        await tx
          .insert(subscriptions)
          .values({
            id: subscriptionId,
            merchantId: owner.merchantId,
            oxyAppId: owner.oxyAppId,
            environment: owner.environment,
            subjectRef: input.storeId,
            planRef: input.planId,
            priceRef: input.providerPriceId,
            billingInterval: offer.interval,
            customerRef: input.providerCustomerId,
            initialKey: key,
          })
          .onConflictDoNothing();
      }
      const [sub] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
        .for('update');
      if (
        !sub ||
        sub.merchantId !== owner.merchantId ||
        sub.subjectRef !== input.storeId ||
        sub.planRef !== input.planId ||
        sub.priceRef !== input.providerPriceId ||
        sub.billingInterval !== offer.interval ||
        sub.customerRef !== input.providerCustomerId
      )
        throw new BillingError('not_found', 404);
      const [replay] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
      if (replay) {
        if (replay.requestDigest !== requestDigest) throw new BillingError('idempotency_conflict');
        return replay;
      }
      if (sub.cancelAtPeriodEnd) throw new BillingError('identity_conflict');
      const prior = await tx
        .select({ invoice: invoices, intent: paymentIntents })
        .from(invoices)
        .leftJoin(paymentIntents, eq(invoices.paymentIntentId, paymentIntents.id))
        .where(eq(invoices.subscriptionId, sub.id))
        .orderBy(desc(invoices.periodStart));
      if (
        prior.some(
          (p) =>
            !p.intent ||
            ['created', 'awaiting_approval', 'approved', 'broadcast', 'confirming'].includes(
              p.intent.status,
            ),
        )
      )
        throw new BillingError('identity_conflict');
      // A failed chain observation may include partial funds. Do not propose
      // another full renewal payment until that payment has been reconciled.
      if (prior.some((p) => p.intent?.status === 'failed'))
        throw new BillingError('reconciliation_required');
      const lastPaid = prior.find(
        (p) =>
          p.intent?.status === 'settled' &&
          p.intent.rail === 'faircoin' &&
          p.intent.amount === p.invoice.fxQuote.amountBaseUnits &&
          p.invoice.acceptedAt &&
          +p.invoice.acceptedAt >= Date.parse(p.invoice.fxQuote.quotedAt) &&
          +p.invoice.acceptedAt < Date.parse(p.invoice.fxQuote.expiresAt),
      );
      // One explicit period at a time; renew during the final week or after expiry.
      if (lastPaid && +lastPaid.invoice.periodEnd - +now() > 7 * 86_400_000)
        throw new BillingError('identity_conflict');
      const start = new Date(Math.max(+now(), lastPaid ? +lastPaid.invoice.periodEnd : 0));
      const [inserted] = await tx
        .insert(invoices)
        .values({
          id: invoiceId,
          subscriptionId,
          checkoutRef: `cs_${owner.environment === 'production' ? 'live' : 'test'}_fair${digest(invoiceId)}`,
          operationKey: key,
          requestDigest,
          taxSnapshot: snapshot,
          fxQuote: fx,
          periodStart: start,
          periodEnd: periodAfter(start, offer.interval),
        })
        .returning();
      if (!inserted) throw new BillingError('reconciliation_required');
      return inserted;
    });
    return materialize(owner, invoice, input);
  }
  const service: BillingService & {
    renew: (
      owner: BillingOwner,
      ref: string,
      input: CreateBillingCheckoutParams,
      key: string,
    ) => Promise<{ id: string; url: string; expiresAt: string }>;
  } = {
    async ensureCustomer(owner, input, _key) {
      authorize(owner);
      const parsed = ensureCustomerSchema.parse(input);
      await merchant(owner);
      return { providerCustomerId: customerRef(owner, parsed.storeId) };
    },
    async createTaxQuote(owner, input) {
      const m = await merchant(owner);
      return createVerifiedBillingTaxQuote(
        options.taxQuoteCalculator,
        owner,
        m.publicId,
        input,
        now,
      );
    },
    createCheckoutSession: (owner, input, key) => checkout(owner, input, key),
    renew: (owner, ref, input, key) => checkout(owner, input, key, ref),
    async createPortalSession() {
      throw new BillingError('not_found', 404);
    },
    async retrieveCheckout(owner, ref): Promise<BillingCheckoutObservation> {
      const [invoice] = await db.select().from(invoices).where(eq(invoices.checkoutRef, ref));
      if (!invoice) throw new BillingError('not_found', 404);
      const sub = await owned(owner, invoice.subscriptionId);
      const intent = invoice.paymentIntentId
        ? await findIntentById(db, invoice.paymentIntentId)
        : null;
      const settled = intent?.status === 'settled';
      if (
        intent?.status === 'failed' ||
        (invoice.acceptedAt &&
          (+invoice.acceptedAt < Date.parse(invoice.fxQuote.quotedAt) ||
            +invoice.acceptedAt >= Date.parse(invoice.fxQuote.expiresAt))) ||
        (!invoice.acceptedAt &&
          Date.parse(invoice.fxQuote.expiresAt) <= +now() &&
          ['approved', 'broadcast', 'confirming'].includes(intent?.status ?? ''))
      )
        throw new BillingError('reconciliation_required');
      if (settled) {
        // Funds confirmed after the frozen quote are not an expired unpaid
        // checkout, nor valid paid authority. Preserve them for explicit review.
        try {
          await paidInvoice(owner, sub.id, invoice.id);
        } catch (error) {
          if (error instanceof BillingError && error.code === 'not_found')
            throw new BillingError('reconciliation_required');
          throw error;
        }
      }
      return {
        id: ref,
        initialInvoiceId: settled ? invoice.id : null,
        status: settled
          ? 'complete'
          : ['expired', 'rejected'].includes(intent?.status ?? '')
            ? 'expired'
            : 'open',
        storeId: sub.subjectRef,
        planId: sub.planRef,
        providerCustomerId: sub.customerRef,
        providerPriceId: sub.priceRef,
        subscription: settled ? await project(sub) : null,
      };
    },
    async retrieveCheckoutOperation(owner, input) {
      const m = await merchant(owner);
      const source = {
        ...input,
        taxQuoteId: null as string | null,
        merchantId: m.publicId,
        appId: owner.oxyAppId,
        mode: owner.environment === 'production' ? ('live' as const) : ('test' as const),
        environment: owner.environment,
      };
      if (input.providerCustomerId !== customerRef(owner, input.storeId))
        throw new BillingError('not_found', 404);
      const found = await db
        .select({ invoice: invoices, sub: subscriptions })
        .from(invoices)
        .innerJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
        .where(
          and(
            eq(subscriptions.merchantId, owner.merchantId),
            eq(invoices.operationKey, input.idempotencyKey),
            eq(subscriptions.subjectRef, input.storeId),
            eq(subscriptions.planRef, input.planId),
            eq(subscriptions.priceRef, input.providerPriceId),
          ),
        );
      if (!found.length) return { state: 'not_found', source };
      if (found.length !== 1 || !found[0]) throw new BillingError('identity_conflict');
      const row = found[0].invoice;
      source.taxQuoteId = row.taxSnapshot.taxQuote.quote.id;
      const intent = row.paymentIntentId ? await findIntentById(db, row.paymentIntentId) : null;
      if (!intent) return { state: 'pending', source };
      const session = await findSessionByIntentId(db, intent.id);
      if (!session) return { state: 'pending', source };
      return {
        state: 'succeeded',
        source,
        checkout: {
          id: row.checkoutRef,
          expiresAt: row.fxQuote.expiresAt,
          ...(Date.parse(row.fxQuote.expiresAt) > +now()
            ? {
                url: `${config.checkoutBaseUrl}/c/${session.publicId}#cs=${encodeURIComponent(intent.clientSecret)}`,
              }
            : {}),
        },
      };
    },
    retrieveSubscription: async (owner, ref) => project(await owned(owner, ref)),
    retrievePaidInvoice: paidInvoice,
    async retrieveInvoiceState(owner, ref, invoiceId): Promise<BillingInvoiceState> {
      const paid = await paidInvoice(owner, ref, invoiceId);
      return { ...paid, chargeId: paid.paymentIntentId, amountRefunded: '0', state: 'paid' };
    },
    async retrieveFinalInvoiceAuthority(owner, ref, invoiceId, include) {
      const paid = await paidInvoice(owner, ref, invoiceId);
      const { invoice } = await ownedInvoice(owner, ref, invoiceId);
      const m = await merchant(owner);
      const tax = invoice.taxSnapshot.taxQuote.quote;
      const fx = invoice.fxQuote;
      const authority: BillingFinalInvoiceAuthority = {
        schemaVersion: 1,
        method: 'faircoin',
        source: {
          invoiceId,
          paymentIntentId: paid.paymentIntentId,
          customerId: paid.providerCustomerId,
          subscriptionId: ref,
          priceId: paid.providerPriceId,
          planId: paid.planId,
          merchantId: m.publicId,
          appId: owner.oxyAppId,
          mode: paid.livemode ? 'live' : 'test',
          environment: owner.environment,
        },
        invoice: {
          platform: 'peable',
          currency: 'USD',
          grossMinorUnits: tax.grossMinorUnits,
          netMinorUnits: tax.netMinorUnits,
          taxMinorUnits: tax.taxMinorUnits,
          merchantFeeMinorUnits: 0,
          taxTreatment: tax.taxTreatment,
          sellerId: tax.sellerId,
          invoiceIssuerId: tax.invoiceIssuerId,
          taxQuoteId: tax.id,
          customerLocationEvidenceId: tax.customerLocationEvidenceId,
          taxRateEvidenceId: tax.taxRateEvidenceId,
          context: {
            payerAccountId: paid.storeId,
            beneficiaryAccountId: paid.storeId,
            providerSubscriptionId: ref,
            offerId: invoice.taxSnapshot.offer.offerId,
            offerVersion: invoice.taxSnapshot.offer.offerVersion,
            periodStart: paid.periodStart,
            periodEnd: paid.periodEnd,
            mode: paid.livemode ? 'live' : 'test',
            environment: owner.environment,
          },
          issuedAt: now().toISOString(),
          expiresAt: new Date(Math.max(+now() + 60_000, Date.parse(fx.expiresAt))).toISOString(),
          faircoinQuote: {
            id: fx.id,
            amountBaseUnits: fx.amountBaseUnits,
            quotedAt: fx.quotedAt,
            expiresAt: fx.expiresAt,
            roundingEvidenceId: fx.id,
          },
          ...(include?.taxLines
            ? { taxLines: await requireTaxLines(owner, tax.taxRateEvidenceId) }
            : {}),
        },
        signature: { algorithm: 'Ed25519', keyId: configuration.invoiceSigningKeyId, value: '' },
      };
      authority.signature.value = sign(
        null,
        Buffer.from(canonicalBillingAuthority(authority)),
        privateKey,
      ).toString('base64url');
      return verifyFinalInvoiceAuthority(
        authority,
        { owner, merchantPublicId: m.publicId, invoice: paid },
        verificationKeys,
        now(),
      );
    },
    async cancelAtPeriodEnd(owner, ref, rawKey) {
      billingIdempotencyKey.parse(rawKey);
      await owned(owner, ref);
      // Cancelling blocks all subsequent invoices. An already issued checkout
      // remains observable and its issued period is honoured after confirmation.
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.id, ref))
          .for('update');
        if (!row) throw new BillingError('not_found', 404);
        if (!row.cancelAtPeriodEnd)
          await tx
            .update(subscriptions)
            .set({ cancelAtPeriodEnd: true, cancelledAt: now() })
            .where(eq(subscriptions.id, ref));
      });
      return project(await owned(owner, ref));
    },
  };
  return service;
}
