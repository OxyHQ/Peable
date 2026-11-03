import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type {
  AutomaticTaxStatus,
  CollectionMethod,
  CurrencyCode,
  InvoiceBillingReason,
  InvoiceStatus,
  InvoiceTaxAmount,
} from '@peable.to/shared-types';
import { invoiceItems, invoiceLineItems, invoices, testClocks } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type CreatedRange, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import type { InvoiceLineType } from '../schema/valueSets';
import { nowMs, orderedId, publicIdOf, requiredPublicIdOf } from './columns';

/**
 * Reads and writes for `invoices`, `invoice_line_items` and `invoice_items`
 * (ADR 0018). `status` is written only by {@link setInvoiceStatus}, a
 * compare-and-swap; `transitionInvoice` is its one caller.
 */

export interface InvoiceRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly customerId: string;
  readonly customerPublicId: string;
  readonly subscriptionId: string | null;
  readonly subscriptionPublicId: string | null;
  readonly testClockId: string | null;
  readonly testClockPublicId: string | null;
  readonly status: InvoiceStatus;
  readonly billingReason: InvoiceBillingReason;
  readonly collectionMethod: CollectionMethod;
  readonly currency: CurrencyCode;
  readonly number: string | null;
  readonly description: string | null;
  readonly autoAdvance: boolean;
  readonly automaticallyFinalizesAt: Date | null;
  readonly daysUntilDue: number | null;
  readonly dueDate: Date | null;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly defaultPaymentMethodId: string | null;
  readonly defaultPaymentMethodPublicId: string | null;
  readonly discountCouponId: string | null;
  readonly discountCouponPublicId: string | null;
  readonly discountPromotionCodeId: string | null;
  readonly discountPromotionCodePublicId: string | null;
  readonly automaticTax: boolean;
  readonly automaticTaxStatus: AutomaticTaxStatus | null;
  readonly taxCalculationId: string | null;
  readonly taxedLinesDigest: string | null;
  readonly subtotal: string;
  readonly totalDiscount: string;
  readonly tax: string | null;
  readonly total: string;
  readonly totalExcludingTax: string;
  readonly startingBalance: string;
  readonly endingBalance: string | null;
  readonly amountDue: string;
  readonly amountPaid: string;
  readonly prePaymentCreditNotesAmount: string;
  readonly postPaymentCreditNotesAmount: string;
  readonly attemptCount: number;
  readonly nextPaymentAttempt: Date | null;
  readonly paymentIntentId: string | null;
  readonly paymentIntentPublicId: string | null;
  readonly paidOutOfBand: boolean;
  readonly customerEmail: string | null;
  readonly customerName: string | null;
  readonly hostedToken: string | null;
  readonly finalizedAt: Date | null;
  readonly paidAt: Date | null;
  readonly voidedAt: Date | null;
  readonly markedUncollectibleAt: Date | null;
  readonly sentAt: Date | null;
  readonly dunningExhaustedAt: Date | null;
  readonly lastFinalizationError: { code: string; message: string } | null;
  readonly metadata: Record<string, string>;
  readonly nextActionAt: Date | null;
  readonly createdAt: Date;
}

