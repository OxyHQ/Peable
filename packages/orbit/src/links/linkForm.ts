import type {
  CheckoutCustomField,
  CheckoutCustomFieldParams,
  CheckoutCustomFieldType,
  CheckoutLocale,
  CheckoutSubmitType,
  CreatePaymentLinkParams,
  CurrencyCode,
  PaymentLink,
  PaymentLinkAfterCompletionParams,
  Price,
  UpdatePaymentLinkParams,
} from '@peable.to/shared-types';

/**
 * The Payment Links builder as pure data: the form a screen edits, every rule
 * the gateway would refuse checked here first, and the exact request bodies.
 *
 * The value sets and bounds are restated rather than imported: the
 * `@peable.to/shared-types` root barrel also exports the `node:crypto` webhook
 * signer, which a browser bundle cannot load. `linkForm.test.ts` pins each one
 * to its shared-types original.
 */

export const ORBIT_CHECKOUT_LOCALES: readonly CheckoutLocale[] = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
];
export const ORBIT_SUBMIT_TYPES: readonly CheckoutSubmitType[] = ['auto', 'pay', 'book', 'donate'];
export const ORBIT_CUSTOM_FIELD_TYPES: readonly CheckoutCustomFieldType[] = [
  'text',
  'numeric',
  'dropdown',
];

export const ORBIT_LINK_LIMITS = {
  lineItemsMax: 20,
  customMessageMax: 500,
  customFieldsMax: 3,
  customFieldKeyMax: 200,
  customFieldLabelMax: 50,
  customFieldTextMax: 255,
  dropdownOptionsMax: 200,
  dropdownOptionLabelMax: 100,
  dropdownOptionValueMax: 100,
  quantityMax: 999_999,
  shippingCountriesMax: 250,
} as const;

/** The price a line names, with what the builder shows and checks. */
export interface LinkPriceChoice {
  id: string;
  currency: CurrencyCode;
  type: Price['type'];
  active: boolean;
  /** `19.99 EUR` — formatted by the caller. */
  label: string;
  productName: string;
}

export interface LinkLineForm {
  price: LinkPriceChoice;
  quantity: string;
  adjustable: boolean;
  minimum: string;
  maximum: string;
}

export interface CustomFieldForm {
  key: string;
  label: string;
  type: CheckoutCustomFieldType;
  optional: boolean;
  /** Dropdown only: one option per line, `Label` or `Label = value`. */
  options: string;
  minimumLength: string;
  maximumLength: string;
}

export interface LinkOptionsForm {
  allowPromotionCodes: boolean;
  billingAddress: 'auto' | 'required';
  /** ISO 3166-1 alpha-2 codes, separated by commas or spaces; empty for no shipping. */
  shippingCountries: string;
  phone: boolean;
  taxId: boolean;
  customFields: CustomFieldForm[];
  termsOfService: boolean;
  automaticTax: boolean;
  afterCompletion: 'hosted_confirmation' | 'redirect';
  redirectUrl: string;
  confirmationMessage: string;
  /** Empty for no limit. */
  sessionsLimit: string;
  submitType: CheckoutSubmitType;
  locale: 'auto' | CheckoutLocale;
}

export const EMPTY_LINK_OPTIONS: LinkOptionsForm = {
  allowPromotionCodes: false,
  billingAddress: 'auto',
  shippingCountries: '',
  phone: false,
  taxId: false,
  customFields: [],
  termsOfService: false,
  automaticTax: false,
  afterCompletion: 'hosted_confirmation',
  redirectUrl: '',
  confirmationMessage: '',
  sessionsLimit: '',
  submitType: 'auto',
  locale: 'auto',
};

export const EMPTY_CUSTOM_FIELD: CustomFieldForm = {
  key: '',
  label: '',
  type: 'text',
  optional: false,
  options: '',
  minimumLength: '',
  maximumLength: '',
};

/** A new line for `price`: quantity 1, not adjustable. */
export function lineFor(price: LinkPriceChoice): LinkLineForm {
  return { price, quantity: '1', adjustable: false, minimum: '', maximum: '' };
}

/**
 * Why a form cannot be sent, keyed by the field a screen marks — the same
 * spelling the gateway uses for `param` (`line_items[0][quantity]`), so a
 * server refusal lands on the same field as a local one.
 */
export type LinkFormErrors = Record<string, LinkFormErrorCode>;

export type LinkFormErrorCode =
  | 'required'
  | 'too_many'
  | 'currency_mismatch'
  | 'not_one_time'
  | 'inactive'
  | 'duplicate'
  | 'quantity'
  | 'bounds'
  | 'countries'
  | 'key'
  | 'label'
  | 'options'
  | 'length'
  | 'url'
  | 'message'
  | 'limit'
  /** The gateway refused it; its message is shown beside the form. */
  | 'server';

