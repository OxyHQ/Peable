import { describe, expect, test } from 'bun:test';
import { CHECKOUT_LOCALES } from '@peable.to/shared-types';
import { mailerFromEnv, MemoryMailer, MailerRefusedError } from '../mailer';
import { formatReceiptNumber } from '../outbox';
import { EMAIL_STRINGS, emailLocale, escapeHtml, formatAmount, stringsFor } from '../render';

describe('customer email rendering', () => {
  test('amounts are exact in every currency', () => {
    expect(formatAmount('250000000', 'FAIR', 'en')).toBe('2.5 FAIR');
    expect(formatAmount('100000000', 'FAIR', 'en')).toBe('1 FAIR');
    expect(formatAmount('1250', 'EUR', 'en')).toBe('€12.50');
    // A large amount keeps its exact digits — no float in between.
    expect(formatAmount('900719925474099399', 'USD', 'en')).toContain('.99');
  });

  test('every interpolated string is escaped', () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe(
      '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;',
    );
  });

  test('every checkout locale has its own strings, and anything else is English', () => {
    const subjects = new Set(
      CHECKOUT_LOCALES.map((locale) => stringsFor(locale).receiptSubject('Shop')),
    );
    expect(subjects.size).toBe(CHECKOUT_LOCALES.length);
    expect(stringsFor('zz').receiptSubject('Shop')).toBe('Your receipt from Shop');
    expect(stringsFor('es').receiptSubject('Shop')).toBe('Tu recibo de Shop');
  });

  test('the emails speak exactly the payer locale set', () => {
    expect(Object.keys(EMAIL_STRINGS).sort()).toEqual([...CHECKOUT_LOCALES].sort());
    expect(emailLocale('zh')).toBe('zh');
    expect(emailLocale(null)).toBe('en');
    expect(emailLocale('nl')).toBe('en');
  });

  test('every locale has every string, translated, and every subject names its arguments', () => {
    const english = EMAIL_STRINGS.en;
    const keys = Object.keys(english).sort();
    for (const locale of CHECKOUT_LOCALES) {
      const strings = EMAIL_STRINGS[locale];
      expect([locale, Object.keys(strings).sort()]).toEqual([locale, keys]);
      for (const [key, value] of Object.entries(strings)) {
        const source = english[key as keyof typeof english];
        if (typeof value === 'function') {
          expect([locale, key, typeof source]).toEqual([locale, key, 'function']);
          // A subject interpolates the merchant (and the invoice number) it is given.
          const rendered = (value as (m: string, n: string) => string)('«Shop»', '«INV-7»');
          expect([locale, key, rendered.includes('«Shop»')]).toEqual([locale, key, true]);
          const wantsNumber = (source as (m: string, n: string) => string)('a', '«INV-7»').includes(
            '«INV-7»',
          );
          expect([locale, key, rendered.includes('«INV-7»')]).toEqual([locale, key, wantsNumber]);
        } else {
          expect([locale, key, typeof value === 'string' && value.trim().length > 0]).toEqual([
            locale,
            key,
            true,
          ]);
        }
      }
      if (locale !== 'en') {
        // Not an English copy: the sentences differ.
        expect([locale, strings.paymentFailedNote === english.paymentFailedNote]).toEqual([
          locale,
          false,
        ]);
        expect([locale, strings.receiptSubject('S') === english.receiptSubject('S')]).toEqual([
          locale,
          false,
        ]);
      }
    }
  });

  test('receipt numbers are the merchant sequence, zero-padded', () => {
    expect(formatReceiptNumber(42)).toBe('R-000042');
  });

  test('the memory mailer records, and can be made to refuse', async () => {
    const mailer = new MemoryMailer();
    mailer.failNext(new MailerRefusedError('suppressed'));
    const email = { to: 'a@b.c', replyTo: null, subject: 's', text: 't', html: 'h', headers: {} };
    await expect(mailer.send(email)).rejects.toThrow('suppressed');
    await mailer.send(email);
    expect(mailer.sent).toHaveLength(1);
    expect(mailerFromEnv({})).toBeNull();
    expect(mailerFromEnv({ PEABLE_MAIL_TRANSPORT: 'log' })?.name).toBe('log');
  });
});
