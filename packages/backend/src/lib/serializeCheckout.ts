/**
 * Checkout's wire shapes (Orbit Phase 3): sessions, their line items, payment
 * links and branding. Rendered from stored rows only — a serializer never
 * reads the provider, and never writes.
 */
import {
  type CheckoutBranding,
  type CheckoutCustomerDetails,
  type CheckoutCustomField,
  type CheckoutLineItem,
  type CheckoutSession,
  type CheckoutSessionPublic,
  DEFAULT_BRANDING,
  type MerchantBranding,
  type MerchantDisplay,
  type MerchantEmailSettings,
  type PaymentIntent,
  type PaymentLink,
  type PublicPaymentLink,
  type SetupIntentStatus,
} from '@peable.to/shared-types';
import { config } from '../config';
import type {
  MerchantBrandingRow,
  MerchantEmailSettingsRow,
} from '../db/merchants/brandingRepository';
import type {
  CheckoutLineItemRow,
  CheckoutSessionRow,
} from '../db/payments/checkoutSessionRepository';
import type { PaymentLinkRow } from '../db/payments/paymentLinkRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import type { StoredCheckoutCollection, StoredCustomField } from '../db/schema/payments';
import { oxy } from '../oxy';
import { substituteSessionId } from '../services/checkout/params';
import { toContributionDetails } from './serialize';
import { toUnix, toUnixOrNull } from './time';

const DAY_MS = 24 * 3600_000;

export function toCustomFieldDTO(field: StoredCustomField): CheckoutCustomField {
  const bounds = {
    minimum_length: field.minimumLength,
    maximum_length: field.maximumLength,
    value: field.value,
  };
  return {
    key: field.key,
    label: { type: 'custom', custom: field.label },
    type: field.type,
    optional: field.optional,
    dropdown:
      field.type === 'dropdown'
        ? { options: (field.options ?? []).map((o) => ({ ...o })), value: field.value }
        : null,
    text: field.type === 'text' ? bounds : null,
    numeric: field.type === 'numeric' ? bounds : null,
  };
}

function collectionView(collection: StoredCheckoutCollection | null) {
  return {
    billing_address_collection: collection?.billingAddressCollection ?? 'auto',
    shipping_address_collection: collection?.shippingCountries
      ? { allowed_countries: [...collection.shippingCountries] }
      : null,
    phone_number_collection: { enabled: collection?.phoneNumber ?? false },
    tax_id_collection: { enabled: collection?.taxId ?? false },
    consent_collection: collection?.termsOfService
      ? { terms_of_service: 'required' as const }
      : null,
  };
}

/** The session's own client secret, hosted checkout's fragment — never a query string. */
export function hostedCheckoutUrl(row: CheckoutSessionRow): string | null {
  if (row.uiMode !== 'hosted' || row.clientSecret === null) return null;
  return `${config.checkoutBaseUrl}/c/${row.publicId}#cs=${encodeURIComponent(row.clientSecret)}`;
}

function expiresAtOf(row: CheckoutSessionRow): number {
  return toUnix(row.expiresAt ?? new Date(row.createdAt.getTime() + DAY_MS));
}

/** The merchant/SDK session (`GET /v1/checkout_sessions/:id`, every `checkout.session.*` event). */
/**
 * What the payer may choose (ADR 0021 D1): FairCoin on every order, beside the
 * card rail on a fiat one. A `setup` session saves a card and pays nothing.
 */
export function sessionPaymentMethodTypes(
  row: Pick<CheckoutSessionRow, 'mode' | 'rail'>,
): CheckoutSession['payment_method_types'] {
  if (row.mode === 'setup') return ['card'];
  return row.rail === 'faircoin' ? ['faircoin'] : ['card', 'faircoin'];
}

