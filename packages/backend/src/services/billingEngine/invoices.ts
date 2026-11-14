/**
 * Invoices and invoice items through the API (ADR 0018 §2): manual invoices,
 * drafts edited line by line, finalize / pay / send / void /
 * mark_uncollectible, and the customer balance ledger.
 */
import type { CollectionMethod, CurrencyCode, DiscountParams } from '@peable.to/shared-types';
import { findCouponById } from '../../db/catalog/couponRepository';
import { findPriceForMerchant, findPricesByRowIds } from '../../db/catalog/priceRepository';
import { toCustomerDTO } from '../../lib/serialize';
import { recordCustomerObjectEvent } from '../intentTransition';
import {
  findCustomerById,
  findLiveCustomerForMerchant,
} from '../../db/customers/customerRepository';
import { findPaymentMethodForMerchant } from '../../db/customers/paymentMethodRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { MetadataPatch } from '../../db/metadata';
import type { PriceShape } from '../../db/catalog/priceRepository';
import {
  claimCustomerCurrency,
  recordBalanceTransaction,
  type BalanceTransactionRow,
} from '../../db/billingEngine/balanceRepository';
import {
  attachItemsToInvoice,
  deleteInvoiceItem,
  findInvoiceForMerchant,
  findInvoiceItemForMerchant,
  insertInvoice,
  insertInvoiceItem,
  insertLines,
  listLines,
  lockInvoice,
  lockInvoiceItem,
  lockPendingItems,
  updateInvoiceItem as writeInvoiceItem,
  type InvoiceItemRow,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import { ensureBillingSettings } from '../../db/billingEngine/settingsRepository';
import { findSubscriptionForMerchant } from '../../db/billingEngine/subscriptionRepository';
import { invoiceLineItems } from '../../db/schema';
import { getDb, type Transaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { renderInvoice, renderInvoiceItems } from '../../lib/serializeBilling';
import { amountForQuantity } from '../catalog/pricing';
import { pricingPriceOf, pricingPriceOfShape } from '../catalog/pricingRows';
import { resolvePriceData } from '../catalog/catalogService';
import { kickWebhookOutbox } from '../webhookOutbox';
import { eq } from 'drizzle-orm';
import { attemptInvoicePayment, railOf } from './collect';
import { applyDiscountFor, discountRequest } from './discounts';
import { discountsFor, draftLineOf, invoiceItemLine, loadCatalog, toInsertLine } from './drafting';
import { BillingEngineError, invalid, missing } from './errors';
import {
  DRAFT_FINALIZATION_DELAY_MS,
  deleteDraftInTx,
  draftTotals,
  finalizeStoredInvoice,
  markInvoicePaid,
  markUncollectibleInTx,
  voidInvoiceInTx,
} from './invoiceEngine';
import { oweInvoiceEmailNow } from './notices';
import { engineNow } from './runtime';
import { MetadataLimitError, patchInvoice, recordBillingEvent } from './transitions';

async function committed<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    const result = await getDb().transaction(work);
    kickWebhookOutbox();
    return result;
  } catch (error) {
    if (error instanceof MetadataLimitError) throw invalid('metadata limit exceeded', 'metadata');
    throw error;
  }
}

async function invoiceFor(merchant: MerchantRow, publicId: string): Promise<InvoiceRow> {
  const invoice = await findInvoiceForMerchant(getDb(), publicId, merchant.id);
  if (!invoice) throw missing('invoice');
  return invoice;
}

function assertDraft(invoice: InvoiceRow): void {
  if (invoice.status !== 'draft') {
    throw new BillingEngineError(
      'invoice_not_editable',
      `this invoice is ${invoice.status}; only a draft can be edited`,
    );
  }
}

