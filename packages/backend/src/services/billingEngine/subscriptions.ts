/**
 * Subscriptions (ADR 0018 §1): create, change, cancel, resume — and the
 * engine's steps for one subscription (trial reminders and ends, renewals,
 * scheduled cancellation, incomplete expiry, pause resumption).
 *
 * ## Invariants every function here keeps
 *
 * - Every status change is `transitionSubscription` (CAS + event + webhook,
 *   one transaction); every other write that moves a rendered field records
 *   `customer.subscription.updated`.
 * - A subscription's items share ONE currency and ONE recurrence (Stripe's
 *   rule): a period is the same instant for every item.
 * - Money is decided by the catalog's pricing (`itemPeriodAmount`), prorated
 *   by the second (`periods.ts`), discounted by `invoiceMath.ts` and taxed
 *   before finalization (`invoiceTax.ts`).
 * - FairCoin is never debited: a FAIR subscription is `send_invoice`, and each
 *   period is paid by the payer on the hosted invoice page — explicit renewal.
 * - Time is the customer's clock (`engineNow`), never `new Date()`.
 */
import type {
  CollectionMethod,
  CurrencyCode,
  DiscountParams,
  PauseCollectionBehavior,
  PaymentBehavior,
  ProrationBehavior,
  SubscriptionStatus,
  TrialEndBehavior,
} from '@peable.to/shared-types';
import { findCouponById } from '../../db/catalog/couponRepository';
import { findPromotionCodeById } from '../../db/catalog/promotionCodeRepository';
import { findPricesByPublicIds, type PriceRow } from '../../db/catalog/priceRepository';
import {
  findCustomerById,
  findLiveCustomerForMerchant,
  type CustomerRow,
} from '../../db/customers/customerRepository';
import {
  findPaymentMethodForMerchant,
  type PaymentMethodRow,
} from '../../db/customers/paymentMethodRepository';
import { findMerchantById, type MerchantRow } from '../../db/merchants/merchantRepository';
import type { MetadataPatch } from '../../db/metadata';
import {
  claimCustomerCurrency,
  lockCustomerBalance,
} from '../../db/billingEngine/balanceRepository';
import {
  attachItemsToInvoice,
  findChargedLineCovering,
  findInvoiceById,
  insertInvoice,
  insertInvoiceItem,
  insertLines,
  listOpenSubscriptionInvoices,
  lockInvoice,
  lockPendingItems,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import { aggregateMeter, findMeterById } from '../../db/billingEngine/meterRepository';
import { ensureBillingSettings } from '../../db/billingEngine/settingsRepository';
import {
  findSubscriptionById,
  findSubscriptionForMerchant,
  updateSubscription as writeSubscription,
  insertSubscription,
  insertSubscriptionItem,
  listLiveItems,
  lockSubscription,
  updateSubscriptionItem,
  type SubscriptionItemRow,
  type SubscriptionPatch,
  type SubscriptionRow,
} from '../../db/billingEngine/subscriptionRepository';
import { getDb, type Transaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { renderInvoice, renderSubscription } from '../../lib/serializeBilling';
import { kickWebhookOutbox } from '../webhookOutbox';
import { attemptInvoicePayment, payerIntentForInvoice, railOf } from './collect';
import {
  applyDiscountFor,
  couponInEffect,
  discountRequest,
  type AppliedDiscount,
} from './discounts';
import {
  type Catalog,
  type DraftLine,
  discountsFor,
  invoiceItemLine,
  itemPeriodAmount,
  loadCatalog,
  meteredLine,
  periodLines,
  priceOf,
  productOfPrice,
  toInsertLine,
} from './drafting';
import { BillingEngineError, invalid, missing } from './errors';
import {
  commitFinalization,
  DRAFT_FINALIZATION_DELAY_MS,
  draftTotals,
  finalizeStoredInvoice,
  prepareInvoice,
  voidInvoiceInTx,
} from './invoiceEngine';
import { applyBalance } from './invoiceMath';
import { addDays, addIntervals, nextBoundaryAfter, prorate, type Recurrence } from './periods';
import { engineNow } from './runtime';
import { subscriptionIsTerminal } from './stateMachines';
import { nextActionAt, TRIAL_WILL_END_LEAD_MS, UPCOMING_LEAD_MS } from './subscriptionSchedule';
import { previousAttributes } from '../catalog/catalogService';
import { refreshEntitlementSummary } from './entitlements';
import { upcomingInvoice } from './upcoming';
import {
  MetadataLimitError,
  patchInvoice,
  patchSubscription,
  recordBillingEvent,
  transitionSubscription,
} from './transitions';

const MAX_TRIAL_DAYS = 730;
const MAX_ITEMS = 20;

// ---- Shared helpers ---------------------------------------------------------------

function recurrenceOf(price: PriceRow): Recurrence {
  if (price.recurringInterval === null || price.recurringIntervalCount === null) {
    throw new Error('a recurring price without its recurrence');
  }
  return { interval: price.recurringInterval, intervalCount: price.recurringIntervalCount };
}

/** The one recurrence of a subscription (every item shares it). */
async function subscriptionRecurrence(
  catalog: Catalog,
  items: readonly SubscriptionItemRow[],
): Promise<Recurrence> {
  const [first] = items;
  if (!first) throw new Error('a subscription without items');
  return recurrenceOf(priceOf(catalog, first.priceId));
}

function intervalMs(start: Date, recurrence: Recurrence): number {
  return (
    addIntervals(start, recurrence.interval, recurrence.intervalCount).getTime() - start.getTime()
  );
}

async function committed<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const result = await getDb().transaction(work);
  kickWebhookOutbox();
  return result;
}

function wrapMetadata<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    if (error instanceof MetadataLimitError) throw invalid('metadata limit exceeded', 'metadata');
    throw error;
  });
}

interface ResolvedItem {
  readonly price: PriceRow;
  readonly quantity: number;
  readonly metadata: Record<string, string>;
}

/** Validate a set of prices as one subscription's items: recurring, active, one currency, one recurrence. */
function assertCoherentItems(items: readonly { price: PriceRow; param: string }[]): {
  currency: CurrencyCode;
  recurrence: Recurrence;
} {
  const [first] = items;
  if (!first) throw invalid('a subscription needs at least one item', 'items');
  if (items.length > MAX_ITEMS) throw invalid(`at most ${MAX_ITEMS} items`, 'items');
  const seen = new Set<string>();
  for (const { price, param } of items) {
    if (!price.active) throw invalid('this price is archived and cannot be subscribed to', param);
    if (price.type !== 'recurring')
      throw invalid('a subscription item needs a recurring price', param);
    if (seen.has(price.id)) throw invalid('each price appears once in a subscription', param);
    seen.add(price.id);
    if (price.currency !== first.price.currency) {
      throw invalid('every item of a subscription is in one currency', param);
    }
    const a = recurrenceOf(price);
    const b = recurrenceOf(first.price);
    if (a.interval !== b.interval || a.intervalCount !== b.intervalCount) {
      throw invalid('every item of a subscription bills on the same interval', param);
    }
  }
  return { currency: first.price.currency, recurrence: recurrenceOf(first.price) };
}

async function resolvePaymentMethod(
  merchant: MerchantRow,
  customer: CustomerRow,
  publicId: string | undefined,
  param = 'default_payment_method',
): Promise<PaymentMethodRow | null> {
  if (publicId === undefined) return null;
  const method = await findPaymentMethodForMerchant(getDb(), publicId, merchant.id);
  if (!method || method.customerId !== customer.id) {
    throw new BillingEngineError(
      'resource_missing',
      `no payment method '${publicId}' attached to this customer`,
      param,
    );
  }
  return method;
}

/** The metered lines of a period: each metered item's meter aggregate over `[start, end)`. */
async function meteredLines(
  tx: Transaction,
  catalog: Catalog,
  subscription: SubscriptionRow,
  items: readonly SubscriptionItemRow[],
  period: { start: Date; end: Date },
): Promise<DraftLine[]> {
  const lines: DraftLine[] = [];
  for (const item of items) {
    const price = priceOf(catalog, item.priceId);
    if (price.recurringUsageType !== 'metered' || price.meterId === null) continue;
    const meter = await findMeterById(tx, price.meterId);
    if (!meter) continue;
    const usage = await aggregateMeter(tx, {
      meterId: meter.id,
      customerId: subscription.customerId,
      start: period.start,
      end: period.end,
      aggregation: meter.aggregation,
    });
    lines.push(meteredLine(catalog, subscription.id, item, period, usage));
  }
  return lines;
}

