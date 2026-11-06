import { intlLocale } from './messages';

/** FairCoin's base unit: 1 FAIR = 10⁸ m⊜. Intl has no currency code for it. */
const FAIR_DECIMALS = 8;

/** A FAIR amount from its base-unit string, in the payer's digits, exact (no float). */
export function formatFairAmount(baseUnits: string, payerLocale: string): string {
  const locale = intlLocale(payerLocale);
  if (!/^(0|[1-9]\d*)$/.test(baseUnits)) throw new RangeError('Invalid FairCoin amount');
  const units = BigInt(baseUnits);
  const scale = 10n ** BigInt(FAIR_DECIMALS);
  const whole = new Intl.NumberFormat(locale).format(units / scale);
  const fraction = (units % scale).toString().padStart(FAIR_DECIMALS, '0').replace(/0+$/, '');
  if (!fraction) return `${whole} FAIR`;
  const separator =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')
      ?.value ?? '.';
  return `${whole}${separator}${fraction} FAIR`;
}

/** Format quoted minor units only; this never converts currency or calculates a checkout price. */
export function formatCheckoutAmount(
  amountMinorUnits: number,
  currency: string,
  payerLocale: string,
): string {
  const locale = intlLocale(payerLocale);
  if (!Number.isSafeInteger(amountMinorUnits) || amountMinorUnits < 0)
    throw new RangeError('Invalid checkout amount');
  if (currency.toUpperCase() === 'FAIR') return formatFairAmount(String(amountMinorUnits), locale);
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits;
  if (digits === undefined) throw new Error('Currency precision unavailable');
  return formatter.format(amountMinorUnits / 10 ** digits);
}