/** Recompute a draft's totals from its lines (no tax yet) after its lines moved. */
export async function recomputeDraft(tx: Transaction, invoice: InvoiceRow): Promise<InvoiceRow> {
  const lines = (await listLines(tx, invoice.id)).map(draftLineOf);
  const catalog = await loadCatalog(
    tx,
    lines.map((line) => line.priceId),
  );
  const coupon = invoice.discountCouponId
    ? await findCouponById(tx, invoice.discountCouponId)
    : null;
  const totals = draftTotals(
    lines,
    discountsFor(lines, catalog, coupon, invoice.currency),
    invoice.automaticTax,
  );
  return patchInvoice(tx, invoice, {
    subtotal: totals.subtotal.toString(),
    totalDiscount: totals.totalDiscount.toString(),
    tax: totals.tax === null ? null : totals.tax.toString(),
    total: totals.total.toString(),
    totalExcludingTax: totals.totalExcludingTax.toString(),
    amountDue: (totals.total > 0n ? totals.total : 0n).toString(),
    // Any earlier tax answer was for other lines.
    automaticTaxStatus: null,
    lastFinalizationError: null,
  });
}

// ---- Create / update ---------------------------------------------------------------

export interface CreateInvoiceInput {
  readonly customer: string;
  readonly currency?: CurrencyCode;
  readonly subscription?: string;
  readonly autoAdvance?: boolean;
  readonly collectionMethod?: CollectionMethod;
  readonly daysUntilDue?: number;
  readonly dueDate?: number;
  readonly description?: string;
  readonly defaultPaymentMethod?: string;
  readonly discounts?: readonly DiscountParams[];
  readonly automaticTax?: boolean;
  readonly pendingInvoiceItemsBehavior?: 'include' | 'exclude';
  readonly metadata: Record<string, string>;
}

export async function createInvoice(
  merchant: MerchantRow,
  input: CreateInvoiceInput,
): Promise<InvoiceRow> {
  const db = getDb();
  const customer = await findLiveCustomerForMerchant(db, input.customer, merchant.id);
  if (!customer) throw missing('customer', 'customer');
  const subscription = input.subscription
    ? await findSubscriptionForMerchant(db, input.subscription, merchant.id)
    : null;
  if (input.subscription && (!subscription || subscription.customerId !== customer.id)) {
    throw new BillingEngineError(
      'resource_missing',
      `no subscription '${input.subscription}' of this customer`,
      'subscription',
    );
  }
  const currency = input.currency ?? subscription?.currency ?? customer.currency;
  if (!currency)
    throw new BillingEngineError(
      'parameter_missing',
      'this customer has no billing currency yet; pass currency',
      'currency',
    );
  const rail = railOf(currency);
  const collectionMethod: CollectionMethod =
    input.collectionMethod ?? (rail === 'faircoin' ? 'send_invoice' : 'charge_automatically');
  if (rail === 'faircoin' && collectionMethod === 'charge_automatically') {
    throw new BillingEngineError(
      'faircoin_cannot_debit',
      'a FairCoin invoice is sent for the payer to pay',
      'collection_method',
    );
  }
  if (
    collectionMethod === 'charge_automatically' &&
    (input.daysUntilDue !== undefined || input.dueDate !== undefined)
  ) {
    throw invalid(
      'days_until_due and due_date are for send_invoice',
      input.dueDate !== undefined ? 'due_date' : 'days_until_due',
    );
  }
  if (input.daysUntilDue !== undefined && input.dueDate !== undefined) {
    throw invalid('pass days_until_due or due_date, not both', 'due_date');
  }
  const method = input.defaultPaymentMethod
    ? await findPaymentMethodForMerchant(db, input.defaultPaymentMethod, merchant.id)
    : null;
  if (input.defaultPaymentMethod && (!method || method.customerId !== customer.id)) {
    throw new BillingEngineError(
      'resource_missing',
      'no such payment method attached to this customer',
      'default_payment_method',
    );
  }
  if (rail === 'faircoin' && method) {
    throw new BillingEngineError(
      'faircoin_cannot_debit',
      'a FairCoin payer has no saved payment method',
      'default_payment_method',
    );
  }
  const settings = await ensureBillingSettings(db, merchant.id);
  const request = discountRequest({ discounts: input.discounts });
  const now = await engineNow(db, customer.testClockId);
  return committed(async (tx) => {
    if (!(await claimCustomerCurrency(tx, customer.id, currency))) {
      throw new BillingEngineError(
        'customer_currency_mismatch',
        `this customer bills in ${customer.currency}`,
        'currency',
      );
    }
    const discount = request
      ? await applyDiscountFor(tx, {
          merchantId: merchant.id,
          customerId: customer.id,
          currency,
          now,
          orderTotal: 0n,
          request,
        })
      : null;
    const autoAdvance = input.autoAdvance ?? false;
    const invoice = await insertInvoice(tx, {
      publicId: newId('in'),
      merchantId: merchant.id,
      customerId: customer.id,
      subscriptionId: subscription?.id ?? null,
      testClockId: customer.testClockId,
      billingReason: 'manual',
      collectionMethod,
      currency,
      description: input.description ?? null,
      autoAdvance,
      automaticallyFinalizesAt: autoAdvance
        ? new Date(now.getTime() + DRAFT_FINALIZATION_DELAY_MS)
        : null,
      daysUntilDue:
        collectionMethod === 'send_invoice' && input.dueDate === undefined
          ? (input.daysUntilDue ?? settings.defaultDaysUntilDue)
          : null,
      dueDate: input.dueDate !== undefined ? new Date(input.dueDate * 1000) : null,
      periodStart: now,
      periodEnd: now,
      defaultPaymentMethodId: method?.id ?? null,
      discountCouponId: discount?.coupon.id ?? null,
      discountPromotionCodeId: discount?.promotionCode?.id ?? null,
      automaticTax: input.automaticTax ?? false,
      metadata: input.metadata,
      nextActionAt: autoAdvance ? new Date(now.getTime() + DRAFT_FINALIZATION_DELAY_MS) : null,
    });
    if (!invoice) throw new Error('a manual invoice conflicted');
    let row = invoice;
    if (input.pendingInvoiceItemsBehavior === 'include') {
      const pending = await lockPendingItems(tx, customer.id, {
        subscriptionId: subscription?.id ?? null,
        includeUnattached: true,
      });
      const usable = pending.filter((item) => item.currency === currency);
      await insertLines(
        tx,
        usable.map((item) => toInsertLine(invoiceItemLine(item), invoice.id, merchant.id)),
      );
      await attachItemsToInvoice(
        tx,
        usable.map((item) => item.id),
        invoice.id,
      );
      row = await recomputeDraftQuietly(tx, invoice);
    }
    await recordBillingEvent(tx, merchant.id, 'invoice.created', await renderInvoice(tx, row));
    return row;
  });
}

