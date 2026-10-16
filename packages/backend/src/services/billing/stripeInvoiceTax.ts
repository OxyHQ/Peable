/**
 * Peable Tax over the life of a quoted card subscription (ADR 0012, ADR 0013).
 *
 * Three provider events, each only a wake-up — every fact is re-read from
 * Stripe and checked before anything is written:
 *
 * - `invoice.created` (a draft renewal): HOLD the draft (`auto_advance:
 *   false`), record fresh location evidence from what Stripe holds about the
 *   payer, freeze a new Peable Tax calculation behind a newly signed quote,
 *   put it on the draft's one line as a manual tax rate Stripe's rounding
 *   lands exactly on, check Stripe's recomputed totals, remember the pricing,
 *   and only then RELEASE the draft. Any failure leaves it held, so a renewal
 *   is never charged with tax Peable Tax did not price for that period.
 * - `invoice.paid`: commit the calculation that priced the invoice — the
 *   checkout's for the first invoice, the renewal's for every later one — as a
 *   `tax_transaction`. Idempotent.
 * - a refund or credit note: reverse the committed transaction to the share
 *   Stripe now reports refunded or credited, as a cumulative reconciliation.
 *
 * Constructed only for a Stripe rail entry that opted into Peable Tax, so a
 * deployment that never did (Mercaria's I08 cohort) is untouched.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalBillingTaxQuote } from '@peable.to/shared-types';
import type { Database } from '../../db/postgres';
import {
  findBillingRenewalTax,
  findBillingTaxCheckoutsForCustomer,
  recordBillingRenewalTax,
} from '../../db/billing/billingRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { taxCalculations, taxTransactions } from '../../db/schema/tax';
import { commitTaxTransaction, reverseTaxTransaction, type TaxService } from '../tax/taxService';
import { BillingError, billingOwnerSchema, type BillingDeployment } from './contracts';
import { createFrozenTaxRate } from './stripeTaxCheckout';
import type { StripeBillingClient } from './stripeBillingProvider';
import { billingTaxCheckoutSnapshotSchema, type BillingTaxCheckoutSnapshot } from './tax-checkout';
import { createVerifiedBillingTaxQuote, type BillingTaxQuoteCalculator } from './tax-quote';
import type { VerifiedBillingBindings } from './verifiedBindings';

/** The Stripe events Peable Tax on the card rail acts on. The rail's webhook
 * endpoint must deliver every one of them; boot refuses an endpoint that does
 * not (`verifyPeableTaxWebhookEndpoint`). */
export const PEABLE_TAX_STRIPE_EVENTS = [
  'invoice.created',
  'invoice.paid',
  'charge.refunded',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'credit_note.created',
  'credit_note.updated',
  'credit_note.voided',
] as const;
const REVERSAL_EVENTS = new Set<string>(PEABLE_TAX_STRIPE_EVENTS.slice(2));

export type InvoiceTaxOutcome = 'committed' | 'not_quoted' | 'renewal_unquoted';
export type RenewalTaxOutcome = 'priced' | 'not_quoted' | 'not_renewal' | 'finalized_unpriced';
export type ReversalTaxOutcome = 'reversed' | 'unchanged' | 'not_quoted';
export interface StripeInvoiceTaxRecorder {
  /** `invoice.paid`: commit the calculation that priced the invoice. Idempotent. */
  recordPaidInvoice(invoiceRef: string): Promise<InvoiceTaxOutcome>;
  /** `invoice.created`: reprice a draft renewal before it can finalize. */
  priceRenewalInvoice(invoiceRef: string, customerRef?: string): Promise<RenewalTaxOutcome>;
  /** A refund or credit note: reverse the committed share Stripe reports. */
  reconcileReversals(refs: {
    invoiceRef?: string;
    paymentRef?: string;
  }): Promise<ReversalTaxOutcome>;
}

