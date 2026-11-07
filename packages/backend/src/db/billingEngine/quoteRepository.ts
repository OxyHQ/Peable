import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type {
  AutomaticTaxStatus,
  CollectionMethod,
  CurrencyCode,
  QuoteStatus,
} from '@peable.to/shared-types';
import { billingSettings, quoteLineItems, quotes, testClocks } from '../schema';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import { keyset, type KeysetPage } from '../keyset';
import { merchantLivemodeOf } from '../merchants/merchantLivemode';
import { mergedMetadata, metadataWithinLimit, type MetadataPatch } from '../metadata';
import { nowMs, orderedId, publicIdOf, requiredPublicIdOf } from './columns';
import { defaultInvoicePrefix } from './settingsRepository';

/**
 * Reads and writes for `quotes` and `quote_line_items` (ADR 0018 §5).
 * `status` is written only by {@link setQuoteStatus}, a compare-and-swap;
 * `transitionQuote` is its one caller.
 */

export interface QuoteRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly livemode: boolean;
  readonly customerId: string;
  readonly customerPublicId: string;
  readonly testClockId: string | null;
  readonly testClockPublicId: string | null;
  readonly status: QuoteStatus;
  readonly number: string | null;
  readonly currency: CurrencyCode;
  readonly collectionMethod: CollectionMethod;
  readonly daysUntilDue: number | null;
  readonly subscriptionDescription: string | null;
  readonly trialPeriodDays: number | null;
  readonly subscriptionMetadata: Record<string, string>;
  readonly discountCouponId: string | null;
  readonly discountCouponPublicId: string | null;
  readonly discountPromotionCodeId: string | null;
  readonly discountPromotionCodePublicId: string | null;
  readonly automaticTax: boolean;
  readonly automaticTaxStatus: AutomaticTaxStatus | null;
  readonly taxCalculationId: string | null;
  readonly amountSubtotal: string;
  readonly amountDiscount: string;
  readonly amountTax: string | null;
  readonly amountTotal: string;
  readonly expiresAt: Date;
  readonly header: string | null;
  readonly description: string | null;
  readonly footer: string | null;
  readonly invoiceId: string | null;
  readonly invoicePublicId: string | null;
  readonly subscriptionId: string | null;
  readonly subscriptionPublicId: string | null;
  readonly finalizedAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const N = 'quotes';
const COLUMNS = {
  id: quotes.id,
  publicId: quotes.publicId,
  merchantId: quotes.merchantId,
  livemode: merchantLivemodeOf(quotes.merchantId),
  customerId: quotes.customerId,
  customerPublicId: requiredPublicIdOf('customers', N, 'customer_id'),
  testClockId: quotes.testClockId,
  testClockPublicId: publicIdOf('test_clocks', N, 'test_clock_id'),
  status: quotes.status,
  number: quotes.number,
  currency: quotes.currency,
  collectionMethod: quotes.collectionMethod,
  daysUntilDue: quotes.daysUntilDue,
  subscriptionDescription: quotes.subscriptionDescription,
  trialPeriodDays: quotes.trialPeriodDays,
  subscriptionMetadata: quotes.subscriptionMetadata,
  discountCouponId: quotes.discountCouponId,
  discountCouponPublicId: publicIdOf('coupons', N, 'discount_coupon_id'),
  discountPromotionCodeId: quotes.discountPromotionCodeId,
  discountPromotionCodePublicId: publicIdOf('promotion_codes', N, 'discount_promotion_code_id'),
  automaticTax: quotes.automaticTax,
  automaticTaxStatus: quotes.automaticTaxStatus,
  taxCalculationId: quotes.taxCalculationId,
  amountSubtotal: quotes.amountSubtotal,
  amountDiscount: quotes.amountDiscount,
  amountTax: quotes.amountTax,
  amountTotal: quotes.amountTotal,
  expiresAt: quotes.expiresAt,
  header: quotes.header,
  description: quotes.description,
  footer: quotes.footer,
  invoiceId: quotes.invoiceId,
  invoicePublicId: publicIdOf('invoices', N, 'invoice_id'),
  subscriptionId: quotes.subscriptionId,
  subscriptionPublicId: publicIdOf('subscriptions', N, 'subscription_id'),
  finalizedAt: quotes.finalizedAt,
  acceptedAt: quotes.acceptedAt,
  canceledAt: quotes.canceledAt,
  metadata: quotes.metadata,
  createdAt: quotes.createdAt,
  updatedAt: quotes.updatedAt,
} as const;

