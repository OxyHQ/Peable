/** Format quoted minor units only; this never converts currency or calculates a checkout price. */
export function formatCheckoutAmount(
  amountMinorUnits: number,
  currency: string,
  locale: string,
): string {
  if (!Number.isSafeInteger(amountMinorUnits) || amountMinorUnits < 0)
    throw new RangeError('Invalid checkout amount');
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits;
  if (digits === undefined) throw new Error('Currency precision unavailable');
  return formatter.format(amountMinorUnits / 10 ** digits);
}
