/**
 * Checkout's request validators (Orbit Phase 3) — the session create body, the
 * payer's edit, and the collection options a payment link shares with the
 * sessions it creates. One shape rule is written once, so a link and a session
 * refuse the same mistake with the same `param`.
 */
import { z } from 'zod';
import {
  CHECKOUT_BILLING_ADDRESS_COLLECTIONS,
  CHECKOUT_CUSTOM_FIELD_TYPES,
  CHECKOUT_CUSTOMER_CREATIONS,
  CHECKOUT_LIMITS,
  CHECKOUT_LOCALES,
  CHECKOUT_SESSION_ID_TEMPLATE,
  CHECKOUT_SESSION_MODES,
  CHECKOUT_SUBMIT_TYPES,
  CHECKOUT_TAX_ID_TYPES,
  CHECKOUT_UI_MODES,
  CATALOG_LIMITS,
  PRICE_TAX_BEHAVIORS,
  RECURRING_INTERVALS,
  type CheckoutLocale,
} from '@peable.to/shared-types';
import type { StoredCheckoutCollection, StoredCustomField } from '../../db/schema/payments';
import { expandParam } from '../../lib/list';
import { metadataCreateSchema } from '../../lib/metadata';
import { isKnownTaxCode } from '../tax/codes';
import { amountSchema, currencySchema } from '../catalog/params';

const idSchema = z.string().min(1).max(255);
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 country code');

/**
 * A redirect target. `https` only, except `http://localhost` for development —
 * a payer is sent there after paying, so an `http` URL elsewhere would leak the
 * session id in the clear. `{CHECKOUT_SESSION_ID}` may appear anywhere.
 */
export const redirectUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    const probe = value.split(CHECKOUT_SESSION_ID_TEMPLATE).join('cs_template');
    try {
      const url = new URL(probe);
      return (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
      );
    } catch {
      return false;
    }
  }, 'must be an https URL (http only on localhost)');

/** `true` when `url` names `{CHECKOUT_SESSION_ID}`, substituted on the way to the payer. */
export function substituteSessionId(url: string, sessionPublicId: string): string {
  return url.split(CHECKOUT_SESSION_ID_TEMPLATE).join(sessionPublicId);
}

// ---- Collection options --------------------------------------------------------

