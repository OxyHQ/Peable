/**
 * The billing engine's wire objects (ADR 0014 D1, ADR 0018). Rendering a
 * subscription needs its items and their prices, and an invoice its lines, so
 * these renderers read in batches — one query per kind of object for a whole
 * list, never one per row.
 */
import type {
  CustomerBalanceTransaction,
  Discount,
  Invoice,
  InvoiceItem,
  InvoiceLineItem,
  Price,
  Subscription,
  SubscriptionItem,
  TestClock,
} from '@peable.to/shared-types';
import { config } from '../config';
import { findPricesByRowIds, type PriceRow } from '../db/catalog/priceRepository';
import type { BalanceTransactionRow } from '../db/billingEngine/balanceRepository';
import {
  listLinesFor,
  type InvoiceItemRow,
  type InvoiceLineRow,
  type InvoiceRow,
} from '../db/billingEngine/invoiceRepository';
import {
  listLiveItemsFor,
  type SubscriptionItemRow,
  type SubscriptionRow,
} from '../db/billingEngine/subscriptionRepository';
import type { TestClockRow } from '../db/billingEngine/testClockRepository';
import type { DatabaseOrTransaction } from '../db/postgres';
import { toPriceDTO } from './serializeCatalog';
import { toUnix, toUnixOrNull } from './time';

async function pricesById(
  db: DatabaseOrTransaction,
  ids: readonly (string | null)[],
): Promise<Map<string, Price>> {
  const wanted = ids.filter((id): id is string => id !== null);
  const rows = await findPricesByRowIds(db, wanted);
  return new Map(rows.map((row: PriceRow) => [row.id, toPriceDTO(row)]));
}

function mustPrice(prices: Map<string, Price>, id: string): Price {
  const price = prices.get(id);
  if (!price) throw new Error(`price ${id} vanished`);
  return price;
}

