import { afterEach, describe, expect, it } from 'bun:test';
import { catalogFor, FALLBACK_LOCALE, setLocale, SUPPORTED_LOCALES, t } from './i18n';
import { MONEY_EN, MONEY_ES } from './money/strings';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => {
  setLocale(FALLBACK_LOCALE);
});

describe('catalogs', () => {
  it('spells the money screens in English and Spanish with the same keys and placeholders', () => {
    expect(Object.keys(MONEY_ES).sort()).toEqual(Object.keys(MONEY_EN).sort());
    for (const [key, english] of Object.entries(MONEY_EN)) {
      expect(placeholders(MONEY_ES[key] ?? '')).toEqual(placeholders(english));
    }
  });

  it('has no Spanish key that English lacks', () => {
    const en = catalogFor('en') ?? {};
    for (const key of Object.keys(catalogFor('es') ?? {}))
      expect(Object.hasOwn(en, key)).toBe(true);
  });

  it('does not offer Spanish to Oxy until the rest of Orbit is translated', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en']);
  });
});

describe('t', () => {
  it('reads the active catalog and falls back to English per key', () => {
    expect(setLocale('es-ES')).toBe('es');
    expect(t('nav.balances')).toBe('Saldos');
    expect(t('payments.title')).toBe('Payments');
    expect(t('payoutCreate.available', { amount: '1.00 EUR' })).toBe('Disponible: 1.00 EUR');
  });

  it('selects English for an unknown language', () => {
    expect(setLocale('fr')).toBe('en');
    expect(t('nav.balances')).toBe('Balances');
  });
});