const customFieldSchema = z
  .object({
    key: z
      .string()
      .regex(
        new RegExp(`^[A-Za-z0-9_]{1,${CHECKOUT_LIMITS.customFieldKeyMax}}$`),
        'a key is letters, digits and underscores',
      ),
    label: z
      .object({
        type: z.literal('custom'),
        custom: z.string().trim().min(1).max(CHECKOUT_LIMITS.customFieldLabelMax),
      })
      .strict(),
    type: z.enum(CHECKOUT_CUSTOM_FIELD_TYPES),
    optional: z.boolean().optional(),
    dropdown: z
      .object({
        options: z
          .array(
            z
              .object({
                label: z.string().trim().min(1).max(CHECKOUT_LIMITS.dropdownOptionLabelMax),
                value: z
                  .string()
                  .regex(
                    new RegExp(`^[A-Za-z0-9]{1,${CHECKOUT_LIMITS.dropdownOptionValueMax}}$`),
                    'an option value is letters and digits',
                  ),
              })
              .strict(),
          )
          .min(1)
          .max(CHECKOUT_LIMITS.dropdownOptionsMax),
      })
      .strict()
      .optional(),
    text: z
      .object({
        minimum_length: z.number().int().min(1).max(CHECKOUT_LIMITS.customFieldTextMax).optional(),
        maximum_length: z.number().int().min(1).max(CHECKOUT_LIMITS.customFieldTextMax).optional(),
      })
      .strict()
      .optional(),
    numeric: z
      .object({
        minimum_length: z.number().int().min(1).max(CHECKOUT_LIMITS.customFieldTextMax).optional(),
        maximum_length: z.number().int().min(1).max(CHECKOUT_LIMITS.customFieldTextMax).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    const issue = (path: string[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (field.type === 'dropdown' && !field.dropdown) {
      issue(['dropdown'], 'a dropdown field needs dropdown.options');
    }
    if (field.type !== 'dropdown' && field.dropdown) {
      issue(['dropdown'], 'dropdown is only for a dropdown field');
    }
    if (field.type !== 'text' && field.text) issue(['text'], 'text is only for a text field');
    if (field.type !== 'numeric' && field.numeric) {
      issue(['numeric'], 'numeric is only for a numeric field');
    }
    const bounds = field.text ?? field.numeric;
    if (
      bounds?.minimum_length !== undefined &&
      bounds.maximum_length !== undefined &&
      bounds.minimum_length > bounds.maximum_length
    ) {
      issue([field.type, 'minimum_length'], 'minimum_length cannot exceed maximum_length');
    }
    if (field.dropdown) {
      const values = field.dropdown.options.map((option) => option.value);
      if (new Set(values).size !== values.length) {
        issue(['dropdown', 'options'], 'option values must be unique');
      }
    }
  });

export const customFieldsSchema = z
  .array(customFieldSchema)
  .max(CHECKOUT_LIMITS.customFieldsMax)
  .superRefine((fields, ctx) => {
    const keys = fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', message: 'custom field keys must be unique' });
    }
  });

/** The collection options, as a request names them — shared by sessions and links. */
export const collectionFields = {
  billing_address_collection: z.enum(CHECKOUT_BILLING_ADDRESS_COLLECTIONS).optional(),
  shipping_address_collection: z
    .object({
      allowed_countries: z.array(countryCode).min(1).max(CHECKOUT_LIMITS.shippingCountriesMax),
    })
    .strict()
    .optional(),
  phone_number_collection: z.object({ enabled: z.boolean() }).strict().optional(),
  tax_id_collection: z.object({ enabled: z.boolean() }).strict().optional(),
  consent_collection: z
    .object({ terms_of_service: z.enum(['none', 'required']).optional() })
    .strict()
    .optional(),
  custom_fields: customFieldsSchema.optional(),
};

type CollectionInput = {
  billing_address_collection?: (typeof CHECKOUT_BILLING_ADDRESS_COLLECTIONS)[number] | undefined;
  shipping_address_collection?: { allowed_countries: string[] } | undefined;
  phone_number_collection?: { enabled: boolean } | undefined;
  tax_id_collection?: { enabled: boolean } | undefined;
  consent_collection?: { terms_of_service?: 'none' | 'required' | undefined } | undefined;
};

/** The stored collection a request's options describe (`null` when it asks for nothing beyond defaults). */
export function storedCollectionOf(input: CollectionInput): StoredCheckoutCollection {
  return {
    billingAddressCollection: input.billing_address_collection ?? 'auto',
    shippingCountries: input.shipping_address_collection
      ? [...new Set(input.shipping_address_collection.allowed_countries)]
      : null,
    phoneNumber: input.phone_number_collection?.enabled ?? false,
    taxId: input.tax_id_collection?.enabled ?? false,
    termsOfService: input.consent_collection?.terms_of_service === 'required',
  };
}

export const DEFAULT_COLLECTION: StoredCheckoutCollection = storedCollectionOf({});

export function storedCustomFieldsOf(
  fields: z.infer<typeof customFieldsSchema> | undefined,
): StoredCustomField[] {
  return (fields ?? []).map((field) => {
    const bounds = field.text ?? field.numeric;
    return {
      key: field.key,
      label: field.label.custom,
      type: field.type,
      optional: field.optional ?? false,
      options: field.dropdown ? field.dropdown.options.map((o) => ({ ...o })) : null,
      minimumLength: bounds?.minimum_length ?? null,
      maximumLength: bounds?.maximum_length ?? null,
      value: null,
    };
  });
}

// ---- Line items -------------------------------------------------------------------

const adjustableQuantitySchema = z
  .object({
    enabled: z.boolean(),
    minimum: z.number().int().min(0).max(CHECKOUT_LIMITS.quantityMax).optional(),
    maximum: z.number().int().min(1).max(CHECKOUT_LIMITS.quantityMax).optional(),
  })
  .strict();

const quantitySchema = z.number().int().min(1).max(CHECKOUT_LIMITS.quantityMax);

const productDataSchema = z
  .object({
    name: z.string().trim().min(1).max(CATALOG_LIMITS.productNameMax),
    description: z.string().min(1).max(CATALOG_LIMITS.productDescriptionMax).optional(),
    images: z
      .array(
        z
          .string()
          .max(CATALOG_LIMITS.urlMax)
          .regex(/^https:\/\/\S+$/, 'must be an https URL'),
      )
      .max(8)
      .optional(),
    tax_code: z
      .string()
      .refine(isKnownTaxCode, 'is not a Peable Tax code (GET /v1/tax/codes lists them)')
      .optional(),
  })
  .strict();

const lineItemPriceDataSchema = z
  .object({
    currency: currencySchema,
    unit_amount: amountSchema,
    product: idSchema.optional(),
    product_data: productDataSchema.optional(),
    recurring: z
      .object({
        interval: z.enum(RECURRING_INTERVALS),
        interval_count: z.number().int().min(1).max(1095).optional(),
      })
      .strict()
      .optional(),
    tax_behavior: z.enum(PRICE_TAX_BEHAVIORS).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if ((data.product === undefined) === (data.product_data === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['product'],
        message: 'exactly one of product and product_data',
      });
    }
  });

/** One `line_items[]` entry of a session. */
export const sessionLineItemSchema = z
  .object({
    price: idSchema.optional(),
    price_data: lineItemPriceDataSchema.optional(),
    quantity: quantitySchema,
    adjustable_quantity: adjustableQuantitySchema.optional(),
  })
  .strict()
  .superRefine((line, ctx) => {
    if ((line.price === undefined) === (line.price_data === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['price'],
        message: 'exactly one of price and price_data',
      });
    }
    adjustableIssues(line.quantity, line.adjustable_quantity, ctx);
  });

/** One `line_items[]` entry of a payment link — a catalog price only. */
export const linkLineItemSchema = z
  .object({
    price: idSchema,
    quantity: quantitySchema,
    adjustable_quantity: adjustableQuantitySchema.optional(),
  })
  .strict()
  .superRefine((line, ctx) => adjustableIssues(line.quantity, line.adjustable_quantity, ctx));

/** Stripe's defaults: 0–99 when enabled. */
export function adjustableBoundsOf(
  adjustable: z.infer<typeof adjustableQuantitySchema> | undefined,
): { minimum: number; maximum: number } | null {
  if (!adjustable?.enabled) return null;
  return { minimum: adjustable.minimum ?? 0, maximum: adjustable.maximum ?? 99 };
}

function adjustableIssues(
  quantity: number,
  adjustable: z.infer<typeof adjustableQuantitySchema> | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!adjustable) return;
  if (!adjustable.enabled) {
    if (adjustable.minimum !== undefined || adjustable.maximum !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['adjustable_quantity', 'enabled'],
        message: 'minimum and maximum need adjustable_quantity.enabled',
      });
    }
    return;
  }
  const bounds = adjustableBoundsOf(adjustable);
  if (!bounds) return;
  if (bounds.minimum > bounds.maximum) {
    ctx.addIssue({
      code: 'custom',
      path: ['adjustable_quantity', 'minimum'],
      message: 'minimum cannot exceed maximum',
    });
  } else if (quantity < bounds.minimum || quantity > bounds.maximum) {
    ctx.addIssue({
      code: 'custom',
      path: ['quantity'],
      message: `quantity must be between ${bounds.minimum} and ${bounds.maximum}`,
    });
  }
}

