import type { BillingFinalInvoiceAuthority, BillingTaxQuote } from './billing';

/** Canonical JSON v1: lexicographic object keys, array order preserved, UTF-8.
 * Only finite safe integer amounts and plain JSON values are permitted. */
function encode(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid authority JSON');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${encode(object[key])}`).join(',')}}`;
}

export function canonicalBillingAuthority(authority: Pick<BillingFinalInvoiceAuthority, 'schemaVersion' | 'source' | 'invoice' | 'method'>): string {
  return encode({ schemaVersion: authority.schemaVersion, source: authority.source, invoice: authority.invoice, method: authority.method });
}
export function canonicalBillingTaxQuote(authority: Pick<BillingTaxQuote, 'schemaVersion' | 'source' | 'quote'>): string {
  return encode({ schemaVersion: authority.schemaVersion, source: authority.source, quote: authority.quote });
}
