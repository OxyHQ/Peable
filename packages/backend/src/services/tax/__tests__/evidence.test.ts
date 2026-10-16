import { describe, expect, it } from 'bun:test';
import { createTaxLocationEvidenceSchema, evaluateEvidence } from '../evidence';
import { registrationCovers, validateRegistration } from '../jurisdictions';

const billing = (country: string, extra: Record<string, string> = {}) => ({
  type: 'billing_address' as const,
  address: { country, ...extra },
});

describe('customer location evidence', () => {
  it('places an EU customer on two agreeing kinds of evidence, never one', () => {
    expect(evaluateEvidence([billing('DE')], undefined).status).toBe('insufficient');
    const two = evaluateEvidence(
      [billing('DE'), { type: 'ip_address', ipAddress: '203.0.113.7', country: 'DE' }],
      'salt',
    );
    expect(two).toMatchObject({
      status: 'sufficient',
      rule: 'eu_digital_two_items',
      country: 'DE',
    });
    // The address is never stored; only its salted hash.
    expect(JSON.stringify(two.items)).not.toContain('203.0.113.7');
    expect(
      evaluateEvidence(
        [billing('DE'), { type: 'ip_address', ipAddress: '203.0.113.7', country: 'FR' }],
        undefined,
      ).status,
    ).toBe('conflicting');
    // Two agreeing kinds outweigh one contradicting kind.
    expect(
      evaluateEvidence(
        [
          billing('FR'),
          { type: 'bank_country', country: 'FR' },
          { type: 'ip_address', ipAddress: '203.0.113.7', country: 'ES' },
        ],
        undefined,
      ),
    ).toMatchObject({ status: 'sufficient', country: 'FR' });
  });

  it('places a US customer only by a billing address with state and postal code', () => {
    expect(
      evaluateEvidence(
        [{ type: 'ip_address', ipAddress: '198.51.100.1', country: 'US' }],
        undefined,
      ).status,
    ).toBe('insufficient');
    expect(evaluateEvidence([billing('US', { state: 'CA' })], undefined).status).toBe(
      'insufficient',
    );
    expect(
      evaluateEvidence([billing('US', { state: 'CA', postalCode: '94103' })], undefined),
    ).toMatchObject({ status: 'sufficient', country: 'US', state: 'CA' });
  });

  it('refuses language, currency or timezone as evidence', () => {
    for (const type of ['language', 'currency', 'timezone', 'locale'])
      expect(
        createTaxLocationEvidenceSchema.safeParse({
          customerRef: 'acct_1',
          evidence: [{ type, country: 'DE' }],
        }).success,
      ).toBe(false);
  });
});

describe('registrations', () => {
  it('validates the scheme against its country', () => {
    expect(validateRegistration('US', 'NY', 'us_state_sales_tax')).toBeNull();
    expect(validateRegistration('US', null, 'us_state_sales_tax')).not.toBeNull();
    expect(validateRegistration('IE', null, 'eu_oss_non_union')).toBeNull();
    expect(validateRegistration('GB', null, 'eu_oss_non_union')).not.toBeNull();
    expect(validateRegistration('US', null, 'standard')).not.toBeNull();
  });

  it('covers by scheme: OSS every member state, a US registration its state', () => {
    const oss = { country: 'IE', state: null, scheme: 'eu_oss_non_union' as const };
    expect(registrationCovers(oss, 'DE', null)).toBe(true);
    expect(registrationCovers(oss, 'GB', null)).toBe(false);
    const ny = { country: 'US', state: 'NY', scheme: 'us_state_sales_tax' as const };
    expect(registrationCovers(ny, 'US', 'NY')).toBe(true);
    expect(registrationCovers(ny, 'US', 'TX')).toBe(false);
  });
});