async function recomputeDraftQuietly(tx: Transaction, invoice: InvoiceRow): Promise<InvoiceRow> {
  const lines = (await listLines(tx, invoice.id)).map(draftLineOf);
  const catalog = await loadCatalog(
    tx,
    lines.map((line) => line.priceId),
  );
  const coupon = invoice.discountCouponId
    ? await findCouponById(tx, invoice.discountCouponId)
    : null;
  const totals = draftTotals(
    lines,
    discountsFor(lines, catalog, coupon, invoice.currency),
    invoice.automaticTax,
  );
  return patchInvoice(
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
}

export interface UpdateInvoiceInput {
  readonly autoAdvance?: boolean;
  readonly collectionMethod?: CollectionMethod;
  readonly daysUntilDue?: number;
  readonly dueDate?: number;
  readonly description?: string | null;
  readonly defaultPaymentMethod?: string | null;
  readonly discounts?: readonly DiscountParams[] | null;
  readonly automaticTax?: boolean;
  readonly metadata?: MetadataPatch;
}

/** `POST /v1/invoices/:id`: a draft's fields; `metadata` (and `auto_advance` of an open one) on any. */
export async function updateInvoice(
  merchant: MerchantRow,
  publicId: string,
  input: UpdateInvoiceInput,
): Promise<InvoiceRow> {
  const found = await invoiceFor(merchant, publicId);
  const db = getDb();
  const method =
    input.defaultPaymentMethod === undefined || input.defaultPaymentMethod === null
      ? null
      : await findPaymentMethodForMerchant(db, input.defaultPaymentMethod, merchant.id);
  if (input.defaultPaymentMethod && (!method || method.customerId !== found.customerId)) {
    throw new BillingEngineError(
      'resource_missing',
      'no such payment method attached to this customer',
      'default_payment_method',
    );
  }
  const request =
    input.discounts === null ? null : discountRequest({ discounts: input.discounts ?? undefined });
  return committed(async (tx) => {
    const invoice = await lockInvoice(tx, found.id);
    if (!invoice) throw missing('invoice');
    const touchesDraft = Object.entries(input).some(
      ([key, value]) => value !== undefined && key !== 'metadata' && key !== 'autoAdvance',
    );
    if (touchesDraft) assertDraft(invoice);
    if (input.autoAdvance !== undefined && !['draft', 'open'].includes(invoice.status)) {
      throw invalid('auto_advance changes only on a draft or open invoice', 'auto_advance');
    }
    const collection = input.collectionMethod ?? invoice.collectionMethod;
    if (railOf(invoice.currency) === 'faircoin' && collection === 'charge_automatically') {
      throw new BillingEngineError(
        'faircoin_cannot_debit',
        'a FairCoin invoice is sent for the payer to pay',
        'collection_method',
      );
    }
    const now = await engineNow(tx, invoice.testClockId);
    let discount: { couponId: string | null; promotionCodeId: string | null } | undefined;
    if (input.discounts === null) discount = { couponId: null, promotionCodeId: null };
    else if (request) {
      const applied = await applyDiscountFor(tx, {
        merchantId: merchant.id,
        customerId: invoice.customerId,
        currency: invoice.currency,
        now,
        orderTotal: BigInt(invoice.subtotal),
        request,
      });
      discount = {
        couponId: applied.coupon.id,
        promotionCodeId: applied.promotionCode?.id ?? null,
      };
    }
    let row = await patchInvoice(tx, invoice, {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.defaultPaymentMethod !== undefined
        ? { defaultPaymentMethodId: method?.id ?? null }
        : {}),
      ...(input.collectionMethod !== undefined ? { collectionMethod: input.collectionMethod } : {}),
      ...(input.daysUntilDue !== undefined
        ? { daysUntilDue: input.daysUntilDue, dueDate: null }
        : {}),
      ...(input.dueDate !== undefined
        ? { dueDate: new Date(input.dueDate * 1000), daysUntilDue: null }
        : {}),
      ...(input.automaticTax !== undefined
        ? { automaticTax: input.automaticTax, automaticTaxStatus: null }
        : {}),
      ...(discount
        ? { discountCouponId: discount.couponId, discountPromotionCodeId: discount.promotionCodeId }
        : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.autoAdvance !== undefined
        ? {
            autoAdvance: input.autoAdvance,
            ...(invoice.status === 'draft'
              ? {
                  automaticallyFinalizesAt: input.autoAdvance
                    ? new Date(now.getTime() + DRAFT_FINALIZATION_DELAY_MS)
                    : null,
                  nextActionAt: input.autoAdvance
                    ? new Date(now.getTime() + DRAFT_FINALIZATION_DELAY_MS)
                    : null,
                }
              : {}),
          }
        : {}),
    });
    if (discount || input.automaticTax !== undefined) row = await recomputeDraft(tx, row);
    return row;
  });
}