export function toSubscriptionItemDTO(row: SubscriptionItemRow, price: Price): SubscriptionItem {
  return {
    id: row.publicId,
    object: 'subscription_item',
    livemode: row.livemode,
    subscription: row.subscriptionPublicId,
    price,
    quantity: row.quantity,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

function subscriptionDiscount(row: SubscriptionRow): Discount | null {
  if (row.discountCouponPublicId === null || row.discountStart === null) return null;
  return {
    object: 'discount',
    coupon: row.discountCouponPublicId,
    promotion_code: row.discountPromotionCodePublicId,
    start: toUnix(row.discountStart),
    end: toUnixOrNull(row.discountEnd),
  };
}

/** Render subscriptions with their live items, in one read per kind. */
export async function renderSubscriptions(
  db: DatabaseOrTransaction,
  rows: readonly SubscriptionRow[],
): Promise<Subscription[]> {
  const items = await listLiveItemsFor(
    db,
    rows.map((row) => row.id),
  );
  const prices = await pricesById(
    db,
    items.map((item) => item.priceId),
  );
  return rows.map((row) => {
    const own = items.filter((item) => item.subscriptionId === row.id);
    return {
      id: row.publicId,
      object: 'subscription',
      livemode: row.livemode,
      customer: row.customerPublicId,
      status: row.status,
      currency: row.currency,
      items: {
        object: 'list',
        data: own.map((item) => toSubscriptionItemDTO(item, mustPrice(prices, item.priceId))),
        has_more: false,
        url: `/v1/subscription_items?subscription=${row.publicId}`,
      },
      collection_method: row.collectionMethod,
      days_until_due: row.daysUntilDue,
      default_payment_method: row.defaultPaymentMethodPublicId,
      description: row.description,
      billing_cycle_anchor: toUnix(row.billingCycleAnchor),
      current_period_start: toUnix(row.currentPeriodStart),
      current_period_end: toUnix(row.currentPeriodEnd),
      start_date: toUnix(row.startDate),
      trial_start: toUnixOrNull(row.trialStart),
      trial_end: toUnixOrNull(row.trialEnd),
      trial_settings: { end_behavior: { missing_payment_method: row.trialEndBehavior } },
      cancel_at_period_end: row.cancelAtPeriodEnd,
      cancel_at: toUnixOrNull(row.cancelAt),
      canceled_at: toUnixOrNull(row.canceledAt),
      ended_at: toUnixOrNull(row.endedAt),
      cancellation_details: {
        reason: row.cancellationReason,
        comment: row.cancellationComment,
      },
      pause_collection:
        row.pauseBehavior === null
          ? null
          : { behavior: row.pauseBehavior, resumes_at: toUnixOrNull(row.pauseResumesAt) },
      automatic_tax: { enabled: row.automaticTax },
      discount: subscriptionDiscount(row),
      latest_invoice: row.latestInvoicePublicId,
      test_clock: row.testClockPublicId,
      metadata: row.metadata,
      created: toUnix(row.createdAt),
    };
  });
}

export async function renderSubscription(
  db: DatabaseOrTransaction,
  row: SubscriptionRow,
): Promise<Subscription> {
  const [dto] = await renderSubscriptions(db, [row]);
  if (!dto) throw new Error('subscription did not render');
  return dto;
}

export function toInvoiceLineDTO(row: InvoiceLineRow, price: Price | null): InvoiceLineItem {
  return {
    id: row.publicId,
    object: 'line_item',
    livemode: row.livemode,
    invoice: row.invoicePublicId,
    type: row.type,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    discount_amounts:
      row.discountAmount === '0'
        ? []
        : [{ amount: row.discountAmount, discount: `${row.invoicePublicId}:discount` }],
    discountable: row.discountable,
    period: { start: toUnix(row.periodStart), end: toUnix(row.periodEnd) },
    price,
    quantity: row.quantity,
    proration: row.proration,
    subscription: row.subscriptionPublicId,
    subscription_item: row.subscriptionItemPublicId,
    invoice_item: row.invoiceItemPublicId,
    tax_amounts: row.taxAmounts,
    metadata: row.metadata,
  };
}

/** The payer-facing page of a finalized invoice. */
export function hostedInvoiceUrl(token: string): string {
  return `${config.checkoutBaseUrl}/invoice/${token}`;
}

/** The PDF of a finalized invoice — rendered by the gateway itself, anonymous by token. */
export function invoicePdfUrl(token: string): string {
  return `${config.apiBaseUrl}/v1/invoices/public/${token}/pdf`;
}

/** An invoice rendered from its row and lines (already read). */
export function toInvoiceDTO(
  row: InvoiceRow,
  lines: readonly InvoiceLineRow[],
  prices: Map<string, Price>,
): Invoice {
  const paid = BigInt(row.amountPaid);
  const credited = BigInt(row.prePaymentCreditNotesAmount);
  const due = BigInt(row.amountDue);
  const left = row.status === 'paid' || row.status === 'void' ? 0n : due - paid - credited;
  return {
    id: row.publicId,
    object: 'invoice',
    livemode: row.livemode,
    number: row.number,
    customer: row.customerPublicId,
    customer_email: row.customerEmail,
    customer_name: row.customerName,
    subscription: row.subscriptionPublicId,
    status: row.status,
    billing_reason: row.billingReason,
    collection_method: row.collectionMethod,
    currency: row.currency,
    description: row.description,
    auto_advance: row.autoAdvance,
    automatically_finalizes_at:
      row.status === 'draft' && row.autoAdvance ? toUnixOrNull(row.automaticallyFinalizesAt) : null,
    lines: {
      object: 'list',
      data: lines.map((line) =>
        toInvoiceLineDTO(line, line.priceId ? (prices.get(line.priceId) ?? null) : null),
      ),
      has_more: false,
      url: `/v1/invoices/${row.publicId}/lines`,
    },
    subtotal: row.subtotal,
    subtotal_excluding_tax: subtotalExcludingTax(row, lines),
    total_discount_amounts:
      row.totalDiscount === '0'
        ? []
        : [{ amount: row.totalDiscount, discount: `${row.publicId}:discount` }],
    discount:
      row.discountCouponPublicId === null
        ? null
        : {
            object: 'discount',
            coupon: row.discountCouponPublicId,
            promotion_code: row.discountPromotionCodePublicId,
            start: toUnix(row.createdAt),
            end: null,
          },
    tax: row.tax,
    total: row.total,
    total_excluding_tax: row.totalExcludingTax,
    starting_balance: row.startingBalance,
    ending_balance: row.endingBalance,
    amount_due: row.amountDue,
    amount_paid: row.amountPaid,
    amount_remaining: (left > 0n ? left : 0n).toString(),
    pre_payment_credit_notes_amount: row.prePaymentCreditNotesAmount,
    post_payment_credit_notes_amount: row.postPaymentCreditNotesAmount,
    attempt_count: row.attemptCount,
    attempted: row.attemptCount > 0,
    next_payment_attempt: toUnixOrNull(row.nextPaymentAttempt),
    due_date: toUnixOrNull(row.dueDate),
    days_until_due: row.daysUntilDue,
    period_start: toUnix(row.periodStart),
    period_end: toUnix(row.periodEnd),
    payment_intent: row.paymentIntentPublicId,
    default_payment_method: row.defaultPaymentMethodPublicId,
    automatic_tax: {
      enabled: row.automaticTax,
      status: row.automaticTaxStatus,
      tax_calculation: row.taxCalculationId,
    },
    hosted_invoice_url: row.hostedToken ? hostedInvoiceUrl(row.hostedToken) : null,
    invoice_pdf: row.hostedToken ? invoicePdfUrl(row.hostedToken) : null,
    last_finalization_error: row.lastFinalizationError,
    status_transitions: {
      finalized_at: toUnixOrNull(row.finalizedAt),
      paid_at: toUnixOrNull(row.paidAt),
      voided_at: toUnixOrNull(row.voidedAt),
      marked_uncollectible_at: toUnixOrNull(row.markedUncollectibleAt),
    },
    paid_out_of_band: row.paidOutOfBand,
    test_clock: row.testClockPublicId,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
    effective_at: toUnixOrNull(row.finalizedAt),
  };
}

function subtotalExcludingTax(row: InvoiceRow, lines: readonly InvoiceLineRow[]): string {
  let inclusive = 0n;
  for (const line of lines) {
    for (const tax of line.taxAmounts) if (tax.inclusive) inclusive += BigInt(tax.amount);
  }
  return (BigInt(row.subtotal) - inclusive).toString();
}

export async function renderInvoices(
  db: DatabaseOrTransaction,
  rows: readonly InvoiceRow[],
): Promise<Invoice[]> {
  const lines = await listLinesFor(
    db,
    rows.map((row) => row.id),
  );
  const prices = await pricesById(
    db,
    lines.map((line) => line.priceId),
  );
  return rows.map((row) =>
    toInvoiceDTO(
      row,
      lines.filter((line) => line.invoiceId === row.id),
      prices,
    ),
  );
}

export async function renderInvoice(db: DatabaseOrTransaction, row: InvoiceRow): Promise<Invoice> {
  const [dto] = await renderInvoices(db, [row]);
  if (!dto) throw new Error('invoice did not render');
  return dto;
}

export async function renderInvoiceItems(
  db: DatabaseOrTransaction,
  rows: readonly InvoiceItemRow[],
): Promise<InvoiceItem[]> {
  const prices = await pricesById(
    db,
    rows.map((row) => row.priceId),
  );
  return rows.map((row) => ({
    id: row.publicId,
    object: 'invoiceitem',
    livemode: row.livemode,
    customer: row.customerPublicId,
    invoice: row.invoicePublicId,
    subscription: row.subscriptionPublicId,
    subscription_item: row.subscriptionItemPublicId,
    price: row.priceId ? (prices.get(row.priceId) ?? null) : null,
    quantity: row.quantity,
    unit_amount: row.unitAmount,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    discountable: row.discountable,
    period: { start: toUnix(row.periodStart), end: toUnix(row.periodEnd) },
    proration: row.proration,
    metadata: row.metadata,
    date: toUnix(row.createdAt),
  }));
}

export function toTestClockDTO(row: TestClockRow): TestClock {
  return {
    id: row.publicId,
    object: 'test_helpers.test_clock',
    livemode: false,
    name: row.name,
    frozen_time: toUnix(row.frozenTime),
    status: row.status,
    deletes_after: toUnix(row.deletesAfter),
    created: toUnix(row.createdAt),
  };
}

export function toBalanceTransactionDTO(row: BalanceTransactionRow): CustomerBalanceTransaction {
  return {
    id: row.publicId,
    object: 'customer_balance_transaction',
    livemode: row.livemode,
    customer: row.customerPublicId,
    type: row.type,
    amount: row.amount,
    currency: row.currency,
    ending_balance: row.endingBalance,
    description: row.description,
    invoice: row.invoicePublicId,
    credit_note: row.creditNotePublicId,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}
