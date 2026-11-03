import { describe, expect, it } from 'bun:test';
import {
  CHECKOUT_CUSTOM_FIELD_TYPES,
  CHECKOUT_LIMITS,
  CHECKOUT_LOCALES,
  CHECKOUT_SUBMIT_TYPES,
  PAYMENT_LINK_LIMITS,
  type PaymentLink,
} from '@peable.to/shared-types';
import {
  buildCreateLinkBody,
  buildUpdateLinkBody,
  EMPTY_CUSTOM_FIELD,
  EMPTY_LINK_OPTIONS,
  fieldForParam,
  keyFromLabel,
  lineFor,
  type LinkPriceChoice,
  linkFormFields,
  linkOptionsOf,
  linkSummary,
  ORBIT_CHECKOUT_LOCALES,
  ORBIT_CUSTOM_FIELD_TYPES,
  ORBIT_LINK_LIMITS,
  ORBIT_SUBMIT_TYPES,
  parseCountries,
  parseDropdownOptions,
  priceRefusal,
  serverErrors,
} from './linkForm';

const eur: LinkPriceChoice = {
  id: 'price_eur',
  currency: 'EUR',
  type: 'one_time',
  active: true,
  label: '10.00 EUR',
  productName: 'Mug',
};
const eur2: LinkPriceChoice = { ...eur, id: 'price_eur2', productName: 'Shirt' };
const usd: LinkPriceChoice = { ...eur, id: 'price_usd', currency: 'USD' };

describe('restated value sets', () => {
  it('are the shared-types originals', () => {
    expect([...ORBIT_CHECKOUT_LOCALES]).toEqual([...CHECKOUT_LOCALES]);
    expect([...ORBIT_SUBMIT_TYPES]).toEqual([...CHECKOUT_SUBMIT_TYPES]);
    expect([...ORBIT_CUSTOM_FIELD_TYPES]).toEqual([...CHECKOUT_CUSTOM_FIELD_TYPES]);
    expect(ORBIT_LINK_LIMITS.lineItemsMax).toBe(PAYMENT_LINK_LIMITS.lineItemsMax);
    expect(ORBIT_LINK_LIMITS.customMessageMax).toBe(PAYMENT_LINK_LIMITS.customMessageMax);
    for (const key of [
      'customFieldsMax',
      'customFieldKeyMax',
      'customFieldLabelMax',
      'customFieldTextMax',
      'dropdownOptionsMax',
      'dropdownOptionLabelMax',
      'dropdownOptionValueMax',
      'quantityMax',
      'shippingCountriesMax',
    ] as const) {
      expect(ORBIT_LINK_LIMITS[key]).toBe(CHECKOUT_LIMITS[key]);
    }
  });
});

describe('priceRefusal', () => {
  it('keeps one currency, one-time active prices, each once', () => {
    const lines = [lineFor(eur)];
    expect(priceRefusal(lines, eur2)).toBeNull();
    expect(priceRefusal(lines, usd)).toBe('currency_mismatch');
    expect(priceRefusal(lines, eur)).toBe('duplicate');
    expect(priceRefusal([], { ...eur, type: 'recurring' })).toBe('not_one_time');
    expect(priceRefusal([], { ...eur, active: false })).toBe('inactive');
    const full = Array.from({ length: 20 }, (_, i) => lineFor({ ...eur, id: `price_${i}` }));
    expect(priceRefusal(full, eur2)).toBe('too_many');
  });
});

describe('parsers', () => {
  it('reads countries separated by commas or spaces, uppercased and deduplicated', () => {
    expect(parseCountries('es, fr  DE,es')).toEqual(['ES', 'FR', 'DE']);
    expect(parseCountries('')).toEqual([]);
    expect(parseCountries('ES, Spain')).toBeNull();
  });

  it('reads dropdown options with an optional value', () => {
    expect(parseDropdownOptions('Small\nExtra large = xl\n\n')).toEqual([
      { label: 'Small', value: 'small' },
      { label: 'Extra large', value: 'xl' },
    ]);
  });

  it('slugs a label into a key', () => {
    expect(keyFromLabel('Your company name!')).toBe('your_company_name');
  });
});

