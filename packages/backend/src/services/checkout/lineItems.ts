/**
 * From a request's `line_items` to priced lines (Orbit Phase 3).
 *
 * A catalog line names a `price_…` of the merchant, ACTIVE, of an active
 * product; an inline line (`price_data`) names an active product or carries
 * `product_data`. Either way the line keeps a snapshot of the price it was
 * priced with (`StoredLinePrice`) — prices are immutable, so for a catalog
 * line the snapshot IS the price — and the product's name, images and tax
 * code as the payer will see them.
 */
import type { CheckoutLineItem, CurrencyCode, PriceTaxBehavior } from '@peable.to/shared-types';
import {
  findPriceForMerchant,
  findPricesByIds,
  type PriceRow,
} from '../../db/catalog/priceRepository';
import {
  findProductForMerchant,
  findProductsByPublicIds,
  type ProductRow,
} from '../../db/catalog/productRepository';
import type { DatabaseOrTransaction } from '../../db/postgres';
import type { NewLineItem } from '../../db/payments/checkoutSessionRepository';
import type { PaymentLinkLineItemRow } from '../../db/payments/paymentLinkRepository';
import type { StoredLinePrice } from '../../db/schema/checkout';
import { fromBaseUnits } from '../../lib/money';
import { maxBaseUnits } from '@peable.to/contracts';
import { invalid } from './errors';
import { adjustableBoundsOf } from './params';
import { lineSubtotals } from './totals';

export interface RequestedLine {
  readonly price?: string | undefined;
  readonly price_data?:
    | {
        readonly currency: CurrencyCode;
        readonly unit_amount: string;
        readonly product?: string | undefined;
        readonly product_data?:
          | {
              readonly name: string;
              readonly description?: string | undefined;
              readonly images?: string[] | undefined;
              readonly tax_code?: string | undefined;
            }
          | undefined;
        readonly recurring?:
          | {
              readonly interval: 'day' | 'week' | 'month' | 'year';
              readonly interval_count?: number | undefined;
            }
          | undefined;
        readonly tax_behavior?: PriceTaxBehavior | undefined;
      }
    | undefined;
  readonly quantity: number;
  readonly adjustable_quantity?:
    | {
        readonly enabled: boolean;
        readonly minimum?: number | undefined;
        readonly maximum?: number | undefined;
      }
    | undefined;
}

/** A line before pricing: what it sells and how it is priced. */
export interface ResolvedLine {
  readonly priceId: string | null;
  readonly productId: string | null;
  readonly description: string;
  readonly images: readonly string[];
  readonly taxCode: string | null;
  readonly taxBehavior: PriceTaxBehavior;
  readonly currency: CurrencyCode;
  readonly price: StoredLinePrice;
  readonly recurring: boolean;
  readonly quantity: number;
  readonly adjustable: { readonly minimum: number; readonly maximum: number } | null;
}

export function linePriceOf(price: PriceRow): StoredLinePrice {
  return {
    billingScheme: price.billingScheme,
    unitAmount: price.unitAmount,
    tiers: price.tiers,
    tiersMode: price.tiersMode,
    transformQuantity:
      price.transformQuantityDivideBy !== null && price.transformQuantityRound !== null
        ? { divideBy: price.transformQuantityDivideBy, round: price.transformQuantityRound }
        : null,
    recurring:
      price.recurringInterval !== null
        ? { interval: price.recurringInterval, interval_count: price.recurringIntervalCount ?? 1 }
        : null,
  };
}

function catalogLine(
  price: PriceRow,
  product: ProductRow,
  quantity: number,
  adjustable: ResolvedLine['adjustable'],
): ResolvedLine {
  return {
    priceId: price.id,
    productId: product.id,
    description: product.name,
    images: product.images.slice(0, 8),
    taxCode: product.taxCode,
    taxBehavior: price.taxBehavior,
    currency: price.currency,
    price: linePriceOf(price),
    recurring: price.type === 'recurring',
    quantity,
    adjustable,
  };
}

