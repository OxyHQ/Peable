/**
 * Quotes (`qt_…`, ADR 0018 §5) — Stripe's Quotes on the native engine.
 *
 * ## Invariants every function here keeps
 *
 * - Every status change is `transitionQuote` (CAS on the status read + the
 *   `quote.*` event, one transaction). Only a `draft` is edited.
 * - Money is the engine's: each line is the catalog's pricing
 *   (`itemPeriodAmount` over `pricing.ts`), the discount `invoiceMath.ts`'s
 *   per-line split, and the tax Peable Tax's, computed by `prepareInvoice` —
 *   the same call an invoice finalizes with. Nothing here re-derives an
 *   amount.
 * - Tax fails CLOSED at finalize: a quote whose tax cannot be computed stays a
 *   draft with `automatic_tax.status` saying why; it is never opened at zero.
 * - Accepting makes native billing objects in the SAME transaction as the
 *   move to `accepted`: a one-time quote's invoice (written, finalized and
 *   linked by this module), or — through `createSubscription`'s
 *   `inTransaction` hook — a subscription with its first invoice. A second
 *   accept waits on the quote's row lock and finds it accepted; whatever it
 *   had written rolls back with it.
 * - FairCoin is never debited: a `FAIR` quote is `send_invoice` (CHECKed),
 *   and its invoice is paid by the payer on the hosted page, where every fiat
 *   invoice offers FairCoin too.
 * - Time is the customer's clock (`engineNow`), never `new Date()`.
 */
import { createHash } from 'node:crypto';
import type { CollectionMethod, CurrencyCode, DiscountParams } from '@peable.to/shared-types';
import { QUOTE_LIMITS } from '@peable.to/shared-types';
import { findCouponById, type CouponRow } from '../../db/catalog/couponRepository';
import {
  findPricesByPublicIds,
  findPricesByRowIds,
  type PriceRow,
} from '../../db/catalog/priceRepository';
import { findPromotionCodeById } from '../../db/catalog/promotionCodeRepository';
import {
  findCustomerById,
  findLiveCustomerForMerchant,
  type CustomerRow,
} from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { MetadataPatch } from '../../db/metadata';
import { claimCustomerCurrency } from '../../db/billingEngine/balanceRepository';
import { orderedId } from '../../db/billingEngine/columns';
import {
  insertInvoice,
  insertInvoiceItem,
  insertLines,
  type InvoiceRow,
} from '../../db/billingEngine/invoiceRepository';
import {
  claimQuoteNumber,
  findExpiredOpenQuotes,
  findQuoteById,
  findQuoteForMerchant,
  formatQuoteNumber,
  insertQuote,
  type InsertQuoteLineParams,
  listQuoteLines,
  lockQuote,
  type QuoteLineRow,
  type QuotePatch,
  type QuoteRow,
  replaceQuoteLines,
  setQuoteLineAmounts,
} from '../../db/billingEngine/quoteRepository';
import { ensureBillingSettings } from '../../db/billingEngine/settingsRepository';
import { getDb, type Transaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { renderInvoice, toQuoteDTO } from '../../lib/serializeBilling';
import { kickWebhookOutbox } from '../webhookOutbox';
import { attemptInvoicePayment, payerIntentForInvoice, railOf } from './collect';
import { type AppliedDiscount, applyDiscountFor, discountRequest } from './discounts';
import {
  type DraftLine,
  discountsFor,
  itemPeriodAmount,
  loadCatalog,
  priceOf,
  productOfPrice,
  toInsertLine,
} from './drafting';
import { BillingEngineError, invalid, missing } from './errors';
import { commitFinalization, draftTotals, prepareInvoice } from './invoiceEngine';
import { InvoiceTaxError } from './invoiceTax';
import { addDays } from './periods';
import { engineNow } from './runtime';
import { createSubscription } from './subscriptions';
import { MetadataLimitError, patchQuote, recordBillingEvent, transitionQuote } from './transitions';

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

async function quoteFor(merchant: MerchantRow, publicId: string): Promise<QuoteRow> {
  const quote = await findQuoteForMerchant(getDb(), publicId, merchant.id);
  if (!quote) throw missing('quote');
  return quote;
}

function unexpected(quote: QuoteRow, doing: string): BillingEngineError {
  return new BillingEngineError(
    'quote_unexpected_state',
    `this quote is ${quote.status}; ${doing}`,
  );
}

// ---- Lines and their prices ------------------------------------------------------------

interface QuotedLine {
  readonly price: PriceRow;
  readonly quantity: number;
}

/**
 * The lines a request names, checked as one quote: active, licensed prices,
 * each once, in one currency, every recurring one on one interval — what
 * accepting it as one subscription (plus one-time items) needs.
 */
async function resolveLines(
  merchant: MerchantRow,
  items: readonly { readonly price: string; readonly quantity?: number | undefined }[],
): Promise<QuotedLine[]> {
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
        `line_items[${index}][price]`,
      );
    }
    return { price, quantity: item.quantity ?? 1 };
  });
}