/** Write a draft: the invoice, its lines and the pending items it pulled in. */
async function writeDraft(
  tx: Transaction,
  params: {
    readonly subscription: SubscriptionRow;
    readonly reason:
      | 'subscription_create'
      | 'subscription_cycle'
      | 'subscription_update'
      | 'subscription_cancel';
    readonly period: { start: Date; end: Date };
    readonly lines: readonly DraftLine[];
    readonly pendingItemIds: readonly string[];
    readonly couponId: string | null;
    readonly promotionCodeId: string | null;
    readonly autoAdvance: boolean;
    readonly finalizesAt: Date | null;
    readonly catalog: Catalog;
    readonly automaticTax?: boolean;
  },
): Promise<InvoiceRow | null> {
  const { subscription } = params;
  const coupon = params.couponId ? await findCouponById(tx, params.couponId) : null;
  const totals = draftTotals(
    params.lines,
    discountsFor(params.lines, params.catalog, coupon, subscription.currency),
    subscription.automaticTax,
  );
  const invoice = await insertInvoice(tx, {
    publicId: newId('in'),
    merchantId: subscription.merchantId,
    customerId: subscription.customerId,
    subscriptionId: subscription.id,
    testClockId: subscription.testClockId,
    billingReason: params.reason,
    collectionMethod: subscription.collectionMethod,
    currency: subscription.currency,
    description: subscription.description,
    autoAdvance: params.autoAdvance,
    automaticallyFinalizesAt: params.autoAdvance ? params.finalizesAt : null,
    daysUntilDue: subscription.daysUntilDue,
    dueDate: null,
    periodStart: params.period.start,
    periodEnd: params.period.end,
    defaultPaymentMethodId: subscription.defaultPaymentMethodId,
    discountCouponId: params.couponId,
    discountPromotionCodeId: params.promotionCodeId,
    automaticTax: params.automaticTax ?? subscription.automaticTax,
    metadata: {},
    nextActionAt: params.autoAdvance ? params.finalizesAt : null,
  });
  if (!invoice) return null;
  await insertLines(
    tx,
    params.lines.map((line) => toInsertLine(line, invoice.id, subscription.merchantId)),
  );
  await attachItemsToInvoice(tx, params.pendingItemIds, invoice.id);
  const withTotals = await patchInvoice(
    tx,
    invoice,
    {
      subtotal: totals.subtotal.toString(),
      totalDiscount: totals.totalDiscount.toString(),
      tax: totals.tax === null ? null : totals.tax.toString(),
      total: totals.total.toString(),
      totalExcludingTax: totals.totalExcludingTax.toString(),
      amountDue: (totals.total > 0n ? totals.total : 0n).toString(),
    },
    { record: false },
  );
  await recordBillingEvent(
    tx,
    withTotals.merchantId,
    'invoice.created',
    await renderInvoice(tx, withTotals),
  );
  return withTotals;
}

// ---- Create ---------------------------------------------------------------------

/**
 * An adopted subscription whose previous provider still renews it belongs to
 * the migration until the release (ADR 0018 §7): a change now would act on a
 * subscription two systems could bill.
 */
function assertNotHeld(subscription: SubscriptionRow): void {
  if (subscription.providerHandoffPending) {
    throw new BillingEngineError(
      'subscription_unexpected_state',
      'this subscription is being handed over from its previous billing provider; retry shortly',
      undefined,
      409,
    );
  }
}

export interface CreateSubscriptionInput {
  readonly customer: string;
  readonly items: readonly {
    price: string;
    quantity?: number;
    metadata?: Record<string, string>;
  }[];
  readonly defaultPaymentMethod?: string;
  readonly collectionMethod?: CollectionMethod;
  readonly daysUntilDue?: number;
  readonly description?: string;
  readonly trialPeriodDays?: number;
  readonly trialEnd?: number | 'now';
  readonly trialEndBehavior?: TrialEndBehavior;
  readonly billingCycleAnchor?: number;
  readonly prorationBehavior?: 'create_prorations' | 'none';
  readonly cancelAtPeriodEnd?: boolean;
  readonly cancelAt?: number;
  readonly coupon?: string;
  readonly promotionCode?: string;
  readonly discounts?: readonly DiscountParams[];
  readonly paymentBehavior?: PaymentBehavior;
  readonly automaticTax?: boolean;
  readonly metadata: Record<string, string>;
  /**
   * A Checkout Session's discount (Orbit Phase 3): already validated and
   * REDEEMED by the session when it completes, so the subscription carries it
   * without counting a second redemption. Not reachable from the API.
   */
  readonly checkoutDiscount?: {
    readonly couponId: string;
    readonly promotionCodeId: string | null;
  };
}

/** A checkout's discount as the engine holds one: its window from `now`, no redemption. */
async function checkoutApplied(
  discount: NonNullable<CreateSubscriptionInput['checkoutDiscount']>,
  now: Date,
): Promise<AppliedDiscount> {
  const db = getDb();
  const coupon = await findCouponById(db, discount.couponId);
  if (!coupon) throw new Error('a checkout discount without its coupon');
  const promotionCode = discount.promotionCodeId
    ? await findPromotionCodeById(db, discount.promotionCodeId)
    : null;
  return {
    coupon,
    promotionCode,
    start: now,
    end:
      coupon.duration === 'repeating' && coupon.durationInMonths !== null
        ? addIntervals(now, 'month', coupon.durationInMonths)
        : null,
  };
}

async function resolveItems(
  merchant: MerchantRow,
  items: CreateSubscriptionInput['items'],
  paramBase = 'items',
): Promise<ResolvedItem[]> {
  const prices = await findPricesByPublicIds(
    getDb(),
    merchant.id,
    items.map((item) => item.price),
  );
  return items.map((item, index) => {
    const price = prices.find((candidate) => candidate.publicId === item.price);
    if (!price) {
      throw new BillingEngineError(
        'resource_missing',
        `no such price: '${item.price}'`,
        `${paramBase}[${index}][price]`,
      );
    }
    if (price.recurringUsageType === 'metered' && item.quantity !== undefined) {
      throw invalid(
        'a metered item has no quantity: its usage is the meter',
        `${paramBase}[${index}][quantity]`,
      );
    }
    return {
      price,
      quantity: price.recurringUsageType === 'metered' ? 0 : (item.quantity ?? 1),
      metadata: item.metadata ?? {},
    };
  });
}

/**
 * `POST /v1/subscriptions`. Prices and taxes the first invoice BEFORE writing
 * anything — a tax that fails closed refuses the whole create — then writes
 * the subscription, its items, the first invoice and their events in one
 * transaction, finalizes the invoice, and collects it per `payment_behavior`.
 */
