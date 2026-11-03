// A merchant's branding as CSS: the custom properties every component's
// stylesheet reads, derived through the SDK's appearance module so the page
// chrome and the provider's secure fields agree.
import type { CSSProperties } from 'react';
import {
  type Appearance,
  appearanceFromBranding,
  toCssVariables,
  toProviderAppearance,
} from '@peable.to/sdk/checkout';
import type { CheckoutBranding } from '@peable.to/shared-types';

export type { Appearance } from '@peable.to/sdk/checkout';

export function brandingAppearance(branding: CheckoutBranding, override?: Appearance): Appearance {
  return appearanceFromBranding(branding, override);
}

/** Inline style carrying the branding's CSS variables, plus the accent colour. */
export function brandingStyle(branding: CheckoutBranding, override?: Appearance): CSSProperties {
  return {
    ...toCssVariables(brandingAppearance(branding, override)),
    '--peable-color-accent': branding.accent_color,
  } as CSSProperties;
}

/** The provider's Elements `appearance` for this branding. */
export function providerAppearance(
  branding: CheckoutBranding,
  override?: Appearance,
): Record<string, unknown> {
  return toProviderAppearance(brandingAppearance(branding, override));
}
