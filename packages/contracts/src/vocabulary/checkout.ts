// Checkout vocabulary (Orbit Phase 3): the closed value sets and bounds of
// Checkout Sessions and Payment Links. Zod-free, so the hosted checkout and
// the wallet import them without the schemas (`@peable.to/contracts/vocabulary`,
// re-exported by `@peable.to/shared-types`).

/**
 * Why FairCoin cannot be paid with on an order right now (ADR 0021). It is
 * still offered — never hidden — and says why:
 *
 *  - `faircoin_wallet_missing` — the Peable wallet of the account that receives
 *    (the merchant's owner, or the seller) isn't set up yet: no identity key;
 *  - `faircoin_network_closed` — this deployment does not open payments on the
 *    order's FairCoin network yet (ADR 0002's gate);
 *  - `price_unavailable` — no fresh FairCoin price exists to quote a fiat order;
 *  - `temporarily_unavailable` — whether the wallet exists could not be checked, or every
 *    address the recipient can hold open is open (ADR 0021 D9) — try again shortly.
 */
export const FAIRCOIN_UNAVAILABLE_REASONS = [
  'faircoin_wallet_missing',
  'faircoin_network_closed',
  'price_unavailable',
  'temporarily_unavailable',
] as const;
export type FaircoinUnavailableReason = (typeof FAIRCOIN_UNAVAILABLE_REASONS)[number];

export const CHECKOUT_SESSION_MODES = ['payment', 'setup', 'subscription'] as const;
export type CheckoutSessionMode = (typeof CHECKOUT_SESSION_MODES)[number];

export const CHECKOUT_SESSION_STATUSES = ['open', 'complete', 'expired'] as const;
export type CheckoutSessionStatus = (typeof CHECKOUT_SESSION_STATUSES)[number];

export const CHECKOUT_PAYMENT_STATUSES = ['paid', 'unpaid', 'no_payment_required'] as const;
export type CheckoutSessionPaymentStatus = (typeof CHECKOUT_PAYMENT_STATUSES)[number];

export const CHECKOUT_UI_MODES = ['hosted', 'embedded'] as const;
export type CheckoutUiMode = (typeof CHECKOUT_UI_MODES)[number];

/**
 * The languages every payer surface speaks — ONE set: the Pay with Peable
 * sheet (`@peable.to/sdk/checkout/ui`), the hosted and embedded checkout, the
 * hosted invoice and portal pages, and the customer emails. Each surface keeps
 * its own catalog (their strings differ, and Metro does not tree-shake), typed
 * `Record<CheckoutLocale, …>`, so a language added here is a compile error on
 * every surface until it is translated.
 *
 * Language codes: `pt` is Brazilian Portuguese (`pt-BR`), `zh` Simplified
 * Chinese (`zh-Hans`). A BCP 47 tag resolves to its language.
 */
export const CHECKOUT_LOCALES = [
  'ar',
  'bn',
  'ca',
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'pt',
  'ru',
  'tr',
  'zh',
] as const;
export type CheckoutLocale = (typeof CHECKOUT_LOCALES)[number];

/** The locales written right to left: a surface sets `dir="rtl"` for them. */
export const CHECKOUT_RTL_LOCALES: readonly CheckoutLocale[] = ['ar'];

/** The text direction a locale is written in. */
export function checkoutLocaleDirection(locale: CheckoutLocale): 'ltr' | 'rtl' {
  return CHECKOUT_RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}

export const CHECKOUT_SUBMIT_TYPES = ['auto', 'pay', 'book', 'donate'] as const;
export type CheckoutSubmitType = (typeof CHECKOUT_SUBMIT_TYPES)[number];

export const CHECKOUT_CUSTOMER_CREATIONS = ['always', 'if_required'] as const;
export type CheckoutCustomerCreation = (typeof CHECKOUT_CUSTOMER_CREATIONS)[number];

export const CHECKOUT_BILLING_ADDRESS_COLLECTIONS = ['auto', 'required'] as const;
export type CheckoutBillingAddressCollection =
  (typeof CHECKOUT_BILLING_ADDRESS_COLLECTIONS)[number];

export const CHECKOUT_CUSTOM_FIELD_TYPES = ['text', 'numeric', 'dropdown'] as const;
export type CheckoutCustomFieldType = (typeof CHECKOUT_CUSTOM_FIELD_TYPES)[number];

/** Stripe's tax id types Peable collects; `eu_vat` covers every EU member state. */
export const CHECKOUT_TAX_ID_TYPES = [
  'eu_vat',
  'gb_vat',
  'ch_vat',
  'no_vat',
  'us_ein',
  'ca_bn',
] as const;
export type CheckoutTaxIdType = (typeof CHECKOUT_TAX_ID_TYPES)[number];

/**
 * Bounds of the session contract, shared by the gateway's validators and the
 * clients that build requests, so the two cannot drift.
 */
export const CHECKOUT_LIMITS = Object.freeze({
  lineItemsMax: 20,
  quantityMax: 999_999,
  customFieldsMax: 3,
  customFieldKeyMax: 200,
  customFieldLabelMax: 50,
  customFieldTextMax: 255,
  dropdownOptionsMax: 200,
  dropdownOptionLabelMax: 100,
  dropdownOptionValueMax: 100,
  clientReferenceIdMax: 200,
  /** `expires_at` must be between 30 minutes and 24 hours from creation. */
  expiresMinSeconds: 30 * 60,
  expiresMaxSeconds: 24 * 3600,
  shippingCountriesMax: 250,
  termsTextMax: 1200,
});

/** The template a `success_url` may carry; replaced with the session's `cs_…`. */
export const CHECKOUT_SESSION_ID_TEMPLATE = '{CHECKOUT_SESSION_ID}';

export const PAYMENT_LINK_LIMITS = Object.freeze({
  lineItemsMax: 20,
  customMessageMax: 500,
});

/** Who owns contact collection for a service-created checkout session. */
export const CHECKOUT_CONTACT_COLLECTIONS = ['email', 'merchant_account'] as const;
export type CheckoutContactCollection = (typeof CHECKOUT_CONTACT_COLLECTIONS)[number];
