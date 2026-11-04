/**
 * The arithmetic fake tax providers answer with, exact in bigint base units —
 * the same no-float rule the code under test keeps (`CONVENTIONS.md` §Money).
 */

/** `value × percent / 100`, rounded half up: the tax added on top of a net amount. */
export function exclusiveTaxOf(value: bigint, percent: bigint): bigint {
  return (2n * value * percent + 100n) / 200n;
}

/** The tax inside a tax-inclusive `gross`: `gross − round(gross × 100 / (100 + percent))`. */
export function inclusiveTaxOf(gross: bigint, percent: bigint): bigint {
  const divisor = 100n + percent;
  return gross - (200n * gross + divisor) / (2n * divisor);
}
