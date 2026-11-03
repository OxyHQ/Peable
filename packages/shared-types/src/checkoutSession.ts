// Checkout Session (Orbit Phase 3) — Stripe Checkout's session model, at the
// root: a session is an ORDER (line items, discounts, tax, what to collect from
// the payer) that a payer completes on Peable's hosted or embedded checkout.
// The PaymentIntent (or SetupIntent) is created when the session needs one —
// when the payer confirms — with the amount the session computed, and linked.
//
// Amounts are base-unit STRINGS (ADR 0014 D1), like every amount on the wire.
import type { BillingFaircoinFxQuote } from './billing';
import type { Price, Product } from './catalog';
import type { Customer } from './customer';
import type { CheckoutBranding } from './branding';
import type { CurrencyCode } from './money';
import type { MerchantDisplay } from './merchantDisplay';
import type { NetworkType } from './network';
import type { Address, AddressParams, PaymentIntent, PaymentIntentRail } from './paymentIntent';
import type { ConnectedAccount } from './settlement';
import type { SetupIntent } from './setupIntent';

export const CHECKOUT_SESSION_MODES = ['payment', 'setup', 'subscription'] as const;
export type CheckoutSessionMode = (typeof CHECKOUT_SESSION_MODES)[number];

export const CHECKOUT_SESSION_STATUSES = ['open', 'complete', 'expired'] as const;
export type CheckoutSessionStatus = (typeof CHECKOUT_SESSION_STATUSES)[number];

export const CHECKOUT_PAYMENT_STATUSES = ['paid', 'unpaid', 'no_payment_required'] as const;
export type CheckoutSessionPaymentStatus = (typeof CHECKOUT_PAYMENT_STATUSES)[number];

export const CHECKOUT_UI_MODES = ['hosted', 'embedded'] as const;
export type CheckoutUiMode = (typeof CHECKOUT_UI_MODES)[number];

/** The languages the hosted and embedded checkout speak. */
export const CHECKOUT_LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pt'] as const;
export type CheckoutLocale = (typeof CHECKOUT_LOCALES)[number];

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

// ---- Objects ----------------------------------------------------------------

export interface CheckoutAdjustableQuantity {
  enabled: boolean;
  /** Default 0 when enabled. */
  minimum: number | null;
  /** Default 99 when enabled. */
  maximum: number | null;
}

/** One line of a session — Stripe's `item` (`GET /v1/checkout_sessions/:id/line_items`). */
export interface CheckoutLineItem {
  id: string;
  object: 'item';
  /** The product's name, or the inline `product_data.name`. */
  description: string;
  /**
   * The catalog price (`price_…`, or the object with `expand[]=data.price`), or
   * `null` for an inline `price_data` line — an inline price is a snapshot on
   * the line, never a stored `price_…`.
   */
  price: string | Price | null;
  /** The catalog product (`prod_…`, expandable), or `null` for `product_data`. */
  product: string | Product | null;
  /** Images to show beside the line (the product's, or `product_data.images`). */
  images: string[];
  quantity: number;
  adjustable_quantity: CheckoutAdjustableQuantity | null;
  currency: CurrencyCode;
  /** The per-unit amount for a per-unit price; `null` for a tiered one. */
  unit_amount: string | null;
  /** Before discount and tax. */
  amount_subtotal: string;
  amount_discount: string;
  amount_tax: string;
  /** `amount_subtotal - amount_discount + amount_tax` (exclusive tax only). */
  amount_total: string;
}

export interface CheckoutTaxId {
  type: CheckoutTaxIdType;
  value: string;
}

/** What the payer told checkout about themselves — Stripe's `customer_details`. */
export interface CheckoutCustomerDetails {
  email: string | null;
  name: string | null;
  phone: string | null;
  address: Address | null;
  tax_ids: CheckoutTaxId[];
}

export interface CheckoutShippingDetails {
  name: string;
  address: Address;
}

export interface CheckoutCustomFieldLabel {
  type: 'custom';
  custom: string;
}

