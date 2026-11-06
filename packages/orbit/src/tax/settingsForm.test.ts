import { describe, expect, it } from 'bun:test';
import type { TaxSettings } from '@peable.to/shared-types/tax';
import { buildTaxSettingsBody, taxSettingsFormOf } from './settingsForm';

const SETTINGS: TaxSettings = {
  object: 'tax.settings',
  merchant_id: 'merch_test',
  status: 'draft',
  legal_name: 'Example Software SL',
  head_office: {
    country: 'ES',
    state: null,
    postal_code: '08001',
    city: 'Barcelona',
    line1: 'Carrer Example 1',
    line2: null,
  },
  default_tax_code: 'txcd_10103001',
  default_tax_behavior: 'inclusive',
  calculation_account: 'none',
  provider: null,
  approved_at: null,
  approved_by: null,
  updated_at: null,
};

describe('the Peable Tax settings form', () => {
  it('saves back every head-office field and the tax behavior it loaded', () => {
    expect(buildTaxSettingsBody(taxSettingsFormOf(SETTINGS))).toEqual({
      legal_name: 'Example Software SL',
      head_office: {
        country: 'ES',
        state: null,
        postal_code: '08001',
        city: 'Barcelona',
        line1: 'Carrer Example 1',
        line2: null,
      },
      default_tax_code: 'txcd_10103001',
      default_tax_behavior: 'inclusive',
    });
  });

  it('starts empty for settings never saved, and sends null for empty fields', () => {
    const form = taxSettingsFormOf({ ...SETTINGS, legal_name: null, head_office: null });
    expect(form).toMatchObject({ legalName: '', line1: '', city: '', country: '' });
    expect(buildTaxSettingsBody(form)).toMatchObject({ legal_name: null, head_office: null });
  });

  it('trims lines and upper-cases the country and state codes', () => {
    const body = buildTaxSettingsBody({
      ...taxSettingsFormOf(SETTINGS),
      legalName: '  Example Inc.  ',
      country: ' us ',
      state: 'de',
      line1: '  1 Example Street ',
      line2: '   ',
    });
    expect(body.legal_name).toBe('Example Inc.');
    expect(body.head_office).toMatchObject({
      country: 'US',
      state: 'DE',
      line1: '1 Example Street',
      line2: null,
    });
  });

  it('never sends an empty tax code', () => {
    const body = buildTaxSettingsBody({ ...taxSettingsFormOf(SETTINGS), defaultTaxCode: '' });
    expect('default_tax_code' in body).toBe(false);
  });
});
