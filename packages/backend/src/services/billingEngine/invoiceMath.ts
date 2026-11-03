/**
 * Invoice arithmetic — pure, exact, signed (ADR 0018). The one answer to "what
 * does this invoice ask for": discounts per line, totals, and how the
 * customer's balance and pre-payment credit notes reduce what is due.
 *
 * Amounts are `bigint` base units and may be NEGATIVE (a proration credit). A
 * line's discount has the line's sign — a 50 % coupon halves a charge AND the
 * credit for its unused time, so a mid-period change never credits more than
 * the customer paid.
 */
import type { CurrencyCode } from '@peable.to/shared-types';
import { couponIsValid, discountAmount, type PricingCoupon } from '../catalog/pricing';

export interface MathLine {
  /** SIGNED, before discount (tax-inclusive when the price is). */
  readonly amount: bigint;
  readonly discountable: boolean;
  /** Internal product id, for `applies_to`. `null` for an ad-hoc amount. */
  readonly productId: string | null;
}

/**
 * Each line's discount (same sign as the line) under one coupon.
 *
 * - `percent_off`: every applicable line, rounded half up on its magnitude.
 * - `amount_off`: spread over the applicable CHARGE lines in proportion to
 *   their amounts (largest remainder, so the parts add up exactly), capped at
 *   their sum; credit lines are not reduced by a fixed amount.
 *
 * A coupon in another currency, or that applies to none of the lines, takes
 * nothing off. Validity at `now` is checked by the caller when the discount is
 * APPLIED; an applied discount keeps working until its `end`.
 */
export function lineDiscounts(
  lines: readonly MathLine[],
  coupon: Pick<PricingCoupon, 'percentOffBps' | 'amountOff' | 'currency' | 'appliesToProducts'>,
  currency: CurrencyCode,
): bigint[] {
  const applies = (line: MathLine) =>
    line.discountable &&
    (coupon.appliesToProducts === null ||
      (line.productId !== null && coupon.appliesToProducts.includes(line.productId)));
  if (coupon.percentOffBps !== null) {
    return lines.map((line) => {
      if (!applies(line) || line.amount === 0n) return 0n;
      const magnitude = line.amount < 0n ? -line.amount : line.amount;
      const off = discountAmount(magnitude, currency, coupon);
      return line.amount < 0n ? -off : off;
    });
  }
  if (coupon.amountOff === null || coupon.currency !== currency) return lines.map(() => 0n);
  const eligible = lines.map((line) => applies(line) && line.amount > 0n);
  const base = lines.reduce((sum, line, i) => (eligible[i] ? sum + line.amount : sum), 0n);
  if (base === 0n) return lines.map(() => 0n);
  const off = coupon.amountOff < base ? coupon.amountOff : base;
  return allocate(
    off,
    lines.map((line, i) => (eligible[i] ? line.amount : 0n)),
  );
}

/**
 * Split `total` over `weights` (non-negative) in proportion, by largest
 * remainder: the parts are integers that add up to `total` exactly, and ties
 * go to the earlier line so the answer is deterministic.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const parts = weights.map((w) => (total * w) / sum);
  let left = total - parts.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, remainder: (total * w) % sum }))
    .filter(({ i }) => (weights[i] ?? 0n) > 0n)
    .sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    parts[i] = (parts[i] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts;
}

/** Whether a discount still applies to an invoice dated `at`. */
export function discountActive(
  discount: { readonly start: Date; readonly end: Date | null },
  at: Date,
): boolean {
  return at.getTime() >= discount.start.getTime() && (discount.end === null || at < discount.end);
}

export { couponIsValid };

export interface TotalsInput {
  readonly lines: readonly {
    readonly amount: bigint;
    readonly discount: bigint;
    /** SIGNED; `inclusive` tax is already inside `amount`. */
    readonly taxExclusive: bigint;
    readonly taxInclusive: bigint;
  }[];
  /** `null`: tax not calculated yet (a draft with automatic tax). */
  readonly taxed: boolean;
}

export interface Totals {
  readonly subtotal: bigint;
  readonly subtotalExcludingTax: bigint;
  readonly totalDiscount: bigint;
  readonly tax: bigint | null;
  readonly total: bigint;
  readonly totalExcludingTax: bigint;
}

/**
 * - `subtotal` = Σ amount (before discounts);
 * - `total` = subtotal − discounts + exclusive tax;
 * - `total_excluding_tax` = total − all tax;
 * - `subtotal_excluding_tax` = subtotal − inclusive tax.
 */
export function invoiceTotals(input: TotalsInput): Totals {
  let subtotal = 0n;
  let totalDiscount = 0n;
  let exclusive = 0n;
  let inclusive = 0n;
  for (const line of input.lines) {
    subtotal += line.amount;
    totalDiscount += line.discount;
    exclusive += line.taxExclusive;
    inclusive += line.taxInclusive;
  }
  const total = subtotal - totalDiscount + exclusive;
  return {
    subtotal,
    subtotalExcludingTax: subtotal - inclusive,
    totalDiscount,
    tax: input.taxed ? exclusive + inclusive : null,
    total,
    totalExcludingTax: total - exclusive - inclusive,
  };
}

/**
 * Apply the customer's balance at finalization (Stripe's rule): `x = total +
 * balance`; the invoice asks for `max(0, x)` and the balance becomes `min(0,
 * x)`. A credit is consumed up to the total; a debt is added to it; a negative
 * total becomes more credit.
 */
export function applyBalance(
  total: bigint,
  balance: bigint,
): { amountDue: bigint; endingBalance: bigint; applied: bigint } {
  const x = total + balance;
  const amountDue = x > 0n ? x : 0n;
  const endingBalance = x < 0n ? x : 0n;
  return { amountDue, endingBalance, applied: endingBalance - balance };
}

/** `max(0, a − b)`. */
export function remaining(due: bigint, paid: bigint, credited: bigint): bigint {
  const left = due - paid - credited;
  return left > 0n ? left : 0n;
}

/** A bigint to a signed wire amount — `-0` never exists. */
export function signed(value: bigint): string {
  return value.toString();
}

/** A signed wire amount to a bigint, through the one pattern. */
export function parseSigned(value: string): bigint {
  if (!/^(0|-?[1-9][0-9]*)$/.test(value)) throw new Error(`invalid signed amount: ${value}`);
  return BigInt(value);
}
