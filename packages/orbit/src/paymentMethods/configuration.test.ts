import { describe, expect, it } from 'bun:test';
import {
  FIAT_CURRENCY_CODES,
  PAYMENT_METHOD_CONFIGURATION_TYPES,
  PAYMENT_METHOD_CURRENCIES,
  type PaymentMethodConfiguration,
  type PaymentMethodConfigurationEntry,
} from '@peable.to/shared-types';
import {
  canToggle,
  currenciesText,
  defaultConfiguration,
  ORBIT_PAYMENT_METHOD_TYPES,
  parseDomainInput,
  paymentMethodLabel,
  preferenceText,
  preferenceUpdate,
  unavailableReasonText,
  walletStatusText,
} from './configuration';

function entry(overrides: Partial<PaymentMethodConfigurationEntry> = {}) {
  return {
    available: true,
    display_preference: { preference: 'none', value: 'on' },
    unavailable_reason: null,
    currencies: ['EUR'],
    ...overrides,
  } as PaymentMethodConfigurationEntry;
}

describe('ORBIT_PAYMENT_METHOD_TYPES', () => {
  it('is every configurable method, each once, and each has a name', () => {
    expect([...ORBIT_PAYMENT_METHOD_TYPES].sort()).toEqual(
      [...PAYMENT_METHOD_CONFIGURATION_TYPES].sort(),
    );
    for (const type of ORBIT_PAYMENT_METHOD_TYPES) {
      expect(paymentMethodLabel(type)).not.toBe(type);
    }
  });
});

describe('truthful wording', () => {
  it('says why a method cannot be offered', () => {
    expect(unavailableReasonText('provider_unsupported')).toBe(
      'Not offered by the processing provider',
    );
    expect(unavailableReasonText('requires_card')).toBe('Needs card payments on');
  });

  it('names the currencies a method applies to', () => {
    expect(currenciesText(PAYMENT_METHOD_CURRENCIES.ideal)).toBe('EUR only');
    expect(currenciesText(PAYMENT_METHOD_CURRENCIES.card)).toBe('All currencies');
    expect(currenciesText(FIAT_CURRENCY_CODES)).toBe('All currencies');
    expect(currenciesText(['EUR', 'GBP'])).toBe('EUR, GBP');
  });

  it('tells the merchant’s choice from Orbit’s default', () => {
    expect(preferenceText(entry())).toBe('Default (on)');
    expect(preferenceText(entry({ display_preference: { preference: 'off', value: 'off' } }))).toBe(
      'Off',
    );
  });

  it('disables only what the provider does not offer', () => {
    expect(canToggle(entry({ unavailable_reason: 'provider_unsupported', available: false }))).toBe(
      false,
    );
    expect(canToggle(entry({ unavailable_reason: 'requires_card', available: false }))).toBe(true);
  });

  it('words a wallet status with the provider’s detail', () => {
    expect(walletStatusText({ status: 'active', status_details: null })).toBe('Active');
    expect(
      walletStatusText({
        status: 'inactive',
        status_details: { error_message: 'the verification file is missing' },
      }),
    ).toBe('Inactive: the verification file is missing');
  });
});

describe('preferenceUpdate', () => {
  it('changes exactly one method', () => {
    expect(preferenceUpdate('ideal', true)).toEqual({
      ideal: { display_preference: { preference: 'on' } },
    });
    expect(preferenceUpdate('card', false)).toEqual({
      card: { display_preference: { preference: 'off' } },
    });
  });
});

describe('defaultConfiguration', () => {
  it('starts on the default, else the first', () => {
    const a = { id: 'pmc_a', is_default: false } as PaymentMethodConfiguration;
    const b = { id: 'pmc_b', is_default: true } as PaymentMethodConfiguration;
    expect(defaultConfiguration([a, b])?.id).toBe('pmc_b');
    expect(defaultConfiguration([a])?.id).toBe('pmc_a');
    expect(defaultConfiguration([])).toBeUndefined();
  });
});

describe('parseDomainInput', () => {
  it('accepts a hostname and lowercases it', () => {
    expect(parseDomainInput(' Shop.Example.COM ')).toEqual({
      ok: true,
      domain: 'shop.example.com',
    });
  });

  it('refuses a scheme, a path, a port or a bare word', () => {
    expect(parseDomainInput('https://shop.example.com').ok).toBe(false);
    expect(parseDomainInput('shop.example.com/pay').ok).toBe(false);
    expect(parseDomainInput('shop.example.com:443').ok).toBe(false);
    expect(parseDomainInput('localhost').ok).toBe(false);
    expect(parseDomainInput('-bad.example.com').ok).toBe(false);
    expect(parseDomainInput('').ok).toBe(false);
  });
});
