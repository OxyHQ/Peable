/**
 * Checkout totals (Orbit Phase 3) — what an order costs, from its lines, its
 * discount and its tax. Pure: no database, no clock (the instant is passed
 * in), no provider. Every amount comes from the catalog's one pricing module
 * (`services/catalog/pricing.ts`), so a line priced here and the same price on
 * an invoice can never disagree.
 *
 * ## The discount is the ORDER's, allocated to its lines
 *
 * A session carries at most one coupon (Stripe's rule), applied to the lines
 * it covers (`applies_to.products`, or every line):
 *
 * - `percent_off` is applied to each covered line and rounds half up ONCE per
 *   line (`discountAmount`), exactly as Stripe rounds per line;
 * - `amount_off` is capped at the covered subtotal and allocated to the
 *   covered lines in proportion to their amounts, the rounding remainder going
 *   to the lines with the largest fractional share (ties: the earlier line), so
 *   the line discounts always sum to the order's discount exactly.
 *
 * A promotion code's `minimum_amount` is judged against the ORDER subtotal, and
 * every refusal is named (`DiscountRefusal`) so checkout can tell the payer why.
 *
 * ## Tax
 *
 * Peable Tax prices each line AFTER its discount (`taxBases`). An exclusive
 * line's tax is added to the total; an inclusive line's is already inside its
 * amount and is only reported.
 */
import type { CurrencyCode } from '@peable.to/shared-types';
import type { StoredLinePrice } from '../../db/schema/checkout';
import { toBaseUnits } from '../../lib/money';
import {
  amountForQuantity,
  applyDiscount,
  type DiscountRefusal,
  discountAmount,
  type PricingCoupon,
  type PricingPrice,
  type PricingPromotionCode,
} from '../catalog/pricing';

/** A line as the totals need it. */
export interface TotalsLine {
  /** Stable key the caller maps back (the line's id, or its index before it has one). */
  readonly key: string;
  readonly currency: CurrencyCode;
  readonly price: StoredLinePrice;
  readonly quantity: number;
  /** INTERNAL product id, checked against a coupon's `applies_to`. */
  readonly productId: string | null;
}

export interface TotalsDiscount {
  readonly coupon: PricingCoupon;
  readonly promotionCode?: PricingPromotionCode | undefined;
}

export interface TotalsContext {
  readonly now: Date;
  readonly customerId?: string | undefined;
  readonly firstTimeTransaction?: boolean | undefined;
}

/** Peable Tax's answer per line key: its tax, and whether it is inside the amount. */
export type LineTaxes = ReadonlyMap<
  string,
  { readonly amountTax: bigint; readonly inclusive: boolean }
>;

export interface PricedLine {
  readonly key: string;
  readonly amountSubtotal: bigint;
  readonly amountDiscount: bigint;
  readonly amountTax: bigint;
  readonly amountTotal: bigint;
}

export interface OrderTotals {
  readonly lines: readonly PricedLine[];
  readonly amountSubtotal: bigint;
  readonly amountDiscount: bigint;
  readonly amountTax: bigint;
  readonly amountShipping: bigint;
  readonly amountTotal: bigint;
}

export type TotalsResult =
  | { readonly ok: true; readonly totals: OrderTotals }
  | { readonly ok: false; readonly reason: DiscountRefusal };

/** A stored line price as `pricing.ts` computes over it. */
export function pricingPriceOfLine(currency: CurrencyCode, price: StoredLinePrice): PricingPrice {
  if (price.billingScheme === 'tiered') {
    if (price.tiers === null || price.tiersMode === null) {
      throw new Error('a tiered line price without tiers');
    }
    return {
      currency,
      billingScheme: 'tiered',
      tiersMode: price.tiersMode,
      tiers: price.tiers.map((tier) => ({
        upTo: tier.up_to === null ? null : BigInt(tier.up_to),
        unitAmount: tier.unit_amount === null ? 0n : toBaseUnits(tier.unit_amount),
        flatAmount: tier.flat_amount === null ? 0n : toBaseUnits(tier.flat_amount),
      })),
    };
  }
  if (price.unitAmount === null) throw new Error('a per-unit line price without an amount');
  return {
    currency,
    billingScheme: 'per_unit',
    unitAmount: toBaseUnits(price.unitAmount),
    transformQuantity: price.transformQuantity
      ? {
          divideBy: BigInt(price.transformQuantity.divideBy),
          round: price.transformQuantity.round,
        }
      : null,
  };
}

/** Each line's amount before discount and tax. */
export function lineSubtotals(lines: readonly TotalsLine[]): Map<string, bigint> {
  return new Map(
    lines.map((line) => [
      line.key,
      amountForQuantity(pricingPriceOfLine(line.currency, line.price), BigInt(line.quantity)),
    ]),
  );
}

function covers(coupon: PricingCoupon, line: TotalsLine): boolean {
  return (
    coupon.appliesToProducts === null ||
    (line.productId !== null && coupon.appliesToProducts.includes(line.productId))
  );
}

