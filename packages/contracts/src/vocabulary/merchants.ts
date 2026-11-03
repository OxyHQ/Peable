// Merchant vocabulary: the environments a merchant lives in, and the closed
// sets branding draws from. Every branding value is from a CLOSED set or a
// validated colour, so nothing a merchant stores can inject markup or a remote
// font into a payer's page or an email. Zod-free.

export const MERCHANT_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type MerchantEnvironment = (typeof MERCHANT_ENVIRONMENTS)[number];

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