export async function createSubscription(
  merchant: MerchantRow,
  input: CreateSubscriptionInput,
): Promise<SubscriptionRow> {
  const db = getDb();
  const customer = await findLiveCustomerForMerchant(db, input.customer, merchant.id);
  if (!customer) throw missing('customer', 'customer');
  const items = await resolveItems(merchant, input.items);
  const { currency, recurrence } = assertCoherentItems(
    items.map((item, i) => ({ price: item.price, param: `items[${i}][price]` })),
  );
  if (customer.currency !== null && customer.currency !== currency) {
    throw new BillingEngineError(
      'customer_currency_mismatch',
      `this customer bills in ${customer.currency}; a ${currency} subscription needs another customer`,
      'items',
    );
  }
  const rail = railOf(currency);
  const collectionMethod: CollectionMethod =
    input.collectionMethod ?? (rail === 'faircoin' ? 'send_invoice' : 'charge_automatically');
  if (rail === 'faircoin' && collectionMethod === 'charge_automatically') {
    throw new BillingEngineError(
      'faircoin_cannot_debit',
      'a FairCoin subscription sends its invoices for the payer to pay; it cannot be charged automatically',
      'collection_method',
    );
  }
  if (rail === 'faircoin' && input.defaultPaymentMethod !== undefined) {
    throw new BillingEngineError(
      'faircoin_cannot_debit',
      'a FairCoin payer signs from their own wallet; there is no saved payment method',
      'default_payment_method',
    );
  }
  if (collectionMethod === 'charge_automatically' && input.daysUntilDue !== undefined) {
    throw invalid('days_until_due is for send_invoice', 'days_until_due');
  }
  if (rail === 'faircoin' && !merchant.network) {
    throw new BillingEngineError(
      'rail_unavailable',
      'this merchant has not registered a FairCoin account',
      'items',
    );
  }
  const method = await resolvePaymentMethod(merchant, customer, input.defaultPaymentMethod);
  const settings = await ensureBillingSettings(db, merchant.id);
  const daysUntilDue =
    collectionMethod === 'send_invoice'
      ? (input.daysUntilDue ?? settings.defaultDaysUntilDue)
      : null;

  const now = await engineNow(db, customer.testClockId);
  if (input.trialEnd !== undefined && input.trialPeriodDays !== undefined) {
    throw invalid('pass trial_end or trial_period_days, not both', 'trial_end');
  }
  let trialEnd: Date | null = null;
  if (input.trialPeriodDays !== undefined) {
    if (input.trialPeriodDays < 1 || input.trialPeriodDays > MAX_TRIAL_DAYS) {
      throw invalid(`trial_period_days is 1–${MAX_TRIAL_DAYS}`, 'trial_period_days');
    }
    trialEnd = addDays(now, input.trialPeriodDays);
  } else if (typeof input.trialEnd === 'number') {
    trialEnd = new Date(input.trialEnd * 1000);
    if (trialEnd.getTime() <= now.getTime())
      throw invalid('trial_end must be in the future', 'trial_end');
    if (trialEnd.getTime() > addDays(now, MAX_TRIAL_DAYS).getTime()) {
      throw invalid(`a trial lasts at most ${MAX_TRIAL_DAYS} days`, 'trial_end');
    }
  }
  const base = trialEnd ?? now;
  let anchor = base;
  if (input.billingCycleAnchor !== undefined) {
    anchor = new Date(input.billingCycleAnchor * 1000);
    const limit = addIntervals(base, recurrence.interval, recurrence.intervalCount);
    if (anchor.getTime() < base.getTime() || anchor.getTime() > limit.getTime()) {
      throw invalid(
        'billing_cycle_anchor must fall within the first period (after the trial)',
        'billing_cycle_anchor',
      );
    }
  }
  const cancelAt = input.cancelAt !== undefined ? new Date(input.cancelAt * 1000) : null;
  if (cancelAt && cancelAt.getTime() <= now.getTime())
    throw invalid('cancel_at must be in the future', 'cancel_at');

  // The first period, and its lines.
  const period = trialEnd
    ? { start: now, end: trialEnd }
    : {
        start: now,
        end:
          anchor.getTime() > now.getTime()
            ? anchor
            : addIntervals(now, recurrence.interval, recurrence.intervalCount),
      };
  const stub =
    !trialEnd && anchor.getTime() > now.getTime()
      ? {
          wholeMs: intervalMs(
            addIntervals(anchor, recurrence.interval, -recurrence.intervalCount),
            recurrence,
          ),
          prorate: (input.prorationBehavior ?? 'create_prorations') !== 'none',
        }
      : null;
  const subscriptionId = 'pending';
  const provisionalItems: SubscriptionItemRow[] = items.map((item, i) => ({
    id: `pending-${i}`,
    publicId: newId('si'),
    merchantId: merchant.id,
    livemode: merchant.livemode,
    subscriptionId,
    subscriptionPublicId: '',
    priceId: item.price.id,
    quantity: item.quantity,
    metadata: item.metadata,
    deletedAt: null,
    createdAt: now,
  }));
  const catalog = await loadCatalog(
    db,
    items.map((item) => item.price.id),
  );
  const draftLines = periodLines(catalog, subscriptionId, provisionalItems, period, {
    trial: trialEnd !== null,
    stub,
  });
  // The discount, validated (and redeemed again, under lock, in the transaction).
  const request = discountRequest({
    coupon: input.coupon,
    promotionCode: input.promotionCode,
    discounts: input.discounts,
  });
  const subtotal = draftLines.reduce((sum, line) => sum + line.amount, 0n);
  const previewDiscount = request
    ? await db
        .transaction(async (tx) => {
          const applied = await applyDiscountFor(tx, {
            merchantId: merchant.id,
            customerId: customer.id,
            currency,
            now,
            orderTotal: subtotal,
            request,
          });
          // A dry run: validate now, count it in the real transaction.
          throw new DryRun(applied);
        })
        .catch((error: unknown) => {
          if (error instanceof DryRun) return error.applied;
          throw error;
        })
    : null;
  const fromCheckout = input.checkoutDiscount
    ? await checkoutApplied(input.checkoutDiscount, now)
    : null;
  const firstCoupon = fromCheckout?.coupon ?? previewDiscount?.coupon ?? null;
  const automaticTax = input.automaticTax ?? false;
  const prepared = await prepareInvoice({
    merchant,
    customer,
    currency,
    automaticTax,
    lines: draftLines,
    coupon: firstCoupon,
  });

  const created = await db.transaction(async (tx) => {
    if (!(await claimCustomerCurrency(tx, customer.id, currency))) {
      throw new BillingEngineError(
        'customer_currency_mismatch',
        'this customer bills in another currency',
        'items',
      );
    }
    const balance = await lockCustomerBalance(tx, customer.id);
    const predicted = applyBalance(prepared.totals.total, balance.balance);
    const paymentBehavior = input.paymentBehavior ?? 'allow_incomplete';
    let status: SubscriptionStatus;
    if (trialEnd) status = 'trialing';
    else if (predicted.amountDue === 0n) status = 'active';
    else if (collectionMethod === 'send_invoice') {
      status = paymentBehavior === 'default_incomplete' ? 'incomplete' : 'active';
    } else status = 'incomplete';

    const discount: AppliedDiscount | null = fromCheckout
      ? fromCheckout
      : request
        ? await applyDiscountFor(tx, {
            merchantId: merchant.id,
            customerId: customer.id,
            currency,
            now,
            orderTotal: subtotal,
            request,
          })
        : null;
    const keepsDiscount =
      discount !== null && !(discount.coupon.duration === 'once' && subtotal > 0n);
    let subscription = await insertSubscription(tx, {
      publicId: newId('sub'),
      merchantId: merchant.id,
      customerId: customer.id,
      testClockId: customer.testClockId,
      status,
      currency,
      collectionMethod,
      daysUntilDue,
      defaultPaymentMethodId: method?.id ?? null,
      description: input.description ?? null,
      billingCycleAnchor: anchor,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      startDate: now,
      trialStart: trialEnd ? now : null,
      trialEnd,
      trialEndBehavior: input.trialEndBehavior ?? 'create_invoice',
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      cancelAt,
      automaticTax,
      discountCouponId: keepsDiscount ? discount.coupon.id : null,
      discountPromotionCodeId: keepsDiscount ? (discount.promotionCode?.id ?? null) : null,
      discountStart: keepsDiscount ? discount.start : null,
      discountEnd: keepsDiscount ? discount.end : null,
      metadata: input.metadata,
      nextActionAt: null,
    });
    const realItems: SubscriptionItemRow[] = [];
    for (const [i, item] of items.entries()) {
      const written = await insertSubscriptionItem(tx, {
        publicId: provisionalItems[i]?.publicId ?? newId('si'),
        merchantId: merchant.id,
        subscriptionId: subscription.id,
        priceId: item.price.id,
        quantity: item.quantity,
        metadata: item.metadata,
      });
      if (written === 'price_taken')
        throw invalid('each price appears once in a subscription', `items[${i}][price]`);
      realItems.push(written);
    }
    const lines = prepared.lines.map((line) => {
      const index = provisionalItems.findIndex((item) => item.id === line.subscriptionItemId);
      return {
        ...line,
        subscriptionId: subscription.id,
        subscriptionItemId: realItems[index]?.id ?? null,
      };
    });
    const invoice = await insertInvoice(tx, {
      publicId: newId('in'),
      merchantId: merchant.id,
      customerId: customer.id,
      subscriptionId: subscription.id,
      testClockId: customer.testClockId,
      billingReason: 'subscription_create',
      collectionMethod,
      currency,
      description: input.description ?? null,
      autoAdvance: true,
      automaticallyFinalizesAt: null,
      daysUntilDue,
      dueDate: null,
      periodStart: period.start,
      periodEnd: period.end,
      defaultPaymentMethodId: method?.id ?? null,
      discountCouponId: discount?.coupon.id ?? null,
      discountPromotionCodeId: discount?.promotionCode?.id ?? null,
      automaticTax,
      metadata: {},
      nextActionAt: null,
    });
    if (!invoice) throw new Error('a new subscription already had a first invoice');
    await insertLines(
      tx,
      lines.map((line) => toInsertLine(line, invoice.id, merchant.id)),
    );
    const linked = await writeSubscription(tx, subscription.id, {
      latestInvoiceId: invoice.id,
      nextActionAt: nextActionAt(subscription),
    });
    if (linked === 'limit_exceeded') throw invalid('metadata limit exceeded', 'metadata');
    subscription = linked;
    await recordBillingEvent(
      tx,
      merchant.id,
      'customer.subscription.created',
      await renderSubscription(tx, subscription),
    );
    await recordBillingEvent(tx, merchant.id, 'invoice.created', await renderInvoice(tx, invoice));
    const outcome = await commitFinalization(tx, invoice, prepared, now, { autoAdvance: false });
    await refreshEntitlementSummary(tx, merchant.id, customer.id);
    return { subscription, invoice: outcome.invoice, paymentBehavior };
  });
  kickWebhookOutbox();

  const { invoice, paymentBehavior } = created;
  if (invoice.status === 'open' && invoice.collectionMethod === 'charge_automatically') {
    // The subscription's method, else the customer's default (Stripe's order).
    const chargeable = method !== null || customer.defaultPaymentMethodId !== null;
    if (paymentBehavior === 'default_incomplete' || !chargeable) {
      if (paymentBehavior === 'error_if_incomplete') {
        await expireIncomplete(created.subscription.id);
        throw new BillingEngineError(
          'payment_method_missing',
          'the first invoice needs a payment method to be paid at once',
          'default_payment_method',
          402,
        );
      }
      // The payer confirms the first payment on-session (`latest_invoice.payment_intent`).
      await payerIntentForInvoice(invoice);
    } else {
      const attempt = await attemptInvoicePayment(invoice.id, { offSession: true });
      const after = await findInvoiceById(db, invoice.id);
      if (paymentBehavior === 'error_if_incomplete' && after?.status !== 'paid') {
        await expireIncomplete(created.subscription.id);
        const declined = attempt.kind === 'attempted' ? attempt.intent.lastPaymentError : null;
        throw new BillingEngineError(
          'card_declined',
          declined?.message ?? 'the first payment did not succeed',
          undefined,
          402,
          'card_error',
          { ...(declined?.decline_code ? { decline_code: declined.decline_code } : {}) },
        );
      }
    }
  }
  return (await findSubscriptionById(db, created.subscription.id)) ?? created.subscription;
}

