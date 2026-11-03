// The `appearance` API (Orbit Phase 3) — one description of how payment UI
// looks, applied to Peable's own DOM chrome AND handed to the card provider's
// Elements, so the provider-hosted secure fields match the page around them.
//
// Pure: no DOM, no provider. `toProviderAppearance` is the only place the
// provider's vocabulary appears, and `toCssVariables` the only place Peable's
// chrome reads it.
import type { BrandingBorderStyle, BrandingFont, CheckoutBranding } from '@peable.to/shared-types';

export const APPEARANCE_THEMES = ['peable', 'night', 'flat'] as const;
export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

export interface AppearanceVariables {
  colorPrimary?: string;
  colorBackground?: string;
  colorText?: string;
  colorDanger?: string;
  fontFamily?: string;
  /** CSS length, e.g. `'8px'`. */
  borderRadius?: string;
  /** CSS length, e.g. `'4px'` — the base of every gap and padding. */
  spacingUnit?: string;
}

/**
 * Per-selector overrides (Stripe's `rules`): `'.Input'`, `'.Input:focus'`,
 * `'.Label'`, `'.Tab'`, `'.Tab--selected'`, `'.Error'` → CSS properties in
 * camelCase. Only these selectors and a fixed property set are passed on.
 */
export type AppearanceRules = Record<string, Record<string, string>>;

export interface Appearance {
  theme?: AppearanceTheme;
  variables?: AppearanceVariables;
  rules?: AppearanceRules;
}

export const APPEARANCE_RULE_SELECTORS = [
  '.Input',
  '.Input:focus',
  '.Input--invalid',
  '.Label',
  '.Tab',
  '.Tab:hover',
  '.Tab--selected',
  '.Error',
  '.Block',
] as const;

const RULE_PROPERTIES = new Set([
  'color',
  'backgroundColor',
  'border',
  'borderColor',
  'borderRadius',
  'borderWidth',
  'boxShadow',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'padding',
  'margin',
  'outline',
  'textTransform',
]);

/** Font stacks for the branding fonts — local/system fonts only, never a remote load. */
export const FONT_STACKS: Readonly<Record<BrandingFont, string>> = Object.freeze({
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  inter: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  roboto: 'Roboto, system-ui, -apple-system, "Segoe UI", sans-serif',
  open_sans: '"Open Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  lato: 'Lato, system-ui, -apple-system, "Segoe UI", sans-serif',
  source_sans: '"Source Sans 3", "Source Sans Pro", system-ui, sans-serif',
  noto_sans: '"Noto Sans", system-ui, -apple-system, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  monospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
});

export const BORDER_RADII: Readonly<Record<BrandingBorderStyle, string>> = Object.freeze({
  rounded: '8px',
  rectangular: '0px',
  pill: '999px',
});

