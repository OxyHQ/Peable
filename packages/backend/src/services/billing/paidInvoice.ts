import { z } from 'zod';
import type { BillingPaidInvoice, BillingInvoiceState } from '@peable.to/shared-types';
import { BillingError } from './contracts';
import type { StripeBillingClient } from './stripeBillingProvider';
const ref = z.string().min(1).max(128);
const amount = z.number().int().safe().nonnegative();
const seconds = z
  .number()
  .int()
  .safe()
  .positive()
  .refine((n) => Number.isFinite(new Date(n * 1000).getTime()));
/** Full single-line cash-paid invoice only; credits, partial/out-of-band payments,
 * prorations, multiple lines, refunds/disputes and incomplete pagination fail closed. */
export async function readOwnedInvoiceState(
  client: StripeBillingClient,
  expected: {
    invoiceId: string;
    subscriptionId: string;
    customerId: string;
    priceId: string;
    storeId: string;
    planId: string;
    livemode: boolean;
  },
  clock: () => Date = () => new Date(),
  signal?: AbortSignal,
): Promise<BillingInvoiceState> {
  const checkAbort = () => {
    if (signal?.aborted) throw new BillingError('provider_unavailable', 503);
  };
  checkAbort();
  if (
    !client.retrieveInvoice ||
    !client.listInvoiceLines ||
    !client.listInvoicePayments ||
    !client.retrievePaidPaymentIntent ||
    !client.listChargeRefunds
  )
    throw new BillingError('provider_unavailable', 503);
  const invoiceSchema = z.object({
    id: z.literal(expected.invoiceId),
    customer: z.literal(expected.customerId),
    livemode: z.literal(expected.livemode),
    status: z.literal('paid'),
    pre_payment_credit_notes_amount: z.literal(0),
    post_payment_credit_notes_amount: z.literal(0),
    currency: z.string().regex(/^[a-z]{3}$/),
    total: amount,
    amount_paid: amount,
    amount_due: amount,
    amount_remaining: z.literal(0),
    total_excluding_tax: amount.nullable(),
    parent: z.object({
      type: z.literal('subscription_details'),
      subscription_details: z.object({ subscription: z.literal(expected.subscriptionId) }),
    }),
  });
  const invoice = invoiceSchema.parse(await client.retrieveInvoice(expected.invoiceId));
  if (
    !invoice.total ||
    invoice.amount_paid !== invoice.total ||
    invoice.amount_due !== invoice.total
  )
    throw new BillingError('invalid_provider_response', 502);
  const page = (schema: z.ZodTypeAny) =>
    z.object({ has_more: z.literal(false), data: z.array(schema).length(1) });
  const line = page(
    z.object({
      id: ref,
      invoice: z.literal(expected.invoiceId),
      livemode: z.literal(expected.livemode),
      subscription: z.literal(expected.subscriptionId),
      quantity: z.literal(1),
      amount: amount,
      parent: z.object({
        type: z.literal('subscription_item_details'),
        subscription_item_details: z.object({
          subscription: z.literal(expected.subscriptionId),
          proration: z.literal(false),
        }),
      }),
      pricing: z.object({ price_details: z.object({ price: z.literal(expected.priceId) }) }),
      period: z.object({ start: seconds, end: seconds }),
    }),
  ).parse(await client.listInvoiceLines(expected.invoiceId)).data[0];
  if (line.period.end <= line.period.start || !line.amount)
    throw new BillingError('invalid_provider_response', 502);
  const payment = page(
    z.object({
      id: ref,
      invoice: z.literal(expected.invoiceId),
      livemode: z.literal(expected.livemode),
      currency: z.literal(invoice.currency),
      status: z.literal('paid'),
      amount_paid: z.literal(invoice.total),
      payment: z.object({
        type: z.literal('payment_intent'),
        payment_intent: z.string().regex(/^pi_[A-Za-z0-9]+$/),
      }),
      status_transitions: z.object({ paid_at: seconds }),
    }),
  ).parse(await client.listInvoicePayments(expected.invoiceId)).data[0];
  const intentSchema = z.object({
    id: z.literal(payment.payment.payment_intent),
    customer: z.literal(expected.customerId),
    livemode: z.literal(expected.livemode),
    currency: z.literal(invoice.currency),
    status: z.literal('succeeded'),
    amount_received: z.literal(invoice.total),
    latest_charge: z.object({
      id: ref,
      payment_intent: z.literal(payment.payment.payment_intent),
      customer: z.literal(expected.customerId),
      currency: z.literal(invoice.currency),
      livemode: z.literal(expected.livemode),
      paid: z.literal(true),
      captured: z.literal(true),
      amount_captured: z.literal(invoice.total),
      amount_refunded: amount,
      refunded: z.boolean(),
      disputed: z.literal(false),
    }),
  });
  const intent = intentSchema.parse(
    await client.retrievePaidPaymentIntent(payment.payment.payment_intent),
  );
  // Cash refunds must be completed, not merely requested. Exhaust success
  // receipts and reconcile to the charge's cumulative total. Pending/unknown
  // receipts fail closed; failed/canceled receipts never revoke a paid period.
  let cursor: string | undefined;
  let refundTotal = 0;
  const seen = new Set<string>();
  let complete = false;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    checkAbort();
    const refunds = z
      .object({
        has_more: z.boolean(),
        data: z
          .array(
            z.object({
              id: ref,
              charge: z.literal(intent.latest_charge.id),
              payment_intent: z.literal(intent.id),
              currency: z.literal(invoice.currency),
              amount,
              status: z.enum(['succeeded', 'failed', 'canceled']),
            }),
          )
          .max(100),
      })
      .parse(await client.listChargeRefunds(intent.latest_charge.id, cursor));
    for (const receipt of refunds.data) {
      if (seen.has(receipt.id)) throw new BillingError('invalid_provider_response', 502);
      seen.add(receipt.id);
      if (receipt.status === 'succeeded') {
        refundTotal += receipt.amount;
        if (!Number.isSafeInteger(refundTotal))
          throw new BillingError('invalid_provider_response', 502);
      }
    }
    if (!refunds.has_more) {
      complete = true;
      break;
    }
    const last = refunds.data.at(-1);
    if (!last) throw new BillingError('invalid_provider_response', 502);
    cursor = last.id;
  }
  if (!complete || refundTotal !== intent.latest_charge.amount_refunded)
    throw new BillingError('reconciliation_required');
  // Detect changed root/payment fields; provider reads are not an atomic transaction.
  if (
    JSON.stringify(invoice) !==
      JSON.stringify(invoiceSchema.parse(await client.retrieveInvoice(expected.invoiceId))) ||
    JSON.stringify(intent) !==
      JSON.stringify(
        intentSchema.parse(await client.retrievePaidPaymentIntent(payment.payment.payment_intent)),
      )
  )
    throw new BillingError('reconciliation_required');
  const refunded = intent.latest_charge.amount_refunded;
  if (refunded > invoice.total || intent.latest_charge.refunded !== (refunded === invoice.total))
    throw new BillingError('invalid_provider_response', 502);
  const net = invoice.total_excluding_tax;
  if (net !== null && net > invoice.total) throw new BillingError('invalid_provider_response', 502);
  checkAbort();
  return {
    state:
      refunded === 0
        ? 'paid'
        : refunded === invoice.total
          ? 'fully_refunded'
          : 'partially_refunded',
    chargeId: intent.latest_charge.id,
    amountRefunded: String(refunded),
    invoiceId: invoice.id,
    lineId: line.id,
    paymentIntentId: intent.id,
    providerSubscriptionId: expected.subscriptionId,
    providerCustomerId: expected.customerId,
    providerPriceId: expected.priceId,
    storeId: expected.storeId,
    planId: expected.planId,
    livemode: expected.livemode,
    currency: invoice.currency.toUpperCase(),
    amountPaid: String(invoice.amount_paid),
    netAmount: net === null ? null : String(net),
    taxAmount: net === null ? null : String(invoice.total - net),
    periodStart: new Date(line.period.start * 1000).toISOString(),
    periodEnd: new Date(line.period.end * 1000).toISOString(),
    paidAt: new Date(payment.status_transitions.paid_at * 1000).toISOString(),
    observedAt: clock().toISOString(),
  };
}

export async function readOwnedPaidInvoice(
  client: StripeBillingClient,
  expected: Parameters<typeof readOwnedInvoiceState>[1],
): Promise<BillingPaidInvoice> {
  const value = await readOwnedInvoiceState(client, expected);
  if (value.state !== 'paid') throw new BillingError('reconciliation_required');
  const { state, chargeId, amountRefunded, ...paid } = value;
  return paid;
}