class DryRun extends Error {
  constructor(readonly applied: AppliedDiscount) {
    super('dry run');
  }
}

/** `incomplete` → `incomplete_expired`: the first invoice is voided and its payment retired. */
async function expireIncomplete(subscriptionId: string): Promise<void> {
  await committed(async (tx) => {
    const subscription = await lockSubscription(tx, subscriptionId);
    if (subscription?.status !== 'incomplete') return;
    const now = await engineNow(tx, subscription.testClockId);
    if (subscription.latestInvoiceId) {
      const invoice = await lockInvoice(tx, subscription.latestInvoiceId);
      if (invoice && (invoice.status === 'open' || invoice.status === 'uncollectible')) {
        await voidInvoiceInTx(tx, invoice, now);
      }
    }
    await transitionSubscription(tx, subscription, 'incomplete_expired', {
      endedAt: now,
      nextActionAt: null,
    });
  });
}

// ---- Update ---------------------------------------------------------------------

export interface UpdateSubscriptionInput {
  readonly items?: readonly {
    id?: string;
    price?: string;
    quantity?: number;
    deleted?: boolean;
    metadata?: Record<string, string>;
  }[];
  readonly prorationBehavior?: ProrationBehavior;
  readonly prorationDate?: number;
  readonly defaultPaymentMethod?: string | null;
  readonly collectionMethod?: CollectionMethod;
  readonly daysUntilDue?: number;
  readonly description?: string | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly cancelAt?: number | null;
  readonly pauseCollection?: { behavior: PauseCollectionBehavior; resumesAt?: number } | null;
  readonly trialEnd?: number | 'now';
  readonly coupon?: string | null;
  readonly promotionCode?: string;
  readonly discounts?: readonly DiscountParams[] | null;
  readonly automaticTax?: boolean;
  readonly metadata?: MetadataPatch;
}

/**
 * `POST /v1/subscriptions/:id`. Item changes are prorated by the second at
 * `proration_date` (default now): the unused time of what changed is credited
 * — reversing the tax of the line it credits — and the remaining time of what
 * replaced it charged, as pending invoice items for the next invoice
 * (`create_prorations`), on an invoice now (`always_invoice`), or not at all
 * (`none`). Changing the billing interval restarts the period now and
 * invoices at once, Stripe's rule.
 */
