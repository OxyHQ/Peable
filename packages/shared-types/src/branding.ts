// Merchant branding and customer email settings (Orbit Phase 3).
//
// Branding is what the hosted checkout, the embedded checkout and Peable's
// receipts look like for one merchant. Every value is from a CLOSED set or a
// validated colour, so nothing a merchant stores can inject markup or a remote
// font into a payer's page or an email.

/** The fonts checkout may render in — system stacks only, no remote font is ever loaded. */
export const BRANDING_FONTS = [
  'system',
  'inter',
  'roboto',
  'open_sans',
  'lato',
  'source_sans',
  'noto_sans',
  'serif',
  'monospace',
] as const;
export type BrandingFont = (typeof BRANDING_FONTS)[number];

export const BRANDING_BORDER_STYLES = ['rounded', 'rectangular', 'pill'] as const;
export type BrandingBorderStyle = (typeof BRANDING_BORDER_STYLES)[number];

/** `#rrggbb`, lowercase — the only colour spelling branding stores. */
export const BRANDING_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Peable's defaults, applied wherever a merchant set nothing. */
export const DEFAULT_BRANDING = Object.freeze({
  primary_color: '#1f6feb',
  accent_color: '#0b1f33',
  font: 'system' as BrandingFont,
  border_style: 'rounded' as BrandingBorderStyle,
});

/**
 * A merchant's branding settings, as Orbit reads and writes them
 * (`GET|POST /v1/merchants/me/branding`, and the dashboard's twin).
 */
export interface MerchantBranding {
  object: 'branding_settings';
  livemode: boolean;
  /**
   * The square icon: the merchant's avatar (`avatar_file_id`, an Oxy file
   * Peable already governs), shown when `use_avatar_as_icon` is on.
   */
  use_avatar_as_icon: boolean;
  /**
   * The wide logo: the merchant's `business_logo` — a `file_…` of purpose
   * `business_logo` (Files API) — or `null`. Setting it here and through
   * `POST /v1/merchants/me {business_logo}` is the same write.
   */
  logo: string | null;
  primary_color: string | null;
  accent_color: string | null;
  font: BrandingFont | null;
  border_style: BrandingBorderStyle | null;
  /**
   * Your terms of service (`https://`). Required before a session or link can
   * ask for terms acceptance (`consent_collection.terms_of_service: required`).
   */
  terms_of_service_url: string | null;
  updated_at: number | null;
}

export interface UpdateMerchantBrandingParams {
  use_avatar_as_icon?: boolean;
  /** A `file_…` of purpose `business_logo`; `null` removes it. */
  logo?: string | null;
  /** `#rrggbb` (any case; stored lowercase), `null` for Peable's default. */
  primary_color?: string | null;
  accent_color?: string | null;
  font?: BrandingFont | null;
  border_style?: BrandingBorderStyle | null;
  /** `https://` only; `null` removes it. */
  terms_of_service_url?: string | null;
}

/**
 * Branding as a payer surface renders it: every field resolved (defaults
 * filled in), the logo and icon as URLs the gateway built through Oxy's media
 * chokepoint — a withheld file is `null`, never a broken image.
 */
export interface CheckoutBranding {
  icon_url: string | null;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  font: BrandingFont;
  border_style: BrandingBorderStyle;
}

/** Which customer emails Peable sends for this merchant. */
export interface MerchantEmailSettings {
  object: 'email_settings';
  livemode: boolean;
  /** A receipt when a payment succeeds and it has a `receipt_email` (or a collected email). */
  payment_receipts: boolean;
  /** A notice when a refund succeeds. */
  refund_notices: boolean;
  /** A confirmation when a checkout session completes. */
  checkout_confirmations: boolean;
  /** The reply-to address shown on emails, or `null` for none. */
  support_email: string | null;
  updated_at: number | null;
}

export interface UpdateMerchantEmailSettingsParams {
  payment_receipts?: boolean;
  refund_notices?: boolean;
  checkout_confirmations?: boolean;
  support_email?: string | null;
}