function assertCoherent(lines: readonly QuotedLine[]): {
  currency: CurrencyCode;
  recurring: boolean;
} {
  const [first] = lines;
  if (!first) throw invalid('a quote needs at least one line', 'line_items');
  if (lines.length > QUOTE_LIMITS.lineItemsMax) {
    throw invalid(`at most ${QUOTE_LIMITS.lineItemsMax} lines`, 'line_items');
  }
  const seen = new Set<string>();
  let recurrence: string | null = null;
  for (const [index, { price }] of lines.entries()) {
    const param = `line_items[${index}][price]`;
    if (!price.active) throw invalid('this price is archived and cannot be quoted', param);
    if (price.recurringUsageType === 'metered') {
      throw invalid('a metered price is billed by its meter; it cannot be quoted', param);
    }
    if (seen.has(price.id)) throw invalid('each price appears once in a quote', param);
    seen.add(price.id);
    if (price.currency !== first.price.currency) {
      throw invalid('every line of a quote is in one currency', param);
    }
    if (price.type === 'recurring') {
      const mine = `${price.recurringInterval}:${price.recurringIntervalCount}`;
      if (recurrence !== null && recurrence !== mine) {
        throw invalid('every recurring line of a quote bills on the same interval', param);
      }
      recurrence = mine;
    }
  }
  return { currency: first.price.currency, recurring: recurrence !== null };
}

/** Lines as the engine drafts them: price × quantity for one period, in the quote's order. */
async function draftOf(
  lines: readonly QuotedLine[],
  ids: readonly { id: string; publicId: string }[] = [],
) {
  const catalog = await loadCatalog(
    getDb(),
    lines.map((line) => line.price.id),
  );
  const draft: DraftLine[] = lines.map((line, i) => ({
    id: ids[i]?.id ?? orderedId(),
    publicId: ids[i]?.publicId ?? newId('li'),
    type: 'invoiceitem',
    subscriptionId: null,
    subscriptionItemId: null,
    invoiceItemId: null,
    priceId: line.price.id,
    quantity: line.quantity,
    amount: itemPeriodAmount(line.price, line.quantity),
    currency: line.price.currency,
    description: productOfPrice(catalog, line.price.id)?.name ?? line.price.publicId,
    discountable: true,
    periodStart: new Date(0),
    periodEnd: new Date(0),
    proration: false,
    creditsLineId: null,
    metered: false,
    metadata: {},
  }));
  return { draft, catalog };
}

/** A draft's lines and totals: the catalog's prices, the quote's discount, no tax yet. */
async function priceDraft(
  lines: readonly QuotedLine[],
  coupon: CouponRow | null,
  currency: CurrencyCode,
  automaticTax: boolean,
): Promise<{ rows: InsertQuoteLineParams[]; totals: QuotePatch }> {
  const { draft, catalog } = await draftOf(lines);
  const discounts = discountsFor(draft, catalog, coupon, currency);
  const totals = draftTotals(draft, discounts, automaticTax);
  return {
    rows: draft.map((line, position) => {
      const discount = discounts[position] ?? 0n;
      return {
        publicId: line.publicId,
        position,
        priceId: line.priceId as string,
        description: line.description ?? '',
        quantity: line.quantity ?? 1,
        currency,
        amountSubtotal: line.amount.toString(),
        amountDiscount: discount.toString(),
        amountTax: '0',
        amountTotal: (line.amount - discount).toString(),
      };
    }),
    totals: {
      amountSubtotal: totals.subtotal.toString(),
      amountDiscount: totals.totalDiscount.toString(),
      amountTax: automaticTax ? null : '0',
      amountTotal: totals.total.toString(),
      automaticTaxStatus: null,
      taxCalculationId: null,
    },
  };
}