describe('buildCreateLinkBody', () => {
  it('builds the whole request', () => {
    const line = { ...lineFor(eur), quantity: '2', adjustable: true, minimum: '1', maximum: '5' };
    const result = buildCreateLinkBody([line, lineFor(eur2)], {
      ...EMPTY_LINK_OPTIONS,
      allowPromotionCodes: true,
      billingAddress: 'required',
      shippingCountries: 'es fr',
      phone: true,
      taxId: true,
      termsOfService: true,
      automaticTax: true,
      customFields: [
        { ...EMPTY_CUSTOM_FIELD, key: 'size', label: 'Size', type: 'dropdown', options: 'S\nM' },
        { ...EMPTY_CUSTOM_FIELD, key: 'note', label: 'Note', optional: true, maximumLength: '40' },
      ],
      afterCompletion: 'redirect',
      redirectUrl: 'https://shop.example/thanks?cs={CHECKOUT_SESSION_ID}',
      sessionsLimit: '100',
      submitType: 'book',
      locale: 'es',
    });
    expect(result).toEqual({
      ok: true,
      body: {
        line_items: [
          {
            price: 'price_eur',
            quantity: 2,
            adjustable_quantity: { enabled: true, minimum: 1, maximum: 5 },
          },
          { price: 'price_eur2', quantity: 1 },
        ],
        allow_promotion_codes: true,
        billing_address_collection: 'required',
        shipping_address_collection: { allowed_countries: ['ES', 'FR'] },
        phone_number_collection: { enabled: true },
        tax_id_collection: { enabled: true },
        custom_fields: [
          {
            key: 'size',
            label: { type: 'custom', custom: 'Size' },
            type: 'dropdown',
            dropdown: {
              options: [
                { label: 'S', value: 's' },
                { label: 'M', value: 'm' },
              ],
            },
          },
          {
            key: 'note',
            label: { type: 'custom', custom: 'Note' },
            type: 'text',
            optional: true,
            text: { maximum_length: 40 },
          },
        ],
        consent_collection: { terms_of_service: 'required' },
        automatic_tax: { enabled: true },
        after_completion: {
          type: 'redirect',
          redirect: { url: 'https://shop.example/thanks?cs={CHECKOUT_SESSION_ID}' },
        },
        restrictions: { completed_sessions: { limit: 100 } },
        submit_type: 'book',
        locale: 'es',
      },
    });
  });

  it('sends a hosted confirmation with its message, and no optional collections', () => {
    const result = buildCreateLinkBody([lineFor(eur)], {
      ...EMPTY_LINK_OPTIONS,
      confirmationMessage: '  Thanks!  ',
    });
    expect(result.ok && result.body.after_completion).toEqual({
      type: 'hosted_confirmation',
      hosted_confirmation: { custom_message: 'Thanks!' },
    });
    expect(result.ok && 'shipping_address_collection' in result.body).toBe(false);
    expect(result.ok && 'custom_fields' in result.body).toBe(false);
  });

  it('names every refusal by the gateway param spelling', () => {
    const result = buildCreateLinkBody(
      [
        { ...lineFor(eur), quantity: '0' },
        { ...lineFor(usd), adjustable: true, minimum: '9', maximum: '2' },
      ],
      {
        ...EMPTY_LINK_OPTIONS,
        shippingCountries: 'Spain',
        afterCompletion: 'redirect',
        redirectUrl: 'javascript:alert(1)',
        sessionsLimit: '0',
        customFields: [
          { ...EMPTY_CUSTOM_FIELD, key: 'bad key', label: '' },
          { ...EMPTY_CUSTOM_FIELD, key: 'x', label: 'X', type: 'dropdown', options: '' },
          { ...EMPTY_CUSTOM_FIELD, key: 'y', label: 'Y', minimumLength: '9', maximumLength: '2' },
          { ...EMPTY_CUSTOM_FIELD, key: 'z', label: 'Z' },
        ],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      'line_items[0][quantity]': 'quantity',
      'line_items[1][price]': 'currency_mismatch',
      'line_items[1][adjustable_quantity]': 'bounds',
      'shipping_address_collection[allowed_countries]': 'countries',
      'after_completion[redirect][url]': 'url',
      'restrictions[completed_sessions][limit]': 'limit',
      custom_fields: 'too_many',
      'custom_fields[0][key]': 'key',
      'custom_fields[0][label]': 'label',
      'custom_fields[1][dropdown]': 'options',
      'custom_fields[2][text]': 'length',
    });
  });

  it('refuses a link with no lines and duplicate custom field keys', () => {
    const result = buildCreateLinkBody([], {
      ...EMPTY_LINK_OPTIONS,
      customFields: [
        { ...EMPTY_CUSTOM_FIELD, key: 'a', label: 'A' },
        { ...EMPTY_CUSTOM_FIELD, key: 'a', label: 'B' },
      ],
    });
    expect(result.ok ? null : result.errors).toEqual({
      line_items: 'required',
      'custom_fields[1][key]': 'key',
    });
  });
});

