// Payment method breadth on the card rail (`pmc_…`, `pmd_…`). Zod-free.

import { FIAT_CURRENCY_CODES, type FiatCurrencyCode } from './money';

/**
 * The methods a configuration can turn on.
 *
 * `apple_pay` and `google_pay` are WALLETS over a card: a payment made with one
 * is a `card` payment, so they appear here and never in a PaymentIntent's
 * `payment_method_types`. `bizum` is listed because merchants ask for it and the
 * honest answer is a reason, not an absence: the provider does not offer it.
 *
 * Deliberately absent: the provider's own consumer wallet (its brand on Orbit's
 * checkout, `payment-provider-boundary.md`) and giropay (discontinued by the
 * scheme).
 */
export const PAYMENT_METHOD_CONFIGURATION_TYPES = [
  'card',
  'apple_pay',
  'google_pay',
  'sepa_debit',
  'ideal',
  'bancontact',
  'eps',
  'bizum',
] as const;
export type PaymentMethodConfigurationType = (typeof PAYMENT_METHOD_CONFIGURATION_TYPES)[number];

/**
 * Why a method cannot be offered whatever the merchant chooses.
 *
 *  - `provider_unsupported` — the processing provider does not offer it;
 *  - `requires_card` — a wallet rides on card payments, and card is off.
 */
export const PAYMENT_METHOD_UNAVAILABLE_REASONS = [
  'provider_unsupported',
  'requires_card',
] as const;
export type PaymentMethodUnavailableReason = (typeof PAYMENT_METHOD_UNAVAILABLE_REASONS)[number];

/**
 * The currencies each method can take a payment in. A method is offered on a
 * payment only when its currency is listed — so iDEAL never appears on a USD
 * payment, and a payer is never shown a method that would fail.
 */
export const PAYMENT_METHOD_CURRENCIES: Readonly<
  Record<PaymentMethodConfigurationType, readonly FiatCurrencyCode[]>
> = Object.freeze({
  card: FIAT_CURRENCY_CODES,
  apple_pay: FIAT_CURRENCY_CODES,
  google_pay: FIAT_CURRENCY_CODES,
  sepa_debit: ['EUR'],
  ideal: ['EUR'],
  bancontact: ['EUR'],
  eps: ['EUR'],
  bizum: ['EUR'],
});
