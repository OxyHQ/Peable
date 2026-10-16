import type { TaxRegistrationScheme } from '@peable.to/shared-types';

/** The 27 EU member states, ISO 3166-1 (Greece is `GR`, not VAT's `EL`). */
export const EU_MEMBER_STATES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
]);

/** Countries where Stripe Tax registers a plain `standard` registration. */
const STANDARD_ONLY: ReadonlySet<string> = new Set([
  'AE',
  'AL',
  'AO',
  'AU',
  'AW',
  'BA',
  'BB',
  'BD',
  'BF',
  'BH',
  'BS',
  'CD',
  'CH',
  'ET',
  'GB',
  'GN',
  'IS',
  'JP',
  'ME',
  'MK',
  'MR',
  'NO',
  'NZ',
  'OM',
  'RS',
  'SG',
  'SR',
  'UY',
  'ZA',
  'ZW',
]);
/** Countries where Stripe Tax registers a `simplified` (non-resident) registration. */
const SIMPLIFIED_ONLY: ReadonlySet<string> = new Set([
  'AM',
  'AZ',
  'BJ',
  'BY',
  'CL',
  'CM',
  'CO',
  'CR',
  'CV',
  'EC',
  'EG',
  'GE',
  'ID',
  'IN',
  'KE',
  'KG',
  'KH',
  'KR',
  'KZ',
  'LA',
  'LK',
  'MA',
  'MD',
  'MX',
  'MY',
  'NG',
  'NP',
  'PE',
  'PH',
  'RU',
  'SA',
  'SN',
  'TH',
  'TJ',
  'TR',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UZ',
  'VN',
  'ZM',
]);

/**
 * Whether `scheme` is a registration that exists in `country`, and whether it
 * needs a subdivision. A registration Peable cannot place is refused on entry,
 * not discovered at the first sale.
 */
export function validateRegistration(
  country: string,
  state: string | null,
  scheme: TaxRegistrationScheme,
): string | null {
  switch (scheme) {
    case 'us_state_sales_tax':
      if (country !== 'US') return 'us_state_sales_tax registrations are in the US';
      if (!state) return 'a US registration names its state';
      return null;
    case 'ca_provincial':
      if (country !== 'CA') return 'ca_provincial registrations are in Canada';
      if (!state) return 'a provincial registration names its province';
      return null;
    case 'eu_oss_union':
    case 'eu_oss_non_union':
      if (!EU_MEMBER_STATES.has(country))
        return 'an OSS registration is held in its EU member state of identification';
      return state ? 'an OSS registration covers whole member states' : null;
    case 'standard':
      if (country === 'US') return 'US registrations are per state (us_state_sales_tax)';
      if (state) return 'a standard registration covers the whole country';
      return null;
    case 'simplified':
      if (country === 'US' || EU_MEMBER_STATES.has(country))
        return 'simplified registrations are not available in this country';
      if (state) return 'a simplified registration covers the whole country';
      return null;
  }
}

/** Whether a registration covers a customer located in (`country`, `state`). */
export function registrationCovers(
  registration: { country: string; state: string | null; scheme: TaxRegistrationScheme },
  country: string,
  state: string | null,
): boolean {
  switch (registration.scheme) {
    case 'eu_oss_union':
    case 'eu_oss_non_union':
      // One OSS registration collects in every member state.
      return EU_MEMBER_STATES.has(country);
    case 'us_state_sales_tax':
    case 'ca_provincial':
      return registration.country === country && state !== null && registration.state === state;
    case 'standard':
    case 'simplified':
      return registration.country === country;
  }
}

/** Stripe Tax's `country_options` for a Peable registration, or null when
 * Stripe Tax has no matching registration type there. */
export function stripeRegistrationOptions(registration: {
  country: string;
  state: string | null;
  scheme: TaxRegistrationScheme;
}): Record<string, Record<string, unknown>> | null {
  const key = registration.country.toLowerCase();
  const { country, scheme, state } = registration;
  if (scheme === 'us_state_sales_tax' && country === 'US' && state)
    return { us: { state, type: 'state_sales_tax' } };
  if (scheme === 'ca_provincial' && country === 'CA' && state)
    return { ca: { type: 'province_standard', province_standard: { province: state } } };
  if (EU_MEMBER_STATES.has(country)) {
    if (scheme === 'eu_oss_union') return { [key]: { type: 'oss_union' } };
    if (scheme === 'eu_oss_non_union') return { [key]: { type: 'oss_non_union' } };
    if (scheme === 'standard')
      return { [key]: { type: 'standard', standard: { place_of_supply_scheme: 'standard' } } };
    return null;
  }
  if (country === 'CA' && (scheme === 'standard' || scheme === 'simplified'))
    return { ca: { type: scheme } };
  if (scheme === 'standard' && STANDARD_ONLY.has(country)) return { [key]: { type: 'standard' } };
  if (scheme === 'simplified' && SIMPLIFIED_ONLY.has(country))
    return { [key]: { type: 'simplified' } };
  return null;
}

/**
 * Location rules for digital services, by the customer's country.
 *
 * - `eu_digital_two_items` / `gb_digital_two_items`: two non-contradictory
 *   pieces of evidence of DIFFERENT kinds (EU Implementing Regulation
 *   282/2011 Art. 24b/24f; HMRC's equivalent for UK digital services).
 * - `us_billing_address` / `ca_billing_address`: a billing address naming the
 *   state or province and a postal code; an IP address alone never places a
 *   US or Canadian customer.
 * - `default_one_item`: one piece of evidence, the billing address preferred.
 */
export type TaxLocationRule =
  | 'eu_digital_two_items'
  | 'gb_digital_two_items'
  | 'us_billing_address'
  | 'ca_billing_address'
  | 'default_one_item';

export function locationRuleFor(country: string): TaxLocationRule {
  if (EU_MEMBER_STATES.has(country)) return 'eu_digital_two_items';
  if (country === 'GB') return 'gb_digital_two_items';
  if (country === 'US') return 'us_billing_address';
  if (country === 'CA') return 'ca_billing_address';
  return 'default_one_item';
}
