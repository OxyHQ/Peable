import type {
  BrandingBorderStyle,
  BrandingFont,
  MerchantBranding,
  MerchantEmailSettings,
  UpdateMerchantBrandingParams,
  UpdateMerchantEmailSettingsParams,
} from '@peable.to/shared-types';

/**
 * Branding and customer-email settings as pure data: the forms, their rules,
 * the patches, and the preview the screen draws.
 *
 * Restated from `@peable.to/shared-types` (its root barrel is not loadable in a
 * browser — see `format/money.ts`) and pinned by `brandingForm.test.ts`.
 */
export const ORBIT_BRANDING_FONTS: readonly BrandingFont[] = [
  'system',
  'inter',
  'roboto',
  'open_sans',
  'lato',
  'source_sans',
  'noto_sans',
  'serif',
  'monospace',
];
export const ORBIT_BORDER_STYLES: readonly BrandingBorderStyle[] = [
  'rounded',
  'rectangular',
  'pill',
];
export const ORBIT_BRANDING_COLOR = /^#[0-9a-f]{6}$/;
export const ORBIT_DEFAULT_BRANDING = {
  primary_color: '#1f6feb',
  accent_color: '#0b1f33',
  font: 'system' as BrandingFont,
  border_style: 'rounded' as BrandingBorderStyle,
};

/**
 * The CSS font stacks checkout renders each font with — the same strings as
 * the SDK's `FONT_STACKS` (`@peable.to/sdk/checkout`), so the preview reads
 * like the real page. Not imported: that entry carries the socket client.
 */
export const PREVIEW_FONT_STACKS: Readonly<Record<BrandingFont, string>> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  inter: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  roboto: 'Roboto, system-ui, -apple-system, "Segoe UI", sans-serif',
  open_sans: '"Open Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  lato: 'Lato, system-ui, -apple-system, "Segoe UI", sans-serif',
  source_sans: '"Source Sans 3", "Source Sans Pro", system-ui, sans-serif',
  noto_sans: '"Noto Sans", system-ui, -apple-system, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  monospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

/** The SDK's `BORDER_RADII`, as React Native numbers. */
export const PREVIEW_RADII: Readonly<Record<BrandingBorderStyle, number>> = {
  rounded: 8,
  rectangular: 0,
  pill: 999,
};

export interface BrandingForm {
  useAvatarAsIcon: boolean;
  logo: string;
  /** As typed; empty for Peable's default. */
  primaryColor: string;
  accentColor: string;
  /** `null` for Peable's default. */
  font: BrandingFont | null;
  borderStyle: BrandingBorderStyle | null;
  /** `https://…`, or empty for none. */
  termsOfServiceUrl: string;
}

export type BrandingFormError = 'primary_color' | 'accent_color' | 'logo' | 'terms_of_service_url';

export function brandingFormOf(branding: MerchantBranding): BrandingForm {
  return {
    useAvatarAsIcon: branding.use_avatar_as_icon,
    logo: branding.logo ?? '',
    primaryColor: branding.primary_color ?? '',
    accentColor: branding.accent_color ?? '',
    font: branding.font,
    borderStyle: branding.border_style,
    termsOfServiceUrl: branding.terms_of_service_url ?? '',
  };
}