const toRow = (row: Record<string, unknown>) => row as unknown as QuoteRow;

export interface InsertQuoteParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly testClockId: string | null;
  readonly currency: CurrencyCode;
  readonly collectionMethod: CollectionMethod;
  readonly daysUntilDue: number | null;
  readonly subscriptionDescription: string | null;
  readonly trialPeriodDays: number | null;
  readonly subscriptionMetadata: Record<string, string>;
  readonly discountCouponId: string | null;
  readonly discountPromotionCodeId: string | null;
  readonly automaticTax: boolean;
  readonly expiresAt: Date;
  readonly header: string | null;
  readonly description: string | null;
  readonly footer: string | null;
  readonly metadata: Record<string, string>;
}

export async function insertQuote(tx: Transaction, params: InsertQuoteParams): Promise<QuoteRow> {
  const [row] = await tx
    .insert(quotes)
    .values({ id: uuidv7(), ...params })
    .returning(COLUMNS);
  if (!row) throw new Error('quote insert returned no row');
  return toRow(row);
}

export async function findQuoteForMerchant(
  db: DatabaseOrTransaction,
  publicId: string,
  merchantId: string,
): Promise<QuoteRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(quotes)
    .where(and(eq(quotes.publicId, publicId), eq(quotes.merchantId, merchantId)));
  return row ? toRow(row) : null;
}

export async function findQuoteById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<QuoteRow | null> {
  const [row] = await db.select(COLUMNS).from(quotes).where(eq(quotes.id, id));
  return row ? toRow(row) : null;
}

export async function lockQuote(tx: Transaction, id: string): Promise<QuoteRow | null> {
  const [row] = await tx.select(COLUMNS).from(quotes).where(eq(quotes.id, id)).for('update');
  return row ? toRow(row) : null;
}

export interface QuotePatch {
  readonly collectionMethod?: CollectionMethod;
  readonly daysUntilDue?: number | null;
  readonly subscriptionDescription?: string | null;
  readonly trialPeriodDays?: number | null;
  readonly subscriptionMetadata?: Record<string, string>;
  readonly discountCouponId?: string | null;
  readonly discountPromotionCodeId?: string | null;
  readonly automaticTax?: boolean;
  readonly automaticTaxStatus?: AutomaticTaxStatus | null;
  readonly taxCalculationId?: string | null;
  readonly amountSubtotal?: string;
  readonly amountDiscount?: string;
  readonly amountTax?: string | null;
  readonly amountTotal?: string;
  readonly expiresAt?: Date;
  readonly header?: string | null;
  readonly description?: string | null;
  readonly footer?: string | null;
  readonly number?: string;
  readonly invoiceId?: string;
  readonly subscriptionId?: string | null;
  readonly finalizedAt?: Date;
  readonly acceptedAt?: Date;
  readonly canceledAt?: Date;
  readonly metadata?: MetadataPatch;
}

function patchValues(patch: QuotePatch): Record<string, unknown> {
  const { metadata, ...rest } = patch;
  const values: Record<string, unknown> = { updatedAt: nowMs };
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) values[key] = value;
  if (metadata) values.metadata = mergedMetadata(quotes.metadata, metadata);
  return values;
}

/** A non-status write. `limit_exceeded` when the metadata patch would leave too many keys. */
export async function updateQuote(
  tx: DatabaseOrTransaction,
  id: string,
  patch: QuotePatch,
): Promise<QuoteRow | 'limit_exceeded'> {
  const where: SQL[] = [eq(quotes.id, id)];
  if (patch.metadata)
    where.push(metadataWithinLimit(mergedMetadata(quotes.metadata, patch.metadata)));
  const [row] = await tx
    .update(quotes)
    .set(patchValues(patch))
    .where(and(...where))
    .returning(COLUMNS);
  return row ? toRow(row) : 'limit_exceeded';
}