const N = 'invoices';
const COLUMNS = {
  id: invoices.id,
  publicId: invoices.publicId,
  merchantId: invoices.merchantId,
  livemode: merchantLivemodeOf(invoices.merchantId),
  customerId: invoices.customerId,
  customerPublicId: requiredPublicIdOf('customers', N, 'customer_id'),
  subscriptionId: invoices.subscriptionId,
  subscriptionPublicId: publicIdOf('subscriptions', N, 'subscription_id'),
  testClockId: invoices.testClockId,
  testClockPublicId: publicIdOf('test_clocks', N, 'test_clock_id'),
  status: invoices.status,
  billingReason: invoices.billingReason,
  collectionMethod: invoices.collectionMethod,
  currency: invoices.currency,
  number: invoices.number,
  description: invoices.description,
  autoAdvance: invoices.autoAdvance,
  automaticallyFinalizesAt: invoices.automaticallyFinalizesAt,
  daysUntilDue: invoices.daysUntilDue,
  dueDate: invoices.dueDate,
  periodStart: invoices.periodStart,
  periodEnd: invoices.periodEnd,
  defaultPaymentMethodId: invoices.defaultPaymentMethodId,
  defaultPaymentMethodPublicId: publicIdOf('payment_methods', N, 'default_payment_method_id'),
  discountCouponId: invoices.discountCouponId,
  discountCouponPublicId: publicIdOf('coupons', N, 'discount_coupon_id'),
  discountPromotionCodeId: invoices.discountPromotionCodeId,
  discountPromotionCodePublicId: publicIdOf('promotion_codes', N, 'discount_promotion_code_id'),
  automaticTax: invoices.automaticTax,
  automaticTaxStatus: invoices.automaticTaxStatus,
  taxCalculationId: invoices.taxCalculationId,
  taxedLinesDigest: invoices.taxedLinesDigest,
  subtotal: invoices.subtotal,
  totalDiscount: invoices.totalDiscount,
  tax: invoices.tax,
  total: invoices.total,
  totalExcludingTax: invoices.totalExcludingTax,
  startingBalance: invoices.startingBalance,
  endingBalance: invoices.endingBalance,
  amountDue: invoices.amountDue,
  amountPaid: invoices.amountPaid,
  prePaymentCreditNotesAmount: invoices.prePaymentCreditNotesAmount,
  postPaymentCreditNotesAmount: invoices.postPaymentCreditNotesAmount,
  attemptCount: invoices.attemptCount,
  nextPaymentAttempt: invoices.nextPaymentAttempt,
  paymentIntentId: invoices.paymentIntentId,
  paymentIntentPublicId: publicIdOf('payment_intents', N, 'payment_intent_id'),
  paidOutOfBand: invoices.paidOutOfBand,
  customerEmail: invoices.customerEmail,
  customerName: invoices.customerName,
  hostedToken: invoices.hostedToken,
  finalizedAt: invoices.finalizedAt,
  paidAt: invoices.paidAt,
  voidedAt: invoices.voidedAt,
  markedUncollectibleAt: invoices.markedUncollectibleAt,
  sentAt: invoices.sentAt,
  dunningExhaustedAt: invoices.dunningExhaustedAt,
  lastFinalizationError: invoices.lastFinalizationError,
  metadata: invoices.metadata,
  nextActionAt: invoices.nextActionAt,
  createdAt: invoices.createdAt,
} as const;

const toRow = (row: Record<string, unknown>) => row as unknown as InvoiceRow;

export interface InsertInvoiceParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly subscriptionId: string | null;
  readonly testClockId: string | null;
  readonly billingReason: InvoiceBillingReason;
  readonly collectionMethod: CollectionMethod;
  readonly currency: CurrencyCode;
  readonly description: string | null;
  readonly autoAdvance: boolean;
  readonly automaticallyFinalizesAt: Date | null;
  readonly daysUntilDue: number | null;
  readonly dueDate: Date | null;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly defaultPaymentMethodId: string | null;
  readonly discountCouponId: string | null;
  readonly discountPromotionCodeId: string | null;
  readonly automaticTax: boolean;
  readonly metadata: Record<string, string>;
  readonly nextActionAt: Date | null;
}

/**
 * Insert a draft. `null` when the subscription already has its engine invoice
 * for this period and reason (`invoices_subscription_period_reason_key`) — a
 * second worker renewing the same period writes nothing.
 */
export async function insertInvoice(
  tx: Transaction,
  params: InsertInvoiceParams,
): Promise<InvoiceRow | null> {
  const [row] = await tx
    .insert(invoices)
    .values({ id: uuidv7(), ...params })
    .onConflictDoNothing()
    .returning(COLUMNS);
  return row ? toRow(row) : null;
}

export async function findInvoiceForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<InvoiceRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(invoices)
    .where(and(eq(invoices.publicId, publicId), eq(invoices.merchantId, merchantId)));
  return row ? toRow(row) : null;
}

export async function findInvoiceById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<InvoiceRow | null> {
  const [row] = await db.select(COLUMNS).from(invoices).where(eq(invoices.id, id));
  return row ? toRow(row) : null;
}