// ---- Sessions ----------------------------------------------------------------------

const localeSchema = z
  .enum([...CHECKOUT_LOCALES, 'auto'] as [CheckoutLocale | 'auto', ...(CheckoutLocale | 'auto')[]])
  .transform((value) => (value === 'auto' ? null : value));

export { localeSchema };

const discountSchema = z.union([
  z.object({ coupon: idSchema }).strict(),
  z.object({ promotion_code: idSchema }).strict(),
]);

const emailSchema = z.string().trim().max(254).email('must be an email address');

/** `POST /v1/checkout_sessions`. */
export const createSessionBodySchema = z
  .object({
    mode: z.enum(CHECKOUT_SESSION_MODES).optional(),
    line_items: z.array(sessionLineItemSchema).min(1).max(CHECKOUT_LIMITS.lineItemsMax).optional(),
    currency: currencySchema.optional(),
    discounts: z.array(discountSchema).max(1).optional(),
    allow_promotion_codes: z.boolean().optional(),
    customer: idSchema.optional(),
    customer_email: emailSchema.optional(),
    customer_creation: z.enum(CHECKOUT_CUSTOMER_CREATIONS).optional(),
    ...collectionFields,
    automatic_tax: z.object({ enabled: z.boolean() }).strict().optional(),
    payment_method_types: z
      .array(z.enum(['card', 'faircoin']))
      .min(1)
      .max(1)
      .optional(),
    locale: localeSchema.optional(),
    ui_mode: z.enum(CHECKOUT_UI_MODES).optional(),
    success_url: redirectUrlSchema.optional(),
    cancel_url: redirectUrlSchema.optional(),
    expires_at: z.number().int().positive().optional(),
    client_reference_id: z.string().min(1).max(CHECKOUT_LIMITS.clientReferenceIdMax).optional(),
    metadata: metadataCreateSchema.optional(),
    submit_type: z.enum(CHECKOUT_SUBMIT_TYPES).optional(),
    connected_account: idSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const mode = body.mode ?? 'payment';
    if (mode === 'setup') {
      if (body.line_items) issue('line_items', 'a setup session has no line items');
      if (body.discounts || body.allow_promotion_codes) {
        issue('discounts', 'a setup session takes no discounts');
      }
      if (body.automatic_tax?.enabled) issue('automatic_tax', 'a setup session has no tax');
      if (!body.currency) issue('currency', 'a setup session needs a currency');
    } else {
      if (!body.line_items) issue('line_items', `line_items is required in ${mode} mode`);
      if (body.currency !== undefined) {
        issue('currency', 'the currency of a priced session is its line items’');
      }
    }
    if (body.customer !== undefined && body.customer_email !== undefined) {
      issue('customer_email', 'customer and customer_email are mutually exclusive');
    }
    if (body.discounts && body.allow_promotion_codes) {
      issue('allow_promotion_codes', 'discounts and allow_promotion_codes are mutually exclusive');
    }
    const ui = body.ui_mode ?? 'hosted';
    if (ui === 'hosted' && body.success_url === undefined) {
      issue('success_url', 'success_url is required in hosted mode');
    }
    if (ui === 'embedded' && body.cancel_url !== undefined) {
      issue('cancel_url', 'an embedded session has no cancel_url; the page around it is yours');
    }
    if (body.submit_type !== undefined && mode !== 'payment') {
      issue('submit_type', 'submit_type is for payment mode');
    }
  });

