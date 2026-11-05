// Payment method breadth (`pmc_…`, `pmd_…`): the merchant's card-rail methods,
// and FairCoin, which is always offered (ADR 0021). Zod-free.

import { CURRENCY_CODES, type CurrencyCode, FIAT_CURRENCY_CODES } from './money';

/**
 * The methods a configuration lists.
 *
 * `faircoin` is listed and LOCKED (ADR 0021 D2): every payer can always pay
 * with FairCoin, so its entry is always `display_preference.value: 'on'` with
 * `locked: true`, and a create or update that sets it `off` is refused with
 * `payment_method_locked`. It is the chain rail, never a card-provider method:
 * it is never pushed to the provider and never appears in a card PaymentIntent's
 * `payment_method_types`. Every other method is the merchant's to turn on and off.
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
  'faircoin',
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
 *  - `requires_card` — a wallet rides on card payments, and card is off;
 *  - `faircoin_account_missing` — the merchant has not registered its FairCoin
 *    (watch-only) receiving key yet, so no FairCoin address can be derived for
 *    its payers. In live mode such a merchant cannot take payments at all
 *    (ADR 0021 D5).
 */
export const PAYMENT_METHOD_UNAVAILABLE_REASONS = [
  'provider_unsupported',
  'requires_card',
  'faircoin_account_missing',
] as const;
export type PaymentMethodUnavailableReason = (typeof PAYMENT_METHOD_UNAVAILABLE_REASONS)[number];

/**
 * The currencies each method can take a payment in. A method is offered on a
 * payment only when its currency is listed — so iDEAL never appears on a USD
 * payment, and a payer is never shown a method that would fail. FairCoin takes
 * every currency: a `FAIR` order directly, a fiat one at a quoted price (ADR 0021).
 */
export const PAYMENT_METHOD_CURRENCIES: Readonly<
  Record<PaymentMethodConfigurationType, readonly CurrencyCode[]>
> = Object.freeze({
  faircoin: CURRENCY_CODES,
  card: FIAT_CURRENCY_CODES,
  apple_pay: FIAT_CURRENCY_CODES,
  google_pay: FIAT_CURRENCY_CODES,
  sepa_debit: ['EUR'],
  ideal: ['EUR'],
  bancontact: ['EUR'],
  eps: ['EUR'],
  bizum: ['EUR'],
});