export interface CheckoutCustomFieldDropdownOption {
  label: string;
  value: string;
}

/** A merchant-defined field the payer fills in; `value`s are what they entered. */
export interface CheckoutCustomField {
  key: string;
  label: CheckoutCustomFieldLabel;
  type: CheckoutCustomFieldType;
  optional: boolean;
  dropdown: { options: CheckoutCustomFieldDropdownOption[]; value: string | null } | null;
  text: {
    minimum_length: number | null;
    maximum_length: number | null;
    value: string | null;
  } | null;
  numeric: {
    minimum_length: number | null;
    maximum_length: number | null;
    value: string | null;
  } | null;
}

export interface CheckoutDiscount {
  /** The coupon applied (`coupon` id — merchant-chosen or `coupon_…`). */
  coupon: string;
  /** The promotion code it was redeemed through (`promo_…`), or `null`. */
  promotion_code: string | null;
}

export interface CheckoutTotalDetails {
  amount_discount: string;
  amount_tax: string;
  amount_shipping: string;
}

/**
 * `automatic_tax` — Peable Tax (ADR 0011). `requires_location_inputs` until
 * the payer gave an address Peable Tax can locate them with; `failed` when the
 * sale is covered and could not be priced (checkout refuses to proceed: tax
 * fails CLOSED, never zero).
 */
export interface CheckoutAutomaticTax {
  enabled: boolean;
  status: 'complete' | 'requires_location_inputs' | 'failed' | null;
}

export interface CheckoutConsentCollection {
  terms_of_service: 'none' | 'required';
}

export interface CheckoutConsent {
  terms_of_service: 'accepted' | null;
}

export interface CheckoutAfterCompletion {
  type: 'redirect' | 'hosted_confirmation';
  redirect: { url: string } | null;
  hosted_confirmation: { custom_message: string | null } | null;
}

/** The merchant/SDK-facing session — Stripe's Checkout Session. */
export interface CheckoutSession {
  id: string;
  object: 'checkout_session';
  /** ADR 0017: `true` for a `production` merchant. */
  livemode: boolean;
  mode: CheckoutSessionMode;
  status: CheckoutSessionStatus;
  payment_status: CheckoutSessionPaymentStatus;
  ui_mode: CheckoutUiMode;
  /** The language checkout renders in; `null` follows the payer's browser. */
  locale: CheckoutLocale | null;
  submit_type: CheckoutSubmitType;
  currency: CurrencyCode;
  rail: PaymentIntentRail;
  /** FairCoin rail only; `null` on a card session. */
  network: NetworkType | null;
  payment_method_types: string[];
  amount_subtotal: string;
  amount_total: string;
  total_details: CheckoutTotalDetails;
  discounts: CheckoutDiscount[];
  allow_promotion_codes: boolean;
  automatic_tax: CheckoutAutomaticTax;
  /** `cus_…` (expandable) — given on create, or created at completion. */
  customer: string | Customer | null;
  customer_email: string | null;
  customer_creation: CheckoutCustomerCreation;
  customer_details: CheckoutCustomerDetails | null;
  billing_address_collection: CheckoutBillingAddressCollection;
  shipping_address_collection: { allowed_countries: string[] } | null;
  shipping_details: CheckoutShippingDetails | null;
  phone_number_collection: { enabled: boolean };
  tax_id_collection: { enabled: boolean };
  custom_fields: CheckoutCustomField[];
  consent_collection: CheckoutConsentCollection | null;
  consent: CheckoutConsent | null;
  /**
   * The payment this session created (`pi_…`, expandable), once the payer
   * confirmed; `null` before, and always in `setup` mode.
   */
  payment_intent: string | PaymentIntent | null;
  /** `setup` mode: the SetupIntent (`seti_…`, expandable) once confirmed. */
  setup_intent: string | SetupIntent | null;
  /** The seller an on-behalf payment pays (`ca_…`, expandable). */
  connected_account: string | ConnectedAccount | null;
  /** The payment link this session was created from (`link_…`), if any. */
  payment_link: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  /** With `{CHECKOUT_SESSION_ID}` as given; checkout substitutes it. */
  success_url: string | null;
  cancel_url: string | null;
  /** Hosted mode: the URL to send the payer to. `null` in embedded mode. */
  url: string | null;
  /** Embedded mode: what `PeableCheckout.mountCheckout` takes. `null` in hosted mode. */
  client_secret: string | null;
  expires_at: number;
  created: number;
}

