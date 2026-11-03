// Formatting a base-unit amount for display — the ONLY arithmetic this app does
// on money, and it is presentation: every total is the gateway's.
import { formatFair } from '@fairco.in/core';
import { type CurrencyCode, decimalsFor } from '@peable.to/shared-types';

/** `"1999"` EUR → `€19.99` (in the page's locale); FAIR keeps its own formatting. */
export function formatAmount(amount: string, currency: CurrencyCode, locale: string): string {
  if (currency === 'FAIR') return `${formatFair(BigInt(amount))} FAIR`;
  const decimals = decimalsFor(currency);
  const units = BigInt(amount);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = (magnitude / scale).toString();
  const fraction = (magnitude % scale).toString().padStart(decimals, '0');
  const value = Number(`${negative ? '-' : ''}${whole}${decimals > 0 ? `.${fraction}` : ''}`);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Whether a base-unit amount is zero (`"0"`). */
export function isZero(amount: string): boolean {
  return BigInt(amount) === 0n;
}
