import { expect, test } from 'bun:test';
import { CHECKOUT_LOCALES, checkoutLocaleDirection } from '@peable.to/shared-types';
import { providerLocale, resolveLocale, translator } from '../index';
import { CATALOGS } from '../messages';

test('the checkout speaks exactly the payer locale set', () => {
  expect(Object.keys(CATALOGS).sort()).toEqual([...CHECKOUT_LOCALES].sort());
});

test('an override beats the merchant locale, which beats the browser', () => {
  expect(resolveLocale({ override: 'de', merchant: 'es', browser: ['fr-FR'] })).toBe('de');
  expect(resolveLocale({ override: null, merchant: 'es', browser: ['fr-FR'] })).toBe('es');
  expect(resolveLocale({ merchant: null, browser: ['pt-BR', 'en'] })).toBe('pt');
});

test('a regional tag reads its language; an unsupported one falls through, then English', () => {
  expect(resolveLocale({ browser: ['zh-Hans-CN'] })).toBe('zh');
  expect(resolveLocale({ browser: ['ar-EG'] })).toBe('ar');
  expect(resolveLocale({ override: 'nl', browser: ['sv', 'ja-JP'] })).toBe('ja');
  expect(resolveLocale({ browser: ['nl', 'sv'] })).toBe('en');
  expect(resolveLocale({})).toBe('en');
});

test('every locale has every message, none of them empty', () => {
  const keys = Object.keys(CATALOGS.en);
  for (const locale of CHECKOUT_LOCALES) {
    const catalog = CATALOGS[locale];
    expect([locale, Object.keys(catalog).sort()]).toEqual([locale, [...keys].sort()]);
    for (const key of keys) {
      const text = catalog[key as keyof typeof catalog];
      expect([locale, key, text.trim().length > 0]).toEqual([locale, key, true]);
    }
  }
});

test('each locale speaks its own language', () => {
  const expected: Record<(typeof CHECKOUT_LOCALES)[number], string> = {
    ar: 'ملخص الطلب',
    bn: 'অর্ডারের সারাংশ',
    ca: 'Resum de la comanda',
    de: 'Bestellübersicht',
    en: 'Order summary',
    es: 'Resumen del pedido',
    fr: 'Récapitulatif de la commande',
    hi: 'ऑर्डर सारांश',
    id: 'Ringkasan pesanan',
    it: 'Riepilogo dell’ordine',
    ja: 'ご注文の概要',
    pt: 'Resumo do pedido',
    ru: 'Сводка заказа',
    tr: 'Sipariş özeti',
    zh: '订单摘要',
  };
  for (const locale of CHECKOUT_LOCALES) {
    expect(translator(locale)('orderSummary')).toBe(expected[locale]);
  }
  // Not English copies: almost every sentence differs from the source.
  for (const locale of CHECKOUT_LOCALES) {
    if (locale === 'en') continue;
    const same = Object.entries(CATALOGS.en).filter(
      ([key, english]) =>
        english.length > 12 && CATALOGS[locale][key as keyof typeof CATALOGS.en] === english,
    );
    expect([locale, same.map(([key]) => key)]).toEqual([locale, []]);
  }
});

test('placeholders are filled, and every placeholder of a message survives translation', () => {
  expect(translator('es')('submitPay', { amount: '20,00 €' })).toBe('Pagar 20,00 €');
  expect(translator('de')('backTo', { merchant: 'Laden' })).toBe('Zurück zu Laden');
  expect(translator('ja')('invoiceNumber', { number: 'A-1' })).toBe('請求書 A-1');
  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const locale of CHECKOUT_LOCALES) {
    for (const [key, text] of Object.entries(CATALOGS.en)) {
      const translated = CATALOGS[locale][key as keyof typeof CATALOGS.en];
      expect([locale, key, placeholders(translated)]).toEqual([locale, key, placeholders(text)]);
    }
  }
});

test('Arabic is laid out right to left, every other locale left to right', () => {
  for (const locale of CHECKOUT_LOCALES) {
    expect([locale, checkoutLocaleDirection(locale)]).toEqual([
      locale,
      locale === 'ar' ? 'rtl' : 'ltr',
    ]);
  }
});

test('the card provider gets its own code, or auto where it has no translation', () => {
  expect(providerLocale('pt')).toBe('pt-BR');
  expect(providerLocale('zh')).toBe('zh');
  expect(providerLocale('ca')).toBe('auto');
  expect(providerLocale('hi')).toBe('auto');
});
