import { describe, expect, test } from 'bun:test';
import en from '../locales/en';
import {
  CHECKOUT_UI_LOCALES,
  checkoutMessage,
  intlLocale,
  providerLocale,
  resolveCheckoutLocale,
} from '../messages';

const placeholders = (text: string) =>
  [...text.matchAll(/\{\{[^}]+\}\}|\{[a-z]+\}/g)].map((match) => match[0]).sort();

describe('the catalog', () => {
  test.each(CHECKOUT_UI_LOCALES.map((locale) => [locale]))(
    '%s has every key, with the same placeholders, and translates',
    async (locale) => {
      const catalog = (await import(`../locales/${locale}`)).default as Record<string, string>;
      expect(Object.keys(catalog)).toEqual(Object.keys(en));
      for (const [key, english] of Object.entries(en)) {
        const text = catalog[key] ?? '';
        expect({ key, placeholders: placeholders(text) }).toEqual({
          key,
          placeholders: placeholders(english),
        });
        if (english === '') expect({ key, text }).toEqual({ key, text: '' });
        else expect({ key, empty: text.trim() === '' }).toEqual({ key, empty: false });
      }
      if (locale !== 'en') {
        // Not an English copy: most of the visible sentences differ.
        const same = Object.entries(en).filter(
          ([key, english]) => english.length > 12 && catalog[key] === english,
        );
        expect(same.length).toBeLessThan(10);
      }
    },
  );
});

describe('choosing a language', () => {
  test('a regional tag reads its language; an unknown one reads English', () => {
    expect(resolveCheckoutLocale('pt-BR')).toBe('pt');
    expect(resolveCheckoutLocale('zh-Hans')).toBe('zh');
    expect(resolveCheckoutLocale('de_DE')).toBe('en');
    expect(resolveCheckoutLocale('de-DE')).toBe('de');
    expect(resolveCheckoutLocale('sv')).toBe('en');
    expect(resolveCheckoutLocale('not a tag')).toBe('en');
  });

  test('every locale renders the sheet in its own words', () => {
    expect(checkoutMessage('de', 'method.card')).not.toBe(checkoutMessage('en', 'method.card'));
    expect(checkoutMessage('ja', 'continue')).not.toBe('Continue');
    expect(checkoutMessage('fr', 'payMerchant', { merchant: 'Mention' })).toContain('Mention');
  });

  test('a host override wins, and a missing key reads as itself', () => {
    expect(checkoutMessage('es', 'continue', undefined, { continue: 'Seguir' })).toBe('Seguir');
    expect(checkoutMessage('es', 'no.such.key')).toBe('no.such.key');
  });

  test('auto follows the device; Intl always gets a usable tag', () => {
    expect(CHECKOUT_UI_LOCALES).toContain(resolveCheckoutLocale('auto'));
    expect(() => new Intl.NumberFormat(intlLocale('auto'))).not.toThrow();
    expect(intlLocale('not a tag')).toBe('en');
  });

  test('the provider gets the language where it has it, else auto', () => {
    expect(providerLocale('pt-BR')).toBe('pt-BR');
    expect(providerLocale('de-AT')).toBe('de');
    expect(providerLocale('ca')).toBe('auto');
    expect(providerLocale('hi-IN')).toBe('auto');
  });
});