// ---- Payer side --------------------------------------------------------------

/**
 * What the hosted/embedded checkout loads, authorized by the session's
 * `client_secret` (or, for a session wrapping a payment, that payment's). No
 * metadata, no client reference, no internal ids.
 */
export interface CheckoutSessionPublic {
  id: string;
  object: 'checkout_session';
  livemode: boolean;
  mode: CheckoutSessionMode;
  status: CheckoutSessionStatus;
  payment_status: CheckoutSessionPaymentStatus;
  ui_mode: CheckoutUiMode;
  locale: CheckoutLocale | null;
  submit_type: CheckoutSubmitType;
  currency: CurrencyCode;
  rail: PaymentIntentRail;
  network: NetworkType | null;
  line_items: CheckoutLineItem[];
  amount_subtotal: string;
  amount_total: string;
  total_details: CheckoutTotalDetails;
  /**
   * The discount applied, with what the payer sees — the code they typed (or
   * the coupon's name) and how much it took off.
   */
  discount: {
    promotion_code: string | null;
    coupon_name: string | null;
    amount_off: string | null;
    percent_off: number | null;
  } | null;
  allow_promotion_codes: boolean;
  automatic_tax: CheckoutAutomaticTax;
  /** Prefilled from `customer_email` / the customer; then what the payer entered. */
  customer_details: CheckoutCustomerDetails;
  /** Whether the email is fixed by the merchant (a `customer` or `customer_email`). */
  customer_email_locked: boolean;
  billing_address_collection: CheckoutBillingAddressCollection;
  shipping_address_collection: { allowed_countries: string[] } | null;
  shipping_details: CheckoutShippingDetails | null;
  phone_number_collection: { enabled: boolean };
  tax_id_collection: { enabled: boolean };
  custom_fields: CheckoutCustomField[];
  consent_collection: CheckoutConsentCollection | null;
  consent: CheckoutConsent | null;
  /** The merchant's terms URL when `consent_collection.terms_of_service` is required. */
  terms_of_service_url: string | null;
  /** The payment the payer confirmed — with its `client_secret`, the payer's capability. */
  payment_intent: PaymentIntent | null;
  /** `setup` mode: the SetupIntent id and client secret, once confirmed. */
  setup_intent: { id: string; client_secret: string; status: SetupIntent['status'] } | null;
  /** `success_url` with `{CHECKOUT_SESSION_ID}` substituted; only once `complete`. */
  success_url: string | null;
  /** Shown as "Back to <merchant>" before payment. */
  cancel_url: string | null;
  /** A payment link's hosted confirmation, shown once `complete`. */
  confirmation_message: string | null;
  merchant: MerchantDisplay;
  branding: CheckoutBranding;
  /**
   * The card provider's PUBLIC key for this session's mode (ADR 0017), so the
   * payment fields can mount before the payment exists. `null` on FairCoin.
   */
  publishable_key: string | null;
  /** FairCoin billing invoices: the frozen USD price and FAIR settlement quote. */
  billing_quote?: BillingFaircoinFxQuote;
  expires_at: number;
}

/** `POST /v1/checkout_sessions/:id/public` — what the payer changes before confirming. */
export interface UpdateCheckoutSessionPublicParams {
  /** Adjust a line's quantity, within its `adjustable_quantity` bounds. */
  line_items?: { id: string; quantity: number }[];
  /** A code to redeem (`allow_promotion_codes`), or `''` to remove the one applied. */
  promotion_code?: string;
  customer_details?: {
    email?: string;
    name?: string;
    phone?: string;
    address?: AddressParams;
    tax_ids?: CheckoutTaxId[];
  };
  shipping_details?: { name: string; address: AddressParams } | null;
  /** By `key`: the payer's value for each custom field. */
  custom_fields?: { key: string; value: string }[];
  consent?: { terms_of_service?: 'accepted' };
}