/**
 * Allocate `total` over `weights` in proportion, largest remainder first —
 * the parts sum to `total` exactly.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((acc, w) => acc + w, 0n);
  if (sum === 0n || total === 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (total * w) / sum);
  let rest = total - parts.reduce((acc, p) => acc + p, 0n);
  const order = weights
    .map((w, index) => ({ index, remainder: (total * w) % sum }))
    .sort((a, b) =>
      b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index,
    );
  for (const { index } of order) {
    if (rest === 0n) break;
    if ((weights[index] ?? 0n) === 0n) continue;
    parts[index] = (parts[index] ?? 0n) + 1n;
    rest -= 1n;
  }
  return parts;
}

/** Each line's discount under `discount`, or the refusal. */
export function lineDiscounts(
  lines: readonly TotalsLine[],
  subtotals: ReadonlyMap<string, bigint>,
  discount: TotalsDiscount | null,
  context: TotalsContext,
): { ok: true; discounts: Map<string, bigint> } | { ok: false; reason: DiscountRefusal } {
  const zero = new Map(lines.map((line) => [line.key, 0n]));
  if (discount === null || lines.length === 0) return { ok: true, discounts: zero };
  const currency = lines[0]?.currency;
  if (currency === undefined) return { ok: true, discounts: zero };
  const covered = lines.filter((line) => covers(discount.coupon, line));
  const orderSubtotal = lines.reduce((acc, line) => acc + (subtotals.get(line.key) ?? 0n), 0n);
  const coveredSubtotal = covered.reduce((acc, line) => acc + (subtotals.get(line.key) ?? 0n), 0n);
  if (covered.length === 0) return { ok: false, reason: 'coupon_not_applicable' };
  const verdict = applyDiscount(
    {
      amount: coveredSubtotal,
      currency,
      now: context.now,
      productId: covered[0]?.productId ?? undefined,
      orderTotal: orderSubtotal,
      customerId: context.customerId,
      firstTimeTransaction: context.firstTimeTransaction,
    },
    discount.coupon,
    discount.promotionCode,
  );
  if (!verdict.ok) return verdict;
  const discounts = new Map(zero);
  if (discount.coupon.percentOffBps !== null) {
    for (const line of covered) {
      discounts.set(
        line.key,
        discountAmount(subtotals.get(line.key) ?? 0n, currency, discount.coupon),
      );
    }
  } else {
    const parts = allocate(
      verdict.discount,
      covered.map((line) => subtotals.get(line.key) ?? 0n),
    );
    covered.forEach((line, index) => {
      discounts.set(line.key, parts[index] ?? 0n);
    });
  }
  return { ok: true, discounts };
}

/** The amount Peable Tax prices for each line: its subtotal after its discount. */
export function taxBases(
  lines: readonly TotalsLine[],
  discount: TotalsDiscount | null,
  context: TotalsContext,
): { ok: true; bases: Map<string, bigint> } | { ok: false; reason: DiscountRefusal } {
  const subtotals = lineSubtotals(lines);
  const discounts = lineDiscounts(lines, subtotals, discount, context);
  if (!discounts.ok) return discounts;
  return {
    ok: true,
    bases: new Map(
      lines.map((line) => [
        line.key,
        (subtotals.get(line.key) ?? 0n) - (discounts.discounts.get(line.key) ?? 0n),
      ]),
    ),
  };
}

/** The order's totals. */
export function orderTotals(
  lines: readonly TotalsLine[],
  discount: TotalsDiscount | null,
  context: TotalsContext,
  taxes: LineTaxes = new Map(),
): TotalsResult {
  const subtotals = lineSubtotals(lines);
  const discounts = lineDiscounts(lines, subtotals, discount, context);
  if (!discounts.ok) return discounts;
  const priced: PricedLine[] = lines.map((line) => {
    const amountSubtotal = subtotals.get(line.key) ?? 0n;
    const amountDiscount = discounts.discounts.get(line.key) ?? 0n;
    const tax = taxes.get(line.key);
    const amountTax = tax?.amountTax ?? 0n;
    const exclusiveTax = tax && !tax.inclusive ? amountTax : 0n;
    return {
      key: line.key,
      amountSubtotal,
      amountDiscount,
      amountTax,
      amountTotal: amountSubtotal - amountDiscount + exclusiveTax,
    };
  });
  const sum = (pick: (line: PricedLine) => bigint) =>
    priced.reduce((acc, line) => acc + pick(line), 0n);
  return {
    ok: true,
    totals: {
      lines: priced,
      amountSubtotal: sum((l) => l.amountSubtotal),
      amountDiscount: sum((l) => l.amountDiscount),
      amountTax: sum((l) => l.amountTax),
      amountShipping: 0n,
      amountTotal: sum((l) => l.amountTotal),
    },
  };
}