export async function finalizeInvoice(
  merchant: MerchantRow,
  publicId: string,
  options: { autoAdvance?: boolean; expectedFinalizationRevision?: string },
): Promise<InvoiceRow> {
  const invoice = await invoiceFor(merchant, publicId);
  return finalizeStoredInvoice(invoice.id, { ...options, manual: true });
}

/**
 * `POST /v1/invoices/:id/pay`. A card invoice is charged off-session against
 * the saved method (402 on a decline, with the invoice); `paid_out_of_band`
 * records a payment made outside Orbit. A FairCoin invoice cannot be paid by
 * the merchant — its payer pays it on the hosted invoice page.
 */
export async function payInvoice(
  merchant: MerchantRow,
  publicId: string,
  options: { paymentMethod?: string; paidOutOfBand?: boolean; offSession?: boolean },
): Promise<InvoiceRow> {
  let invoice = await invoiceFor(merchant, publicId);
  if (invoice.status === 'draft')
    invoice = await finalizeStoredInvoice(invoice.id, { manual: true });
  if (invoice.status === 'paid') {
    throw new BillingEngineError('invoice_unexpected_state', 'this invoice is already paid');
  }
  if (invoice.status === 'void') {
    throw new BillingEngineError('invoice_unexpected_state', 'this invoice is void');
  }
  if (options.paidOutOfBand) {
    return committed(async (tx) => {
      const locked = await lockInvoice(tx, invoice.id);
      if (!locked || (locked.status !== 'open' && locked.status !== 'uncollectible')) {
        throw new BillingEngineError(
          'invoice_unexpected_state',
          'this invoice can no longer be paid',
        );
      }
      return markInvoicePaid(tx, locked, await engineNow(tx, locked.testClockId), {
        amountPaid: 0n,
        outOfBand: true,
      });
    });
  }
  const outcome = await attemptInvoicePayment(invoice.id, {
    ...(options.paymentMethod ? { paymentMethod: options.paymentMethod } : {}),
    offSession: options.offSession ?? true,
  });
  if (outcome.kind === 'no_payment_method') {
    throw new BillingEngineError(
      'payment_method_missing',
      'this invoice has no payment method to charge; pass payment_method',
      'payment_method',
    );
  }
  if (outcome.kind === 'deferred') {
    throw new BillingEngineError(
      'rail_unavailable',
      'the card rail could not be reached; try again',
      undefined,
      503,
    );
  }
  const after = outcome.invoice;
  if (after.status !== 'paid' && outcome.intent.lastPaymentError) {
    throw new BillingEngineError(
      'card_declined',
      outcome.intent.lastPaymentError.message,
      undefined,
      402,
      'card_error',
      {
        invoice: await renderInvoice(getDb(), after),
        ...(outcome.intent.lastPaymentError.decline_code
          ? { decline_code: outcome.intent.lastPaymentError.decline_code }
          : {}),
      },
    );
  }
  if (after.status !== 'paid' && outcome.intent.status === 'requires_action') {
    throw new BillingEngineError(
      'invoice_payment_intent_requires_action',
      'the payer must authenticate this payment; send them the hosted invoice page',
      undefined,
      402,
      'card_error',
      { invoice: await renderInvoice(getDb(), after) },
    );
  }
  return after;
}