/** The status compare-and-swap. `stale` when another writer moved the row first. */
export async function setQuoteStatus(
  tx: Transaction,
  id: string,
  from: QuoteStatus,
  to: QuoteStatus,
  patch: QuotePatch = {},
): Promise<QuoteRow | 'stale'> {
  const [row] = await tx
    .update(quotes)
    .set({ ...patchValues(patch), status: to })
    .where(and(eq(quotes.id, id), eq(quotes.status, from)))
    .returning(COLUMNS);
  return row ? toRow(row) : 'stale';
}

export interface QuoteListFilters {
  readonly merchantId: string;
  readonly customerId?: string | undefined;
  readonly status?: QuoteStatus | undefined;
  readonly page: KeysetPage;
}

export async function listQuotes(
  db: DatabaseOrTransaction,
  filters: QuoteListFilters,
): Promise<{ data: QuoteRow[]; hasMore: boolean }> {
  const walk = keyset(quotes.id, quotes.createdAt, filters.page);
  const conditions: (SQL | undefined)[] = [eq(quotes.merchantId, filters.merchantId)];
  if (filters.customerId) conditions.push(eq(quotes.customerId, filters.customerId));
  if (filters.status) conditions.push(eq(quotes.status, filters.status));
  const rows = await db
    .select(COLUMNS)
    .from(quotes)
    .where(and(...conditions, walk.where))
    .orderBy(walk.orderBy)
    .limit(walk.limit);
  return walk.finish(rows.map(toRow));
}

/**
 * Open quotes past their `expires_at` on their OWN clock — a test clock's
 * frozen time, the database's `now()` otherwise. Ids only: the sweep re-reads
 * each under its lock and moves it by the status CAS.
 */
export async function findExpiredOpenQuotes(
  db: DatabaseOrTransaction,
  options: { readonly limit: number; readonly testClockId?: string },
): Promise<string[]> {
  const clockFilter = options.testClockId
    ? sql`and q.test_clock_id = ${options.testClockId}`
    : sql``;
  const rows = await db.execute<{ id: string }>(sql`
    select q.id from ${quotes} q
    left join ${testClocks} tc on tc.id = q.test_clock_id
    where q.status = 'open'
      and q.expires_at <= coalesce(tc.frozen_time, now())
      ${clockFilter}
    order by q.expires_at
    limit ${options.limit}`);
  return [...rows].map((row) => row.id);
}

// ---- Lines ---------------------------------------------------------------------

export interface QuoteLineRow {
  readonly id: string;
  readonly publicId: string;
  readonly quoteId: string;
  readonly merchantId: string;
  readonly position: number;
  readonly priceId: string;
  readonly pricePublicId: string;
  readonly productPublicId: string;
  readonly productImages: string[];
  readonly unitAmount: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly currency: CurrencyCode;
  readonly amountSubtotal: string;
  readonly amountDiscount: string;
  readonly amountTax: string;
  readonly amountTotal: string;
}

const LINE_COLUMNS = {
  id: quoteLineItems.id,
  publicId: quoteLineItems.publicId,
  quoteId: quoteLineItems.quoteId,
  merchantId: quoteLineItems.merchantId,
  position: quoteLineItems.position,
  priceId: quoteLineItems.priceId,
  pricePublicId: requiredPublicIdOf('prices', 'quote_line_items', 'price_id'),
  productPublicId: sql<string>`(${sql.raw(
    'select pr.public_id from prices p join products pr on pr.id = p.product_id where p.id = "quote_line_items"."price_id"',
  )})`,
  productImages: sql<string[]>`(${sql.raw(
    `select pr.images from prices p join products pr on pr.id = p.product_id where p.id = "quote_line_items"."price_id"`,
  )})`,
  unitAmount: sql<string | null>`(${sql.raw(
    `select case when p.billing_scheme = 'per_unit' then p.unit_amount end from prices p where p.id = "quote_line_items"."price_id"`,
  )})`,
  description: quoteLineItems.description,
  quantity: quoteLineItems.quantity,
  currency: quoteLineItems.currency,
  amountSubtotal: quoteLineItems.amountSubtotal,
  amountDiscount: quoteLineItems.amountDiscount,
  amountTax: quoteLineItems.amountTax,
  amountTotal: quoteLineItems.amountTotal,
} as const;