export async function findInvoicesByPublicIds(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicIds: readonly string[],
): Promise<InvoiceRow[]> {
  if (publicIds.length === 0) return [];
  const rows = await db
    .select(COLUMNS)
    .from(invoices)
    .where(and(eq(invoices.merchantId, merchantId), inArray(invoices.publicId, [...publicIds])));
  return rows.map(toRow);
}

export async function findInvoiceByHostedToken(
  db: DatabaseOrTransaction,
  token: string,
): Promise<InvoiceRow | null> {
  const [row] = await db.select(COLUMNS).from(invoices).where(eq(invoices.hostedToken, token));
  return row ? toRow(row) : null;
}

/** The invoice a PaymentIntent collects, locked — the payment hook's read. */
export async function lockInvoiceByPaymentIntent(
  tx: Transaction,
  paymentIntentId: string,
): Promise<InvoiceRow | null> {
  const [row] = await tx
    .select(COLUMNS)
    .from(invoices)
    .where(eq(invoices.paymentIntentId, paymentIntentId))
    .for('update');
  return row ? toRow(row) : null;
}

export async function lockInvoice(tx: Transaction, id: string): Promise<InvoiceRow | null> {
  const [row] = await tx.select(COLUMNS).from(invoices).where(eq(invoices.id, id)).for('update');
  return row ? toRow(row) : null;
}

export interface InvoicePatch {
  readonly collectionMethod?: CollectionMethod;
  readonly description?: string | null;
  readonly autoAdvance?: boolean;
  readonly automaticallyFinalizesAt?: Date | null;
  readonly daysUntilDue?: number | null;
  readonly dueDate?: Date | null;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly defaultPaymentMethodId?: string | null;
  readonly discountCouponId?: string | null;
  readonly discountPromotionCodeId?: string | null;
  readonly automaticTax?: boolean;
  readonly automaticTaxStatus?: AutomaticTaxStatus | null;
  readonly taxCalculationId?: string | null;
  readonly taxedLinesDigest?: string | null;
  readonly subtotal?: string;
  readonly totalDiscount?: string;
  readonly tax?: string | null;
  readonly total?: string;
  readonly totalExcludingTax?: string;
  readonly startingBalance?: string;
  readonly endingBalance?: string | null;
  readonly amountDue?: string;
  readonly amountPaid?: string;
  readonly prePaymentCreditNotesAmount?: string;
  readonly postPaymentCreditNotesAmount?: string;
  readonly attemptCount?: number;
  readonly nextPaymentAttempt?: Date | null;
  readonly paymentIntentId?: string | null;
  readonly paidOutOfBand?: boolean;
  readonly customerEmail?: string | null;
  readonly customerName?: string | null;
  readonly hostedToken?: string | null;
  readonly number?: string | null;
  readonly finalizedAt?: Date | null;
  readonly paidAt?: Date | null;
  readonly voidedAt?: Date | null;
  readonly markedUncollectibleAt?: Date | null;
  readonly sentAt?: Date | null;
  readonly dunningExhaustedAt?: Date | null;
  readonly lastFinalizationError?: { code: string; message: string } | null;
  readonly nextActionAt?: Date | null;
  readonly metadata?: MetadataPatch;
}

function patchValues(patch: InvoicePatch): Record<string, unknown> {
  const { metadata, ...rest } = patch;
  const values: Record<string, unknown> = { updatedAt: nowMs };
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) values[key] = value;
  if (metadata) values.metadata = mergedMetadata(invoices.metadata, metadata);
  return values;
}

export async function updateInvoice(
  tx: DatabaseOrTransaction,
  id: string,
  patch: InvoicePatch,
): Promise<InvoiceRow | 'limit_exceeded'> {
  const where: SQL[] = [eq(invoices.id, id)];
  if (patch.metadata)
    where.push(metadataWithinLimit(mergedMetadata(invoices.metadata, patch.metadata)));
  const [row] = await tx
    .update(invoices)
    .set(patchValues(patch))
    .where(and(...where))
    .returning(COLUMNS);
  return row ? toRow(row) : 'limit_exceeded';
}

