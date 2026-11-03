// Payment Link v2 (Orbit Phase 3) — Stripe's model: a shareable URL over
// catalog PRICES. A payer visiting it creates a Checkout Session with the
// link's line items and options; the session creates the payment when the
// payer confirms. Nothing about a link mints a payment on its own.
//
// A contribution link (an Oxy organization's FairCoin collection,
// `@peable.to/contracts`) is a payment link whose one line is the contribution
// itself — a fixed amount, or one the payer chooses — rather than a price.
import type { ContributionDetails } from '@peable.to/contracts';
import type { CheckoutBranding } from './branding';
import type {
  CheckoutAdjustableQuantity,
  CheckoutAfterCompletion,
  CheckoutBillingAddressCollection,
  CheckoutCustomField,
  CheckoutCustomFieldParams,
  CheckoutCustomerCreation,
  CheckoutLineItem,
  CheckoutLocale,
  CheckoutSubmitType,
} from './checkoutSession';
import type { CurrencyCode } from './money';
import type { MerchantDisplay } from './merchantDisplay';
import type { NetworkType } from './network';
import type { PaymentIntentRail } from './paymentIntent';

export const PAYMENT_LINK_LIMITS = Object.freeze({
  lineItemsMax: 20,
  customMessageMax: 500,
});

export interface PaymentLink {
  id: string;
  object: 'payment_link';
  livemode: boolean;
  active: boolean;
  currency: CurrencyCode;
  rail: PaymentIntentRail;
  network: NetworkType | null;
  /** The link's prices (`GET /v1/payment_links/:id/line_items` lists them in full). */
  line_items: CheckoutLineItem[];
  allow_promotion_codes: boolean;
  billing_address_collection: CheckoutBillingAddressCollection;
  shipping_address_collection: { allowed_countries: string[] } | null;
  phone_number_collection: { enabled: boolean };
  tax_id_collection: { enabled: boolean };
  custom_fields: CheckoutCustomField[];
  consent_collection: { terms_of_service: 'none' | 'required' } | null;
  automatic_tax: { enabled: boolean };
  customer_creation: CheckoutCustomerCreation;
  after_completion: CheckoutAfterCompletion;
  restrictions: { completed_sessions: { limit: number; count: number } } | null;
  submit_type: CheckoutSubmitType;
  locale: CheckoutLocale | null;
  /** Present on an organization contribution link (FairCoin). */
  contribution?: ContributionDetails;
  metadata: Record<string, string>;
  /** `checkout.peable.to/l/<id>` — share it, or render it as a QR code. */
  url: string;
  created: number;
  updated_at: number;
}

/** What an anonymous visitor may see before checkout starts — no metadata, no counts. */
export interface PublicPaymentLink {
  id: string;
  object: 'payment_link';
  livemode: boolean;
  active: boolean;
  currency: CurrencyCode;
  rail: PaymentIntentRail;
  network: NetworkType | null;
  line_items: CheckoutLineItem[];
  contribution?: ContributionDetails;
  /** A fixed contribution's amount; `null` when the payer chooses (or for a price link). */
  contribution_amount: string | null;
  merchant: MerchantDisplay;
  branding: CheckoutBranding;
  locale: CheckoutLocale | null;
}

export interface PaymentLinkLineItemParams {
  price: string;
  quantity: number;
  adjustable_quantity?: { enabled: boolean; minimum?: number; maximum?: number };
}

export interface PaymentLinkAfterCompletionParams {
  type: 'redirect' | 'hosted_confirmation';
  /** `type: redirect` — may carry `{CHECKOUT_SESSION_ID}`. */
  redirect?: { url: string };
  hosted_confirmation?: { custom_message?: string };
}

export interface CreatePaymentLinkParams {
  /** 1–20 prices of ONE currency, one-time prices only. */
  line_items: PaymentLinkLineItemParams[];
  allow_promotion_codes?: boolean;
  billing_address_collection?: CheckoutBillingAddressCollection;
  shipping_address_collection?: { allowed_countries: string[] };
  phone_number_collection?: { enabled: boolean };
  tax_id_collection?: { enabled: boolean };
  custom_fields?: CheckoutCustomFieldParams[];
  consent_collection?: { terms_of_service?: 'none' | 'required' };
  automatic_tax?: { enabled: boolean };
  customer_creation?: CheckoutCustomerCreation;
  after_completion?: PaymentLinkAfterCompletionParams;
  restrictions?: { completed_sessions: { limit: number } };
  submit_type?: CheckoutSubmitType;
  locale?: CheckoutLocale | 'auto';
  metadata?: Record<string, string>;
}

/**
 * `POST /v1/payment_links/:id`. The line items are fixed once shared (a payer
 * may hold a session priced from them); everything else may change.
 */
export interface UpdatePaymentLinkParams {
  active?: boolean;
  allow_promotion_codes?: boolean;
  billing_address_collection?: CheckoutBillingAddressCollection;
  shipping_address_collection?: { allowed_countries: string[] } | '';
  phone_number_collection?: { enabled: boolean };
  tax_id_collection?: { enabled: boolean };
  custom_fields?: CheckoutCustomFieldParams[] | '';
  consent_collection?: { terms_of_service?: 'none' | 'required' };
  automatic_tax?: { enabled: boolean };
  customer_creation?: CheckoutCustomerCreation;
  after_completion?: PaymentLinkAfterCompletionParams;
  restrictions?: { completed_sessions: { limit: number } } | '';
  submit_type?: CheckoutSubmitType;
  locale?: CheckoutLocale | 'auto';
  /** A patch: named keys are set, `""` removes a key, others are kept. */
  metadata?: Record<string, string>;
}

/**
 * `POST /v1/payment_links/:id/checkout_sessions` — a payer starting checkout
 * (anonymous, rate-limited). A contribution link the payer prices takes
 * `amount`; nothing else is the payer's to say.
 */
export interface CreatePaymentLinkSessionParams {
  amount?: string;
}

/** Its answer: where to go — the hosted session and the secret that opens it. */
export interface PaymentLinkSessionStart {
  object: 'checkout_session_start';
  id: string;
  client_secret: string;
  url: string;
}

export type { CheckoutAdjustableQuantity };
