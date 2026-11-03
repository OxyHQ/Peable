/**
 * The upcoming invoice (`GET /v1/invoices/upcoming`, `invoice.upcoming`) — a
 * PREVIEW of a subscription's next renewal, never stored (ADR 0018).
 *
 * It is drafted exactly as the renewal will be — the next period's licensed
 * lines, the metered usage of the current period so far, the pending items,
 * the discount in effect — and, when asked, with a proposed item change and
 * the prorations it would create. Tax is NOT calculated for a preview (a
 * calculation is a frozen, recorded answer about a real sale): with automatic
 * tax on, `tax` is `null` and is computed when the real invoice finalizes.
 */
import type { Invoice, Price } from '@peable.to/shared-types';
import { findPricesByPublicIds } from '../../db/catalog/priceRepository';
import {
  findChargedLineCovering,
  readPendingItems,
  type InvoiceLineRow,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import { aggregateMeter, findMeterById } from '../../db/billingEngine/meterRepository';
import { listLiveItems, type SubscriptionRow } from '../../db/billingEngine/subscriptionRepository';
import type { DatabaseOrTransaction } from '../../db/postgres';
import { toPriceDTO } from '../../lib/serializeCatalog';
import { toInvoiceDTO } from '../../lib/serializeBilling';
import { couponInEffect } from './discounts';
import {
  type DraftLine,
  discountsFor,
  invoiceItemLine,
  itemPeriodAmount,
  loadCatalog,
  meteredLine,
  periodLines,
  priceOf,
  productOfPrice,
} from './drafting';
import { BillingEngineError, invalid } from './errors';
import { draftTotals } from './invoiceEngine';
import { nextBoundaryAfter, prorate } from './periods';
import { engineNow } from './runtime';
import { newId } from '../../lib/ids';
import { uuidv7 } from '@oxy.so/db';

export interface UpcomingOptions {
  readonly items?: readonly { id?: string; price?: string; quantity?: number; deleted?: boolean }[];
  readonly prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
  readonly prorationDate?: Date;
}

/** The preview, or `null` for a subscription that will not renew. */
export async function upcomingInvoice(
  db: DatabaseOrTransaction,
  subscription: SubscriptionRow,
  options: UpcomingOptions,
): Promise<Invoice | null> {
  if (['canceled', 'incomplete_expired', 'paused'].includes(subscription.status)) return null;
  if (subscription.cancelAtPeriodEnd) return null;
  const now = await engineNow(db, subscription.testClockId);
  const live = await listLiveItems(db, subscription.id);
  let items = live;
  const extra: DraftLine[] = [];
  const named = options.items
    ? await findPricesByPublicIds(
        db,
        subscription.merchantId,
        options.items.flatMap((entry) => (entry.price ? [entry.price] : [])),
      )
    : [];
  const catalog = await loadCatalog(db, [
    ...live.map((item) => item.priceId),
    ...named.map((p) => p.id),
  ]);
  if (options.items) {
    const t = options.prorationDate ?? now;
    const whole =
      subscription.currentPeriodEnd.getTime() - subscription.currentPeriodStart.getTime();
    const left = subscription.currentPeriodEnd.getTime() - t.getTime();
    const prorating =
      (options.prorationBehavior ?? 'create_prorations') !== 'none' &&
      subscription.status !== 'trialing';
    const next = [...live];
    for (const [i, entry] of options.items.entries()) {
      const existingIndex = entry.id ? next.findIndex((item) => item.publicId === entry.id) : -1;
      if (entry.id && existingIndex < 0) {
        throw new BillingEngineError(
          'resource_missing',
          `no item '${entry.id}' on this subscription`,
          `subscription_items[${i}][id]`,
        );
      }
      const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
      const price = entry.price
        ? named.find((p) => p.publicId === entry.price)
        : existing
          ? priceOf(catalog, existing.priceId)
          : undefined;
      if (!price) throw invalid('a new item needs a price', `subscription_items[${i}][price]`);
      const quantity = entry.quantity ?? existing?.quantity ?? 1;
      const line = (
        amount: bigint,
        description: string,
        creditsLineId: string | null,
      ): DraftLine => ({
        id: uuidv7(),
        publicId: newId('il'),
        type: 'invoiceitem',
        subscriptionId: subscription.id,
        subscriptionItemId: existing?.id ?? null,
        invoiceItemId: null,
        priceId: price.id,
        quantity,
        amount,
        currency: subscription.currency,
        description,
        discountable: true,
        periodStart: t,
        periodEnd: subscription.currentPeriodEnd,
        proration: true,
        creditsLineId,
        metered: false,
        metadata: {},
      });
      if (existing && prorating) {
        const oldPrice = priceOf(catalog, existing.priceId);
        const credited = await findChargedLineCovering(db, existing.id, t);
        if (credited && oldPrice.recurringUsageType !== 'metered') {
          extra.push(
            line(
              -prorate(itemPeriodAmount(oldPrice, existing.quantity), left, whole),
              `Unused time on ${existing.quantity} × ${productOfPrice(catalog, oldPrice.id)?.name ?? 'item'}`,
              credited.id,
            ),
          );
        }
      }
      if (entry.deleted) {
        if (existingIndex >= 0) next.splice(existingIndex, 1);
        continue;
      }
      if (prorating && price.recurringUsageType !== 'metered') {
        extra.push(
          line(
            prorate(itemPeriodAmount(price, quantity), left, whole),
            `Remaining time on ${quantity} × ${productOfPrice(catalog, price.id)?.name ?? 'item'}`,
            null,
          ),
        );
      }
      const replacement = {
        ...(existing ??
          live[0] ?? {
            id: uuidv7(),
            publicId: newId('si'),
            merchantId: subscription.merchantId,
            livemode: subscription.livemode,
            subscriptionId: subscription.id,
            subscriptionPublicId: subscription.publicId,
            metadata: {},
            deletedAt: null,
            createdAt: now,
          }),
        id: existing?.id ?? uuidv7(),
        priceId: price.id,
        quantity,
      };
      if (existingIndex >= 0) next[existingIndex] = replacement;
      else next.push(replacement);
    }
    items = next;
  }
  if (items.length === 0) return null;
  const first = priceOf(catalog, (items[0] as (typeof items)[number]).priceId);
  if (first.recurringInterval === null || first.recurringIntervalCount === null) return null;
  const recurrence = {
    interval: first.recurringInterval,
    intervalCount: first.recurringIntervalCount,
  };
  const start =
    subscription.status === 'trialing' && subscription.trialEnd
      ? subscription.trialEnd
      : subscription.currentPeriodEnd;
  const end = nextBoundaryAfter(subscription.billingCycleAnchor, recurrence, start);
  const lines: DraftLine[] = [
    ...extra,
    ...periodLines(catalog, subscription.id, items, { start, end }),
  ];
  if (subscription.status !== 'trialing') {
    for (const item of items) {
      const price = priceOf(catalog, item.priceId);
      if (price.recurringUsageType !== 'metered' || price.meterId === null) continue;
      const meter = await findMeterById(db, price.meterId);
      if (!meter) continue;
      const usage = await aggregateMeter(db, {
        meterId: meter.id,
        customerId: subscription.customerId,
        start: subscription.currentPeriodStart,
        end: now < subscription.currentPeriodEnd ? now : subscription.currentPeriodEnd,
        aggregation: meter.aggregation,
      });
      lines.push(
        meteredLine(
          catalog,
          subscription.id,
          item,
          { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd },
          usage,
        ),
      );
    }
  }
  lines.push(
    ...(await readPendingItems(db, subscription.customerId, subscription.id)).map(invoiceItemLine),
  );
  const lineCatalog = await loadCatalog(
    db,
    lines.map((line) => line.priceId),
  );
  const coupon = await couponInEffect(
    db,
    {
      couponId: subscription.discountCouponId,
      start: subscription.discountStart,
      end: subscription.discountEnd,
    },
    start,
  );
  const discounts = discountsFor(lines, lineCatalog, coupon, subscription.currency);
  const totals = draftTotals(lines, discounts, subscription.automaticTax);
  const due = totals.total > 0n ? totals.total : 0n;
  const row: InvoiceRow = {
    id: '',
    publicId: '',
    merchantId: subscription.merchantId,
    livemode: subscription.livemode,
    customerId: subscription.customerId,
    customerPublicId: subscription.customerPublicId,
    subscriptionId: subscription.id,
    subscriptionPublicId: subscription.publicId,
    testClockId: subscription.testClockId,
    testClockPublicId: subscription.testClockPublicId,
    status: 'draft',
    billingReason: 'upcoming',
    collectionMethod: subscription.collectionMethod,
    currency: subscription.currency,
    number: null,
    description: subscription.description,
    autoAdvance: true,
    automaticallyFinalizesAt: null,
    daysUntilDue: subscription.daysUntilDue,
    dueDate: null,
    periodStart: start,
    periodEnd: end,
    defaultPaymentMethodId: subscription.defaultPaymentMethodId,
    defaultPaymentMethodPublicId: subscription.defaultPaymentMethodPublicId,
    discountCouponId: coupon?.id ?? null,
    discountCouponPublicId: coupon?.publicId ?? null,
    discountPromotionCodeId: null,
    discountPromotionCodePublicId: null,
    automaticTax: subscription.automaticTax,
    automaticTaxStatus: null,
    taxCalculationId: null,
    taxedLinesDigest: null,
    subtotal: totals.subtotal.toString(),
    totalDiscount: totals.totalDiscount.toString(),
    tax: totals.tax === null ? null : totals.tax.toString(),
    total: totals.total.toString(),
    totalExcludingTax: totals.totalExcludingTax.toString(),
    startingBalance: '0',
    endingBalance: null,
    amountDue: due.toString(),
    amountPaid: '0',
    prePaymentCreditNotesAmount: '0',
    postPaymentCreditNotesAmount: '0',
    attemptCount: 0,
    nextPaymentAttempt: null,
    paymentIntentId: null,
    paymentIntentPublicId: null,
    paidOutOfBand: false,
    customerEmail: null,
    customerName: null,
    hostedToken: null,
    finalizedAt: null,
    paidAt: null,
    voidedAt: null,
    markedUncollectibleAt: null,
    sentAt: null,
    dunningExhaustedAt: null,
    lastFinalizationError: null,
    metadata: {},
    nextActionAt: null,
    createdAt: now,
  };
  const lineRows: InvoiceLineRow[] = lines.map((line, i) => ({
    id: line.id,
    publicId: line.publicId,
    merchantId: subscription.merchantId,
    livemode: subscription.livemode,
    invoiceId: '',
    invoicePublicId: '',
    type: line.type,
    subscriptionId: subscription.id,
    subscriptionPublicId: subscription.publicId,
    subscriptionItemId: line.subscriptionItemId,
    subscriptionItemPublicId:
      items.find((item) => item.id === line.subscriptionItemId)?.publicId ?? null,
    invoiceItemId: line.invoiceItemId,
    invoiceItemPublicId: null,
    priceId: line.priceId,
    quantity: line.quantity,
    amount: line.amount.toString(),
    discountAmount: (discounts[i] ?? 0n).toString(),
    taxAmounts: [],
    currency: line.currency,
    description: line.description,
    discountable: line.discountable,
    periodStart: line.periodStart,
    periodEnd: line.periodEnd,
    proration: line.proration,
    creditsLineId: line.creditsLineId,
    metered: line.metered,
    metadata: line.metadata,
    createdAt: now,
  }));
  const prices = new Map<string, Price>(
    [...lineCatalog.prices.values()].map((price) => [price.id, toPriceDTO(price)]),
  );
  return toInvoiceDTO(row, lineRows, prices);
}
