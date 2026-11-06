import type { TaxBehavior, UpdateTaxSettingsParams } from '@peable.to/shared-types/tax';

export interface CollectionSettingsForm {
  legalName: string;
  country: string;
  state: string;
  postalCode: string;
  city: string;
  line1: string;
  line2: string;
  defaultTaxCode: string;
  taxBehavior: TaxBehavior;
}

/** Saving collection settings replaces the address: send every editable field. */
export function buildCollectionSettingsBody(form: CollectionSettingsForm): UpdateTaxSettingsParams {
  const country = form.country.trim().toUpperCase();
  return {
    legal_name: form.legalName.trim() || null,
    head_office: country
      ? {
          country,
          state: form.state.trim().toUpperCase() || null,
          postal_code: form.postalCode.trim() || null,
          city: form.city.trim() || null,
          line1: form.line1.trim() || null,
          line2: form.line2.trim() || null,
        }
      : null,
    default_tax_code: form.defaultTaxCode,
    default_tax_behavior: form.taxBehavior,
  };
}