const ref = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}[A-Za-z0-9]+$`))
    .max(128);
const amount = z.number().int().safe().nonnegative();
const stripeAddress = z
  .object({
    country: z.string().nullable(),
    state: z.string().nullable().optional(),
    postal_code: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    line1: z.string().nullable().optional(),
    line2: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

/** A Stripe address as a Peable Tax billing address, or nothing usable. */
function billingAddress(address: z.infer<typeof stripeAddress>) {
  const country = address?.country?.toUpperCase();
  if (!address || !country || !/^[A-Z]{2}$/.test(country)) return undefined;
  const text = (value: string | null | undefined, max: number) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length <= max ? trimmed : undefined;
  };
  const state = address.state?.trim().toUpperCase();
  return {
    country,
    // A subdivision Peable Tax cannot read is left out rather than guessed;
    // the jurisdiction's rule then decides whether the rest is enough.
    ...(state && /^[A-Z0-9]{1,3}$/.test(state) ? { state } : {}),
    ...(text(address.postal_code, 20) ? { postalCode: text(address.postal_code, 20) } : {}),
    ...(text(address.city, 200) ? { city: text(address.city, 200) } : {}),
    ...(text(address.line1, 200) ? { line1: text(address.line1, 200) } : {}),
    ...(text(address.line2, 200) ? { line2: text(address.line2, 200) } : {}),
  };
}

/** The webhook endpoint a Peable Tax card rail listens on must deliver its
 * events, in this deployment's mode and API version. */
export async function verifyPeableTaxWebhookEndpoint(
  client: StripeBillingClient,
  endpointRef: string,
) {
  if (!client.retrieveWebhookEndpoint)
    throw new Error('Peable Tax on the card rail cannot read its webhook endpoint');
  const endpoint = z
    .object({
      id: z.literal(endpointRef),
      status: z.literal('enabled'),
      livemode: z.literal(client.livemode),
      api_version: z.literal(client.apiVersion),
      url: z.string().url(),
      enabled_events: z.array(z.string()),
    })
    .safeParse(await client.retrieveWebhookEndpoint(endpointRef));
  if (!endpoint.success) throw new Error('Peable Tax webhook endpoint is not enabled for this key');
  const events = new Set(endpoint.data.enabled_events);
  const missing = PEABLE_TAX_STRIPE_EVENTS.filter((event) => !events.has(event));
  if (!events.has('*') && missing.length)
    throw new Error(`Peable Tax webhook endpoint does not deliver ${missing.join(', ')}`);
  if (!new URL(endpoint.data.url).pathname.endsWith('/v1/webhooks/stripe'))
    throw new Error('Peable Tax webhook endpoint is not Peable’s platform webhook');
}

export function createStripeInvoiceTaxRecorder(options: {
  db: Database;
  client: StripeBillingClient;
  deployment: BillingDeployment;
  bindings: Pick<VerifiedBillingBindings, 'retrieveCheckout' | 'retrieveInvoiceState'>;
  tax: TaxService;
  calculator: BillingTaxQuoteCalculator;
  now?: () => Date;
}): StripeInvoiceTaxRecorder {
  const { db, client, deployment, bindings, tax, calculator } = options;
  const now = options.now ?? (() => new Date());
  const invoiceSchema = (invoiceRef: string) =>
    z.object({
      id: z.literal(invoiceRef),
      customer: ref('cus_'),
      livemode: z.literal(deployment.livemode),
      status: z.string().nullable(),
      billing_reason: z.string().nullable(),
      auto_advance: z.boolean().optional(),
      parent: z.object({
        type: z.literal('subscription_details'),
        subscription_details: z.object({ subscription: ref('sub_') }),
      }),
    });

  /** The quoted checkout that made this subscription, or null for a
   * subscription Peable Tax never priced. */
  async function quotedSubscription(customerRef: string, subscriptionRef: string) {
    const quoted = await findBillingTaxCheckoutsForCustomer(db, deployment, customerRef);
    if (!quoted.length) return null;
    const sessions = z
      .object({
        has_more: z.literal(false),
        data: z.array(z.object({ id: z.string() })).max(1),
      })
      .parse(await client.listCheckoutsForSubscription(subscriptionRef));
    const operation = quoted.find(
      (candidate) => candidate.providerObjectRef === sessions.data[0]?.id,
    );
    if (!operation?.providerObjectRef) return null;
    return {
      operation: { ...operation, providerObjectRef: operation.providerObjectRef },
      snapshot: billingTaxCheckoutSnapshotSchema.parse(operation.taxCheckoutSnapshot),
      owner: billingOwnerSchema.parse({
        merchantId: operation.merchantId,
        oxyAppId: operation.oxyAppId,
        environment: operation.environment,
      }),
    };
  }

  /** Commit a paid invoice against the quote that priced it. */
  async function commitPaid(
    owner: z.infer<typeof billingOwnerSchema>,
    subscriptionRef: string,
    invoiceRef: string,
    snapshot: BillingTaxCheckoutSnapshot,
  ) {
    const paid = await bindings.retrieveInvoiceState(owner, subscriptionRef, invoiceRef, false);
    const quote = snapshot.taxQuote.quote;
    if (
      paid.currency !== quote.currency ||
      paid.amountPaid !== String(quote.grossMinorUnits) ||
      paid.netAmount !== String(quote.netMinorUnits) ||
      paid.taxAmount !== String(quote.taxMinorUnits)
    )
      throw new BillingError('invalid_provider_response', 502);
    await commitTaxTransaction(db, {
      calculationPublicId: quote.taxRateEvidenceId,
      reference: invoiceRef,
      rail: 'stripe',
      committedAt: new Date(paid.paidAt),
      providerPaymentRef: paid.paymentIntentId,
    });
  }

  /** Hold a draft: Stripe will not finalize (or charge) it until released. */
  async function hold(invoiceRef: string) {
    if (!client.updateInvoice) throw new BillingError('not_found', 404);
    await client.updateInvoice(
      invoiceRef,
      { auto_advance: false },
      `peable-tax:${invoiceRef}:hold:${now().getTime()}`,
    );
  }

  /** Stripe's own totals for the repriced draft must be the frozen quote. */
  async function verifyDraft(invoiceRef: string, snapshot: BillingTaxCheckoutSnapshot) {
    if (!client.retrieveInvoice) throw new BillingError('not_found', 404);
    const quote = snapshot.taxQuote.quote;
    return z
      .object({
        id: z.literal(invoiceRef),
        status: z.literal('draft'),
        currency: z.literal(quote.currency.toLowerCase()),
        total: z.literal(quote.grossMinorUnits),
        total_excluding_tax: z.literal(quote.netMinorUnits),
        automatic_tax: z.object({ enabled: z.literal(false) }),
      })
      .safeParse(await client.retrieveInvoice(invoiceRef)).success;
  }

  /** Fresh evidence of where the payer is, from what Stripe holds: the
   * customer's billing address (or the card's) and the card's country. */
  async function renewalEvidence(customerRef: string, subscriptionRef: string) {
    const customer = z
      .object({
        id: z.literal(customerRef),
        address: stripeAddress,
        invoice_settings: z
          .object({ default_payment_method: z.string().nullable().optional() })
          .optional(),
      })
      .parse(await client.retrieveCustomer(customerRef));
    const subscription = z
      .object({ default_payment_method: z.string().nullable().optional() })
      .parse(await client.retrieveSubscription(subscriptionRef));
    const methodRef =
      subscription.default_payment_method ?? customer.invoice_settings?.default_payment_method;
    const method =
      methodRef && client.retrievePaymentMethod
        ? z
            .object({
              id: z.literal(methodRef),
              customer: z.literal(customerRef),
              card: z.object({ country: z.string().nullable() }).nullable().optional(),
              billing_details: z.object({ address: stripeAddress }).optional(),
            })
            .parse(await client.retrievePaymentMethod(methodRef))
        : undefined;
    const address =
      billingAddress(customer.address) ?? billingAddress(method?.billing_details?.address);
    const cardCountry = method?.card?.country?.toUpperCase();
    return [
      ...(address ? [{ type: 'billing_address' as const, address }] : []),
      ...(cardCountry && /^[A-Z]{2}$/.test(cardCountry)
        ? [{ type: 'payment_method_country' as const, country: cardCountry }]
        : []),
    ];
  }

  return {
    async recordPaidInvoice(invoiceRef) {
      if (!client.retrieveInvoice) return 'not_quoted';
      const invoice = invoiceSchema(invoiceRef).safeParse(await client.retrieveInvoice(invoiceRef));
      // Not a subscription invoice of this deployment: nothing Peable Tax priced.
      if (!invoice.success) return 'not_quoted';
      const subscriptionRef = invoice.data.parent.subscription_details.subscription;
      const quoted = await quotedSubscription(invoice.data.customer, subscriptionRef);
      if (!quoted) return 'not_quoted';
      const { operation, snapshot, owner } = quoted;
      if (invoice.data.billing_reason !== 'subscription_create') {
        // A renewal commits the quote it was repriced with, never the checkout's.
        const renewal = await findBillingRenewalTax(db, deployment, invoiceRef);
        if (!renewal) return 'renewal_unquoted';
        if (renewal.subscriptionRef !== subscriptionRef || renewal.merchantId !== owner.merchantId)
          throw new BillingError('identity_conflict');
        await commitPaid(owner, subscriptionRef, invoiceRef, renewal.snapshot);
        return 'committed';
      }
      const checkout = await bindings.retrieveCheckout(owner, operation.providerObjectRef);
      if (
        checkout.status !== 'complete' ||
        checkout.subscription?.providerSubscriptionId !== subscriptionRef ||
        checkout.initialInvoiceId !== invoiceRef
      )
        throw new BillingError('reconciliation_required');
      await commitPaid(owner, subscriptionRef, invoiceRef, snapshot);
      return 'committed';
    },

    async priceRenewalInvoice(invoiceRef, customerRef) {
      if (!client.retrieveInvoice || !client.listInvoiceLines || !client.updateInvoiceLine)
        return 'not_quoted';
      // A customer that never bought through a quote is answered locally.
      if (
        customerRef &&
        !(await findBillingTaxCheckoutsForCustomer(db, deployment, customerRef)).length
      )
        return 'not_quoted';
      const invoice = invoiceSchema(invoiceRef).safeParse(await client.retrieveInvoice(invoiceRef));
      if (!invoice.success) return 'not_quoted';
      const draft = invoice.data;
      const subscriptionRef = draft.parent.subscription_details.subscription;
      const quoted = await quotedSubscription(draft.customer, subscriptionRef);
      if (!quoted) return 'not_quoted';
      const { snapshot: checkoutSnapshot, owner } = quoted;
      if (draft.billing_reason !== 'subscription_cycle') return 'not_renewal';
      let priced = await findBillingRenewalTax(db, deployment, invoiceRef);
      if (draft.status !== 'draft') return priced ? 'priced' : 'finalized_unpriced';

      if (!priced) {
        // Held before anything else: from here on, every failure leaves a
        // draft Stripe will not finalize with last period's tax.
        if (draft.auto_advance !== false) await hold(invoiceRef);
        const merchant = await findMerchantById(db, owner.merchantId);
        if (!merchant) throw new BillingError('not_found', 404);
        const storeId = checkoutSnapshot.taxQuote.source.storeId;
        const offer = checkoutSnapshot.offer;
        const evidence = await tax.recordEvidence(merchant, {
          customerRef: storeId,
          evidence: await renewalEvidence(draft.customer, subscriptionRef),
        });
        if (evidence.status !== 'sufficient')
          throw new BillingError('reconciliation_required', 409);
        const taxQuote = await createVerifiedBillingTaxQuote(
          calculator,
          owner,
          merchant.publicId,
          {
            storeId,
            planId: offer.planId,
            providerPriceId: offer.providerPriceId,
            customerLocationEvidenceId: evidence.id,
          },
          now,
        );
        const quote = taxQuote.quote;
        // The renewal sells what the checkout sold, at the same listed price.
        if (
          quote.currency !== offer.currency ||
          quote.taxTreatment !== offer.taxTreatment ||
          (offer.taxTreatment === 'inclusive' ? quote.grossMinorUnits : quote.netMinorUnits) !==
            offer.grossMinorUnits
        )
          throw new BillingError('identity_conflict');
        const snapshot: BillingTaxCheckoutSnapshot = {
          taxQuote,
          offer,
          quoteDigest: createHash('sha256')
            .update(canonicalBillingTaxQuote(taxQuote))
            .digest('hex'),
        };
        const line = z
          .object({
            has_more: z.literal(false),
            data: z
              .array(
                z.object({
                  id: z.string().min(1).max(128),
                  invoice: z.literal(invoiceRef),
                  quantity: z.literal(1),
                  amount: z.literal(offer.grossMinorUnits),
                  parent: z.object({
                    type: z.literal('subscription_item_details'),
                    subscription_item_details: z.object({
                      subscription: z.literal(subscriptionRef),
                      proration: z.literal(false),
                    }),
                  }),
                  pricing: z.object({
                    price_details: z.object({ price: z.literal(offer.providerPriceId) }),
                  }),
                }),
              )
              .length(1),
          })
          .parse(await client.listInvoiceLines(invoiceRef)).data[0];
        if (!line) throw new BillingError('invalid_provider_response', 502);
        const key = `peable-tax:${invoiceRef}:${quote.taxRateEvidenceId}`;
        const taxRate = await createFrozenTaxRate(
          { db, client, owner, livemode: deployment.livemode, quote },
          `${key}:tax_rate`,
        );
        await client.updateInvoiceLine(
          invoiceRef,
          line.id,
          { tax_rates: taxRate ? [taxRate] : '' },
          `${key}:line`,
        );
        if (!(await verifyDraft(invoiceRef, snapshot)))
          throw new BillingError('invalid_provider_response', 502);
        const [calculation] = await db
          .select({ id: taxCalculations.id })
          .from(taxCalculations)
          .where(
            and(
              eq(taxCalculations.merchantId, owner.merchantId),
              eq(taxCalculations.publicId, quote.taxRateEvidenceId),
            ),
          );
        if (!calculation) throw new BillingError('not_found', 404);
        priced = await recordBillingRenewalTax(db, deployment, {
          merchantId: owner.merchantId,
          invoiceRef,
          subscriptionRef,
          calculationId: calculation.id,
          taxRateRef: taxRate ?? null,
          snapshot,
        });
      } else if (!(await verifyDraft(invoiceRef, priced.snapshot))) {
        // Priced, then changed at Stripe: hold it for an operator.
        await hold(invoiceRef);
        throw new BillingError('reconciliation_required');
      }
      // Released only once the draft provably carries the fresh frozen tax.
      if (!client.updateInvoice) throw new BillingError('not_found', 404);
      await client.updateInvoice(
        invoiceRef,
        { auto_advance: true },
        `peable-tax:${invoiceRef}:${priced.snapshot.taxQuote.quote.taxRateEvidenceId}:release`,
      );
      return 'priced';
    },

    async reconcileReversals({ invoiceRef, paymentRef }) {
      if (!invoiceRef && !paymentRef) return 'not_quoted';
      const [original] = await db
        .select({ id: taxTransactions.id, reference: taxTransactions.reference })
        .from(taxTransactions)
        .where(
          and(
            eq(taxTransactions.rail, 'stripe'),
            isNull(taxTransactions.reversalOfId),
            or(
              invoiceRef ? eq(taxTransactions.reference, invoiceRef) : undefined,
              paymentRef ? eq(taxTransactions.providerPaymentRef, paymentRef) : undefined,
            ),
          ),
        )
        .limit(1);
      // A refund of anything Peable Tax never committed is answered locally.
      if (!original) return 'not_quoted';
      if (
        !client.retrieveInvoice ||
        !client.listInvoicePayments ||
        !client.retrievePaidPaymentIntent ||
        !client.listChargeRefunds ||
        !client.listInvoiceCreditNotes
      )
        throw new BillingError('provider_unavailable', 503);
      const invoice = z
        .object({
          id: z.literal(original.reference),
          livemode: z.literal(deployment.livemode),
          status: z.enum(['paid', 'void', 'uncollectible', 'open']),
          total: amount,
        })
        .parse(await client.retrieveInvoice(original.reference));
      // Credited on the paid invoice (refunded, to balance or out of band).
      let credited = 0;
      const linked = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 20) throw new BillingError('reconciliation_required');
        const notes = z
          .object({
            has_more: z.boolean(),
            data: z.array(
              z.object({
                id: ref('cn_'),
                invoice: z.literal(original.reference),
                status: z.enum(['issued', 'void']),
                post_payment_amount: amount,
                refunds: z
                  .array(
                    z.object({
                      refund: z.union([z.string(), z.object({ id: z.string() })]),
                    }),
                  )
                  .optional(),
              }),
            ),
          })
          .parse(await client.listInvoiceCreditNotes(original.reference, cursor));
        for (const note of notes.data) {
          if (note.status !== 'issued') continue;
          credited += note.post_payment_amount;
          for (const entry of note.refunds ?? [])
            linked.add(typeof entry.refund === 'string' ? entry.refund : entry.refund.id);
        }
        if (!notes.has_more) break;
        cursor = notes.data.at(-1)?.id;
      }
      // Refunded on the charge, outside any credit note.
      const payment = z
        .object({
          data: z
            .array(
              z.object({
                payment: z.object({
                  type: z.literal('payment_intent'),
                  payment_intent: ref('pi_'),
                }),
              }),
            )
            .length(1),
        })
        .parse(await client.listInvoicePayments(original.reference)).data[0];
      if (!payment) throw new BillingError('reconciliation_required');
      const intent = z
        .object({ latest_charge: z.object({ id: ref('ch_') }) })
        .parse(await client.retrievePaidPaymentIntent(payment.payment.payment_intent));
      let refunded = 0;
      cursor = undefined;
      for (let page = 0; ; page++) {
        if (page >= 20) throw new BillingError('reconciliation_required');
        const refunds = z
          .object({
            has_more: z.boolean(),
            data: z.array(
              z.object({
                id: ref('re_'),
                amount,
                status: z.string().nullable(),
              }),
            ),
          })
          .parse(await client.listChargeRefunds(intent.latest_charge.id, cursor));
        for (const refund of refunds.data)
          if (refund.status === 'succeeded' && !linked.has(refund.id)) refunded += refund.amount;
        if (!refunds.has_more) break;
        cursor = refunds.data.at(-1)?.id;
      }
      const target = Math.min(invoice.total, credited + refunded);
      const reversal = await reverseTaxTransaction(db, {
        originalId: original.id,
        reference: (sequence) => `${original.reference}:reversal:${sequence}`,
        reversedAt: now(),
        target: (_reversed, total) => Math.min(total, target),
      });
      return reversal ? 'reversed' : 'unchanged';
    },
  };
}

/** Which recorder entry point an event wakes, if any. */
export function invoiceTaxAction(event: {
  type: string;
  objectIds: Readonly<Record<string, string>>;
}):
  | { kind: 'paid'; invoiceRef: string }
  | { kind: 'renewal'; invoiceRef: string; customerRef?: string }
  | { kind: 'reversal'; invoiceRef?: string; paymentRef?: string }
  | null {
  const { invoice, customer, payment_intent: paymentRef } = event.objectIds;
  if (event.type === 'invoice.paid' && invoice) return { kind: 'paid', invoiceRef: invoice };
  if (event.type === 'invoice.created' && invoice)
    return { kind: 'renewal', invoiceRef: invoice, ...(customer ? { customerRef: customer } : {}) };
  if (REVERSAL_EVENTS.has(event.type) && (invoice || paymentRef))
    return {
      kind: 'reversal',
      ...(invoice ? { invoiceRef: invoice } : {}),
      ...(paymentRef ? { paymentRef } : {}),
    };
  return null;
}