export function toCheckoutSessionDTO(row: CheckoutSessionRow): CheckoutSession {
  return {
    id: row.publicId,
    object: 'checkout_session',
    livemode: row.livemode,
    mode: row.mode,
    status: row.status,
    payment_status: row.paymentStatus,
    ui_mode: row.uiMode,
    locale: row.locale,
    submit_type: row.submitType,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    payment_method_types: sessionPaymentMethodTypes(row),
    amount_subtotal: row.amountSubtotal,
    amount_total: row.amount,
    total_details: {
      amount_discount: row.amountDiscount,
      amount_tax: row.amountTax,
      amount_shipping: row.amountShipping,
    },
    discounts:
      row.couponPublicId !== null
        ? [{ coupon: row.couponPublicId, promotion_code: row.promotionCodePublicId }]
        : [],
    allow_promotion_codes: row.allowPromotionCodes,
    automatic_tax: { enabled: row.automaticTax, status: row.automaticTaxStatus },
    customer: row.customerPublicId,
    customer_email: row.customerEmail,
    customer_creation: row.customerCreation,
    customer_details: row.customerDetails,
    ...collectionView(row.collection),
    shipping_details: row.shippingDetails,
    custom_fields: row.customFields.map(toCustomFieldDTO),
    consent: row.consent,
    payment_intent: row.paymentIntentPublicId,
    setup_intent: row.setupIntentPublicId,
    connected_account: row.connectedAccountPublicId,
    payment_link: row.paymentLinkPublicId,
    client_reference_id: row.clientReferenceId,
    metadata: row.metadata,
    success_url: row.successUrl,
    cancel_url: row.cancelUrl,
    url: hostedCheckoutUrl(row),
    client_secret: row.uiMode === 'embedded' ? row.clientSecret : null,
    expires_at: expiresAtOf(row),
    created: toUnix(row.createdAt),
  };
}

/** One line, as `GET /v1/checkout_sessions/:id/line_items` (and the payer page) shows it. */
export function toCheckoutLineItemDTO(row: CheckoutLineItemRow): CheckoutLineItem {
  return {
    id: row.publicId,
    object: 'item',
    description: row.description,
    price: row.pricePublicId,
    product: row.productPublicId,
    images: [...row.images],
    quantity: row.quantity,
    adjustable_quantity: row.adjustableEnabled
      ? { enabled: true, minimum: row.adjustableMinimum, maximum: row.adjustableMaximum }
      : null,
    currency: row.currency,
    unit_amount: row.price.billingScheme === 'per_unit' ? row.price.unitAmount : null,
    amount_subtotal: row.amountSubtotal,
    amount_discount: row.amountDiscount,
    amount_tax: row.amountTax,
    amount_total: row.amountTotal,
  };
}

/** Branding as a payer surface renders it: defaults filled, files as URLs, a withheld logo `null`. */
export function toCheckoutBranding(
  merchant: MerchantRow,
  branding: MerchantBrandingRow,
): CheckoutBranding {
  const avatarShown = merchant.avatarFileId !== null && merchant.avatarWithheld === null;
  return {
    icon_url:
      branding.useAvatarAsIcon && avatarShown && merchant.avatarFileId
        ? oxy.assets.publicUrl(merchant.avatarFileId, 'thumb')
        : null,
    // The wordmark is the merchant's `business_logo` File, served only while
    // Oxy serves it (`merchants.business_logo_oxy_file_id` is null otherwise).
    logo_url: merchant.businessLogoOxyFileId
      ? oxy.assets.publicUrl(merchant.businessLogoOxyFileId)
      : null,
    primary_color: branding.primaryColor ?? DEFAULT_BRANDING.primary_color,
    accent_color: branding.accentColor ?? DEFAULT_BRANDING.accent_color,
    font: branding.font ?? DEFAULT_BRANDING.font,
    border_style: branding.borderStyle ?? DEFAULT_BRANDING.border_style,
  };
}

export function toMerchantBrandingDTO(
  merchant: MerchantRow,
  branding: MerchantBrandingRow,
): MerchantBranding {
  return {
    object: 'branding_settings',
    livemode: merchant.livemode,
    use_avatar_as_icon: branding.useAvatarAsIcon,
    logo: merchant.businessLogo,
    primary_color: branding.primaryColor,
    accent_color: branding.accentColor,
    font: branding.font,
    border_style: branding.borderStyle,
    terms_of_service_url: branding.termsOfServiceUrl,
    updated_at: toUnixOrNull(branding.updatedAt),
  };
}

export function toMerchantEmailSettingsDTO(
  merchant: MerchantRow,
  settings: MerchantEmailSettingsRow,
): MerchantEmailSettings {
  return {
    object: 'email_settings',
    livemode: merchant.livemode,
    payment_receipts: settings.paymentReceipts,
    refund_notices: settings.refundNotices,
    checkout_confirmations: settings.checkoutConfirmations,
    support_email: settings.supportEmail,
    updated_at: toUnixOrNull(settings.updatedAt),
  };
}

const EMPTY_DETAILS: CheckoutCustomerDetails = {
  email: null,
  name: null,
  phone: null,
  address: null,
  tax_ids: [],
};

export interface PublicSessionView {
  readonly session: CheckoutSessionRow;
  readonly lines: readonly CheckoutLineItemRow[];
  readonly merchant: MerchantDisplay;
  readonly branding: CheckoutBranding;
  readonly paymentIntent: PaymentIntent | null;
  readonly setupIntent: { id: string; client_secret: string; status: SetupIntentStatus } | null;
  readonly discount: CheckoutSessionPublic['discount'];
  readonly termsOfServiceUrl: string | null;
  readonly publishableKey: string | null;
  /** Whether FairCoin can be chosen now (ADR 0021); `null` in `setup` mode. */
  readonly faircoin: CheckoutSessionPublic['faircoin'];
}

