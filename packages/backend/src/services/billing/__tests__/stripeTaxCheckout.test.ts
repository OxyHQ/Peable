import { describe, expect, it } from 'bun:test';
import { exactTaxRatePercentage } from '../stripeTaxCheckout';

/** Stripe's arithmetic for a manual rate, under both rounding modes it could use. */
function stripeTax(amount: number, percentage: number, inclusive: boolean) {
  const exact = inclusive ? amount - amount / (1 + percentage / 100) : (amount * percentage) / 100;
  const halfEven =
    Math.abs(exact - Math.floor(exact) - 0.5) < 1e-9
      ? 2 * Math.round(exact / 2)
      : Math.round(exact);
  return [Math.round(exact), halfEven];
}

describe('exactTaxRatePercentage', () => {
  it('finds a rate whose Stripe tax is the frozen amount, or none', () => {
    const cases = [
      { net: 2999, tax: 600, gross: 3599, taxTreatment: 'exclusive' as const },
      { net: 2499, tax: 500, gross: 2999, taxTreatment: 'inclusive' as const },
      { net: 1000, tax: 89, gross: 1089, taxTreatment: 'exclusive' as const },
      { net: 7, tax: 1, gross: 8, taxTreatment: 'exclusive' as const },
      { net: 123457, tax: 23457, gross: 146914, taxTreatment: 'exclusive' as const },
    ];
    for (const { net, tax, gross, taxTreatment } of cases) {
      const quote = {
        net_minor_units: net,
        tax_minor_units: tax,
        gross_minor_units: gross,
        tax_treatment: taxTreatment,
      };
      const percentage = exactTaxRatePercentage(quote);
      if (percentage === null) throw new Error(`no rate for ${JSON.stringify(quote)}`);
      expect(Math.round(percentage * 10_000) / 10_000).toBe(percentage);
      const base = taxTreatment === 'inclusive' ? gross : net;
      expect(stripeTax(base, percentage, taxTreatment === 'inclusive')).toEqual([tax, tax]);
    }
    expect(
      exactTaxRatePercentage({
        net_minor_units: 2999,
        tax_minor_units: 600,
        gross_minor_units: 3599,
        tax_treatment: 'exclusive',
      }),
    ).toBe(20);
    expect(
      exactTaxRatePercentage({
        net_minor_units: 0,
        tax_minor_units: 0,
        gross_minor_units: 0,
        tax_treatment: 'exclusive',
      }),
    ).toBeNull();
  });
});
