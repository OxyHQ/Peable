import { describe, expect, test } from 'bun:test';
import {
  canPrepareCheckout,
  freezeCheckoutDetails,
  initialCheckoutDetails,
} from '../../src/ui/checkoutPreparation';
import { billingCountries } from '../../src/ui/countries';

const request = {
  merchant: 'Fixture',
  currency: 'USD',
  dueTodayMinorUnits: 599,
  items: [],
  requiresShipping: false,
  requiresContact: false,
  paymentMethods: ['card', 'faircoin'],
};

describe('checkout prerequisites', () => {
  test('account contact and digital delivery do not invent extra required fields', () => {
    expect(canPrepareCheckout(request, initialCheckoutDetails(undefined))).toBe(true);
    expect(
      canPrepareCheckout({ ...request, requiresContact: true }, initialCheckoutDetails(undefined)),
    ).toBe(false);
    expect(
      canPrepareCheckout(
        { ...request, requiresContact: true },
        initialCheckoutDetails({ email: 'payer@example.test' }),
      ),
    ).toBe(true);
  });
  test('physical delivery requires a structured address, without inventing a universal postcode rule', () => {
    const details = initialCheckoutDetails({
      shipping: {
        name: 'Fixture',
        line1: '1 Example Street',
        line2: '',
        city: 'Hong Kong',
        state: '',
        postalCode: '',
        country: 'HK',
        phone: '',
      },
    });
    expect(canPrepareCheckout({ ...request, requiresShipping: true }, details)).toBe(true);
    expect(
      canPrepareCheckout(
        { ...request, requiresShipping: true },
        { ...details, shipping: { ...details.shipping, country: 'Hong Kong' } },
      ),
    ).toBe(false);
  });
  test('retry snapshot is independent of a changed saved-address object', () => {
    const details = initialCheckoutDetails({ email: ' payer@example.test ' });
    const frozen = freezeCheckoutDetails(details);
    expect(frozen.email).toBe('payer@example.test');
    expect(frozen.shipping).not.toBe(details.shipping);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.shipping)).toBe(true);
  });
  test('billing reuse requires explicit consent and is frozen with the address', () => {
    const details = initialCheckoutDetails({});
    expect(freezeCheckoutDetails(details).useShippingForBilling).toBe(false);
    expect(
      freezeCheckoutDetails({ ...details, useShippingForBilling: true }).useShippingForBilling,
    ).toBe(true);
  });
  test('country choices remain usable on native runtimes without DisplayNames', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'DisplayNames');
    try {
      Object.defineProperty(Intl, 'DisplayNames', { value: undefined, configurable: true });
      expect(billingCountries('es').find((country) => country.value === 'US')).toEqual({
        value: 'US',
        label: 'US',
      });
    } finally {
      if (descriptor) Object.defineProperty(Intl, 'DisplayNames', descriptor);
    }
  });
});
