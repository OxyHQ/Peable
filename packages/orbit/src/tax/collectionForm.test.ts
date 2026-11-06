import { describe, expect, it } from 'bun:test';
import { updateTaxSettingsParams } from '@peable.to/contracts';
import { buildCollectionSettingsBody, type CollectionSettingsForm } from './collectionForm';

const FORM: CollectionSettingsForm = {
  legalName: 'Example Company',
  country: 'US',
  state: 'DE',
  postalCode: '19802',
  city: 'Wilmington',
  line1: '123 Example St',
  line2: 'Suite 42',
  defaultTaxCode: 'txcd_10000000',
  taxBehavior: 'inclusive',
};

describe('collection settings address and price treatment', () => {
  it('preserves the full loaded address when only the legal name changes', () => {
    const body = buildCollectionSettingsBody({ ...FORM, legalName: 'Updated Company' });
    expect(updateTaxSettingsParams.parse(body)).toEqual(body);
    expect(body.head_office).toEqual({
      country: 'US',
      state: 'DE',
      postal_code: '19802',
      city: 'Wilmington',
      line1: '123 Example St',
      line2: 'Suite 42',
    });
    expect(body.default_tax_behavior).toBe('inclusive');
    expect(body).not.toHaveProperty('approved_by');
    expect(body).not.toHaveProperty('status');
  });

  it('allows explicit exclusive pricing and clearing optional address fields', () => {
    const body = buildCollectionSettingsBody({ ...FORM, taxBehavior: 'exclusive', line2: '  ' });
    expect(updateTaxSettingsParams.parse(body)).toEqual(body);
    expect(body.default_tax_behavior).toBe('exclusive');
    expect(body.head_office?.line2).toBeNull();
    expect(body.head_office?.line1).toBe(FORM.line1);
  });
});
