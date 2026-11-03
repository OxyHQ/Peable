/**
 * Drafting invoice lines (ADR 0018): what a subscription period, a proration
 * or a pending invoice item puts on an invoice, priced with the catalog's one
 * pricing module (`services/catalog/pricing.ts`) and discounted with
 * `invoiceMath.ts`. In memory until written — so a subscription's first
 * invoice can be fully priced and TAXED before anything is stored.
 */
import { createHash } from 'node:crypto';
import type { CurrencyCode } from '@peable.to/shared-types';
import { findPricesByRowIds, type PriceRow } from '../../db/catalog/priceRepository';
import { findProductsByIds, type ProductRow } from '../../db/catalog/productRepository';
import type {
  InsertLineParams,
  InvoiceItemRow,
  InvoiceLineRow,
} from '../../db/billingEngine/invoiceRepository';
import type { SubscriptionItemRow } from '../../db/billingEngine/subscriptionRepository';
import type { DatabaseOrTransaction } from '../../db/postgres';
import { orderedId } from '../../db/billingEngine/columns';
import type { InvoiceLineType } from '../../db/schema/valueSets';
import { newId } from '../../lib/ids';
import { amountForQuantity } from '../catalog/pricing';
import { pricingCouponOf, pricingPriceOf } from '../catalog/pricingRows';
import type { CouponRow } from '../../db/catalog/couponRepository';
import { lineDiscounts } from './invoiceMath';
import { prorate } from './periods';