export type LinkFormResult<T> = { ok: true; body: T } | { ok: false; errors: LinkFormErrors };

const COUNTRY = /^[A-Z]{2}$/;
const CUSTOM_FIELD_KEY = /^[A-Za-z0-9_]+$/;
const POSITIVE_INT = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INT = /^(0|[1-9][0-9]*)$/;

function intOf(text: string, pattern: RegExp): number | null {
  const trimmed = text.trim();
  if (!pattern.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** The currency every line must share, or `null` while there are no lines. */
export function linkCurrency(lines: readonly LinkLineForm[]): CurrencyCode | null {
  return lines[0]?.price.currency ?? null;
}

/**
 * Whether `price` may join `lines`: a one-time, active price in the currency
 * the link already has, not already on it. `null` when it may.
 */
export function priceRefusal(
  lines: readonly LinkLineForm[],
  price: LinkPriceChoice,
): 'currency_mismatch' | 'not_one_time' | 'inactive' | 'duplicate' | 'too_many' | null {
  if (!price.active) return 'inactive';
  if (price.type !== 'one_time') return 'not_one_time';
  if (lines.some((line) => line.price.id === price.id)) return 'duplicate';
  if (lines.length >= ORBIT_LINK_LIMITS.lineItemsMax) return 'too_many';
  const currency = linkCurrency(lines);
  if (currency !== null && currency !== price.currency) return 'currency_mismatch';
  return null;
}

/** `"es, FR de"` → `['ES', 'FR', 'DE']`, or `null` when any code is not two letters. */
export function parseCountries(text: string): string[] | null {
  const codes = text
    .split(/[\s,]+/)
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  if (codes.some((code) => !COUNTRY.test(code))) return null;
  return [...new Set(codes)];
}

/** `Label` or `Label = value`, one per line; the value defaults to the label slugged. */
export function parseDropdownOptions(text: string): { label: string; value: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=');
      const label = (at === -1 ? line : line.slice(0, at)).trim();
      const raw = at === -1 ? label : line.slice(at + 1).trim();
      const value = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      return { label, value };
    });
}

/** The slug of a label, a sensible default key for a new custom field. */
export function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, ORBIT_LINK_LIMITS.customFieldKeyMax);
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function buildLines(
  lines: readonly LinkLineForm[],
  errors: LinkFormErrors,
): CreatePaymentLinkParams['line_items'] {
  if (lines.length === 0) errors.line_items = 'required';
  if (lines.length > ORBIT_LINK_LIMITS.lineItemsMax) errors.line_items = 'too_many';
  const currency = linkCurrency(lines);
  return lines.map((line, index) => {
    const at = `line_items[${index}]`;
    if (line.price.currency !== currency) errors[`${at}[price]`] = 'currency_mismatch';
    else if (line.price.type !== 'one_time') errors[`${at}[price]`] = 'not_one_time';
    const quantity = intOf(line.quantity, POSITIVE_INT);
    if (quantity === null || quantity > ORBIT_LINK_LIMITS.quantityMax) {
      errors[`${at}[quantity]`] = 'quantity';
    }
    const body: CreatePaymentLinkParams['line_items'][number] = {
      price: line.price.id,
      quantity: quantity ?? 0,
    };
    if (line.adjustable) {
      const minimum =
        line.minimum.trim() === '' ? undefined : intOf(line.minimum, NON_NEGATIVE_INT);
      const maximum = line.maximum.trim() === '' ? undefined : intOf(line.maximum, POSITIVE_INT);
      const low = minimum ?? 0;
      const high = maximum ?? 99;
      if (
        minimum === null ||
        maximum === null ||
        high > ORBIT_LINK_LIMITS.quantityMax ||
        low > high ||
        (quantity !== null && (quantity < low || quantity > high))
      ) {
        errors[`${at}[adjustable_quantity]`] = 'bounds';
      }
      body.adjustable_quantity = {
        enabled: true,
        ...(minimum !== undefined && minimum !== null ? { minimum } : {}),
        ...(maximum !== undefined && maximum !== null ? { maximum } : {}),
      };
    }
    return body;
  });
}

