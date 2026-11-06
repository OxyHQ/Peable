/**
 * The sheet's own copy, in every language its hosts ship: ONE catalog, in the
 * SDK, selected by the `locale` prop (Stripe's `locale`, `'auto'` included).
 * A host translates nothing of the sheet; `messages` only overrides product
 * copy by key.
 *
 * Every catalog has exactly the English keys (`CheckoutCatalog`, checked by
 * `tsc`) and the same placeholders (`__tests__/messages.test.ts`).
 */
import ar from './locales/ar';
import bn from './locales/bn';
import ca from './locales/ca';
import de from './locales/de';
import en, { type CheckoutCatalog } from './locales/en';
import es from './locales/es';
import fr from './locales/fr';
import hi from './locales/hi';
import id from './locales/id';
import it from './locales/it';
import ja from './locales/ja';
import pt from './locales/pt';
import ru from './locales/ru';
import tr from './locales/tr';
import zh from './locales/zh';

export type { CheckoutCatalog, CheckoutMessageKey } from './locales/en';

/** The languages the sheet speaks: the union of its hosts' (Mention's and Mercaria's). */
export const CHECKOUT_UI_LOCALES = [
  'ar',
  'bn',
  'ca',
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'pt',
  'ru',
  'tr',
  'zh',
] as const;
export type CheckoutUiLocale = (typeof CHECKOUT_UI_LOCALES)[number];

/** A BCP 47 tag (`pt-BR`, `zh-Hans`), or `'auto'`: the payer's browser or device. */
export type CheckoutLocale = 'auto' | (string & {});

const CATALOGS: Readonly<Record<CheckoutUiLocale, CheckoutCatalog>> = {
  ar,
  bn,
  ca,
  de,
  en,
  es,
  fr,
  hi,
  id,
  it,
  ja,
  pt,
  ru,
  tr,
  zh,
};

/** The browser's (or the device's) language, `en` when neither says. */
function deviceLocale(): string {
  const navigatorLanguage =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator.languages?.[0] ?? (navigator as { language?: string }).language);
  if (navigatorLanguage) return navigatorLanguage;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    return 'en';
  }
}

/**
 * The tag `Intl` formats amounts, dates and country names in: the host's, or
 * the device's for `'auto'`, and `en` for one `Intl` refuses.
 */
export function intlLocale(locale: CheckoutLocale | undefined): string {
  const tag = !locale || locale === 'auto' ? deviceLocale() : locale;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

const resolved = new Map<string, CheckoutUiLocale>();

/** The catalog a locale reads from: its language, else English. */
export function resolveCheckoutLocale(locale: CheckoutLocale | undefined): CheckoutUiLocale {
  const key = locale ?? 'auto';
  const known = key === 'auto' ? undefined : resolved.get(key);
  if (known) return known;
  const language = intlLocale(locale).toLowerCase().split(/[-_]/)[0] ?? 'en';
  const answer = (CHECKOUT_UI_LOCALES as readonly string[]).includes(language)
    ? (language as CheckoutUiLocale)
    : 'en';
  // `auto` follows the device, which can change; a named tag cannot.
  if (key !== 'auto') resolved.set(key, answer);
  return answer;
}

/**
 * The card provider's own field locale (its error lines, its wallet buttons):
 * the payer's language where the provider has it, else the provider's `auto`.
 */
const PROVIDER_LOCALES: ReadonlySet<string> = new Set([
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'id',
  'it',
  'ja',
  'pt',
  'pt-BR',
  'ru',
  'tr',
  'zh',
  'zh-HK',
  'zh-TW',
]);
export function providerLocale(locale: CheckoutLocale | undefined): string {
  const tag = intlLocale(locale);
  if (PROVIDER_LOCALES.has(tag)) return tag;
  const language = tag.split('-')[0] ?? '';
  return PROVIDER_LOCALES.has(language) ? language : 'auto';
}

export function checkoutMessage(
  locale: CheckoutLocale | undefined,
  key: string,
  values?: Record<string, string | number>,
  overrides?: Readonly<Record<string, string>>,
): string {
  const dictionary: Readonly<Record<string, string>> = CATALOGS[resolveCheckoutLocale(locale)];
  const fallback: Readonly<Record<string, string>> = en;
  const template = overrides?.[key] ?? dictionary[key] ?? fallback[key] ?? key;
  return template.replace(/\{\{([^}]+)\}\}/g, (placeholder, name: string) =>
    values?.[name] === undefined ? placeholder : String(values[name]),
  );
}