export async function updateSubscription(
  merchant: MerchantRow,
  publicId: string,
  input: UpdateSubscriptionInput,
): Promise<SubscriptionRow> {
  const db = getDb();
  const found = await findSubscriptionForMerchant(db, publicId, merchant.id);
  if (!found) throw missing('subscription');
  if (subscriptionIsTerminal(found.status)) {
    throw new BillingEngineError(
      'subscription_unexpected_state',
      `this subscription is ${found.status} and can no longer change`,
    );
  }
  const customer = await findCustomerById(db, found.customerId);
  if (!customer) throw new Error('subscription customer vanished');
  const method =
    input.defaultPaymentMethod === undefined || input.defaultPaymentMethod === null
      ? null
      : await resolvePaymentMethod(merchant, customer, input.defaultPaymentMethod);
  if (railOf(found.currency) === 'faircoin') {
    if (input.collectionMethod === 'charge_automatically') {
      throw new BillingEngineError(
        'faircoin_cannot_debit',
        'a FairCoin subscription cannot be charged automatically',
        'collection_method',
      );
    }
    if (method) {
      throw new BillingEngineError(
        'faircoin_cannot_debit',
        'a FairCoin payer has no saved payment method',
        'default_payment_method',
      );
    }
  }
  const newItems = input.items ? await planItems(merchant, found, input.items) : null;
  const prorationBehavior = input.prorationBehavior ?? 'create_prorations';
  const request =
    input.coupon === null || input.discounts === null
      ? null
      : discountRequest({
          coupon: input.coupon ?? undefined,
          promotionCode: input.promotionCode,
          discounts: input.discounts ?? undefined,
        });
  const removeDiscount = input.coupon === null || input.discounts === null;

  let invoiceNow: string | null = null;
  const updated = await wrapMetadata(() =>
    committed(async (tx) => {
      let subscription = await lockSubscription(tx, found.id);
      if (!subscription) throw missing('subscription');
      assertNotHeld(subscription);
      const now = await engineNow(tx, subscription.testClockId);
      if (
        newItems &&
        prorationBehavior !== 'none' &&
        subscription.providerBilledUntil &&
        now.getTime() < subscription.providerBilledUntil.getTime()
      ) {
        // The previous provider billed this period: no engine line covers it,
        // so its unused time cannot be credited, and charging the new price's
        // remaining time without that credit would bill the payer twice.
        throw invalid(
          'this period was billed by the previous billing provider; change items with proration_behavior=none, or after the period ends',
          'proration_behavior',
        );
      }
      const patch: {
        -readonly [K in keyof SubscriptionPatch]: SubscriptionPatch[K];
      } = {};
      if (input.description !== undefined) patch.description = input.description;
      if (input.metadata) patch.metadata = input.metadata;
      if (input.defaultPaymentMethod !== undefined)
        patch.defaultPaymentMethodId = method?.id ?? null;
      if (input.collectionMethod !== undefined) {
        patch.collectionMethod = input.collectionMethod;
        patch.daysUntilDue =
          input.collectionMethod === 'send_invoice'
            ? (input.daysUntilDue ??
              subscription.daysUntilDue ??
              (await ensureBillingSettings(tx, merchant.id)).defaultDaysUntilDue)
            : null;
      } else if (input.daysUntilDue !== undefined) {
        if (subscription.collectionMethod !== 'send_invoice') {
          throw invalid('days_until_due is for send_invoice', 'days_until_due');
        }
        patch.daysUntilDue = input.daysUntilDue;
      }
      if (input.automaticTax !== undefined) patch.automaticTax = input.automaticTax;
      if (input.cancelAtPeriodEnd !== undefined) {
        patch.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
        if (input.cancelAtPeriodEnd) patch.cancelAt = null;
      }
      if (input.cancelAt !== undefined) {
        const at = input.cancelAt === null ? null : new Date(input.cancelAt * 1000);
        if (at && at.getTime() <= now.getTime())
          throw invalid('cancel_at must be in the future', 'cancel_at');
        patch.cancelAt = at;
        if (at) patch.cancelAtPeriodEnd = false;
      }
      if (input.pauseCollection !== undefined) {
        if (input.pauseCollection === null) {
          patch.pauseBehavior = null;
          patch.pauseResumesAt = null;
        } else {
          const resumes =
            input.pauseCollection.resumesAt !== undefined
              ? new Date(input.pauseCollection.resumesAt * 1000)
              : null;
          if (resumes && resumes.getTime() <= now.getTime()) {
            throw invalid('resumes_at must be in the future', 'pause_collection[resumes_at]');
          }
          patch.pauseBehavior = input.pauseCollection.behavior;
          patch.pauseResumesAt = resumes;
        }
      }
      if (removeDiscount) {
        patch.discountCouponId = null;
        patch.discountPromotionCodeId = null;
        patch.discountStart = null;
        patch.discountEnd = null;
      } else if (request) {
        const applied = await applyDiscountFor(tx, {
          merchantId: merchant.id,
          customerId: subscription.customerId,
          currency: subscription.currency,
          now,
          orderTotal: 0n,
          request,
        });
        patch.discountCouponId = applied.coupon.id;
        patch.discountPromotionCodeId = applied.promotionCode?.id ?? null;
        patch.discountStart = applied.start;
        patch.discountEnd = applied.end;
      }
      if (input.trialEnd !== undefined) {
        if (subscription.status !== 'trialing') {
          throw invalid('only a trialing subscription can change its trial', 'trial_end');
        }
        const end = input.trialEnd === 'now' ? now : new Date(input.trialEnd * 1000);
        if (input.trialEnd !== 'now' && end.getTime() <= now.getTime()) {
          throw invalid('trial_end must be in the future', 'trial_end');
        }
        patch.trialEnd = end;
        patch.currentPeriodEnd = end;
        patch.billingCycleAnchor = end;
      }

      let itemsChanged = false;
      if (newItems) {
        const outcome = await applyItemChanges(tx, subscription, newItems, {
          prorationBehavior,
          prorationDate:
            input.prorationDate !== undefined ? new Date(input.prorationDate * 1000) : now,
          now,
        });
        itemsChanged = true;
        Object.assign(patch, outcome.patch);
        if (outcome.invoiceNow) invoiceNow = 'pending';
      }
      subscription = await patchSubscription(tx, subscription, patch, { itemsChanged });
      const scheduled = nextActionAt(subscription);
      if (scheduled?.getTime() !== subscription.nextActionAt?.getTime()) {
        const rescheduled = await writeSubscription(tx, subscription.id, {
          nextActionAt: scheduled,
        });
        if (rescheduled !== 'limit_exceeded') subscription = rescheduled;
      }
      if (invoiceNow) {
        const invoice = await invoicePendingNow(tx, subscription, now, 'subscription_update');
        invoiceNow = invoice?.id ?? null;
      }
      return subscription;
    }),
  );
  if (input.trialEnd === 'now') await runSubscriptionStep(updated.id);
  if (invoiceNow) await finalizeAndCollect(invoiceNow);
  return (await findSubscriptionById(db, updated.id)) ?? updated;
}

interface PlannedItem {
  /** An existing item (`si_…` internal id), or `null` for a new one. */
  readonly existingId: string | null;
  readonly publicId: string | null;
  readonly price: PriceRow;
  readonly quantity: number;
  readonly metadata: Record<string, string> | undefined;
  readonly deleted: boolean;
}

/** Resolve `items[]` of an update against the subscription's live items. */
async function planItems(
  merchant: MerchantRow,
  subscription: SubscriptionRow,
  entries: NonNullable<UpdateSubscriptionInput['items']>,
): Promise<PlannedItem[]> {
  const db = getDb();
  const live = await listLiveItems(db, subscription.id);
  const catalog = await loadCatalog(
    db,
    live.map((item) => item.priceId),
  );
  const named = await findPricesByPublicIds(
    db,
    merchant.id,
    entries.flatMap((entry) => (entry.price ? [entry.price] : [])),
  );
  const planned: PlannedItem[] = [];
  const touched = new Set<string>();
  for (const [i, entry] of entries.entries()) {
    const param = `items[${i}]`;
    let existing: SubscriptionItemRow | undefined;
    if (entry.id !== undefined) {
      existing = live.find((item) => item.publicId === entry.id);
      if (!existing)
        throw new BillingEngineError(
          'resource_missing',
          `no item '${entry.id}' on this subscription`,
          `${param}[id]`,
        );
      touched.add(existing.id);
    }
    const price =
      entry.price !== undefined
        ? named.find((candidate) => candidate.publicId === entry.price)
        : existing
          ? priceOf(catalog, existing.priceId)
          : undefined;
    if (!price) {
      throw new BillingEngineError(
        entry.price ? 'resource_missing' : 'parameter_missing',
        entry.price ? `no such price: '${entry.price}'` : 'a new item needs a price',
        `${param}[price]`,
      );
    }
    if (entry.deleted && !existing)
      throw invalid('only an existing item can be deleted', `${param}[deleted]`);
    const metered = price.recurringUsageType === 'metered';
    if (metered && entry.quantity !== undefined) {
      throw invalid('a metered item has no quantity', `${param}[quantity]`);
    }
    planned.push({
      existingId: existing?.id ?? null,
      publicId: existing?.publicId ?? null,
      price,
      quantity: metered ? 0 : (entry.quantity ?? existing?.quantity ?? 1),
      metadata: entry.metadata,
      deleted: entry.deleted === true,
    });
  }
  // Items the request does not name stay as they are.
  for (const item of live) {
    if (touched.has(item.id)) continue;
    planned.push({
      existingId: item.id,
      publicId: item.publicId,
      price: priceOf(catalog, item.priceId),
      quantity: item.quantity,
      metadata: undefined,
      deleted: false,
    });
  }
  const remaining = planned.filter((item) => !item.deleted);
  assertCoherentItems(
    remaining.map((item, i) => ({ price: item.price, param: `items[${i}][price]` })),
  );
  if (remaining[0]?.price.currency !== subscription.currency) {
    throw invalid('a subscription cannot change currency', 'items');
  }
  return planned;
}

/**
 * Write the planned items and the prorations their change implies. Returns
 * the subscription patch (a reset period when the interval changed) and
 * whether an invoice must be made now.
 */