export interface DraftLine {
  readonly id: string;
  readonly publicId: string;
  readonly type: InvoiceLineType;
  readonly subscriptionId: string | null;
  readonly subscriptionItemId: string | null;
  readonly invoiceItemId: string | null;
  readonly priceId: string | null;
  readonly quantity: number | null;
  /** SIGNED, before discount. */
  readonly amount: bigint;
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

export interface Catalog {
  readonly prices: Map<string, PriceRow>;
  readonly products: Map<string, ProductRow>;
}

/** The prices and their products a set of lines names, in two reads. */
export async function loadCatalog(
  db: DatabaseOrTransaction,
  priceIds: readonly (string | null)[],
): Promise<Catalog> {
  const prices = await findPricesByRowIds(
    db,
    priceIds.filter((id): id is string => id !== null),
  );
  const products = await findProductsByIds(
    db,
    prices.map((price) => price.productId),
  );
  return {
    prices: new Map(prices.map((price) => [price.id, price])),
    products: new Map(products.map((product) => [product.id, product])),
  };
}

export function priceOf(catalog: Catalog, priceId: string): PriceRow {
  const price = catalog.prices.get(priceId);
  if (!price) throw new Error(`price ${priceId} vanished`);
  return price;
}

export function productOfPrice(catalog: Catalog, priceId: string | null): ProductRow | null {
  if (priceId === null) return null;
  return catalog.products.get(priceOf(catalog, priceId).productId) ?? null;
}

function newLineIds(): { id: string; publicId: string } {
  return { id: orderedId(), publicId: newId('il') };
}

/** The full amount of one item for one period: price × quantity. */
export function itemPeriodAmount(price: PriceRow, quantity: number): bigint {
  return amountForQuantity(pricingPriceOf(price), BigInt(quantity));
}

/**
 * The licensed lines of a subscription for `[start, end)`.
 *
 * - `trial`: each item at zero ("Trial period for …").
 * - `stub`: the first period ends early at a future billing anchor — each item
 *   is prorated over the whole interval it would otherwise span (or zero with
 *   `proration_behavior: none`).
 * - metered items are billed in arrears and are not here.
 */
export function periodLines(
  catalog: Catalog,
  subscriptionId: string,
  items: readonly SubscriptionItemRow[],
  period: { readonly start: Date; readonly end: Date },
  options: {
    readonly trial?: boolean;
    readonly stub?: { readonly wholeMs: number; readonly prorate: boolean } | null;
  } = {},
): DraftLine[] {
  const lines: DraftLine[] = [];
  for (const item of items) {
    const price = priceOf(catalog, item.priceId);
    if (price.recurringUsageType === 'metered') continue;
    const product = productOfPrice(catalog, price.id);
    const name = product?.name ?? 'item';
    let amount = itemPeriodAmount(price, item.quantity);
    let description = `${item.quantity} × ${name}`;
    let proration = false;
    if (options.trial) {
      amount = 0n;
      description = `Trial period for ${name}`;
    } else if (options.stub) {
      amount = options.stub.prorate
        ? prorate(amount, period.end.getTime() - period.start.getTime(), options.stub.wholeMs)
        : 0n;
      description = `Remaining time on ${item.quantity} × ${name}`;
      proration = options.stub.prorate;
    }
    lines.push({
      ...newLineIds(),
      type: 'subscription',
      subscriptionId,
      subscriptionItemId: item.id,
      invoiceItemId: null,
      priceId: price.id,
      quantity: item.quantity,
      amount,
      currency: price.currency,
      description,
      discountable: true,
      periodStart: period.start,
      periodEnd: period.end,
      proration,
      creditsLineId: null,
      metered: false,
      metadata: {},
    });
  }
  return lines;
}

/** One metered item's line for a period, its quantity the meter's aggregate. */
export function meteredLine(
  catalog: Catalog,
  subscriptionId: string,
  item: SubscriptionItemRow,
  period: { readonly start: Date; readonly end: Date },
  usage: bigint,
): DraftLine {
  const price = priceOf(catalog, item.priceId);
  const product = productOfPrice(catalog, price.id);
  const quantity =
    usage > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(usage);
  return {
    ...newLineIds(),
    type: 'subscription',
    subscriptionId,
    subscriptionItemId: item.id,
    invoiceItemId: null,
    priceId: price.id,
    quantity,
    amount: amountForQuantity(pricingPriceOf(price), usage),
    currency: price.currency,
    description: `${quantity} × ${product?.name ?? 'usage'} (metered)`,
    discountable: true,
    periodStart: period.start,
    periodEnd: period.end,
    proration: false,
    creditsLineId: null,
    metered: true,
    metadata: {},
  };
}

/** A pending invoice item, drafted onto an invoice. */
export function invoiceItemLine(item: InvoiceItemRow): DraftLine {
  return {
    ...newLineIds(),
    type: 'invoiceitem',
    subscriptionId: item.subscriptionId,
    subscriptionItemId: item.subscriptionItemId,
    invoiceItemId: item.id,
    priceId: item.priceId,
    quantity: item.quantity,
    amount: BigInt(item.amount),
    currency: item.currency,
    description: item.description,
    discountable: item.discountable,
    periodStart: item.periodStart,
    periodEnd: item.periodEnd,
    proration: item.proration,
    creditsLineId: item.creditsLineId,
    metered: false,
    metadata: item.metadata,
  };
}

/** A stored line, as drafting computes over it. */
export function draftLineOf(row: InvoiceLineRow): DraftLine {
  return {
    id: row.id,
    publicId: row.publicId,
    type: row.type,
    subscriptionId: row.subscriptionId,
    subscriptionItemId: row.subscriptionItemId,
    invoiceItemId: row.invoiceItemId,
    priceId: row.priceId,
    quantity: row.quantity,
    amount: BigInt(row.amount),
    currency: row.currency,
    description: row.description,
    discountable: row.discountable,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    proration: row.proration,
    creditsLineId: row.creditsLineId,
    metered: row.metered,
    metadata: row.metadata,
  };
}

export function toInsertLine(
  line: DraftLine,
  invoiceId: string,
  merchantId: string,
): InsertLineParams {
  return {
    id: line.id,
    publicId: line.publicId,
    merchantId,
    invoiceId,
    type: line.type,
    subscriptionId: line.subscriptionId,
    subscriptionItemId: line.subscriptionItemId,
    invoiceItemId: line.invoiceItemId,
    priceId: line.priceId,
    quantity: line.quantity,
    amount: line.amount.toString(),
    currency: line.currency,
    description: line.description,
    discountable: line.discountable,
    periodStart: line.periodStart,
    periodEnd: line.periodEnd,
    proration: line.proration,
    creditsLineId: line.creditsLineId,
    metered: line.metered,
    metadata: line.metadata,
  };
}

/** Each line's discount under the invoice's coupon (zero everywhere without one). */
export function discountsFor(
  lines: readonly DraftLine[],
  catalog: Catalog,
  coupon: CouponRow | null,
  currency: CurrencyCode,
): bigint[] {
  if (coupon === null) return lines.map(() => 0n);
  return lineDiscounts(
    lines.map((line) => ({
      amount: line.amount,
      discountable: line.discountable,
      productId: productOfPrice(catalog, line.priceId)?.id ?? null,
    })),
    pricingCouponOf(coupon),
    currency,
  );
}

/**
 * The fingerprint of what a finalization priced: every line's identity and
 * amount, the coupon and the currency. A draft that changed between the tax
 * calculation and the finalize transaction no longer matches, and the
 * finalize refuses rather than freeze a tax computed for other lines.
 */
export function linesDigest(
  lines: readonly DraftLine[],
  couponId: string | null,
  currency: CurrencyCode,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        currency,
        couponId,
        lines.map((line) => [line.publicId, line.amount.toString(), line.creditsLineId]),
      ]),
    )
    .digest('hex');
}