export async function sendInvoice(merchant: MerchantRow, publicId: string): Promise<InvoiceRow> {
  const invoice = await invoiceFor(merchant, publicId);
  if (invoice.status !== 'open') {
    throw new BillingEngineError('invoice_unexpected_state', 'only an open invoice can be sent');
  }
  return committed(async (tx) => {
    const locked = await lockInvoice(tx, invoice.id);
    if (locked?.status !== 'open') {
      throw new BillingEngineError('invoice_unexpected_state', 'only an open invoice can be sent');
    }
    await oweInvoiceEmailNow(tx, locked);
    return locked;
  });
}

export async function voidInvoice(merchant: MerchantRow, publicId: string): Promise<InvoiceRow> {
  const found = await invoiceFor(merchant, publicId);
  return committed(async (tx) => {
    const invoice = await lockInvoice(tx, found.id);
    if (!invoice) throw missing('invoice');
    return voidInvoiceInTx(tx, invoice, await engineNow(tx, invoice.testClockId));
  });
}

export async function markInvoiceUncollectible(
  merchant: MerchantRow,
  publicId: string,
): Promise<InvoiceRow> {
  const found = await invoiceFor(merchant, publicId);
  return committed(async (tx) => {
    const invoice = await lockInvoice(tx, found.id);
    if (!invoice) throw missing('invoice');
    return markUncollectibleInTx(tx, invoice, await engineNow(tx, invoice.testClockId));
  });
}

export async function deleteDraftInvoice(
  merchant: MerchantRow,
  publicId: string,
): Promise<InvoiceRow> {
  const found = await invoiceFor(merchant, publicId);
  await committed(async (tx) => {
    const invoice = await lockInvoice(tx, found.id);
    if (!invoice) throw missing('invoice');
    await deleteDraftInTx(tx, invoice);
  });
  return found;
}

// ---- Invoice items -------------------------------------------------------------------

export interface CreateInvoiceItemInput {
  readonly customer: string;
  readonly invoice?: string;
  readonly subscription?: string;
  readonly price?: string;
  readonly priceData?: { product: string; shape: PriceShape };
  readonly quantity?: number;
  readonly amount?: string;
  readonly currency?: CurrencyCode;
  readonly description?: string;
  readonly discountable?: boolean;
  readonly period?: { start: number; end: number };
  readonly metadata: Record<string, string>;
}

/**
 * `POST /v1/invoiceitems`: a price × quantity, or a fixed amount, pending on
 * the customer (pulled into their next invoice) or on a draft (`invoice`).
 * Never negative: a credit is a credit note or a balance transaction.
 */