async function applyItemChanges(
  tx: Transaction,
  subscription: SubscriptionRow,
  planned: readonly PlannedItem[],
  options: { prorationBehavior: ProrationBehavior; prorationDate: Date; now: Date },
): Promise<{ patch: SubscriptionPatch; invoiceNow: boolean }> {
  const live = await listLiveItems(tx, subscription.id);
  const catalog = await loadCatalog(tx, [
    ...live.map((item) => item.priceId),
    ...planned.map((item) => item.price.id),
  ]);
  const oldRecurrence = await subscriptionRecurrence(catalog, live);
  const remaining = planned.filter((item) => !item.deleted);
  const newRecurrence = recurrenceOf((remaining[0] as PlannedItem).price);
  const intervalChanged =
    oldRecurrence.interval !== newRecurrence.interval ||
    oldRecurrence.intervalCount !== newRecurrence.intervalCount;
  const t = options.prorationDate;
  const start = subscription.currentPeriodStart;
  const end = subscription.currentPeriodEnd;
  if (t.getTime() < start.getTime() || t.getTime() > end.getTime()) {
    throw invalid('proration_date must fall within the current period', 'proration_date');
  }
  const charging = subscription.status !== 'trialing';
  const prorating = options.prorationBehavior !== 'none' && charging;
  const whole = end.getTime() - start.getTime();
  const left = end.getTime() - t.getTime();
  const newEnd = intervalChanged
    ? addIntervals(options.now, newRecurrence.interval, newRecurrence.intervalCount)
    : end;

  const proration = async (
    item: { id: string },
    price: PriceRow,
    quantity: number,
    sign: 1n | -1n,
  ) => {
    if (price.recurringUsageType === 'metered') return;
    const full = itemPeriodAmount(price, quantity);
    const amount = intervalChanged && sign === 1n ? full : prorate(full, left, whole);
    if (amount === 0n) return;
    const credited = sign === -1n ? await findChargedLineCovering(tx, item.id, t) : null;
    if (sign === -1n && credited === null) return;
    const product = productOfPrice(catalog, price.id);
    await insertInvoiceItem(tx, {
      publicId: newId('ii'),
      merchantId: subscription.merchantId,
      customerId: subscription.customerId,
      invoiceId: null,
      subscriptionId: subscription.id,
      subscriptionItemId: item.id,
      priceId: price.id,
      quantity,
      unitAmount: null,
      amount: (sign * amount).toString(),
      currency: subscription.currency,
      description:
        sign === -1n
          ? `Unused time on ${quantity} × ${product?.name ?? 'item'}`
          : `Remaining time on ${quantity} × ${product?.name ?? 'item'}`,
      discountable: true,
      periodStart: t,
      periodEnd: sign === 1n ? newEnd : end,
      proration: true,
      creditsLineId: credited?.id ?? null,
      metadata: {},
    });
  };

  for (const item of planned) {
    const current = item.existingId ? live.find((row) => row.id === item.existingId) : undefined;
    if (current) {
      const oldPrice = priceOf(catalog, current.priceId);
      const moved =
        item.deleted ||
        oldPrice.id !== item.price.id ||
        current.quantity !== item.quantity ||
        intervalChanged;
      if (moved && prorating) await proration(current, oldPrice, current.quantity, -1n);
      if (item.deleted) {
        const removed = await updateSubscriptionItem(tx, current.id, { deletedAt: options.now });
        if (typeof removed === 'string') throw new Error('item tombstone failed');
        continue;
      }
      const written = await updateSubscriptionItem(tx, current.id, {
        priceId: item.price.id,
        quantity: item.quantity,
        ...(item.metadata ? { metadata: { set: item.metadata, unset: [] } } : {}),
      });
      if (written === 'price_taken')
        throw invalid('each price appears once in a subscription', 'items');
      if (written === 'limit_exceeded') throw invalid('metadata limit exceeded', 'items');
      if (moved && prorating) await proration(written, item.price, item.quantity, 1n);
    } else {
      const written = await insertSubscriptionItem(tx, {
        publicId: newId('si'),
        merchantId: subscription.merchantId,
        subscriptionId: subscription.id,
        priceId: item.price.id,
        quantity: item.quantity,
        metadata: item.metadata ?? {},
      });
      if (written === 'price_taken')
        throw invalid('each price appears once in a subscription', 'items');
      if (prorating) await proration(written, item.price, item.quantity, 1n);
    }
  }
  if (intervalChanged) {
    return {
      patch: {
        billingCycleAnchor: options.now,
        currentPeriodStart: options.now,
        currentPeriodEnd: newEnd,
      },
      invoiceNow: charging,
    };
  }
  return { patch: {}, invoiceNow: options.prorationBehavior === 'always_invoice' && charging };
}

/** An invoice of the subscription's pending items, now (`always_invoice`, an interval change, `invoice_now`). */
async function invoicePendingNow(
  tx: Transaction,
  subscription: SubscriptionRow,
  now: Date,
  reason: 'subscription_update' | 'subscription_cancel',
  extraLines: readonly DraftLine[] = [],
): Promise<InvoiceRow | null> {
  const pending = await lockPendingItems(tx, subscription.customerId, {
    subscriptionId: subscription.id,
    includeUnattached: reason === 'subscription_cancel',
  });
  if (pending.length === 0 && extraLines.length === 0) return null;
  const lines = [...extraLines, ...pending.map(invoiceItemLine)];
  const catalog = await loadCatalog(
    tx,
    lines.map((line) => line.priceId),
  );
  const coupon = await couponInEffect(
    tx,
    {
      couponId: subscription.discountCouponId,
      start: subscription.discountStart,
      end: subscription.discountEnd,
    },
    now,
  );
  const invoice = await writeDraft(tx, {
    subscription,
    reason,
    period: { start: now, end: now },
    lines,
    pendingItemIds: pending.map((item) => item.id),
    couponId: coupon?.id ?? null,
    promotionCodeId: coupon ? subscription.discountPromotionCodeId : null,
    autoAdvance: true,
    finalizesAt: null,
    catalog,
  });
  if (invoice && reason !== 'subscription_cancel') {
    await writeSubscription(tx, subscription.id, { latestInvoiceId: invoice.id });
  }
  return invoice;
}

/** Finalize an engine draft at once and collect it (card: off-session). */
async function finalizeAndCollect(invoiceId: string): Promise<void> {
  const invoice = await finalizeStoredInvoice(invoiceId, { autoAdvance: true });
  if (invoice.status === 'open' && invoice.collectionMethod === 'charge_automatically') {
    await attemptInvoicePayment(invoice.id, { offSession: true });
  }
}

// ---- Cancel and resume ---------------------------------------------------------------

/**
 * `DELETE /v1/subscriptions/:id` — cancel now. `prorate` credits the unused
 * time of the current period (pending items, so they reach the customer's
 * balance or next invoice); `invoice_now` bills everything pending — those
 * credits, metered usage so far, pending items — on a final invoice at once.
 */
export async function cancelSubscriptionNow(
  merchant: MerchantRow,
  publicId: string,
  options: { invoiceNow?: boolean; prorate?: boolean; comment?: string },
): Promise<SubscriptionRow> {
  const db = getDb();
  const found = await findSubscriptionForMerchant(db, publicId, merchant.id);
  if (!found) throw missing('subscription');
  if (subscriptionIsTerminal(found.status)) {
    throw new BillingEngineError(
      'subscription_unexpected_state',
      `this subscription is already ${found.status}`,
    );
  }
  let finalInvoice: string | null = null;
  const canceled = await committed(async (tx) => {
    const subscription = await lockSubscription(tx, found.id);
    if (!subscription || subscriptionIsTerminal(subscription.status)) {
      throw new BillingEngineError(
        'subscription_unexpected_state',
        'this subscription is no longer cancelable',
      );
    }
    assertNotHeld(subscription);
    const now = await engineNow(tx, subscription.testClockId);
    const result = await cancelInTx(tx, subscription, now, {
      reason: 'cancellation_requested',
      comment: options.comment ?? null,
      prorate: options.prorate ?? false,
      invoiceNow: options.invoiceNow ?? false,
    });
    finalInvoice = result.finalInvoiceId;
    return result.subscription;
  });
  if (finalInvoice) await finalizeAndCollect(finalInvoice);
  return (await findSubscriptionById(db, canceled.id)) ?? canceled;
}