const toLine = (row: Record<string, unknown>) => row as unknown as QuoteLineRow;

export interface InsertQuoteLineParams {
  readonly publicId: string;
  readonly position: number;
  readonly priceId: string;
  readonly description: string;
  readonly quantity: number;
  readonly currency: CurrencyCode;
  readonly amountSubtotal: string;
  readonly amountDiscount: string;
  readonly amountTax: string;
  readonly amountTotal: string;
}

/** Replace every line of a quote with `lines`, in their order. */
export async function replaceQuoteLines(
  tx: Transaction,
  quote: { readonly id: string; readonly merchantId: string },
  lines: readonly InsertQuoteLineParams[],
): Promise<void> {
  await tx.delete(quoteLineItems).where(eq(quoteLineItems.quoteId, quote.id));
  if (lines.length === 0) return;
  await tx.insert(quoteLineItems).values(
    lines.map((line) => ({
      id: orderedId(),
      quoteId: quote.id,
      merchantId: quote.merchantId,
      ...line,
    })),
  );
}

/** A finalized line's frozen discount and tax. */
export async function setQuoteLineAmounts(
  tx: Transaction,
  id: string,
  amounts: { amountDiscount: string; amountTax: string; amountTotal: string },
): Promise<void> {
  await tx.update(quoteLineItems).set(amounts).where(eq(quoteLineItems.id, id));
}

export async function listQuoteLines(
  db: DatabaseOrTransaction,
  quoteId: string,
): Promise<QuoteLineRow[]> {
  const rows = await db
    .select(LINE_COLUMNS)
    .from(quoteLineItems)
    .where(eq(quoteLineItems.quoteId, quoteId))
    .orderBy(asc(quoteLineItems.position));
  return rows.map(toLine);
}

export async function listQuoteLinesFor(
  db: DatabaseOrTransaction,
  quoteIds: readonly string[],
): Promise<QuoteLineRow[]> {
  if (quoteIds.length === 0) return [];
  const rows = await db
    .select(LINE_COLUMNS)
    .from(quoteLineItems)
    .where(inArray(quoteLineItems.quoteId, [...quoteIds]))
    .orderBy(asc(quoteLineItems.quoteId), asc(quoteLineItems.position));
  return rows.map(toLine);
}

// ---- Numbering ---------------------------------------------------------------------

/**
 * Claim the merchant's next quote number — ONE statement, the receipt
 * counter's pattern: the upsert creates the billing settings with every
 * default when they do not exist yet, takes the row lock, and `RETURNING n -
 * 1` is the number this call owns. In the finalize transaction, so a rollback
 * gives it back.
 */
export async function claimQuoteNumber(
  tx: Transaction,
  merchant: { readonly id: string; readonly publicId: string },
): Promise<{ number: number; prefix: string }> {
  const [row] = await tx
    .insert(billingSettings)
    .values({
      merchantId: merchant.id,
      invoicePrefix: defaultInvoicePrefix(merchant.publicId),
      nextQuoteNumber: 2,
    })
    .onConflictDoUpdate({
      target: billingSettings.merchantId,
      set: { nextQuoteNumber: sql`${billingSettings.nextQuoteNumber} + 1` },
    })
    .returning({
      number: sql<number>`${billingSettings.nextQuoteNumber} - 1`,
      prefix: billingSettings.invoicePrefix,
    });
  if (!row) throw new Error('quote number claim returned no row');
  return row;
}

/** `QT-<prefix>-0001`: the invoice prefix, marked as a quote. */
export function formatQuoteNumber(prefix: string, number: number): string {
  return `QT-${prefix}-${String(number).padStart(4, '0')}`;
}