/**
 * `POST /v1/checkout_sessions/:id/public/confirm` — lock the order and create
 * the payment (or setup). The answer is the session with `payment_intent` /
 * `setup_intent` set; completing it is the payment's, and `complete` is only
 * ever what the gateway says.
 */
export type ConfirmCheckoutSessionPublicParams = Record<string, never>;

// ---- Merchant create/update --------------------------------------------------

export interface CheckoutProductDataParams {
  name: string;
  description?: string;
  images?: string[];
  tax_code?: string;
}

export interface CheckoutPriceDataParams {
  currency: CurrencyCode;
  unit_amount: string;
  /** Exactly one of `product` and `product_data`. */
  product?: string;
  product_data?: CheckoutProductDataParams;
  recurring?: { interval: 'day' | 'week' | 'month' | 'year'; interval_count?: number };
  tax_behavior?: 'inclusive' | 'exclusive' | 'unspecified';
}

export interface CheckoutLineItemParams {
  /** Exactly one of `price` and `price_data`. */
  price?: string;
  price_data?: CheckoutPriceDataParams;
  quantity: number;
  adjustable_quantity?: { enabled: boolean; minimum?: number; maximum?: number };
}

export interface CheckoutCustomFieldParams {
  key: string;
  label: CheckoutCustomFieldLabel;
  type: CheckoutCustomFieldType;
  optional?: boolean;
  dropdown?: { options: CheckoutCustomFieldDropdownOption[] };
  text?: { minimum_length?: number; maximum_length?: number };
  numeric?: { minimum_length?: number; maximum_length?: number };
}

export interface CreateCheckoutSessionParams {
  /** Default `payment`. `subscription` answers 400 until the billing engine fulfils it. */
  mode?: CheckoutSessionMode;
  /** Required in `payment` and `subscription` mode; refused in `setup` mode. */
  line_items?: CheckoutLineItemParams[];
  /** `setup` mode: the currency of the method being saved (card rail only). */
  currency?: CurrencyCode;
  /** At most one; mutually exclusive with `allow_promotion_codes`. */
  discounts?: ({ coupon: string } | { promotion_code: string })[];
  allow_promotion_codes?: boolean;
  /** `cus_…`; mutually exclusive with `customer_email`. */
  customer?: string;
  customer_email?: string;
  /** Default `if_required` (a customer is created only when something needs one). */
  customer_creation?: CheckoutCustomerCreation;
  billing_address_collection?: CheckoutBillingAddressCollection;
  shipping_address_collection?: { allowed_countries: string[] };
  phone_number_collection?: { enabled: boolean };
  tax_id_collection?: { enabled: boolean };
  /** At most three. */
  custom_fields?: CheckoutCustomFieldParams[];
  consent_collection?: { terms_of_service?: 'none' | 'required' };
  automatic_tax?: { enabled: boolean };
  /** `['card']` or `['faircoin']` — the rail the line items' currency allows. */
  payment_method_types?: string[];
  locale?: CheckoutLocale | 'auto';
  ui_mode?: CheckoutUiMode;
  /** Required in hosted mode; may carry `{CHECKOUT_SESSION_ID}`. */
  success_url?: string;
  /** Hosted mode only: the "Back to merchant" link. */
  cancel_url?: string;
  /** Unix seconds, 30 minutes to 24 hours from now. Default 24 hours. */
  expires_at?: number;
  client_reference_id?: string;
  metadata?: Record<string, string>;
  submit_type?: CheckoutSubmitType;
  /** Pay this seller (`ca_…`) rather than the merchant (ADR 0012); FairCoin only. */
  connected_account?: string;
}

/** `POST /v1/checkout_sessions/:id` — the merchant's `metadata`, as a patch. */
export interface UpdateCheckoutSessionParams {
  metadata?: Record<string, string>;
}
