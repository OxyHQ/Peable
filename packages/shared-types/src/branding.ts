// Merchant branding and customer email settings (Orbit Phase 3). The wire
// types are the contract's (`@peable.to/contracts` `merchantBrandingSchema`,
// `merchantEmailSettingsSchema`, `checkoutBrandingSchema`); the closed sets are
// its zod-free vocabulary.
import type { BrandingBorderStyle, BrandingFont } from '@peable.to/contracts/vocabulary';

export {
  BRANDING_BORDER_STYLES,
  BRANDING_COLOR_PATTERN,
  BRANDING_FONTS,
  type BrandingBorderStyle,
  type BrandingFont,
} from '@peable.to/contracts/vocabulary';
export type {
  CheckoutBranding,
  MerchantBranding,
  MerchantEmailSettings,
  UpdateMerchantBrandingParams,
  UpdateMerchantEmailSettingsParams,
} from '@peable.to/contracts';

/** Peable's defaults, applied wherever a merchant set nothing. */
export const DEFAULT_BRANDING = Object.freeze({
  primary_color: '#1f6feb',
  accent_color: '#0b1f33',
  font: 'system' as BrandingFont,
  border_style: 'rounded' as BrandingBorderStyle,
});
