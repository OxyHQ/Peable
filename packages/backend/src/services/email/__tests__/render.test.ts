import { describe, expect, test } from 'bun:test';
import { CHECKOUT_LOCALES } from '@peable.to/shared-types';
import { mailerFromEnv, MemoryMailer, MailerRefusedError } from '../mailer';
import { formatReceiptNumber } from '../outbox';
import { escapeHtml, formatAmount, stringsFor } from '../render';

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
