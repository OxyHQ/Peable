// The checkout's language: which locale a page renders in, and the `t`
// function every component reads its strings through.
//
// Precedence, highest first: an explicit override (`?locale=` on a hosted page,
// `locale=` in the embedded frame's fragment), the locale the merchant set on
// the session or link, the payer's browser languages, English.
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import {
  CHECKOUT_LOCALES,
  type CheckoutLocale,
  checkoutLocaleDirection,
} from '@peable.to/shared-types';
import { CATALOGS, type MessageKey } from './messages';

export type { MessageKey } from './messages';

export function isCheckoutLocale(value: unknown): value is CheckoutLocale {
  return typeof value === 'string' && (CHECKOUT_LOCALES as readonly string[]).includes(value);
}

/** `es-MX` → `es`; anything checkout does not speak → `null`. */
function matchLanguage(tag: string): CheckoutLocale | null {
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return isCheckoutLocale(base) ? base : null;
}

export function resolveLocale(options: {
  override?: string | null | undefined;
  merchant?: CheckoutLocale | null | undefined;
  browser?: readonly string[] | undefined;
}): CheckoutLocale {
  const override = options.override ? matchLanguage(options.override) : null;
  if (override) return override;
  if (options.merchant) return options.merchant;
  for (const tag of options.browser ?? []) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return 'en';
}

/** The browser's preferred languages, read defensively. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** `?locale=` on the current URL — the hosted page's override. */
export function queryLocale(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('locale');
  } catch {
    return null;
  }
}

/**
 * The card provider's own field locale (its error lines, its wallet buttons)
 * for a page locale: the provider's code where it has the language, else its
 * `auto`. Portuguese is Brazilian, as the catalog is (`pt-BR`); Bengali,
 * Catalan and Hindi have no provider translation. The Pay with Peable sheet
 * makes the same choice (`providerLocale` in `@peable.to/sdk/checkout/ui`).
 */
const PROVIDER_LOCALES: Readonly<Record<CheckoutLocale, string>> = {
  ar: 'ar',
  bn: 'auto',
  ca: 'auto',
  de: 'de',
  en: 'en',
  es: 'es',
  fr: 'fr',
  hi: 'auto',
  id: 'id',
  it: 'it',
  ja: 'ja',
  pt: 'pt-BR',
  ru: 'ru',
  tr: 'tr',
  zh: 'zh',
};

export function providerLocale(locale: CheckoutLocale): string {
  return PROVIDER_LOCALES[locale];
}

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function translator(locale: CheckoutLocale): Translate {
  const catalog = CATALOGS[locale];
  return (key, params) => {
    const template = catalog[key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    );
  };
}

interface I18n {
  locale: CheckoutLocale;
  t: Translate;
}

const I18nContext = createContext<I18n>({ locale: 'en', t: translator('en') });

export function I18nProvider({
  locale,
  children,
}: {
  locale: CheckoutLocale;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale, t: translator(locale) }), [locale]);
  // The document's language follows the page's, for screen readers and
  // hyphenation, and so does its direction: Arabic lays the page out right to
  // left.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = checkoutLocaleDirection(locale);
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