export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;

const addressParamsSchema = z
  .object({
    line1: z.string().trim().min(1).max(200).optional(),
    line2: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(200).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    postal_code: z.string().trim().min(1).max(20).optional(),
    country: countryCode.optional(),
  })
  .strict();

/** `POST /v1/checkout_sessions/:id/public` — the payer's edit. */
export const payerUpdateSchema = z
  .object({
    line_items: z
      .array(
        z
          .object({
            id: idSchema,
            quantity: z.number().int().min(0).max(CHECKOUT_LIMITS.quantityMax),
          })
          .strict(),
      )
      .max(CHECKOUT_LIMITS.lineItemsMax)
      .optional(),
    promotion_code: z
      .union([z.literal(''), z.string().trim().min(1).max(CATALOG_LIMITS.promotionCodeMax)])
      .optional(),
    customer_details: z
      .object({
        email: emailSchema.optional(),
        name: z.string().trim().min(1).max(200).optional(),
        phone: z
          .string()
          .trim()
          .regex(/^\+?[0-9 ()-]{5,25}$/, 'must be a phone number')
          .optional(),
        address: addressParamsSchema.optional(),
        tax_ids: z
          .array(
            z
              .object({
                type: z.enum(CHECKOUT_TAX_ID_TYPES),
                value: z
                  .string()
                  .trim()
                  .regex(/^[A-Za-z0-9 .-]{2,30}$/, 'must be a tax id'),
              })
              .strict(),
          )
          .max(1)
          .optional(),
      })
      .strict()
      .optional(),
    shipping_details: z
      .object({ name: z.string().trim().min(1).max(200), address: addressParamsSchema })
      .strict()
      .nullable()
      .optional(),
    custom_fields: z
      .array(z.object({ key: z.string().min(1).max(200), value: z.string().max(255) }).strict())
      .max(CHECKOUT_LIMITS.customFieldsMax)
      .optional(),
    consent: z
      .object({ terms_of_service: z.literal('accepted').optional() })
      .strict()
      .optional(),
  })
  .strict();

export type PayerUpdate = z.infer<typeof payerUpdateSchema>;
