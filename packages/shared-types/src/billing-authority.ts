import type { BillingFinalInvoiceAuthority, BillingTaxQuote } from './billing';

/** Canonical JSON v1: lexicographic object keys, array order preserved, UTF-8.
 * Only finite safe integer amounts and plain JSON values are permitted. */
function encode(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('Invalid authority JSON');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
    .join(',')}}`;
}

export function canonicalBillingAuthority(
  authority: Pick<BillingFinalInvoiceAuthority, 'schemaVersion' | 'source' | 'invoice' | 'method'>,
): string {
  return encode({
    schemaVersion: authority.schemaVersion,
    source: authority.source,
    invoice: authority.invoice,
    method: authority.method,
  });
}
export function canonicalBillingTaxQuote(
  authority: Pick<BillingTaxQuote, 'schemaVersion' | 'source' | 'quote'>,
): string {
  return encode({
    schemaVersion: authority.schemaVersion,
    source: authority.source,
    quote: authority.quote,
  });
}

/**
 * The PUBLIC halves of the Ed25519 keys production Peable signs billing
 * authority with (signed tax quotes and final invoice authorities), by key id.
 * Pin these as the SDK's `invoiceAuthorityKeys` / `taxQuoteAuthorityKeys`.
 *
 * The private halves exist only in Peable's production secret store and reach
 * the gateway as a mounted file (`PEABLE_BILLING_INVOICE_PRIVATE_KEY_FILE`); the
 * gateway refuses to sign with a key whose public half is not listed here. A
 * rotation adds the new id beside the old one, and the old id is removed only
 * after every authority it signed has been consumed.
 */
export const PEABLE_BILLING_AUTHORITY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'peable-billing-2026-10':
    '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAt6lkqirzUxlnt22igH+lRWW7+dRRlk4QK0a2wIKfnCA=\n-----END PUBLIC KEY-----\n',
});