/** The stored lines with their prices, as {@link QuotedLine}s. */
async function storedLines(
  quote: QuoteRow,
): Promise<{ rows: QuoteLineRow[]; lines: QuotedLine[] }> {
  const db = getDb();
  const rows = await listQuoteLines(db, quote.id);
  const prices = await findPricesByRowIds(
    db,
    rows.map((row) => row.priceId),
  );
  return {
    rows,
    lines: rows.map((row) => {
      const price = prices.find((candidate) => candidate.id === row.priceId);
      if (!price) throw new Error(`price ${row.priceId} vanished`);
      return { price, quantity: row.quantity };
    }),
  };
}

/** What a finalization priced; a draft edited since no longer matches. */
function quoteDigest(quote: QuoteRow, rows: readonly QuoteLineRow[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        quote.currency,
        quote.discountCouponId,
        quote.automaticTax,
        rows.map((row) => [row.publicId, row.priceId, row.quantity]),
      ]),
    )
    .digest('hex');
}

// ---- Shape -------------------------------------------------------------------------------

interface QuoteShape {
  readonly currency: CurrencyCode;
  readonly recurring: boolean;
  readonly collectionMethod: CollectionMethod;
  readonly daysUntilDue: number | null;
  readonly trialPeriodDays: number | null;
}

/** The rules a quote's fields keep together, judged on every write. */
function assertShape(shape: QuoteShape, customer: CustomerRow): void {
  if (customer.currency !== null && customer.currency !== shape.currency) {
    throw new BillingEngineError(
      'customer_currency_mismatch',
      `this customer bills in ${customer.currency}; a ${shape.currency} quote needs another customer`,
      'line_items',
    );
  }
  if (railOf(shape.currency) === 'faircoin' && shape.collectionMethod === 'charge_automatically') {
    throw new BillingEngineError(
      'faircoin_cannot_debit',
      'a FairCoin quote is sent for the payer to pay; it cannot be charged automatically',
      'collection_method',
    );
  }
  if (shape.collectionMethod === 'charge_automatically' && shape.daysUntilDue !== null) {
    throw invalid('days_until_due is for send_invoice', 'invoice_settings[days_until_due]');
  }
  if (shape.trialPeriodDays !== null && !shape.recurring) {
    throw invalid(
      'a trial needs a recurring line: it is the subscription the quote starts',
      'subscription_data[trial_period_days]',
    );
  }
}

function assertExpiry(expiresAt: Date, now: Date, param = 'expires_at'): void {
  if (expiresAt.getTime() <= now.getTime())
    throw invalid('expires_at must be in the future', param);
  if (expiresAt.getTime() > addDays(now, QUOTE_LIMITS.expiryMaxDays).getTime()) {
    throw invalid(`a quote expires within ${QUOTE_LIMITS.expiryMaxDays} days`, param);
  }
}

/**
 * Validate a discount for `customer` WITHOUT redeeming it: the redemption is
 * counted when the quote is accepted (in the transaction that makes its
 * invoice or subscription). A dry run in a transaction that always rolls back.
 */
async function validateDiscount(
  merchant: MerchantRow,
  customer: CustomerRow,
  currency: CurrencyCode,
  now: Date,
  subtotal: bigint,
  request: NonNullable<ReturnType<typeof discountRequest>>,
): Promise<AppliedDiscount> {
  return getDb()
    .transaction(async (tx) => {
      const applied = await applyDiscountFor(tx, {
        merchantId: merchant.id,
        customerId: customer.id,
        currency,
        now,
        orderTotal: subtotal,
        request,
      });
      throw new DryRun(applied);
    })
    .catch((error: unknown) => {
      if (error instanceof DryRun) return error.applied;
      throw error;
    });
}

class DryRun extends Error {
  constructor(readonly applied: AppliedDiscount) {
    super('dry run');
  }
}

/** The stored discount as `createSubscription` / `applyDiscountFor` names one. */
async function storedDiscountRequest(
  quote: QuoteRow,
): Promise<{ coupon?: string; promotionCode?: string; param: string } | null> {
  if (quote.discountPromotionCodeId) {
    const code = await findPromotionCodeById(getDb(), quote.discountPromotionCodeId);
    if (!code) throw new Error('a quote discount without its promotion code');
    return { promotionCode: code.publicId, param: 'discounts' };
  }
  if (quote.discountCouponPublicId) {
    return { coupon: quote.discountCouponPublicId, param: 'discounts' };
  }
  return null;
}

// ---- Create / update -------------------------------------------------------------------------

export interface QuoteLineInput {
  readonly price: string;
  readonly quantity?: number | undefined;
}