/** An `https://` URL with a host, as the gateway accepts for terms of service. */
export function isHttpsUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * `#abc`, `ABCDEF`, ` #AbCdEf ` → `#aabbcc` / `#abcdef`; empty → `null`
 * (Peable's default); anything else → `undefined` (refused).
 */
export function normalizeColor(text: string): string | null | undefined {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') return null;
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const full = /^[0-9a-f]{3}$/.test(hex)
    ? hex
        .split('')
        .map((digit) => digit + digit)
        .join('')
    : hex;
  const color = `#${full}`;
  return ORBIT_BRANDING_COLOR.test(color) ? color : undefined;
}

/** A `file_…` (purpose `business_logo`), as the Files API mints it. */
const FILE_ID = /^file_[A-Za-z0-9]{1,120}$/;

/** The patch of what changed, or the fields that cannot be sent. */
export function buildBrandingPatch(
  current: MerchantBranding,
  form: BrandingForm,
): { ok: true; body: UpdateMerchantBrandingParams } | { ok: false; errors: BrandingFormError[] } {
  const errors: BrandingFormError[] = [];
  const primary = normalizeColor(form.primaryColor);
  const accent = normalizeColor(form.accentColor);
  if (primary === undefined) errors.push('primary_color');
  if (accent === undefined) errors.push('accent_color');
  const logo = form.logo.trim();
  if (logo !== '' && !FILE_ID.test(logo)) errors.push('logo');
  const terms = form.termsOfServiceUrl.trim();
  if (terms !== '' && (!isHttpsUrl(terms) || terms.length > 2048)) {
    errors.push('terms_of_service_url');
  }
  if (errors.length > 0 || primary === undefined || accent === undefined) {
    return { ok: false, errors };
  }
  const body: UpdateMerchantBrandingParams = {};
  if (form.useAvatarAsIcon !== current.use_avatar_as_icon) {
    body.use_avatar_as_icon = form.useAvatarAsIcon;
  }
  const logoValue = logo === '' ? null : logo;
  if (logoValue !== current.logo) body.logo = logoValue;
  if (primary !== current.primary_color) body.primary_color = primary;
  if (accent !== current.accent_color) body.accent_color = accent;
  if (form.font !== current.font) body.font = form.font;
  if (form.borderStyle !== current.border_style) body.border_style = form.borderStyle;
  const termsValue = terms === '' ? null : terms;
  if (termsValue !== current.terms_of_service_url) body.terms_of_service_url = termsValue;
  return { ok: true, body };
}

/** What the preview draws — the form's values where valid, Peable's defaults elsewhere. */
export interface BrandingPreview {
  primaryColor: string;
  accentColor: string;
  /** The text colour that reads on `primaryColor` (WCAG relative luminance). */
  onPrimary: '#ffffff' | '#000000';
  fontFamily: string;
  radius: number;
  showIcon: boolean;
  showLogo: boolean;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Black or white, whichever contrasts more with `background` (`#rrggbb`). */
export function readableOn(background: string): '#ffffff' | '#000000' {
  const l = luminance(background);
  // Contrast with white is 1.05/(l+0.05); with black (l+0.05)/0.05.
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

export function brandingPreview(form: BrandingForm): BrandingPreview {
  const primary = normalizeColor(form.primaryColor) ?? ORBIT_DEFAULT_BRANDING.primary_color;
  const accent = normalizeColor(form.accentColor) ?? ORBIT_DEFAULT_BRANDING.accent_color;
  const font = form.font ?? ORBIT_DEFAULT_BRANDING.font;
  const border = form.borderStyle ?? ORBIT_DEFAULT_BRANDING.border_style;
  return {
    primaryColor: primary,
    accentColor: accent,
    onPrimary: readableOn(primary),
    fontFamily: PREVIEW_FONT_STACKS[font],
    radius: PREVIEW_RADII[border],
    showIcon: form.useAvatarAsIcon,
    showLogo: form.logo.trim() !== '',
  };
}

// ---- Logo upload --------------------------------------------------------------

export interface EmailSettingsForm {
  paymentReceipts: boolean;
  refundNotices: boolean;
  checkoutConfirmations: boolean;
  supportEmail: string;
}

export function emailSettingsFormOf(settings: MerchantEmailSettings): EmailSettingsForm {
  return {
    paymentReceipts: settings.payment_receipts,
    refundNotices: settings.refund_notices,
    checkoutConfirmations: settings.checkout_confirmations,
    supportEmail: settings.support_email ?? '',
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The patch of what changed; `null` when the support email is not an address. */
export function buildEmailSettingsPatch(
  current: MerchantEmailSettings,
  form: EmailSettingsForm,
): UpdateMerchantEmailSettingsParams | null {
  const support = form.supportEmail.trim();
  if (support !== '' && (!EMAIL.test(support) || support.length > 254)) return null;
  const body: UpdateMerchantEmailSettingsParams = {};
  if (form.paymentReceipts !== current.payment_receipts) {
    body.payment_receipts = form.paymentReceipts;
  }
  if (form.refundNotices !== current.refund_notices) body.refund_notices = form.refundNotices;
  if (form.checkoutConfirmations !== current.checkout_confirmations) {
    body.checkout_confirmations = form.checkoutConfirmations;
  }
  const supportValue = support === '' ? null : support;
  if (supportValue !== current.support_email) body.support_email = supportValue;
  return body;
}