export async function createInvoiceItem(
  merchant: MerchantRow,
  input: CreateInvoiceItemInput,
): Promise<InvoiceItemRow> {
  const db = getDb();
  const customer = await findLiveCustomerForMerchant(db, input.customer, merchant.id);
  if (!customer) throw missing('customer', 'customer');
  const named = [input.price, input.priceData, input.amount].filter((v) => v !== undefined).length;
  if (named !== 1) throw invalid('pass exactly one of price, price_data and amount', 'price');
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 0)
    throw invalid('quantity is a non-negative integer', 'quantity');
  let priceId: string | null = null;
  let amount: bigint;
  let currency: CurrencyCode;
  let unitAmount: string | null = null;
  let description = input.description ?? null;
  if (input.price !== undefined) {
    const price = await findPriceForMerchant(db, input.price, merchant.id);
    if (!price)
      throw new BillingEngineError('resource_missing', `no such price: '${input.price}'`, 'price');
    if (!price.active) throw invalid('this price is archived', 'price');
    if (price.recurringUsageType === 'metered')
      throw invalid('a metered price is billed by its meter, not as an item', 'price');
    priceId = price.id;
    currency = price.currency;
    amount = amountForQuantity(pricingPriceOf(price), BigInt(quantity));
    unitAmount = price.billingScheme === 'per_unit' ? price.unitAmount : null;
  } else if (input.priceData !== undefined) {
    const resolved = await resolvePriceData(db, merchant.id, input.priceData);
    currency = resolved.shape.currency;
    amount = amountForQuantity(pricingPriceOfShape(resolved.shape), BigInt(quantity));
    unitAmount = resolved.shape.billingScheme === 'per_unit' ? resolved.shape.unitAmount : null;
    description ??= resolved.product.name;
  } else {
    if (!input.currency)
      throw new BillingEngineError('parameter_missing', 'an amount needs its currency', 'currency');
    currency = input.currency;
    amount = BigInt(input.amount as string);
    if (input.quantity !== undefined) throw invalid('a fixed amount has no quantity', 'quantity');
  }
  if (amount < 0n) throw invalid('an invoice item is never negative', 'amount');
  const subscription = input.subscription
    ? await findSubscriptionForMerchant(db, input.subscription, merchant.id)
    : null;
  if (input.subscription && (!subscription || subscription.customerId !== customer.id)) {
    throw new BillingEngineError(
      'resource_missing',
      'no such subscription of this customer',
      'subscription',
    );
  }
  const draft = input.invoice ? await findInvoiceForMerchant(db, input.invoice, merchant.id) : null;
  if (input.invoice && (!draft || draft.customerId !== customer.id)) {
    throw new BillingEngineError('resource_missing', 'no such invoice of this customer', 'invoice');
  }
  const now = await engineNow(db, customer.testClockId);
  return committed(async (tx) => {
    if (!(await claimCustomerCurrency(tx, customer.id, currency))) {
      throw new BillingEngineError(
        'customer_currency_mismatch',
        `this customer bills in ${customer.currency}`,
        'currency',
      );
    }
    const invoice = draft ? await lockInvoice(tx, draft.id) : null;
    if (invoice) {
      assertDraft(invoice);
      if (invoice.currency !== currency)
        throw invalid('the item and the invoice are in different currencies', 'currency');
    }
    const item = await insertInvoiceItem(tx, {
      publicId: newId('ii'),
      merchantId: merchant.id,
      customerId: customer.id,
      invoiceId: invoice?.id ?? null,
      subscriptionId: subscription?.id ?? null,
      subscriptionItemId: null,
      priceId,
      quantity,
      unitAmount,
      amount: amount.toString(),
      currency,
      description,
      discountable: input.discountable ?? true,
      periodStart: input.period ? new Date(input.period.start * 1000) : now,
      periodEnd: input.period ? new Date(input.period.end * 1000) : now,
      proration: false,
      creditsLineId: null,
      metadata: input.metadata,
    });
    if (invoice) {
      await insertLines(tx, [toInsertLine(invoiceItemLine(item), invoice.id, merchant.id)]);
      await recomputeDraft(tx, invoice);
    }
    const [dto] = await renderInvoiceItems(tx, [item]);
    if (dto) await recordBillingEvent(tx, merchant.id, 'invoiceitem.created', dto);
    return item;
  });
}

