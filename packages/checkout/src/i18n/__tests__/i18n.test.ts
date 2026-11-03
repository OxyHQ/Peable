import { expect, test } from 'bun:test';
import { CHECKOUT_LOCALES } from '@peable.to/shared-types';
import { resolveLocale, translator } from '../index';
import { CATALOGS } from '../messages';

test('an override beats the merchant locale, which beats the browser', () => {
  expect(resolveLocale({ override: 'de', merchant: 'es', browser: ['fr-FR'] })).toBe('de');
  expect(resolveLocale({ override: null, merchant: 'es', browser: ['fr-FR'] })).toBe('es');
  expect(resolveLocale({ merchant: null, browser: ['pt-BR', 'en'] })).toBe('pt');
});

test('an unsupported language falls through to the next preference, then English', () => {
  expect(resolveLocale({ override: 'nl', browser: ['ja', 'it-CH'] })).toBe('it');
  expect(resolveLocale({ browser: ['ja', 'zh-Hans'] })).toBe('en');
  expect(resolveLocale({})).toBe('en');
});

test('every locale has every message, none of them empty', () => {
  const keys = Object.keys(CATALOGS.en);
  for (const locale of CHECKOUT_LOCALES) {
    const catalog = CATALOGS[locale];
    expect(Object.keys(catalog).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(catalog[key as keyof typeof catalog].length).toBeGreaterThan(0);
  }
});

test('each locale speaks its own language', () => {
  const expected = {
    en: 'Order summary',
    es: 'Resumen del pedido',
    fr: 'Récapitulatif de la commande',
    de: 'Bestellübersicht',
    it: 'Riepilogo dell’ordine',
    pt: 'Resumo da encomenda',
  };
  for (const locale of CHECKOUT_LOCALES) {
    expect(translator(locale)('orderSummary')).toBe(expected[locale]);
  }
});

test('placeholders are filled, and every placeholder of a message survives translation', () => {
  expect(translator('es')('submitPay', { amount: '20,00 €' })).toBe('Pagar 20,00 €');
  expect(translator('de')('backTo', { merchant: 'Laden' })).toBe('Zurück zu Laden');
  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const locale of CHECKOUT_LOCALES) {
    for (const [key, text] of Object.entries(CATALOGS.en)) {
      const translated = CATALOGS[locale][key as keyof typeof CATALOGS.en];
      expect([locale, key, placeholders(translated)]).toEqual([locale, key, placeholders(text)]);
    }
  }
});