export interface CreateQuoteInput {
  readonly customer: string;
  readonly lineItems: readonly QuoteLineInput[];
  readonly collectionMethod?: CollectionMethod;
  readonly daysUntilDue?: number;
  readonly subscriptionData?: {
    readonly description?: string | undefined;
    readonly trialPeriodDays?: number | undefined;
    readonly metadata?: Record<string, string> | undefined;
  };
  readonly discounts?: readonly DiscountParams[];
  readonly automaticTax?: boolean;
  readonly expiresAt?: number;
  readonly header?: string;
  readonly description?: string;
  readonly footer?: string;
  readonly metadata: Record<string, string>;
}

/** `POST /v1/quotes`: a draft, priced, with `quote.created`. */
export async function createQuote(
  merchant: MerchantRow,
  input: CreateQuoteInput,
): Promise<QuoteRow> {
  const db = getDb();
  const customer = await findLiveCustomerForMerchant(db, input.customer, merchant.id);
  if (!customer) throw missing('customer', 'customer');
  const lines = await resolveLines(merchant, input.lineItems);
  const { currency, recurring } = assertCoherent(lines);
  const collectionMethod: CollectionMethod =
    input.collectionMethod ??
    (railOf(currency) === 'faircoin' ? 'send_invoice' : 'charge_automatically');
  const shape: QuoteShape = {
    currency,
    recurring,
    collectionMethod,
    daysUntilDue: input.daysUntilDue ?? null,
    trialPeriodDays: input.subscriptionData?.trialPeriodDays ?? null,
  };
  assertShape(shape, customer);
  const now = await engineNow(db, customer.testClockId);
  const expiresAt =
    input.expiresAt !== undefined
      ? new Date(input.expiresAt * 1000)
      : addDays(now, QUOTE_LIMITS.defaultExpiryDays);
  assertExpiry(expiresAt, now);
  const request = discountRequest({ discounts: input.discounts });
  const subtotal = lines.reduce(
    (sum, line) => sum + itemPeriodAmount(line.price, line.quantity),
    0n,
  );
  const discount = request
    ? await validateDiscount(merchant, customer, currency, now, subtotal, request)
    : null;
  const automaticTax = input.automaticTax ?? false;
  const priced = await priceDraft(lines, discount?.coupon ?? null, currency, automaticTax);
  return committed(async (tx) => {
    const inserted = await insertQuote(tx, {
      publicId: newId('qt'),
      merchantId: merchant.id,
      customerId: customer.id,
      testClockId: customer.testClockId,
      currency,
      collectionMethod,
      daysUntilDue: shape.daysUntilDue,
      subscriptionDescription: input.subscriptionData?.description ?? null,
      trialPeriodDays: shape.trialPeriodDays,
      subscriptionMetadata: input.subscriptionData?.metadata ?? {},
      discountCouponId: discount?.coupon.id ?? null,
      discountPromotionCodeId: discount?.promotionCode?.id ?? null,
      automaticTax,
      expiresAt,
      header: input.header ?? null,
      description: input.description ?? null,
      footer: input.footer ?? null,
      metadata: input.metadata,
    });
    await replaceQuoteLines(tx, inserted, priced.rows);
    const quote = await patchQuote(tx, inserted, priced.totals);
    await recordBillingEvent(tx, merchant.id, 'quote.created', toQuoteDTO(quote));
    return quote;
  });
}

export interface UpdateQuoteInput {
  readonly lineItems?: readonly QuoteLineInput[];
  readonly collectionMethod?: CollectionMethod;
  readonly daysUntilDue?: number;
  readonly subscriptionData?: {
    readonly description?: string | undefined;
    readonly trialPeriodDays?: number | undefined;
    readonly metadata?: Record<string, string> | undefined;
  };
  /** `null` removes the discount. */
  readonly discounts?: readonly DiscountParams[] | null;
  readonly automaticTax?: boolean;
  readonly expiresAt?: number;
  readonly header?: string | null;
  readonly description?: string | null;
  readonly footer?: string | null;
  readonly metadata?: MetadataPatch;
}

/**
 * `POST /v1/quotes/:id`: a draft's fields (`line_items` replaces every line),
 * re-priced whole; `metadata` on any quote.
 */