async function cancelInTx(
  tx: Transaction,
  subscription: SubscriptionRow,
  now: Date,
  options: {
    reason: 'cancellation_requested' | 'payment_failed';
    comment: string | null;
    prorate: boolean;
    invoiceNow: boolean;
  },
): Promise<{ subscription: SubscriptionRow; finalInvoiceId: string | null }> {
  const items = await listLiveItems(tx, subscription.id);
  const catalog = await loadCatalog(
    tx,
    items.map((item) => item.priceId),
  );
  if (
    options.prorate &&
    subscription.status !== 'trialing' &&
    now < subscription.currentPeriodEnd
  ) {
    const whole =
      subscription.currentPeriodEnd.getTime() - subscription.currentPeriodStart.getTime();
    const left = subscription.currentPeriodEnd.getTime() - now.getTime();
    for (const item of items) {
      const price = priceOf(catalog, item.priceId);
      if (price.recurringUsageType === 'metered') continue;
      const credit = prorate(itemPeriodAmount(price, item.quantity), left, whole);
      const credited = await findChargedLineCovering(tx, item.id, now);
      if (credit === 0n || !credited) continue;
      await insertInvoiceItem(tx, {
        publicId: newId('ii'),
        merchantId: subscription.merchantId,
        customerId: subscription.customerId,
        invoiceId: null,
        subscriptionId: subscription.id,
        subscriptionItemId: item.id,
        priceId: price.id,
        quantity: item.quantity,
        unitAmount: null,
        amount: (-credit).toString(),
        currency: subscription.currency,
        description: `Unused time on ${item.quantity} × ${productOfPrice(catalog, price.id)?.name ?? 'item'}`,
        discountable: true,
        periodStart: now,
        periodEnd: subscription.currentPeriodEnd,
        proration: true,
        creditsLineId: credited.id,
        metadata: {},
      });
    }
  }
  let finalInvoiceId: string | null = null;
  if (options.invoiceNow) {
    const usage = await meteredLines(tx, catalog, subscription, items, {
      start: subscription.currentPeriodStart,
      end: now,
    });
    const invoice = await invoicePendingNow(tx, subscription, now, 'subscription_cancel', usage);
    finalInvoiceId = invoice?.id ?? null;
  }
  const row = await transitionSubscription(tx, subscription, 'canceled', {
    canceledAt: now,
    endedAt: now,
    cancellationReason: options.reason,
    cancellationComment: options.comment,
    nextActionAt: null,
  });
  return { subscription: row, finalInvoiceId };
}

/**
 * `POST /v1/subscriptions/:id/resume` — a `paused` subscription becomes
 * active: a new period from now (`billing_cycle_anchor: now`, the default)
 * invoiced in full, or the old anchor kept with the stub to it prorated
 * (`unchanged`).
 */
export async function resumeSubscription(
  merchant: MerchantRow,
  publicId: string,
  options: { billingCycleAnchor?: 'now' | 'unchanged'; prorationBehavior?: ProrationBehavior },
): Promise<SubscriptionRow> {
  const db = getDb();
  const found = await findSubscriptionForMerchant(db, publicId, merchant.id);
  if (!found) throw missing('subscription');
  if (found.status !== 'paused') {
    throw new BillingEngineError(
      'subscription_unexpected_state',
      'only a paused subscription can be resumed',
    );
  }
  let invoiceId: string | null = null;
  const resumed = await committed(async (tx) => {
    const subscription = await lockSubscription(tx, found.id);
    if (subscription?.status !== 'paused') {
      throw new BillingEngineError(
        'subscription_unexpected_state',
        'only a paused subscription can be resumed',
      );
    }
    const now = await engineNow(tx, subscription.testClockId);
    const items = await listLiveItems(tx, subscription.id);
    const catalog = await loadCatalog(
      tx,
      items.map((item) => item.priceId),
    );
    const recurrence = await subscriptionRecurrence(catalog, items);
    const keep = options.billingCycleAnchor === 'unchanged';
    const anchor = keep ? subscription.billingCycleAnchor : now;
    const end = keep
      ? nextBoundaryAfter(anchor, recurrence, now)
      : addIntervals(now, recurrence.interval, recurrence.intervalCount);
    const stub = keep
      ? {
          wholeMs: intervalMs(
            addIntervals(end, recurrence.interval, -recurrence.intervalCount),
            recurrence,
          ),
          prorate: (options.prorationBehavior ?? 'create_prorations') !== 'none',
        }
      : null;
    const row = await transitionSubscription(tx, subscription, 'active', {
      billingCycleAnchor: anchor,
      currentPeriodStart: now,
      currentPeriodEnd: end,
    });
    const invoice = await draftPeriodInvoice(
      tx,
      row,
      catalog,
      items,
      { start: now, end },
      {
        reason: 'subscription_cycle',
        stub,
        meteredFor: null,
        autoAdvance: true,
        finalizesAt: null,
      },
    );
    invoiceId = invoice?.id ?? null;
    const scheduled = await writeSubscription(tx, row.id, {
      ...(invoice ? { latestInvoiceId: invoice.id } : {}),
      nextActionAt: nextActionAt(row),
    });
    return scheduled === 'limit_exceeded' ? row : scheduled;
  });
  if (invoiceId) await finalizeAndCollect(invoiceId);
  return (await findSubscriptionById(db, resumed.id)) ?? resumed;
}

/**
 * Draft the invoice of one period: its licensed lines, the metered usage of
 * the period before, the pending items, the discount in effect.
 */
async function draftPeriodInvoice(
  tx: Transaction,
  subscription: SubscriptionRow,
  catalog: Catalog,
  items: readonly SubscriptionItemRow[],
  period: { start: Date; end: Date },
  options: {
    reason: 'subscription_cycle';
    stub: { wholeMs: number; prorate: boolean } | null;
    meteredFor: { start: Date; end: Date } | null;
    autoAdvance: boolean;
    finalizesAt: Date | null;
    automaticTax?: boolean;
  },
): Promise<InvoiceRow | null> {
  const lines = periodLines(catalog, subscription.id, items, period, { stub: options.stub });
  if (options.meteredFor)
    lines.push(...(await meteredLines(tx, catalog, subscription, items, options.meteredFor)));
  const pending = await lockPendingItems(tx, subscription.customerId, {
    subscriptionId: subscription.id,
    includeUnattached: true,
  });
  lines.push(...pending.map(invoiceItemLine));
  const lineCatalog = await loadCatalog(
    tx,
    lines.map((line) => line.priceId),
  );
  const coupon = await couponInEffect(
    tx,
    {
      couponId: subscription.discountCouponId,
      start: subscription.discountStart,
      end: subscription.discountEnd,
    },
    period.start,
  );
  const invoice = await writeDraft(tx, {
    subscription,
    reason: options.reason,
    period,
    lines,
    pendingItemIds: pending.map((item) => item.id),
    couponId: coupon?.id ?? null,
    promotionCodeId: coupon ? subscription.discountPromotionCodeId : null,
    autoAdvance: options.autoAdvance,
    finalizesAt: options.finalizesAt,
    catalog: lineCatalog,
    ...(options.automaticTax !== undefined ? { automaticTax: options.automaticTax } : {}),
  });
  // A `once` coupon is spent by the first invoice that charges anything.
  if (invoice && coupon?.duration === 'once' && BigInt(invoice.subtotal) > 0n) {
    await writeSubscription(tx, subscription.id, {
      discountCouponId: null,
      discountPromotionCodeId: null,
      discountStart: null,
      discountEnd: null,
    });
  }
  return invoice;
}

// ---- The engine's steps -----------------------------------------------------------------

/**
 * Do whatever is due for one subscription at its clock's now — the
 * scheduler's unit of work. Idempotent: every step is decided from the row as
 * it stands under its lock, and a renewal invoice is unique per period, so a
 * second worker (or a retry) finds nothing left to do.
 *
 * @returns the invoice ids it drafted that must be finalized now.
 */
export async function runSubscriptionStep(subscriptionId: string): Promise<string[]> {
  const toFinalize: string[] = [];
  const toVoid: string[] = [];
  let loops = 0;
  // Several obligations can be due at once on an advanced clock (a reminder,
  // then the trial end): each pass does the earliest, until none is due.
  for (;;) {
    loops += 1;
    if (loops > 50) throw new Error(`subscription ${subscriptionId} did not settle`);
    const progressed = await committed(async (tx) => {
      const subscription = await lockSubscription(tx, subscriptionId);
      if (!subscription || subscription.nextActionAt === null) return false;
      const now = await engineNow(tx, subscription.testClockId);
      if (subscription.nextActionAt.getTime() > now.getTime()) return false;
      const step = await stepOnce(tx, subscription, now);
      if (step.finalize) toFinalize.push(step.finalize);
      if (step.void) toVoid.push(step.void);
      return true;
    });
    if (!progressed) break;
  }
  for (const id of toVoid) {
    const invoice = await finalizeStoredInvoice(id, { autoAdvance: false });
    if (invoice.status === 'open') {
      await committed(async (tx) => {
        const locked = await lockInvoice(tx, invoice.id);
        if (locked?.status === 'open')
          await voidInvoiceInTx(tx, locked, await engineNow(tx, locked.testClockId));
      });
    }
  }
  return toFinalize;
}

