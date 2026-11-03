// Payment method breadth on the card rail (`pmc_…`, `pmd_…`). Zod-free.

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
