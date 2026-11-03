// Formatting a base-unit amount for display — the ONLY arithmetic this app does
// on money, and it is presentation: every total is the gateway's.
import { formatFair } from '@fairco.in/core';
import { type CurrencyCode, decimalsFor, isCurrencyCode } from '@peable.to/shared-types';

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

// The billing pages (ADR 0018): exact string arithmetic for a SIGNED base-unit
// amount — it never becomes a float, so `"100000000"` FAIR is exactly
// `1.00000000 FAIR` and a credit line (`"-500"`) keeps its sign.
export function formatBillingAmount(amount: string, currency: string): string {
  const negative = amount.startsWith('-');
  const digits = negative ? amount.slice(1) : amount;
  const decimals = isCurrencyCode(currency) ? decimalsFor(currency as CurrencyCode) : 2;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals > 0 ? `.${padded.slice(padded.length - decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction} ${currency}`;
}

/** A Unix-seconds instant as a calendar date (UTC), or an em dash when absent. */
export function formatDate(seconds: number | null): string {
  if (seconds === null) return '—';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
