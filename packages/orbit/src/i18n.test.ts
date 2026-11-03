import { afterEach, describe, expect, it } from 'bun:test';
import { catalogFor, FALLBACK_LOCALE, getLocale, setLocale, SUPPORTED_LOCALES, t } from './i18n';
import { MONEY_EN, MONEY_ES } from './money/strings';
import { REPORTS_EN, REPORTS_ES } from './reports/strings';
import { SEARCH_EN, SEARCH_ES } from './search/strings';
import { ORBIT_EN, ORBIT_ES } from './orbitStrings';
import { SHELL_EN, SHELL_ES } from './shell/strings';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Names that stay as they are in every language (brands and typefaces). */
const UNTRANSLATED =
  /^(branding\.font\.|methods\.type\.(apple_pay|google_pay|ideal|bancontact|eps|bizum)$)/;

afterEach(() => {
  setLocale(FALLBACK_LOCALE);
});

describe('catalogs', () => {
  it('offers English and Spanish to Oxy', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es']);
  });

  it('spells every screen in both languages, with the same placeholders', () => {
    const en = catalogFor('en') ?? {};
    const es = catalogFor('es') ?? {};
    const missing = Object.keys(en).filter(
      (key) => !Object.hasOwn(es, key) && !UNTRANSLATED.test(key),
    );
    expect(missing).toEqual([]);
    for (const [key, english] of Object.entries(en)) {
      if (Object.hasOwn(es, key))
        expect([key, placeholders(es[key] ?? '')]).toEqual([key, placeholders(english)]);
    }
  });

  it('spells the reports screen, the search box and the shell in both, with the same placeholders', () => {
    for (const [english, spanish] of [
      [REPORTS_EN, REPORTS_ES],
      [SEARCH_EN, SEARCH_ES],
      [SHELL_EN, SHELL_ES],
    ] as const) {
      expect(Object.keys(spanish).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(english)) {
        expect(placeholders(spanish[key] ?? '')).toEqual(placeholders(text));
      }
    }
  });

  it('has no Spanish key that English lacks', () => {
    const en = catalogFor('en') ?? {};
    for (const key of Object.keys(catalogFor('es') ?? {}))
      expect([key, Object.hasOwn(en, key)]).toEqual([key, true]);
  });

  it('keeps each area module’s two languages in step', () => {
    for (const [english, spanish] of [
      [MONEY_EN, MONEY_ES],
      [ORBIT_EN, ORBIT_ES],
    ] as const) {
      expect(Object.keys(spanish).sort()).toEqual(Object.keys(english).sort());
    }
  });
});

describe('t', () => {
  it('reads the active catalog', () => {
    expect(setLocale('es-ES')).toBe('es');
    expect(getLocale()).toBe('es');
    expect(t('nav.balances')).toBe('Saldos');
    expect(t('payoutCreate.available', { amount: '1.00 EUR' })).toBe('Disponible: 1.00 EUR');
  });

  it('selects English for an unknown language, and renders an unknown key as itself', () => {
    expect(setLocale('fr')).toBe('en');
    expect(t('nav.balances')).toBe('Balances');
    expect(t('no.such.key')).toBe('no.such.key');
  });
});