const THEME_DEFAULTS: Readonly<Record<AppearanceTheme, Required<AppearanceVariables>>> =
  Object.freeze({
    peable: {
      colorPrimary: '#1f6feb',
      colorBackground: '#ffffff',
      colorText: '#0b1f33',
      colorDanger: '#c62828',
      fontFamily: FONT_STACKS.system,
      borderRadius: '8px',
      spacingUnit: '4px',
    },
    night: {
      colorPrimary: '#58a6ff',
      colorBackground: '#0d1117',
      colorText: '#e6edf3',
      colorDanger: '#ff7b72',
      fontFamily: FONT_STACKS.system,
      borderRadius: '8px',
      spacingUnit: '4px',
    },
    flat: {
      colorPrimary: '#1f6feb',
      colorBackground: '#f6f8fa',
      colorText: '#0b1f33',
      colorDanger: '#c62828',
      fontFamily: FONT_STACKS.system,
      borderRadius: '4px',
      spacingUnit: '4px',
    },
  });

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const LENGTH = /^\d{1,4}(?:\.\d{1,3})?(?:px|rem|em)$/;
/** A font-family list: names, quotes, commas, spaces, hyphens. No `url(`, no `;`. */
const FONT_FAMILY = /^[A-Za-z0-9 ,"'_-]{1,200}$/;
/** A safe CSS value for a rule property: no `url(`, `expression(`, braces or semicolons. */
const RULE_VALUE = /^[A-Za-z0-9 #%.,()"'_-]{1,120}$/;
/** The only CSS functions a rule value may call — colours and arithmetic, never `expression(`. */
const RULE_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc']);

function safeRuleValue(value: string): boolean {
  if (!RULE_VALUE.test(value)) return false;
  const call = /([A-Za-z-]*)\s*\(/g;
  for (let match = call.exec(value); match !== null; match = call.exec(value)) {
    if (!RULE_FUNCTIONS.has((match[1] ?? '').toLowerCase())) return false;
  }
  return true;
}

function validVariable(key: keyof AppearanceVariables, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  switch (key) {
    case 'colorPrimary':
    case 'colorBackground':
    case 'colorText':
    case 'colorDanger':
      return COLOR.test(value);
    case 'borderRadius':
    case 'spacingUnit':
      return LENGTH.test(value);
    case 'fontFamily':
      return FONT_FAMILY.test(value);
  }
}

/**
 * Validate and complete an appearance: unknown themes fall back to `peable`,
 * invalid variables are dropped (never passed to CSS or the provider), and
 * rules keep only known selectors, known properties and safe values.
 */
export function resolveAppearance(input: Appearance | undefined): {
  theme: AppearanceTheme;
  variables: Required<AppearanceVariables>;
  rules: AppearanceRules;
} {
  const theme: AppearanceTheme =
    input?.theme && (APPEARANCE_THEMES as readonly string[]).includes(input.theme)
      ? input.theme
      : 'peable';
  const variables: Required<AppearanceVariables> = { ...THEME_DEFAULTS[theme] };
  for (const key of Object.keys(variables) as (keyof AppearanceVariables)[]) {
    const value = input?.variables?.[key];
    if (validVariable(key, value)) variables[key] = value;
  }
  const rules: AppearanceRules = {};
  for (const [selector, properties] of Object.entries(input?.rules ?? {})) {
    if (!(APPEARANCE_RULE_SELECTORS as readonly string[]).includes(selector)) continue;
    if (typeof properties !== 'object' || properties === null) continue;
    const kept: Record<string, string> = {};
    for (const [property, value] of Object.entries(properties)) {
      if (RULE_PROPERTIES.has(property) && typeof value === 'string' && safeRuleValue(value)) {
        kept[property] = value;
      }
    }
    if (Object.keys(kept).length > 0) rules[selector] = kept;
  }
  return { theme, variables, rules };
}

/**
 * The provider's Elements `appearance` option. Peable's `peable` theme is the
 * provider's `stripe` base with Peable's variables; `night` and `flat` share
 * the provider's names.
 */
export function toProviderAppearance(input: Appearance | undefined): Record<string, unknown> {
  const resolved = resolveAppearance(input);
  return {
    theme: resolved.theme === 'peable' ? 'stripe' : resolved.theme,
    variables: { ...resolved.variables },
    ...(Object.keys(resolved.rules).length > 0 ? { rules: resolved.rules } : {}),
  };
}

/** CSS custom properties for Peable's own chrome (`--peable-color-primary`, …). */
export function toCssVariables(input: Appearance | undefined): Record<string, string> {
  const { variables } = resolveAppearance(input);
  return {
    '--peable-color-primary': variables.colorPrimary,
    '--peable-color-background': variables.colorBackground,
    '--peable-color-text': variables.colorText,
    '--peable-color-danger': variables.colorDanger,
    '--peable-font-family': variables.fontFamily,
    '--peable-border-radius': variables.borderRadius,
    '--peable-spacing-unit': variables.spacingUnit,
  };
}

/**
 * The appearance a merchant's branding implies — what hosted and embedded
 * checkout start from. An integrator's own `appearance` (embedded mode)
 * overrides it variable by variable.
 */
export function appearanceFromBranding(
  branding: CheckoutBranding,
  override?: Appearance,
): Appearance {
  return {
    theme: override?.theme ?? 'peable',
    variables: {
      colorPrimary: branding.primary_color,
      fontFamily: FONT_STACKS[branding.font],
      borderRadius: BORDER_RADII[branding.border_style],
      ...override?.variables,
    },
    ...(override?.rules ? { rules: override.rules } : {}),
  };
}
