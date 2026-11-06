import type {
  TaxBehavior,
  TaxSettings,
  UpdateTaxSettingsParams,
} from '@peable.to/shared-types/tax';

/**
 * The seller half of Peable Tax settings (ADR 0011), as the owner types it on
 * the Collection page: every field `PATCH …/tax/settings` takes, so saving
 * writes back the whole head office and the default tax behavior instead of
 * replacing them with the three fields the form used to show.
 */
export interface TaxSettingsForm {
  legalName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  defaultTaxCode: string;
  defaultTaxBehavior: TaxBehavior;
}

export function taxSettingsFormOf(settings: TaxSettings): TaxSettingsForm {
  const office = settings.head_office;
  return {
    legalName: settings.legal_name ?? '',
    line1: office?.line1 ?? '',
    line2: office?.line2 ?? '',
    city: office?.city ?? '',
    state: office?.state ?? '',
    postalCode: office?.postal_code ?? '',
    country: office?.country ?? '',
    defaultTaxCode: settings.default_tax_code,
    defaultTaxBehavior: settings.default_tax_behavior,
  };
}

const text = (value: string) => value.trim() || null;
const code = (value: string) => value.trim().toUpperCase();

/**
 * The one body the Save button sends. An empty field is `null`, never `''`
 * (the gateway refuses an empty line); the head office is `null` until it has
 * a country, which is the one part of an address Peable Tax requires.
 */
export function buildTaxSettingsBody(form: TaxSettingsForm): UpdateTaxSettingsParams {
  const country = code(form.country);
  return {
    legal_name: text(form.legalName),
    head_office: country
      ? {
          country,
          state: code(form.state) || null,
          postal_code: text(form.postalCode),
          city: text(form.city),
          line1: text(form.line1),
          line2: text(form.line2),
        }
      : null,
    ...(form.defaultTaxCode ? { default_tax_code: form.defaultTaxCode } : {}),
    default_tax_behavior: form.defaultTaxBehavior,
  };
}