/** The status compare-and-swap. `stale` when another writer moved the row first. */
export async function setInvoiceStatus(
  tx: Transaction,
  id: string,
  from: InvoiceStatus,
  to: InvoiceStatus,
  patch: InvoicePatch = {},
): Promise<InvoiceRow | 'stale'> {
  const [row] = await tx
    .update(invoices)
    .set({ ...patchValues(patch), status: to })
    .where(and(eq(invoices.id, id), eq(invoices.status, from)))
    .returning(COLUMNS);
  return row ? toRow(row) : 'stale';
}

/** Delete a DRAFT and its lines (its invoice items return to pending). */
export async function deleteDraftInvoice(tx: Transaction, id: string): Promise<boolean> {
  await tx
    .update(invoiceItems)
    .set({ invoiceId: null, updatedAt: nowMs })
    .where(eq(invoiceItems.invoiceId, id));
  await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id));
  const rows = await tx
    .delete(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.status, 'draft')))
    .returning({ id: invoices.id });
  return rows.length === 1;
}

/** What a list of invoices walks — its filters, without the page. */
export interface InvoiceListScope {
  readonly merchantId: string;
  readonly customerId?: string | undefined;
  readonly subscriptionId?: string | undefined;
  readonly status?: InvoiceStatus | undefined;
  readonly collectionMethod?: CollectionMethod | undefined;
  readonly dueDate?: CreatedRange | undefined;
  /** A compiled search predicate (`GET /v1/invoices/search`). */
  readonly search?: SQL | undefined;
}

export interface InvoiceListFilters extends InvoiceListScope {
  readonly page: KeysetPage;
}

function invoiceListWhere(filters: InvoiceListScope): SQL | undefined {
  const conditions: (SQL | undefined)[] = [eq(invoices.merchantId, filters.merchantId)];
  if (filters.customerId) conditions.push(eq(invoices.customerId, filters.customerId));
  if (filters.subscriptionId) conditions.push(eq(invoices.subscriptionId, filters.subscriptionId));
  if (filters.status) conditions.push(eq(invoices.status, filters.status));
  if (filters.collectionMethod)
    conditions.push(eq(invoices.collectionMethod, filters.collectionMethod));
  const range = filters.dueDate;
  if (range) {
    const at = (s: number) => new Date(s * 1000);
    if (range.gte !== undefined) conditions.push(gte(invoices.dueDate, at(range.gte)));
    if (range.gt !== undefined) conditions.push(gte(invoices.dueDate, at(range.gt + 1)));
    if (range.lt !== undefined) conditions.push(lt(invoices.dueDate, at(range.lt)));
    if (range.lte !== undefined) conditions.push(lt(invoices.dueDate, at(range.lte + 1)));
  }
  conditions.push(filters.search);
  return and(...conditions);
}

export async function listInvoices(
  db: DatabaseOrTransaction,
  filters: InvoiceListFilters,
): Promise<{ data: InvoiceRow[]; hasMore: boolean }> {
  const walk = keyset(invoices.id, invoices.createdAt, filters.page);
  const rows = await db
    .select(COLUMNS)
    .from(invoices)
    .where(and(invoiceListWhere(filters), walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/** How many invoices {@link listInvoices} would walk — a search's `total_count`. */
export async function countInvoices(
  db: DatabaseOrTransaction,
  filters: InvoiceListScope,
): Promise<number> {
  const [row] = await db.select({ n: count() }).from(invoices).where(invoiceListWhere(filters));
  return row?.n ?? 0;
}

/** A customer's finalized invoices, newest first — the portal's history. */
export async function listCustomerInvoices(
  db: DatabaseOrTransaction,
  customerId: string,
  limit: number,
): Promise<InvoiceRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), sql`${invoices.status} <> 'draft'`))
    .orderBy(desc(invoices.id))
    .limit(limit);
  return rows.map(toRow);
}