function buildCustomFields(
  fields: readonly CustomFieldForm[],
  errors: LinkFormErrors,
): CheckoutCustomFieldParams[] {
  if (fields.length > ORBIT_LINK_LIMITS.customFieldsMax) errors.custom_fields = 'too_many';
  const keys = new Set<string>();
  return fields.map((field, index) => {
    const at = `custom_fields[${index}]`;
    const key = field.key.trim();
    if (
      !CUSTOM_FIELD_KEY.test(key) ||
      key.length > ORBIT_LINK_LIMITS.customFieldKeyMax ||
      keys.has(key)
    ) {
      errors[`${at}[key]`] = 'key';
    }
    keys.add(key);
    const label = field.label.trim();
    if (!label || label.length > ORBIT_LINK_LIMITS.customFieldLabelMax) {
      errors[`${at}[label]`] = 'label';
    }
    const body: CheckoutCustomFieldParams = {
      key,
      label: { type: 'custom', custom: label },
      type: field.type,
      ...(field.optional ? { optional: true } : {}),
    };
    if (field.type === 'dropdown') {
      const options = parseDropdownOptions(field.options);
      const values = new Set(options.map((option) => option.value));
      if (
        options.length === 0 ||
        options.length > ORBIT_LINK_LIMITS.dropdownOptionsMax ||
        values.size !== options.length ||
        options.some(
          (option) =>
            !option.label ||
            !option.value ||
            option.label.length > ORBIT_LINK_LIMITS.dropdownOptionLabelMax ||
            option.value.length > ORBIT_LINK_LIMITS.dropdownOptionValueMax,
        )
      ) {
        errors[`${at}[dropdown]`] = 'options';
      }
      body.dropdown = { options };
    } else {
      const max = field.type === 'text' ? ORBIT_LINK_LIMITS.customFieldTextMax : 255;
      const minimum =
        field.minimumLength.trim() === ''
          ? undefined
          : intOf(field.minimumLength, NON_NEGATIVE_INT);
      const maximum =
        field.maximumLength.trim() === '' ? undefined : intOf(field.maximumLength, POSITIVE_INT);
      if (
        minimum === null ||
        maximum === null ||
        (maximum ?? 0) > max ||
        (minimum !== undefined && maximum !== undefined && minimum > maximum)
      ) {
        errors[`${at}[${field.type}]`] = 'length';
      }
      const lengths = {
        ...(minimum !== undefined && minimum !== null ? { minimum_length: minimum } : {}),
        ...(maximum !== undefined && maximum !== null ? { maximum_length: maximum } : {}),
      };
      if (Object.keys(lengths).length > 0) {
        if (field.type === 'text') body.text = lengths;
        else body.numeric = lengths;
      }
    }
    return body;
  });
}

interface BuiltOptions {
  allow_promotion_codes: boolean;
  billing_address_collection: 'auto' | 'required';
  shipping_address_collection?: { allowed_countries: string[] };
  phone_number_collection: { enabled: boolean };
  tax_id_collection: { enabled: boolean };
  custom_fields?: CheckoutCustomFieldParams[];
  consent_collection: { terms_of_service: 'none' | 'required' };
  automatic_tax: { enabled: boolean };
  after_completion: PaymentLinkAfterCompletionParams;
  restrictions?: { completed_sessions: { limit: number } };
  submit_type: CheckoutSubmitType;
  locale: CheckoutLocale | 'auto';
}

function buildOptions(form: LinkOptionsForm, errors: LinkFormErrors): BuiltOptions {
  const countries = parseCountries(form.shippingCountries);
  if (countries === null || countries.length > ORBIT_LINK_LIMITS.shippingCountriesMax) {
    errors['shipping_address_collection[allowed_countries]'] = 'countries';
  }
  let afterCompletion: PaymentLinkAfterCompletionParams;
  if (form.afterCompletion === 'redirect') {
    const url = form.redirectUrl.trim();
    if (!isHttpUrl(url)) errors['after_completion[redirect][url]'] = 'url';
    afterCompletion = { type: 'redirect', redirect: { url } };
  } else {
    const message = form.confirmationMessage.trim();
    if (message.length > ORBIT_LINK_LIMITS.customMessageMax) {
      errors['after_completion[hosted_confirmation][custom_message]'] = 'message';
    }
    afterCompletion = {
      type: 'hosted_confirmation',
      ...(message ? { hosted_confirmation: { custom_message: message } } : {}),
    };
  }
  let limit: number | null = null;
  if (form.sessionsLimit.trim() !== '') {
    limit = intOf(form.sessionsLimit, POSITIVE_INT);
    if (limit === null) errors['restrictions[completed_sessions][limit]'] = 'limit';
  }
  const customFields = buildCustomFields(form.customFields, errors);
  return {
    allow_promotion_codes: form.allowPromotionCodes,
    billing_address_collection: form.billingAddress,
    ...(countries && countries.length > 0
      ? { shipping_address_collection: { allowed_countries: countries } }
      : {}),
    phone_number_collection: { enabled: form.phone },
    tax_id_collection: { enabled: form.taxId },
    ...(customFields.length > 0 ? { custom_fields: customFields } : {}),
    consent_collection: { terms_of_service: form.termsOfService ? 'required' : 'none' },
    automatic_tax: { enabled: form.automaticTax },
    after_completion: afterCompletion,
    ...(limit !== null ? { restrictions: { completed_sessions: { limit } } } : {}),
    submit_type: form.submitType,
    locale: form.locale,
  };
}