/** Resolve a session's requested lines against the merchant's catalog. */
export async function resolveRequestedLines(
  db: DatabaseOrTransaction,
  merchantId: string,
  requested: readonly RequestedLine[],
): Promise<ResolvedLine[]> {
  const lines: ResolvedLine[] = [];
  for (const [index, line] of requested.entries()) {
    const param = `line_items[${index}]`;
    const adjustable = adjustableBoundsOf(line.adjustable_quantity);
    if (line.price !== undefined) {
      const price = await findPriceForMerchant(db, line.price, merchantId);
      if (!price)
        throw invalid('resource_missing', `no such price: '${line.price}'`, `${param}[price]`);
      if (!price.active) {
        throw invalid(
          'parameter_invalid',
          'the price is archived and cannot be sold',
          `${param}[price]`,
        );
      }
      const [product] = await findProductsByPublicIds(db, merchantId, [price.productPublicId]);
      if (!product?.active) {
        throw invalid('parameter_invalid', 'the price’s product is archived', `${param}[price]`);
      }
      lines.push(catalogLine(price, product, line.quantity, adjustable));
      continue;
    }
    const data = line.price_data;
    if (!data)
      throw invalid('parameter_missing', 'price or price_data is required', `${param}[price]`);
    if (BigInt(data.unit_amount) > maxBaseUnits(data.currency)) {
      throw invalid(
        'parameter_invalid',
        `must be at most ${maxBaseUnits(data.currency)}`,
        `${param}[price_data][unit_amount]`,
      );
    }
    let product: ProductRow | null = null;
    if (data.product !== undefined) {
      product = await findProductForMerchant(db, data.product, merchantId);
      if (!product) {
        throw invalid(
          'resource_missing',
          `no such product: '${data.product}'`,
          `${param}[price_data][product]`,
        );
      }
      if (!product.active) {
        throw invalid(
          'parameter_invalid',
          'the product is archived',
          `${param}[price_data][product]`,
        );
      }
    }
    const inline = data.product_data;
    lines.push({
      priceId: null,
      productId: product?.id ?? null,
      description: product?.name ?? inline?.name ?? '',
      images: (product?.images ?? inline?.images ?? []).slice(0, 8),
      taxCode: product?.taxCode ?? inline?.tax_code ?? null,
      taxBehavior: data.tax_behavior ?? 'unspecified',
      currency: data.currency,
      price: {
        billingScheme: 'per_unit',
        unitAmount: data.unit_amount,
        tiers: null,
        tiersMode: null,
        transformQuantity: null,
        recurring: data.recurring
          ? {
              interval: data.recurring.interval,
              interval_count: data.recurring.interval_count ?? 1,
            }
          : null,
      },
      recurring: data.recurring !== undefined,
      quantity: line.quantity,
      adjustable,
    });
  }
  const currency = lines[0]?.currency;
  lines.forEach((line, index) => {
    if (line.currency !== currency) {
      throw invalid(
        'parameter_invalid',
        `every line item must be in one currency (${currency}); this one is ${line.currency}`,
        `line_items[${index}]`,
      );
    }
  });
  return lines;
}

/** Priced lines, ready to store. */
export function toNewLineItems(
  lines: readonly ResolvedLine[],
  priced: ReadonlyMap<
    string,
    { amountSubtotal: bigint; amountDiscount: bigint; amountTax: bigint; amountTotal: bigint }
  >,
): NewLineItem[] {
  return lines.map((line, index) => {
    const amounts = priced.get(String(index));
    if (!amounts) throw new Error(`line ${index} was not priced`);
    return {
      priceId: line.priceId,
      productId: line.productId,
      description: line.description,
      images: line.images,
      taxCode: line.taxCode,
      taxBehavior: line.taxBehavior,
      currency: line.currency,
      price: line.price,
      quantity: line.quantity,
      adjustable: line.adjustable,
      amountSubtotal: fromBaseUnits(amounts.amountSubtotal),
      amountDiscount: fromBaseUnits(amounts.amountDiscount),
      amountTax: fromBaseUnits(amounts.amountTax),
      amountTotal: fromBaseUnits(amounts.amountTotal),
    };
  });
}

/** A payment link's stored lines, resolved to their prices and products. */
export async function resolveLinkLines(
  db: DatabaseOrTransaction,
  merchantId: string,
  rows: readonly PaymentLinkLineItemRow[],
): Promise<{ row: PaymentLinkLineItemRow; price: PriceRow; product: ProductRow }[]> {
  const prices = new Map(
    (
      await findPricesByIds(
        db,
        merchantId,
        rows.map((row) => row.priceId),
      )
    ).map((p) => [p.id, p]),
  );
  const products = new Map(
    (
      await findProductsByPublicIds(
        db,
        merchantId,
        [...prices.values()].map((p) => p.productPublicId),
      )
    ).map((p) => [p.id, p]),
  );
  return rows.map((row) => {
    const price = prices.get(row.priceId);
    const product = price ? products.get(price.productId) : undefined;
    if (!price || !product)
      throw new Error(`payment link line ${row.id} names an unreadable price`);
    return { row, price, product };
  });
}

/** A link line as a session line — the session copies the link's prices. */
export function sessionLineOfLink(entry: {
  row: PaymentLinkLineItemRow;
  price: PriceRow;
  product: ProductRow;
}): ResolvedLine {
  return catalogLine(
    entry.price,
    entry.product,
    entry.row.quantity,
    entry.row.adjustableEnabled &&
      entry.row.adjustableMinimum !== null &&
      entry.row.adjustableMaximum !== null
      ? { minimum: entry.row.adjustableMinimum, maximum: entry.row.adjustableMaximum }
      : null,
  );
}

/** A link line as the `item` a link's DTO shows: its price at its default quantity. */
export function linkLineItemDTO(
  linkPublicId: string,
  entry: { row: PaymentLinkLineItemRow; price: PriceRow; product: ProductRow },
): CheckoutLineItem {
  const line = sessionLineOfLink(entry);
  const subtotal =
    lineSubtotals([
      {
        key: '0',
        currency: line.currency,
        price: line.price,
        quantity: line.quantity,
        productId: line.productId,
      },
    ]).get('0') ?? 0n;
  const amount = fromBaseUnits(subtotal);
  return {
    // A link line has no `li_…` of its own; it is named by the link and its place.
    id: `${linkPublicId}_li_${entry.row.position}`,
    object: 'item',
    description: line.description,
    price: entry.price.publicId,
    product: entry.product.publicId,
    images: [...line.images],
    quantity: line.quantity,
    adjustable_quantity: line.adjustable
      ? { enabled: true, minimum: line.adjustable.minimum, maximum: line.adjustable.maximum }
      : null,
    currency: line.currency,
    unit_amount: line.price.billingScheme === 'per_unit' ? line.price.unitAmount : null,
    amount_subtotal: amount,
    amount_discount: '0',
    amount_tax: '0',
    amount_total: amount,
  };
}
