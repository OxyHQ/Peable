import { describe, expect, it } from 'bun:test';
import { intentCheckoutMethods, intentMethodAvailability } from '../intentMethods';
import { checkoutMessage } from '../messages';

const label = (key: string) => checkoutMessage('en', key);

describe('intent methods', () => {
  it('offers exactly what the intent carries, in this currency', () => {
    const methods = intentMethodAvailability(
      { rail: 'card', currency: 'EUR', payment_method_types: ['card', 'ideal'] },
      { wallets: ['apple_pay'], localMethods: true },
    );
    const byType = Object.fromEntries(methods.map((method) => [method.type, method]));
    expect(byType.card?.available).toBe(true);
    expect(byType.ideal?.available).toBe(true);
    expect(byType.apple_pay?.available).toBe(true);
    expect(byType.google_pay?.reason).toBe('device');
    expect(byType.sepa_debit?.reason).toBe('notOffered');
  });

  it('never offers a euro-only method on another currency', () => {
    const methods = intentMethodAvailability(
      { rail: 'card', currency: 'USD', payment_method_types: ['card', 'ideal'] },
      { localMethods: true },
    );
    expect(methods.find((method) => method.type === 'ideal')?.reason).toBe('currency');
  });

  it('keeps a wallet "checking" until the provider has probed, never assuming the platform', () => {
    const methods = intentMethodAvailability({
      rail: 'card',
      currency: 'EUR',
      payment_method_types: ['card'],
    });
    expect(methods.find((method) => method.type === 'apple_pay')?.reason).toBe('checking');
  });

  it('marks a wallet unusable on a payment that takes no card', () => {
    const methods = intentMethodAvailability(
      { rail: 'card', currency: 'EUR', payment_method_types: ['sepa_debit'] },
      { wallets: ['apple_pay', 'google_pay'], localMethods: true },
    );
    expect(methods.find((method) => method.type === 'apple_pay')?.reason).toBe('requiresCard');
  });

  it('says a local method needs the browser checkout on a host that cannot run it', () => {
    const methods = intentCheckoutMethods(
      { rail: 'card', currency: 'EUR', payment_method_types: ['card', 'sepa_debit', 'bancontact'] },
      { wallets: [] },
      label,
    );
    expect(methods.map((method) => method.id)).toEqual([
      'apple_pay',
      'google_pay',
      'card',
      'sepa_debit',
      'bancontact',
    ]);
    const sepa = methods.find((method) => method.id === 'sepa_debit');
    expect(sepa).toEqual({
      id: 'sepa_debit',
      label: 'SEPA Direct Debit',
      kind: 'account',
      disabled: true,
      detail: 'Available in the browser checkout',
    });
    expect(methods.find((method) => method.id === 'card')?.disabled).toBeUndefined();
    expect(methods.find((method) => method.id === 'apple_pay')?.detail).toBe(
      'Not available on this device or browser',
    );
  });

  it('has no card-rail methods on a FairCoin payment', () => {
    expect(
      intentMethodAvailability({
        rail: 'faircoin',
        currency: 'FAIR',
        payment_method_types: ['faircoin'],
      }),
    ).toEqual([]);
  });

  it('labels every method and reason in both languages', () => {
    for (const locale of ['en', 'es']) {
      for (const key of [
        'method.apple_pay',
        'method.sepa_debit',
        'method.unavailable.host',
        'method.unavailable.device',
        'method.unavailable.checking',
      ]) {
        expect(checkoutMessage(locale, key)).not.toBe(key);
      }
    }
  });
});
