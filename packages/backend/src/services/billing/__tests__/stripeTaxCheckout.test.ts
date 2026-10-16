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
        netMinorUnits: net,
        taxMinorUnits: tax,
        grossMinorUnits: gross,
        taxTreatment,
      };
      const percentage = exactTaxRatePercentage(quote);
      if (percentage === null) throw new Error(`no rate for ${JSON.stringify(quote)}`);
      expect(Math.round(percentage * 10_000) / 10_000).toBe(percentage);
      const base = taxTreatment === 'inclusive' ? gross : net;
      expect(stripeTax(base, percentage, taxTreatment === 'inclusive')).toEqual([tax, tax]);
    }
    expect(
      exactTaxRatePercentage({
        netMinorUnits: 2999,
        taxMinorUnits: 600,
        grossMinorUnits: 3599,
        taxTreatment: 'exclusive',
      }),
    ).toBe(20);
    expect(
      exactTaxRatePercentage({
        netMinorUnits: 0,
        taxMinorUnits: 0,
        grossMinorUnits: 0,
        taxTreatment: 'exclusive',
      }),
    ).toBeNull();
  });
});