async function stepOnce(
  tx: Transaction,
  subscription: SubscriptionRow,
  now: Date,
): Promise<{ finalize?: string; void?: string }> {
  // Held for the previous provider's release: nothing is due (`nextActionAt`
  // is null for it), and a claim that reaches it anyway must not renew.
  if (subscription.providerHandoffPending) {
    await writeSubscription(tx, subscription.id, { nextActionAt: null });
    return {};
  }
  const write = writeSubscription;
  const reschedule = async (row: SubscriptionRow, extra: SubscriptionPatch = {}) => {
    const merged = { ...row, ...extra } as SubscriptionRow;
    const next = nextActionAt(merged);
    const written = await write(tx, row.id, { ...extra, nextActionAt: next });
    if (written === 'limit_exceeded') throw new Error('unreachable: no metadata in a reschedule');
    return written;
  };

  // 1. A scheduled cancellation.
  if (subscription.cancelAt && subscription.cancelAt.getTime() <= now.getTime()) {
    await cancelInTx(tx, subscription, subscription.cancelAt, {
      reason: 'cancellation_requested',
      comment: subscription.cancellationComment,
      prorate: false,
      invoiceNow: false,
    });
    return {};
  }
  // 2. Collection resumes.
  if (subscription.pauseResumesAt && subscription.pauseResumesAt.getTime() <= now.getTime()) {
    const resumed = await patchSubscription(tx, subscription, {
      pauseBehavior: null,
      pauseResumesAt: null,
    });
    await reschedule(resumed);
    return {};
  }
  // 3. An unpaid first invoice expires the subscription.
  if (subscription.status === 'incomplete') {
    const invoice = subscription.latestInvoiceId
      ? await lockInvoice(tx, subscription.latestInvoiceId)
      : null;
    if (invoice?.dueDate && invoice.dueDate.getTime() > now.getTime()) {
      await write(tx, subscription.id, { nextActionAt: invoice.dueDate });
      return {};
    }
    if (invoice && (invoice.status === 'open' || invoice.status === 'uncollectible')) {
      await voidInvoiceInTx(tx, invoice, now);
    }
    await transitionSubscription(tx, subscription, 'incomplete_expired', {
      endedAt: now,
      nextActionAt: null,
    });
    return {};
  }
  // 4. The trial reminder.
  if (
    subscription.status === 'trialing' &&
    subscription.trialEnd &&
    subscription.trialWillEndSentAt === null &&
    subscription.trialEnd.getTime() - TRIAL_WILL_END_LEAD_MS <= now.getTime() &&
    subscription.trialEnd.getTime() > now.getTime()
  ) {
    const row = await reschedule(subscription, { trialWillEndSentAt: now });
    await recordBillingEvent(
      tx,
      row.merchantId,
      'customer.subscription.trial_will_end',
      await renderSubscription(tx, row),
    );
    return {};
  }
  // 5. The trial ends.
  if (
    subscription.status === 'trialing' &&
    subscription.trialEnd &&
    subscription.trialEnd.getTime() <= now.getTime()
  ) {
    return endTrial(tx, subscription);
  }
  // 6. The upcoming-invoice notice.
  const end = subscription.currentPeriodEnd;
  if (
    !['paused', 'incomplete'].includes(subscription.status) &&
    !subscription.cancelAtPeriodEnd &&
    end.getTime() - UPCOMING_LEAD_MS <= now.getTime() &&
    !(
      subscription.upcomingNoticeSentAt &&
      subscription.upcomingNoticeSentAt >= subscription.currentPeriodStart
    )
  ) {
    const row = await reschedule(subscription, { upcomingNoticeSentAt: now });
    const preview = await upcomingInvoice(tx, row, {});
    if (preview) await recordBillingEvent(tx, row.merchantId, 'invoice.upcoming', preview);
    return {};
  }
  // 7. The period ends.
  if (end.getTime() <= now.getTime() && subscription.status !== 'paused') {
    if (subscription.cancelAtPeriodEnd) {
      await transitionSubscription(tx, subscription, 'canceled', {
        canceledAt: end,
        endedAt: end,
        cancellationReason: subscription.cancellationReason ?? 'cancellation_requested',
        nextActionAt: null,
      });
      return {};
    }
    return renew(tx, subscription, end);
  }
  await reschedule(subscription);
  return {};
}

/** The trial ended: no method and a behaviour that says so, or the first charged period. */
async function endTrial(
  tx: Transaction,
  subscription: SubscriptionRow,
): Promise<{ finalize?: string }> {
  const trialEnd = subscription.trialEnd as Date;
  const customer = await findCustomerById(tx, subscription.customerId);
  const hasMethod =
    subscription.defaultPaymentMethodId !== null || customer?.defaultPaymentMethodId != null;
  if (subscription.collectionMethod === 'charge_automatically' && !hasMethod) {
    if (subscription.trialEndBehavior === 'cancel') {
      await transitionSubscription(tx, subscription, 'canceled', {
        canceledAt: trialEnd,
        endedAt: trialEnd,
        cancellationReason: 'cancellation_requested',
        nextActionAt: null,
      });
      return {};
    }
    if (subscription.trialEndBehavior === 'pause') {
      await transitionSubscription(tx, subscription, 'paused', {
        nextActionAt: subscription.cancelAt ?? null,
      });
      return {};
    }
  }
  const active = await transitionSubscription(tx, subscription, 'active');
  return renew(tx, active, trialEnd);
}

/** Advance one period from `start` and draft its invoice. */
async function renew(
  tx: Transaction,
  subscription: SubscriptionRow,
  start: Date,
): Promise<{ finalize?: string; void?: string }> {
  const items = await listLiveItems(tx, subscription.id);
  const catalog = await loadCatalog(
    tx,
    items.map((item) => item.priceId),
  );
  const recurrence = await subscriptionRecurrence(catalog, items);
  const end = nextBoundaryAfter(subscription.billingCycleAnchor, recurrence, start);
  const wasTrial =
    subscription.trialEnd !== null && subscription.trialEnd.getTime() === start.getTime();
  const meteredFor = wasTrial ? null : { start: subscription.currentPeriodStart, end: start };
  const pause = subscription.pauseBehavior;
  const write = writeSubscription;
  const advanced = await write(tx, subscription.id, {
    currentPeriodStart: start,
    currentPeriodEnd: end,
  });
  if (advanced === 'limit_exceeded') throw new Error('unreachable');
  // Dunning gave up (`unpaid`) or collection is paused to drafts: the invoice
  // stays a draft. Paused to `void`: made, finalized untaxed and voided.
  const keepDraft = subscription.status === 'unpaid' || pause === 'keep_as_draft';
  const invoice = await draftPeriodInvoice(
    tx,
    advanced,
    catalog,
    items,
    { start, end },
    {
      reason: 'subscription_cycle',
      stub: null,
      meteredFor,
      autoAdvance: !keepDraft,
      finalizesAt: keepDraft ? null : new Date(start.getTime() + DRAFT_FINALIZATION_DELAY_MS),
      ...(pause === 'void' ? { automaticTax: false } : {}),
    },
  );
  const before = await renderSubscription(tx, subscription);
  const row = await write(tx, subscription.id, {
    ...(invoice ? { latestInvoiceId: invoice.id } : {}),
    nextActionAt: nextActionAt({
      ...advanced,
      upcomingNoticeSentAt: advanced.upcomingNoticeSentAt,
    }),
  });
  if (row === 'limit_exceeded') throw new Error('unreachable');
  const after = await renderSubscription(tx, row);
  const previous = previousAttributes(before, after);
  if (previous)
    await recordBillingEvent(tx, row.merchantId, 'customer.subscription.updated', after, previous);
  if (!invoice) return {};
  if (pause === 'void') return { void: invoice.id };
  return {};
}

// ---- Reads for other modules -----------------------------------------------------------

/** The merchant of a subscription (the scheduler holds only ids). */
export async function merchantOf(subscription: SubscriptionRow): Promise<MerchantRow> {
  const merchant = await findMerchantById(getDb(), subscription.merchantId);
  if (!merchant) throw new Error('subscription merchant vanished');
  return merchant;
}

export { listOpenSubscriptionInvoices };