/** What the hosted/embedded checkout loads — no metadata, no client reference, no internal ids. */
export function toCheckoutSessionPublicDTO(view: PublicSessionView): CheckoutSessionPublic {
  const row = view.session;
  const details = row.customerDetails ?? {
    ...EMPTY_DETAILS,
    email: row.customerEmail,
  };
  return {
    id: row.publicId,
    object: 'checkout_session',
    livemode: row.livemode,
    mode: row.mode,
    status: row.status,
    payment_status: row.paymentStatus,
    ui_mode: row.uiMode,
    locale: row.locale,
    submit_type: row.submitType,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    payment_method_types: sessionPaymentMethodTypes(row),
    line_items: view.lines.map(toCheckoutLineItemDTO),
    amount_subtotal: row.amountSubtotal,
    amount_total: row.amount,
    total_details: {
      amount_discount: row.amountDiscount,
      amount_tax: row.amountTax,
      amount_shipping: row.amountShipping,
    },
    discount: view.discount,
    allow_promotion_codes: row.allowPromotionCodes,
    automatic_tax: { enabled: row.automaticTax, status: row.automaticTaxStatus },
    customer_details: details,
    customer_email_locked: row.customerEmail !== null,
    ...collectionView(row.collection),
    shipping_details: row.shippingDetails,
    custom_fields: row.customFields.map(toCustomFieldDTO),
    consent: row.consent,
    terms_of_service_url: row.collection?.termsOfService ? view.termsOfServiceUrl : null,
    payment_intent: view.paymentIntent,
    setup_intent: view.setupIntent,
    success_url:
      row.status === 'complete' && row.successUrl !== null
        ? substituteSessionId(row.successUrl, row.publicId)
        : null,
    cancel_url: row.status === 'open' && row.paymentIntentId === null ? row.cancelUrl : null,
    confirmation_message: row.status === 'complete' ? row.confirmationMessage : null,
    merchant: view.merchant,
    branding: view.branding,
    publishable_key: view.publishableKey,
    faircoin: view.faircoin,
    expires_at: expiresAtOf(row),
  };
}

// ---- Payment links ------------------------------------------------------------------

export function linkUrl(row: PaymentLinkRow): string {
  return `${config.checkoutBaseUrl}/l/${row.publicId}`;
}

/** The merchant's link. `lines` are the link's prices rendered as `item`s (no amounts discounted). */
export function toPaymentLinkDTO(
  row: PaymentLinkRow,
  lines: readonly CheckoutLineItem[],
): PaymentLink {
  return {
    id: row.publicId,
    object: 'payment_link',
    livemode: row.livemode,
    active: row.active,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    line_items: [...lines],
    allow_promotion_codes: row.allowPromotionCodes,
    ...collectionView(row.collection),
    custom_fields: row.customFields.map(toCustomFieldDTO),
    automatic_tax: { enabled: row.automaticTax },
    customer_creation: row.customerCreation,
    after_completion: {
      type: row.afterCompletionType,
      redirect:
        row.afterCompletionType === 'redirect' && row.afterCompletionUrl !== null
          ? { url: row.afterCompletionUrl }
          : null,
      hosted_confirmation:
        row.afterCompletionType === 'hosted_confirmation'
          ? { custom_message: row.afterCompletionMessage }
          : null,
    },
    restrictions:
      row.completedSessionsLimit !== null
        ? {
            completed_sessions: {
              limit: row.completedSessionsLimit,
              count: row.completedSessionsCount,
            },
          }
        : null,
    submit_type: row.submitType,
    locale: row.locale,
    ...(row.contribution ? { contribution: toContributionDetails(row.contribution) } : {}),
    metadata: row.metadata,
    url: linkUrl(row),
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

export function toPublicPaymentLinkDTO(
  row: PaymentLinkRow,
  lines: readonly CheckoutLineItem[],
  merchant: MerchantDisplay,
  branding: CheckoutBranding,
): PublicPaymentLink {
  return {
    id: row.publicId,
    object: 'payment_link',
    livemode: row.livemode,
    active: row.active,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    line_items: [...lines],
    ...(row.contribution ? { contribution: toContributionDetails(row.contribution) } : {}),
    contribution_amount:
      row.contribution?.amountMode === 'fixed' && row.amount !== null ? row.amount : null,
    merchant,
    branding,
    locale: row.locale,
  };
}