export async function updateDraftQuote(
  merchant: MerchantRow,
  publicId: string,
  input: UpdateQuoteInput,
): Promise<QuoteRow> {
  const found = await quoteFor(merchant, publicId);
  const touchesDraft = Object.entries(input).some(
    ([key, value]) => value !== undefined && key !== 'metadata',
  );
  if (!touchesDraft) {
    return committed(async (tx) => {
      const quote = await lockQuote(tx, found.id);
      if (!quote) throw missing('quote');
      return input.metadata ? patchQuote(tx, quote, { metadata: input.metadata }) : quote;
    });
  }
  if (found.status !== 'draft') {
    throw new BillingEngineError(
      'quote_not_editable',
      `this quote is ${found.status}; only a draft can be edited`,
    );
  }
  const db = getDb();
  const customer = await findCustomerById(db, found.customerId);
  if (!customer) throw new Error('a quote without its customer');
  const lines = input.lineItems
    ? await resolveLines(merchant, input.lineItems)
    : (await storedLines(found)).lines;
  const { currency, recurring } = assertCoherent(lines);
  const collectionMethod =
    input.collectionMethod ??
    (railOf(currency) === 'faircoin' ? 'send_invoice' : found.collectionMethod);
  const shape: QuoteShape = {
    currency,
    recurring,
    collectionMethod,
    daysUntilDue:
      input.daysUntilDue ?? (collectionMethod === 'send_invoice' ? found.daysUntilDue : null),
    trialPeriodDays:
      input.subscriptionData?.trialPeriodDays !== undefined
        ? input.subscriptionData.trialPeriodDays
        : found.trialPeriodDays,
  };
  assertShape(shape, customer);
  const now = await engineNow(db, found.testClockId);
  const expiresAt = input.expiresAt !== undefined ? new Date(input.expiresAt * 1000) : undefined;
  if (expiresAt) assertExpiry(expiresAt, now);
  const subtotal = lines.reduce(
    (sum, line) => sum + itemPeriodAmount(line.price, line.quantity),
    0n,
  );
  let couponId = found.discountCouponId;
  let promotionCodeId = found.discountPromotionCodeId;
  if (input.discounts === null) {
    couponId = null;
    promotionCodeId = null;
  } else if (input.discounts !== undefined) {
    const request = discountRequest({ discounts: input.discounts });
    const applied = request
      ? await validateDiscount(merchant, customer, currency, now, subtotal, request)
      : null;
    couponId = applied?.coupon.id ?? null;
    promotionCodeId = applied?.promotionCode?.id ?? null;
  }
  const coupon = couponId ? await findCouponById(db, couponId) : null;
  const automaticTax = input.automaticTax ?? found.automaticTax;
  const priced = await priceDraft(lines, coupon, currency, automaticTax);
  return committed(async (tx) => {
    const quote = await lockQuote(tx, found.id);
    if (!quote) throw missing('quote');
    if (quote.status !== 'draft' || quote.updatedAt.getTime() !== found.updatedAt.getTime()) {
      throw new BillingEngineError(
        'quote_not_editable',
        'the quote changed while it was being edited; read it again',
      );
    }
    await replaceQuoteLines(tx, quote, priced.rows);
    return patchQuote(tx, quote, {
      ...priced.totals,
      collectionMethod,
      daysUntilDue: shape.daysUntilDue,
      trialPeriodDays: shape.trialPeriodDays,
      ...(input.subscriptionData?.description !== undefined
        ? { subscriptionDescription: input.subscriptionData.description }
        : {}),
      ...(input.subscriptionData?.metadata !== undefined
        ? { subscriptionMetadata: input.subscriptionData.metadata }
        : {}),
      discountCouponId: couponId,
      discountPromotionCodeId: promotionCodeId,
      automaticTax,
      ...(expiresAt ? { expiresAt } : {}),
      ...(input.header !== undefined ? { header: input.header } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.footer !== undefined ? { footer: input.footer } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  });
}

// ---- Finalize -------------------------------------------------------------------------------

/**
 * `POST /v1/quotes/:id/finalize`: price the draft with Peable Tax (outside any
 * transaction, the invoice's two-step), then — in one transaction that proves
 * the draft is still the one priced — freeze each line's discount and tax,
 * claim the number and move to `open` with `quote.finalized`.
 *
 * @throws {InvoiceTaxError} when tax fails closed; recorded on the draft.
 */
export async function finalizeQuote(
  merchant: MerchantRow,
  publicId: string,
  options: { readonly expiresAt?: number } = {},
): Promise<QuoteRow> {
  const quote = await quoteFor(merchant, publicId);
  if (quote.status !== 'draft') throw unexpected(quote, 'only a draft can be finalized');
  const db = getDb();
  const customer = await findCustomerById(db, quote.customerId);
  if (!customer) throw new Error('a quote without its customer');
  const now = await engineNow(db, quote.testClockId);
  const expiresAt =
    options.expiresAt !== undefined ? new Date(options.expiresAt * 1000) : quote.expiresAt;
  if (options.expiresAt !== undefined) assertExpiry(expiresAt, now);
  else if (expiresAt.getTime() <= now.getTime()) {
    throw new BillingEngineError(
      'quote_expired',
      'this draft expired; finalize it with a new expires_at',
      'expires_at',
    );
  }
  const { rows, lines } = await storedLines(quote);
  const { currency, recurring } = assertCoherent(lines);
  assertShape(
    {
      currency,
      recurring,
      collectionMethod: quote.collectionMethod,
      daysUntilDue: quote.daysUntilDue,
      trialPeriodDays: quote.trialPeriodDays,
    },
    customer,
  );
  // The discount must still be redeemable now; it is redeemed at acceptance.
  const request = await storedDiscountRequest(quote);
  if (request) {
    await validateDiscount(
      merchant,
      customer,
      currency,
      now,
      BigInt(quote.amountSubtotal),
      request,
    );
  }
  const coupon = quote.discountCouponId ? await findCouponById(db, quote.discountCouponId) : null;
  const { draft } = await draftOf(lines, rows);
  let prepared: Awaited<ReturnType<typeof prepareInvoice>>;
  try {
    prepared = await prepareInvoice({
      merchant,
      customer,
      currency,
      automaticTax: quote.automaticTax,
      lines: draft,
      coupon,
    });
  } catch (error) {
    if (error instanceof InvoiceTaxError) {
      await committed(async (tx) => {
        const locked = await lockQuote(tx, quote.id);
        if (locked?.status === 'draft') {
          await patchQuote(tx, locked, { automaticTaxStatus: error.taxStatus });
        }
      });
    }
    throw error;
  }
  const digest = quoteDigest(quote, rows);
  return committed(async (tx) => {
    const locked = await lockQuote(tx, quote.id);
    if (!locked) throw missing('quote');
    if (locked.status !== 'draft') throw unexpected(locked, 'only a draft can be finalized');
    if (quoteDigest(locked, await listQuoteLines(tx, locked.id)) !== digest) {
      throw new BillingEngineError(
        'quote_not_editable',
        'the quote changed while it was being finalized; try again',
      );
    }
    for (const [i, row] of rows.entries()) {
      const amount = BigInt(row.amountSubtotal);
      const discount = prepared.discounts[i] ?? 0n;
      const exclusive = prepared.tax.exclusive[i] ?? 0n;
      const inclusive = prepared.tax.inclusive[i] ?? 0n;
      await setQuoteLineAmounts(tx, row.id, {
        amountDiscount: discount.toString(),
        amountTax: (exclusive + inclusive).toString(),
        amountTotal: (amount - discount + exclusive).toString(),
      });
    }
    const taken = await claimQuoteNumber(tx, merchant);
    const { totals } = prepared;
    return transitionQuote(tx, locked, 'open', {
      number: formatQuoteNumber(taken.prefix, taken.number),
      finalizedAt: now,
      expiresAt,
      amountSubtotal: totals.subtotal.toString(),
      amountDiscount: totals.totalDiscount.toString(),
      amountTax: (totals.tax ?? 0n).toString(),
      amountTotal: totals.total.toString(),
      automaticTaxStatus: quote.automaticTax ? 'complete' : null,
      taxCalculationId: prepared.tax.calculation?.id ?? null,
    });
  });
}

// ---- Accept ----------------------------------------------------------------------------------

/** Lock the quote in the accepting transaction; anything but `open` refuses — and rolls back. */
async function lockOpen(tx: Transaction, quoteId: string): Promise<QuoteRow> {
  const locked = await lockQuote(tx, quoteId);
  if (!locked) throw missing('quote');
  if (locked.status !== 'open') throw unexpected(locked, 'only an open quote can be accepted');
  return locked;
}

/**
 * `POST /v1/quotes/:id/accept`. Recurring lines: a subscription (one-time
 * lines added to its first invoice) through `createSubscription`, the quote
 * locked at the start of its transaction and accepted at its end. One-time
 * lines only: an invoice written, finalized and linked here, in one
 * transaction. Either way the invoice is then collected as the engine
 * collects any: charged when automatic and the customer has a card, otherwise
 * left to its hosted page.
 */
export async function acceptQuote(merchant: MerchantRow, publicId: string): Promise<QuoteRow> {
  const quote = await quoteFor(merchant, publicId);
  if (quote.status !== 'open') throw unexpected(quote, 'only an open quote can be accepted');
  const db = getDb();
  const now = await engineNow(db, quote.testClockId);
  if (quote.expiresAt.getTime() <= now.getTime()) {
    throw new BillingEngineError(
      'quote_expired',
      'this quote expired and can no longer be accepted',
    );
  }
  const customer = await findCustomerById(db, quote.customerId);
  if (!customer) throw new Error('a quote without its customer');
  const { rows, lines } = await storedLines(quote);
  const recurring = rows.flatMap((row, i) =>
    lines[i]?.price.type === 'recurring' ? [{ row, line: lines[i] as QuotedLine }] : [],
  );
  const oneTime = lines.filter((line) => line.price.type !== 'recurring');
  const request = await storedDiscountRequest(quote);
  if (recurring.length > 0) {
    let locked: QuoteRow | null = null;
    await createSubscription(merchant, {
      customer: customer.publicId,
      items: recurring.map(({ row }) => ({ price: row.pricePublicId, quantity: row.quantity })),
      collectionMethod: quote.collectionMethod,
      ...(quote.collectionMethod === 'send_invoice' && quote.daysUntilDue !== null
        ? { daysUntilDue: quote.daysUntilDue }
        : {}),
      ...(quote.subscriptionDescription ? { description: quote.subscriptionDescription } : {}),
      ...(quote.trialPeriodDays !== null ? { trialPeriodDays: quote.trialPeriodDays } : {}),
      ...(request?.coupon ? { coupon: request.coupon } : {}),
      ...(request?.promotionCode ? { promotionCode: request.promotionCode } : {}),
      automaticTax: quote.automaticTax,
      metadata: quote.subscriptionMetadata,
      addInvoiceItems: oneTime,
      inTransaction: {
        start: async (tx) => {
          locked = await lockOpen(tx, quote.id);
        },
        end: async (tx, created) => {
          if (!locked) throw new Error('the quote was not locked');
          await transitionQuote(tx, locked, 'accepted', {
            acceptedAt: await engineNow(tx, locked.testClockId),
            subscriptionId: created.subscription.id,
            invoiceId: created.invoice.id,
          });
        },
      },
    });
    return (await findQuoteById(db, quote.id)) ?? quote;
  }
  const invoice = await acceptOneTime(merchant, quote, customer, lines, request, now);
  await collectNow(invoice, customer);
  return (await findQuoteById(db, quote.id)) ?? quote;
}

/** A one-time quote's invoice: written, finalized (tax before finalize) and linked in one transaction. */
async function acceptOneTime(
  merchant: MerchantRow,
  quote: QuoteRow,
  customer: CustomerRow,
  lines: readonly QuotedLine[],
  request: Awaited<ReturnType<typeof storedDiscountRequest>>,
  now: Date,
): Promise<InvoiceRow> {
  const db = getDb();
  const settings = await ensureBillingSettings(db, merchant.id);
  const { draft, catalog } = await draftOf(
    lines,
    lines.map(() => ({ id: orderedId(), publicId: newId('il') })),
  );
  const pending = draft.map((line, i) => ({
    ...line,
    invoiceItemId: `pending-ii-${i}`,
    periodStart: now,
    periodEnd: now,
  }));
  const coupon = quote.discountCouponId ? await findCouponById(db, quote.discountCouponId) : null;
  const prepared = await prepareInvoice({
    merchant,
    customer,
    currency: quote.currency,
    automaticTax: quote.automaticTax,
    lines: pending,
    coupon,
  });
  const subtotal = prepared.totals.subtotal;
  const written = await committed(async (tx) => {
    const locked = await lockOpen(tx, quote.id);
    if (!(await claimCustomerCurrency(tx, customer.id, quote.currency))) {
      throw new BillingEngineError(
        'customer_currency_mismatch',
        `this customer bills in ${customer.currency}`,
        'line_items',
      );
    }
    const discount = request
      ? await applyDiscountFor(tx, {
          merchantId: merchant.id,
          customerId: customer.id,
          currency: quote.currency,
          now,
          orderTotal: subtotal,
          request,
        })
      : null;
    const invoice = await insertInvoice(tx, {
      publicId: newId('in'),
      merchantId: merchant.id,
      customerId: customer.id,
      subscriptionId: null,
      testClockId: quote.testClockId,
      billingReason: 'quote_accept',
      collectionMethod: quote.collectionMethod,
      currency: quote.currency,
      description: quote.description,
      autoAdvance: true,
      automaticallyFinalizesAt: null,
      daysUntilDue:
        quote.collectionMethod === 'send_invoice'
          ? (quote.daysUntilDue ?? settings.defaultDaysUntilDue)
          : null,
      dueDate: null,
      periodStart: now,
      periodEnd: now,
      defaultPaymentMethodId: null,
      discountCouponId: discount?.coupon.id ?? null,
      discountPromotionCodeId: discount?.promotionCode?.id ?? null,
      automaticTax: quote.automaticTax,
      metadata: {},
      nextActionAt: null,
    });
    if (!invoice) throw new Error("a quote's invoice conflicted");
    const itemIds = new Map<string, string>();
    for (const line of pending) {
      const price = priceOf(catalog, line.priceId as string);
      const item = await insertInvoiceItem(tx, {
        publicId: newId('ii'),
        merchantId: merchant.id,
        customerId: customer.id,
        invoiceId: invoice.id,
        subscriptionId: null,
        subscriptionItemId: null,
        priceId: price.id,
        quantity: line.quantity ?? 1,
        unitAmount: price.billingScheme === 'per_unit' ? price.unitAmount : null,
        amount: line.amount.toString(),
        currency: quote.currency,
        description: line.description,
        discountable: true,
        periodStart: now,
        periodEnd: now,
        proration: false,
        creditsLineId: null,
        metadata: {},
      });
      itemIds.set(line.invoiceItemId, item.id);
    }
    await insertLines(
      tx,
      pending.map((line) =>
        toInsertLine(
          { ...line, invoiceItemId: itemIds.get(line.invoiceItemId) ?? null },
          invoice.id,
          merchant.id,
        ),
      ),
    );
    await recordBillingEvent(tx, merchant.id, 'invoice.created', await renderInvoice(tx, invoice));
    const outcome = await commitFinalization(tx, invoice, prepared, now, { autoAdvance: false });
    await transitionQuote(tx, locked, 'accepted', { acceptedAt: now, invoiceId: invoice.id });
    return outcome.invoice;
  });
  return written;
}

/** Collect a just-finalized invoice the way a new subscription's first one is collected. */
async function collectNow(invoice: InvoiceRow, customer: CustomerRow): Promise<void> {
  if (invoice.status !== 'open' || invoice.collectionMethod !== 'charge_automatically') return;
  if (customer.defaultPaymentMethodId !== null) {
    await attemptInvoicePayment(invoice.id, { offSession: true });
  } else {
    // The payer pays on the hosted invoice page (`invoice.payment_intent`).
    await payerIntentForInvoice(invoice);
  }
}

// ---- Cancel and expiry --------------------------------------------------------------------------

/** `POST /v1/quotes/:id/cancel`: a draft or an open quote. */
export async function cancelQuote(merchant: MerchantRow, publicId: string): Promise<QuoteRow> {
  const found = await quoteFor(merchant, publicId);
  return committed(async (tx) => {
    const quote = await lockQuote(tx, found.id);
    if (!quote) throw missing('quote');
    if (quote.status !== 'draft' && quote.status !== 'open') {
      throw unexpected(quote, 'only a draft or an open quote can be cancelled');
    }
    return transitionQuote(tx, quote, 'canceled', {
      canceledAt: await engineNow(tx, quote.testClockId),
    });
  });
}

/**
 * Cancel the open quotes past their `expires_at` on their own clock — the
 * engine scheduler's pass (and a test clock's advance). Each is re-read under
 * its lock and moved by the status CAS, so two workers cancel it once.
 */
export async function expireDueQuotes(
  options: { readonly testClockId?: string; readonly limit?: number } = {},
): Promise<number> {
  const db = getDb();
  const ids = await findExpiredOpenQuotes(db, {
    limit: options.limit ?? 50,
    ...(options.testClockId ? { testClockId: options.testClockId } : {}),
  });
  let expired = 0;
  for (const id of ids) {
    const moved = await db.transaction(async (tx) => {
      const quote = await lockQuote(tx, id);
      if (quote?.status !== 'open') return false;
      const now = await engineNow(tx, quote.testClockId);
      if (quote.expiresAt.getTime() > now.getTime()) return false;
      await transitionQuote(tx, quote, 'canceled', { canceledAt: now });
      return true;
    });
    if (moved) expired += 1;
  }
  if (expired > 0) kickWebhookOutbox();
  return expired;
}