async function editableItem(tx: Transaction, merchant: MerchantRow, publicId: string) {
  const found = await findInvoiceItemForMerchant(tx, publicId, merchant.id);
  const item = found ? await lockInvoiceItem(tx, found.id) : null;
  if (!item) throw missing('invoice item');
  const invoice = item.invoiceId ? await lockInvoice(tx, item.invoiceId) : null;
  if (invoice) assertDraft(invoice);
  return { item, invoice };
}

export async function updateInvoiceItem(
  merchant: MerchantRow,
  publicId: string,
  patch: {
    description?: string | null;
    quantity?: number;
    discountable?: boolean;
    metadata?: MetadataPatch;
  },
): Promise<InvoiceItemRow> {
  return committed(async (tx) => {
    const { item, invoice } = await editableItem(tx, merchant, publicId);
    let amount: string | undefined;
    if (patch.quantity !== undefined) {
      if (item.proration) throw invalid('a proration has no quantity to change', 'quantity');
      if (item.priceId) {
        const [price] = await findPricesByRowIds(tx, [item.priceId]);
        if (!price) throw new Error('item price vanished');
        amount = amountForQuantity(pricingPriceOf(price), BigInt(patch.quantity)).toString();
      } else if (item.unitAmount !== null) {
        amount = (BigInt(item.unitAmount) * BigInt(patch.quantity)).toString();
      } else throw invalid('a fixed amount has no quantity', 'quantity');
    }
    const written = await writeInvoiceItem(tx, item.id, {
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(patch.discountable !== undefined ? { discountable: patch.discountable } : {}),
      ...(patch.metadata ? { metadata: patch.metadata } : {}),
    });
    if (written === 'limit_exceeded') throw invalid('metadata limit exceeded', 'metadata');
    if (invoice) {
      await tx
        .update(invoiceLineItems)
        .set({
          quantity: written.quantity,
          amount: written.amount,
          description: written.description,
          discountable: written.discountable,
        })
        .where(eq(invoiceLineItems.invoiceItemId, written.id));
      await recomputeDraft(tx, invoice);
    }
    return written;
  });
}

export async function deletePendingInvoiceItem(
  merchant: MerchantRow,
  publicId: string,
): Promise<InvoiceItemRow> {
  return committed(async (tx) => {
    const { item, invoice } = await editableItem(tx, merchant, publicId);
    const [dto] = await renderInvoiceItems(tx, [item]);
    await deleteInvoiceItem(tx, item.id);
    if (invoice) await recomputeDraft(tx, invoice);
    if (dto) await recordBillingEvent(tx, merchant.id, 'invoiceitem.deleted', dto);
    return item;
  });
}

// ---- Customer balance --------------------------------------------------------------

/**
 * `POST /v1/customers/:id/balance_transactions` — a manual adjustment: a
 * negative amount credits the customer (applied to their next invoice), a
 * positive one adds to what they owe. `customer.updated` records the new
 * balance.
 */
export async function adjustCustomerBalance(
  merchant: MerchantRow,
  customerPublicId: string,
  input: {
    amount: bigint;
    currency: CurrencyCode;
    description?: string;
    metadata: Record<string, string>;
  },
): Promise<BalanceTransactionRow> {
  const db = getDb();
  const customer = await findLiveCustomerForMerchant(db, customerPublicId, merchant.id);
  if (!customer) throw missing('customer');
  if (input.amount === 0n) throw invalid('an adjustment moves the balance', 'amount');
  return committed(async (tx) => {
    const written = await recordBalanceTransaction(tx, {
      publicId: newId('cbtxn'),
      merchantId: merchant.id,
      customerId: customer.id,
      type: 'adjustment',
      amount: input.amount,
      currency: input.currency,
      description: input.description ?? null,
      metadata: input.metadata,
    });
    if (written === 'currency_mismatch') {
      throw new BillingEngineError(
        'customer_currency_mismatch',
        `this customer's balance is in ${customer.currency}`,
        'currency',
      );
    }
    if (written === 'customer_missing' || written === null) throw missing('customer');
    const after = await findCustomerById(tx, customer.id);
    if (after) {
      await recordCustomerObjectEvent(tx, merchant.id, 'customer.updated', toCustomerDTO(after));
    }
    return written;
  });
}
