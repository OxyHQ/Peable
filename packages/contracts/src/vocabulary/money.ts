// Money vocabulary. Every monetary value moves through the gateway as a
// canonical integer string in the currency's SMALLEST unit — m⊜ for FairCoin,
// cents for a fiat currency — so no float ever touches one.
//
// Zod-free on purpose: `@peable.to/contracts/vocabulary` is what a bundle that
// must stay small (the wallet, the hosted checkout) imports at runtime, through
// `@peable.to/shared-types`.

/**
 * The currencies this gateway can denominate a payment in: FairCoin on the
 * chain rail, and on the card rail the fiat set the provider settles for the
 * payment methods Orbit offers (cards, wallets, SEPA Debit, iDEAL, Bancontact,
 * EPS). A local method narrows it further per payment
 * (`PAYMENT_METHOD_CURRENCIES` in `paymentMethodConfiguration.ts`).
 *
 * A closed set, and the database mirrors it as a CHECK
 * (`db/schema/valueSets.ts`). ADR 0001 D4: the scale of an amount is a property
 * of its currency and is NOT implied by the field's type, which is why
 * {@link CURRENCY_DECIMALS} exists and why {@link UNITS_PER_COIN} must never be
 * used to interpret a fiat amount.
 */
export const CURRENCY_CODES = [
  'FAIR',
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'CAD',
  'AUD',
  'JPY',
] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** Whether an arbitrary string is a currency this gateway knows. */
export function isCurrencyCode(value: string): value is CurrencyCode {
  return (CURRENCY_CODES as readonly string[]).includes(value);
}

/**
 * How many decimal places each currency's smallest unit represents — i.e. an
 * amount of `1` means `10^-decimals` of one whole unit.
 *
 * ISO 4217's minor units for every fiat member (JPY has none). FairCoin's 8 is
 * a consensus constant and is pinned against {@link UNITS_PER_COIN} by this
 * package's own tests, so the two spellings of one fact cannot drift.
 */
export const CURRENCY_DECIMALS: Readonly<Record<CurrencyCode, number>> = Object.freeze({
  FAIR: 8,
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  CZK: 2,
  CAD: 2,
  AUD: 2,
  // A zero-decimal currency: an amount of `1` is one yen, never a hundredth of
  // one. The provider counts JPY the same way, so the base unit crosses as is.
  JPY: 0,
});

/** A currency the card rail can denominate a payment in. */
export type FiatCurrencyCode = Exclude<CurrencyCode, 'FAIR'>;

/** The fiat members — every currency the card rail can denominate a payment in. */
export const FIAT_CURRENCY_CODES: readonly FiatCurrencyCode[] = CURRENCY_CODES.filter(
  (code): code is FiatCurrencyCode => code !== 'FAIR',
);

/** The decimal places of `currency`'s smallest unit. */
export function decimalsFor(currency: CurrencyCode): number {
  return CURRENCY_DECIMALS[currency];
}

/**
 * Frozen FairCoin consensus constant (smallest units per FAIR). Mirrors
 * `@fairco.in/core`'s branding.ts; inlined to keep this module zero-dependency
 * for a clean CJS+ESM publish — must stay a bigint, never converted to number.
 *
 * FAIRCOIN ONLY. A fiat amount has its own scale (`CURRENCY_DECIMALS`), and
 * dividing a EUR amount by this constant is off by six orders of magnitude with
 * nothing failing.
 */
export const UNITS_PER_COIN = 100_000_000n;

/** The spelling of a base-unit amount: digits, no sign, no leading zeros but `0`. */
export const BASE_UNIT_PATTERN = /^(0|[1-9][0-9]*)$/;

/** A signed base-unit amount (a customer balance, a balance transaction's net). */
export const SIGNED_BASE_UNIT_PATTERN = /^(0|-?[1-9][0-9]*)$/;

/**
 * True only for a canonical non-negative integer string in the currency's
 * smallest unit: one or more decimal digits, no sign, no decimal point, no
 * leading zeros (except the literal "0"). Floats and negatives are rejected.
 *
 * Currency-agnostic on purpose — the pattern is about the SPELLING of an
 * amount, not its scale, and the same one is restated as a CHECK in the
 * database (`BASE_UNIT_STRING_PATTERN`), byte-identical.
 */
export function isBaseUnitString(s: string): boolean {
  return BASE_UNIT_PATTERN.test(s);
}

/** FairCoin network identifier, mirroring `@fairco.in/core`'s `NetworkType`. */
export const NETWORK_TYPES = ['mainnet', 'testnet'] as const;
export type NetworkType = (typeof NETWORK_TYPES)[number];