describe('update and round trip', () => {
  const link = {
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    shipping_address_collection: { allowed_countries: ['ES'] },
    phone_number_collection: { enabled: false },
    tax_id_collection: { enabled: true },
    custom_fields: [
      {
        key: 'size',
        label: { type: 'custom', custom: 'Size' },
        type: 'dropdown',
        optional: false,
        dropdown: { options: [{ label: 'Small', value: 's' }], value: null },
        text: null,
        numeric: null,
      },
    ],
    consent_collection: { terms_of_service: 'none' },
    automatic_tax: { enabled: false },
    after_completion: {
      type: 'hosted_confirmation',
      redirect: null,
      hosted_confirmation: { custom_message: 'Thanks' },
    },
    restrictions: { completed_sessions: { limit: 5, count: 2 } },
    submit_type: 'pay',
    locale: null,
  } as unknown as PaymentLink;

  it('reads a link back into the form and sends the same options', () => {
    const form = linkOptionsOf(link);
    expect(form.shippingCountries).toBe('ES');
    expect(form.customFields[0]?.options).toBe('Small = s');
    expect(form.locale).toBe('auto');
    const result = buildUpdateLinkBody(form);
    expect(result.ok && result.body).toMatchObject({
      allow_promotion_codes: true,
      shipping_address_collection: { allowed_countries: ['ES'] },
      custom_fields: [
        {
          key: 'size',
          type: 'dropdown',
          dropdown: { options: [{ label: 'Small', value: 's' }] },
        },
      ],
      restrictions: { completed_sessions: { limit: 5 } },
      after_completion: {
        type: 'hosted_confirmation',
        hosted_confirmation: { custom_message: 'Thanks' },
      },
    });
  });

  it('unsets what the merchant cleared', () => {
    const result = buildUpdateLinkBody({
      ...linkOptionsOf(link),
      shippingCountries: '',
      customFields: [],
      sessionsLimit: '',
    });
    expect(result.ok && result.body).toMatchObject({
      shipping_address_collection: '',
      custom_fields: '',
      restrictions: '',
    });
  });
});

describe('fieldForParam', () => {
  it('finds the most specific field a gateway param names', () => {
    const fields = linkFormFields(2, 1);
    expect(fieldForParam('line_items[1][quantity]', fields)).toBe('line_items[1][quantity]');
    expect(fieldForParam('line_items[0][price][currency]', fields)).toBe('line_items[0][price]');
    expect(fieldForParam('custom_fields[0][label][custom]', fields)).toBe(
      'custom_fields[0][label]',
    );
    expect(fieldForParam('metadata', fields)).toBeNull();
    expect(fieldForParam(undefined, fields)).toBeNull();
  });

  it('marks the refused field for the screen', () => {
    const fields = linkFormFields(1, 0);
    expect(serverErrors('line_items[0][price]', fields)).toEqual({
      'line_items[0][price]': 'server',
    });
    expect(serverErrors('metadata', fields)).toEqual({});
  });
});

describe('linkSummary', () => {
  it('names what the link sells', () => {
    expect(
      linkSummary({
        line_items: [
          { description: 'Mug', quantity: 2 },
          { description: 'Shirt', quantity: 1 },
        ],
      } as unknown as PaymentLink),
    ).toBe('Mug × 2, Shirt');
  });
});