/** `POST /payment_links` from the builder, or every reason it would be refused. */
export function buildCreateLinkBody(
  lines: readonly LinkLineForm[],
  options: LinkOptionsForm,
): LinkFormResult<CreatePaymentLinkParams> {
  const errors: LinkFormErrors = {};
  const lineItems = buildLines(lines, errors);
  const built = buildOptions(options, errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { line_items: lineItems, ...built } };
}

/**
 * `POST /payment_links/:id` from the options form. Everything is sent (the
 * update replaces options as a whole); fields the merchant cleared are sent as
 * `''`, Stripe's unset, so turning shipping off actually turns it off.
 */
export function buildUpdateLinkBody(
  options: LinkOptionsForm,
): LinkFormResult<UpdatePaymentLinkParams> {
  const errors: LinkFormErrors = {};
  const built = buildOptions(options, errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      ...built,
      shipping_address_collection: built.shipping_address_collection ?? '',
      custom_fields: built.custom_fields ?? '',
      restrictions: built.restrictions ?? '',
    },
  };
}

function customFieldFormOf(field: CheckoutCustomField): CustomFieldForm {
  const lengths =
    field.type === 'text' ? field.text : field.type === 'numeric' ? field.numeric : null;
  return {
    key: field.key,
    label: field.label.custom,
    type: field.type,
    optional: field.optional,
    options: (field.dropdown?.options ?? [])
      .map((option) => `${option.label} = ${option.value}`)
      .join('\n'),
    minimumLength: lengths?.minimum_length != null ? String(lengths.minimum_length) : '',
    maximumLength: lengths?.maximum_length != null ? String(lengths.maximum_length) : '',
  };
}

/** The options form for an existing link — what the detail screen edits. */
export function linkOptionsOf(link: PaymentLink): LinkOptionsForm {
  return {
    allowPromotionCodes: link.allow_promotion_codes,
    billingAddress: link.billing_address_collection,
    shippingCountries: (link.shipping_address_collection?.allowed_countries ?? []).join(', '),
    phone: link.phone_number_collection.enabled,
    taxId: link.tax_id_collection.enabled,
    customFields: link.custom_fields.map(customFieldFormOf),
    termsOfService: link.consent_collection?.terms_of_service === 'required',
    automaticTax: link.automatic_tax.enabled,
    afterCompletion: link.after_completion.type,
    redirectUrl: link.after_completion.redirect?.url ?? '',
    confirmationMessage: link.after_completion.hosted_confirmation?.custom_message ?? '',
    sessionsLimit: link.restrictions ? String(link.restrictions.completed_sessions.limit) : '',
    submitType: link.submit_type,
    locale: link.locale ?? 'auto',
  };
}

/**
 * Map a gateway `param` (`line_items[0][quantity]`, `metadata`) to the field a
 * form marks: the longest local field it names or is inside. `null` when no
 * field of the form is concerned.
 */
export function fieldForParam(param: string | undefined, fields: readonly string[]): string | null {
  if (!param) return null;
  const candidates = fields.filter((field) => param === field || param.startsWith(`${field}[`));
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

/**
 * The form errors for a gateway refusal: the field its `param` names marked
 * `server`, or nothing when the refusal is about no field of the form.
 */
export function serverErrors(param: string | undefined, fields: readonly string[]): LinkFormErrors {
  const field = fieldForParam(param, fields);
  return field ? { [field]: 'server' } : {};
}

/** Every field `buildCreateLinkBody` can name, for `fieldForParam`. */
export function linkFormFields(lineCount: number, customFieldCount: number): string[] {
  const fields = [
    'line_items',
    'shipping_address_collection[allowed_countries]',
    'shipping_address_collection',
    'after_completion[redirect][url]',
    'after_completion[hosted_confirmation][custom_message]',
    'after_completion',
    'restrictions[completed_sessions][limit]',
    'restrictions',
    'custom_fields',
  ];
  for (let index = 0; index < lineCount; index++) {
    const at = `line_items[${index}]`;
    fields.push(at, `${at}[price]`, `${at}[quantity]`, `${at}[adjustable_quantity]`);
  }
  for (let index = 0; index < customFieldCount; index++) {
    const at = `custom_fields[${index}]`;
    fields.push(
      at,
      `${at}[key]`,
      `${at}[label]`,
      `${at}[dropdown]`,
      `${at}[text]`,
      `${at}[numeric]`,
    );
  }
  return fields;
}

/** `Mug × 2, Shirt` — what a link sells, in one line. */
export function linkSummary(link: Pick<PaymentLink, 'contribution' | 'line_items'>): string {
  if (link.contribution) return link.contribution.purpose;
  return link.line_items
    .map((item) =>
      item.quantity === 1 ? item.description : `${item.description} × ${item.quantity}`,
    )
    .join(', ');
}