/** Every unpaid invoice of a subscription (cancel voids or leaves them). */
export async function listOpenSubscriptionInvoices(
  db: DatabaseOrTransaction,
  subscriptionId: string,
): Promise<InvoiceRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(invoices)
    .where(
      and(eq(invoices.subscriptionId, subscriptionId), inArray(invoices.status, ['draft', 'open'])),
    )
    .orderBy(asc(invoices.id));
  return rows.map(toRow);
}

/** The PaymentIntents (internal ids) of a subscription's PAID invoices, newest first. */
export async function listPaidSubscriptionIntents(
  db: DatabaseOrTransaction,
  subscriptionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ paymentIntentId: invoices.paymentIntentId })
    .from(invoices)
    .where(
      and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, 'paid'),
        sql`${invoices.paymentIntentId} is not null`,
      ),
    )
    .orderBy(desc(invoices.id))
    .limit(5);
  return rows.flatMap((row) => (row.paymentIntentId ? [row.paymentIntentId] : []));
}

/** The scheduler's claim on due invoices — see `claimDueSubscriptions`. */
export async function claimDueInvoices(
  db: DatabaseOrTransaction,
  options: { readonly limit: number; readonly leaseSeconds: number; readonly testClockId?: string },
): Promise<string[]> {
  const clockFilter = options.testClockId
    ? sql`and i.test_clock_id = ${options.testClockId}`
    : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    update ${invoices} set lease_expires_at = now() + make_interval(secs => ${options.leaseSeconds})
    where ${invoices.id} in (
      select i.id from ${invoices} i
      left join ${testClocks} tc on tc.id = i.test_clock_id
      where i.next_action_at is not null
        and i.next_action_at <= coalesce(tc.frozen_time, now())
        and (i.lease_expires_at is null or i.lease_expires_at < now())
        ${clockFilter}
      order by i.next_action_at
      limit ${options.limit}
      for update of i skip locked
    )
    returning ${invoices.id} as id`);
  return [...rows].map((row) => row.id);
}

export async function releaseInvoiceLease(db: DatabaseOrTransaction, id: string): Promise<void> {
  await db.update(invoices).set({ leaseExpiresAt: null }).where(eq(invoices.id, id));
}

export async function clockHasDueInvoices(
  db: DatabaseOrTransaction,
  testClockId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .innerJoin(testClocks, eq(testClocks.id, invoices.testClockId))
    .where(
      and(eq(invoices.testClockId, testClockId), lte(invoices.nextActionAt, testClocks.frozenTime)),
    )
    .limit(1);
  return row !== undefined;
}

// ---- Lines ---------------------------------------------------------------------

export interface InvoiceLineRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly invoiceId: string;
  readonly invoicePublicId: string;
  readonly type: InvoiceLineType;
  readonly subscriptionId: string | null;
  readonly subscriptionPublicId: string | null;
  readonly subscriptionItemId: string | null;
  readonly subscriptionItemPublicId: string | null;
  readonly invoiceItemId: string | null;
  readonly invoiceItemPublicId: string | null;
  readonly priceId: string | null;
  readonly quantity: number | null;
  readonly amount: string;
  readonly discountAmount: string;
  readonly taxAmounts: InvoiceTaxAmount[];
  readonly currency: CurrencyCode;
  readonly description: string | null;
  readonly discountable: boolean;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly proration: boolean;
  readonly creditsLineId: string | null;
  readonly metered: boolean;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
}

const L = 'invoice_line_items';
const LINE_COLUMNS = {
  id: invoiceLineItems.id,
  publicId: invoiceLineItems.publicId,
  merchantId: invoiceLineItems.merchantId,
  livemode: merchantLivemodeOf(invoiceLineItems.merchantId),
  invoiceId: invoiceLineItems.invoiceId,
  invoicePublicId: requiredPublicIdOf('invoices', L, 'invoice_id'),
  type: invoiceLineItems.type,
  subscriptionId: invoiceLineItems.subscriptionId,
  subscriptionPublicId: publicIdOf('subscriptions', L, 'subscription_id'),
  subscriptionItemId: invoiceLineItems.subscriptionItemId,
  subscriptionItemPublicId: publicIdOf('subscription_items', L, 'subscription_item_id'),
  invoiceItemId: invoiceLineItems.invoiceItemId,
  invoiceItemPublicId: publicIdOf('invoice_items', L, 'invoice_item_id'),
  priceId: invoiceLineItems.priceId,
  quantity: invoiceLineItems.quantity,
  amount: invoiceLineItems.amount,
  discountAmount: invoiceLineItems.discountAmount,
  taxAmounts: invoiceLineItems.taxAmounts,
  currency: invoiceLineItems.currency,
  description: invoiceLineItems.description,
  discountable: invoiceLineItems.discountable,
  periodStart: invoiceLineItems.periodStart,
  periodEnd: invoiceLineItems.periodEnd,
  proration: invoiceLineItems.proration,
  creditsLineId: invoiceLineItems.creditsLineId,
  metered: invoiceLineItems.metered,
  metadata: invoiceLineItems.metadata,
  createdAt: invoiceLineItems.createdAt,
} as const;

const toLine = (row: Record<string, unknown>) => row as unknown as InvoiceLineRow;

export interface InsertLineParams {
  readonly id?: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly invoiceId: string;
  readonly type: InvoiceLineType;
  readonly subscriptionId: string | null;
  readonly subscriptionItemId: string | null;
  readonly invoiceItemId: string | null;
  readonly priceId: string | null;
  readonly quantity: number | null;
  readonly amount: string;
  readonly discountAmount?: string;
  readonly taxAmounts?: InvoiceTaxAmount[];
  readonly currency: CurrencyCode;
  readonly description: string | null;
  readonly discountable: boolean;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly proration: boolean;
  readonly creditsLineId: string | null;
  readonly metered: boolean;
  readonly metadata: Record<string, string>;
}

export async function insertLines(
  tx: Transaction,
  lines: readonly InsertLineParams[],
): Promise<InvoiceLineRow[]> {
  if (lines.length === 0) return [];
  const rows = await tx
    .insert(invoiceLineItems)
    .values(lines.map((line) => ({ ...line, id: line.id ?? orderedId() })))
    .returning(LINE_COLUMNS);
  return rows.map(toLine);
}

/** An invoice's lines in the order they were drafted. */
export async function listLines(
  db: DatabaseOrTransaction,
  invoiceId: string,
): Promise<InvoiceLineRow[]> {
  const rows = await db
    .select(LINE_COLUMNS)
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceLineItems.id));
  return rows.map(toLine);
}

export async function listLinesFor(
  db: DatabaseOrTransaction,
  invoiceIds: readonly string[],
): Promise<InvoiceLineRow[]> {
  if (invoiceIds.length === 0) return [];
  const rows = await db
    .select(LINE_COLUMNS)
    .from(invoiceLineItems)
    .where(inArray(invoiceLineItems.invoiceId, [...invoiceIds]))
    .orderBy(asc(invoiceLineItems.id));
  return rows.map(toLine);
}

export async function findLinesByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<InvoiceLineRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(LINE_COLUMNS)
    .from(invoiceLineItems)
    .where(inArray(invoiceLineItems.id, [...ids]));
  return rows.map(toLine);
}

export async function setLineAmounts(
  tx: Transaction,
  id: string,
  amounts: { readonly discountAmount: string; readonly taxAmounts: InvoiceTaxAmount[] },
): Promise<void> {
  await tx.update(invoiceLineItems).set(amounts).where(eq(invoiceLineItems.id, id));
}

/**
 * The last CHARGE line for a subscription item whose period covers `at` on a
 * finalized invoice — what a proration credit for unused time gives back, and
 * whose tax it reverses.
 */
export async function findChargedLineCovering(
  db: DatabaseOrTransaction,
  subscriptionItemId: string,
  at: Date,
): Promise<InvoiceLineRow | null> {
  const [row] = await db
    .select(LINE_COLUMNS)
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
    .where(
      and(
        eq(invoiceLineItems.subscriptionItemId, subscriptionItemId),
        sql`${invoiceLineItems.amount} !~ '^-'`,
        lte(invoiceLineItems.periodStart, at),
        gt(invoiceLineItems.periodEnd, at),
        inArray(invoices.status, ['open', 'paid', 'uncollectible']),
      ),
    )
    .orderBy(desc(invoiceLineItems.id))
    .limit(1);
  return row ? toLine(row) : null;
}

// ---- Invoice items ----------------------------------------------------------------

export interface InvoiceItemRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly customerId: string;
  readonly customerPublicId: string;
  readonly invoiceId: string | null;
  readonly invoicePublicId: string | null;
  readonly subscriptionId: string | null;
  readonly subscriptionPublicId: string | null;
  readonly subscriptionItemId: string | null;
  readonly subscriptionItemPublicId: string | null;
  readonly priceId: string | null;
  readonly quantity: number;
  readonly unitAmount: string | null;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly description: string | null;
  readonly discountable: boolean;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly proration: boolean;
  readonly creditsLineId: string | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
}

const II = 'invoice_items';
const ITEM_COLUMNS = {
  id: invoiceItems.id,
  publicId: invoiceItems.publicId,
  merchantId: invoiceItems.merchantId,
  livemode: merchantLivemodeOf(invoiceItems.merchantId),
  customerId: invoiceItems.customerId,
  customerPublicId: requiredPublicIdOf('customers', II, 'customer_id'),
  invoiceId: invoiceItems.invoiceId,
  invoicePublicId: publicIdOf('invoices', II, 'invoice_id'),
  subscriptionId: invoiceItems.subscriptionId,
  subscriptionPublicId: publicIdOf('subscriptions', II, 'subscription_id'),
  subscriptionItemId: invoiceItems.subscriptionItemId,
  subscriptionItemPublicId: publicIdOf('subscription_items', II, 'subscription_item_id'),
  priceId: invoiceItems.priceId,
  quantity: invoiceItems.quantity,
  unitAmount: invoiceItems.unitAmount,
  amount: invoiceItems.amount,
  currency: invoiceItems.currency,
  description: invoiceItems.description,
  discountable: invoiceItems.discountable,
  periodStart: invoiceItems.periodStart,
  periodEnd: invoiceItems.periodEnd,
  proration: invoiceItems.proration,
  creditsLineId: invoiceItems.creditsLineId,
  metadata: invoiceItems.metadata,
  createdAt: invoiceItems.createdAt,
} as const;

const toItem = (row: Record<string, unknown>) => row as unknown as InvoiceItemRow;

export interface InsertInvoiceItemParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly invoiceId: string | null;
  readonly subscriptionId: string | null;
  readonly subscriptionItemId: string | null;
  readonly priceId: string | null;
  readonly quantity: number;
  readonly unitAmount: string | null;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly description: string | null;
  readonly discountable: boolean;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly proration: boolean;
  readonly creditsLineId: string | null;
  readonly metadata: Record<string, string>;
}

export async function insertInvoiceItem(
  tx: Transaction,
  params: InsertInvoiceItemParams,
): Promise<InvoiceItemRow> {
  const [row] = await tx
    .insert(invoiceItems)
    .values({ id: orderedId(), ...params })
    .returning(ITEM_COLUMNS);
  if (!row) throw new Error('invoice item insert returned no row');
  return toItem(row);
}

export async function findInvoiceItemForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<InvoiceItemRow | null> {
  const [row] = await db
    .select(ITEM_COLUMNS)
    .from(invoiceItems)
    .where(and(eq(invoiceItems.publicId, publicId), eq(invoiceItems.merchantId, merchantId)));
  return row ? toItem(row) : null;
}

export async function findInvoiceItemsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<InvoiceItemRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(ITEM_COLUMNS)
    .from(invoiceItems)
    .where(inArray(invoiceItems.id, [...ids]));
  return rows.map(toItem);
}

export async function lockInvoiceItem(tx: Transaction, id: string): Promise<InvoiceItemRow | null> {
  const [row] = await tx
    .select(ITEM_COLUMNS)
    .from(invoiceItems)
    .where(eq(invoiceItems.id, id))
    .for('update');
  return row ? toItem(row) : null;
}

/**
 * A customer's PENDING items, locked: those of `subscriptionId` and those of no
 * subscription when `includeUnattached`. What a draft pulls in.
 */
export async function lockPendingItems(
  tx: Transaction,
  customerId: string,
  options: { readonly subscriptionId: string | null; readonly includeUnattached: boolean },
): Promise<InvoiceItemRow[]> {
  const scope: SQL[] = [];
  if (options.subscriptionId) scope.push(eq(invoiceItems.subscriptionId, options.subscriptionId));
  if (options.includeUnattached) scope.push(isNull(invoiceItems.subscriptionId));
  if (scope.length === 0) return [];
  const rows = await tx
    .select(ITEM_COLUMNS)
    .from(invoiceItems)
    .where(
      and(eq(invoiceItems.customerId, customerId), isNull(invoiceItems.invoiceId), or(...scope)),
    )
    .orderBy(asc(invoiceItems.id))
    .for('update');
  return rows.map(toItem);
}

/** A customer's pending items, unlocked — the upcoming-invoice preview's read. */
export async function readPendingItems(
  db: DatabaseOrTransaction,
  customerId: string,
  subscriptionId: string | null,
): Promise<InvoiceItemRow[]> {
  const rows = await db
    .select(ITEM_COLUMNS)
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.customerId, customerId),
        isNull(invoiceItems.invoiceId),
        subscriptionId
          ? or(eq(invoiceItems.subscriptionId, subscriptionId), isNull(invoiceItems.subscriptionId))
          : isNull(invoiceItems.subscriptionId),
      ),
    )
    .orderBy(asc(invoiceItems.id));
  return rows.map(toItem);
}

export async function attachItemsToInvoice(
  tx: Transaction,
  itemIds: readonly string[],
  invoiceId: string,
): Promise<void> {
  if (itemIds.length === 0) return;
  await tx
    .update(invoiceItems)
    .set({ invoiceId, updatedAt: nowMs })
    .where(and(inArray(invoiceItems.id, [...itemIds]), isNull(invoiceItems.invoiceId)));
}

export async function updateInvoiceItem(
  tx: Transaction,
  id: string,
  patch: {
    readonly description?: string | null;
    readonly quantity?: number;
    readonly amount?: string;
    readonly discountable?: boolean;
    readonly metadata?: MetadataPatch;
  },
): Promise<InvoiceItemRow | 'limit_exceeded'> {
  const { metadata, ...rest } = patch;
  const where: SQL[] = [eq(invoiceItems.id, id)];
  if (metadata) where.push(metadataWithinLimit(mergedMetadata(invoiceItems.metadata, metadata)));
  const [row] = await tx
    .update(invoiceItems)
    .set({
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ...(metadata ? { metadata: mergedMetadata(invoiceItems.metadata, metadata) } : {}),
      updatedAt: nowMs,
    })
    .where(and(...where))
    .returning(ITEM_COLUMNS);
  return row ? toItem(row) : 'limit_exceeded';
}

export async function deleteInvoiceItem(tx: Transaction, id: string): Promise<void> {
  await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceItemId, id));
  await tx.delete(invoiceItems).where(eq(invoiceItems.id, id));
}

export interface InvoiceItemListFilters {
  readonly merchantId: string;
  readonly page: KeysetPage;
  readonly customerId?: string | undefined;
  readonly invoiceId?: string | undefined;
  readonly pending?: boolean | undefined;
}

export async function listInvoiceItems(
  db: DatabaseOrTransaction,
  filters: InvoiceItemListFilters,
): Promise<{ data: InvoiceItemRow[]; hasMore: boolean }> {
  const walk = keyset(invoiceItems.id, invoiceItems.createdAt, filters.page);
  const rows = await db
    .select(ITEM_COLUMNS)
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.merchantId, filters.merchantId),
        filters.customerId ? eq(invoiceItems.customerId, filters.customerId) : undefined,
        filters.invoiceId ? eq(invoiceItems.invoiceId, filters.invoiceId) : undefined,
        filters.pending === true ? isNull(invoiceItems.invoiceId) : undefined,
        filters.pending === false ? sql`${invoiceItems.invoiceId} is not null` : undefined,
        walk.where,
      ),
    )
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toItem));
}
