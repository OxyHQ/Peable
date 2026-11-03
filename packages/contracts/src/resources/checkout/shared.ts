import { z } from 'zod';
import { PAYMENT_INTENT_RAILS } from '../../vocabulary/payments';
import { addressSchema } from '../../common/address';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import { amount, currency } from '../../common/primitives';
import {
  CHECKOUT_BILLING_ADDRESS_COLLECTIONS,
  CHECKOUT_CUSTOM_FIELD_TYPES,
  CHECKOUT_LIMITS,
  CHECKOUT_LOCALES,
  CHECKOUT_SESSION_ID_TEMPLATE,
  CHECKOUT_TAX_ID_TYPES,
  type CheckoutLocale,
} from '../../vocabulary/checkout';
import { BRANDING_BORDER_STYLES, BRANDING_FONTS } from '../../vocabulary/merchants';
import { BASE_UNIT_PATTERN } from '../../vocabulary/money';

/**
 * What Checkout Sessions and Payment Links share: the `item` a line renders
 * as, the collection options (address, phone, tax id, terms, custom fields),
 * the payer-facing merchant and branding, and the request halves of those.
 * One shape rule is written once, so a link and a session refuse the same
 * mistake with the same `param`.
 */

// ---------------------------------------------------------------------------
// Response side
// ---------------------------------------------------------------------------

/** The payment rail: FairCoin on chain, or a card (and the methods riding on it). */
export const railSchema = z.enum(PAYMENT_INTENT_RAILS);

export const checkoutAdjustableQuantitySchema = defineComponent(
  'CheckoutAdjustableQuantity',
  z
    .object({
      enabled: z.boolean(),
      minimum: z.number().int().nullable().describe('Default 0 when enabled.'),
      maximum: z.number().int().nullable().describe('Default 99 when enabled.'),
    })
    .strict(),
);
export type CheckoutAdjustableQuantity = z.output<typeof checkoutAdjustableQuantitySchema>;

/** One line of a session or link — Stripe's `item`. */
export const checkoutLineItemSchema = defineObject(
  'item',
  'CheckoutLineItem',
  z
    .object({
      id: z.string(),
      object: z.literal('item'),
      description: z.string().describe("The product's name, or the inline `product_data.name`."),
      price: expandable(
        'price',
        'The catalog price (`price_…`, or the Price with `expand[]=data.price`); `null` for an inline `price_data` line, which is a snapshot on the line and never a stored price.',
      ).nullable(),
      product: expandable(
        'product',
        'The catalog product (`prod_…`, expandable); `null` for `product_data`.',
      ).nullable(),
      images: z
        .array(z.string())
        .describe("Images to show beside the line (the product's, or `product_data.images`)."),
      quantity: z.number().int(),
      adjustable_quantity: checkoutAdjustableQuantitySchema.nullable(),
      currency,
      unit_amount: amount
        .nullable()
        .describe('The per-unit amount for a per-unit price; `null` for a tiered one.'),
      amount_subtotal: amount.describe('Before discount and tax.'),
      amount_discount: amount,
      amount_tax: amount,
      amount_total: amount.describe(
        '`amount_subtotal - amount_discount + amount_tax` (exclusive tax only).',
      ),
    })
    .strict(),
  {
    examples: [
      {
        id: 'li_0193b8f2c1a87d3e9f4a',
        object: 'item',
        description: 'Pro plan',
        price: 'price_0193b8f2c1a87d3e9f4b',
        product: 'prod_0193b8f2c1a87d3e9f4c',
        images: [],
        quantity: 1,
        adjustable_quantity: null,
        currency: 'EUR',
        unit_amount: '1999',
        amount_subtotal: '1999',
        amount_discount: '0',
        amount_tax: '0',
        amount_total: '1999',
      },
    ],
  },
);
export type CheckoutLineItem = Expand<z.output<typeof checkoutLineItemSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    item: CheckoutLineItem;
  }
}

export const checkoutTaxIdSchema = defineComponent(
  'CheckoutTaxId',
  z.object({ type: z.enum(CHECKOUT_TAX_ID_TYPES), value: z.string() }).strict(),
);
export type CheckoutTaxId = z.output<typeof checkoutTaxIdSchema>;

/** What the payer told checkout about themselves — Stripe's `customer_details`. */
export const checkoutCustomerDetailsSchema = defineComponent(
  'CheckoutCustomerDetails',
  z
    .object({
      email: z.string().nullable(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
      address: addressSchema.nullable(),
      tax_ids: z.array(checkoutTaxIdSchema),
    })
    .strict(),
);
export type CheckoutCustomerDetails = z.output<typeof checkoutCustomerDetailsSchema>;

export const checkoutShippingDetailsSchema = defineComponent(
  'CheckoutShippingDetails',
  z.object({ name: z.string(), address: addressSchema }).strict(),
);
export type CheckoutShippingDetails = z.output<typeof checkoutShippingDetailsSchema>;

export const checkoutCustomFieldLabelSchema = z
  .object({ type: z.literal('custom'), custom: z.string() })
  .strict();
export type CheckoutCustomFieldLabel = z.output<typeof checkoutCustomFieldLabelSchema>;

export const checkoutCustomFieldDropdownOptionSchema = z
  .object({ label: z.string(), value: z.string() })
  .strict();
export type CheckoutCustomFieldDropdownOption = z.output<
  typeof checkoutCustomFieldDropdownOptionSchema
>;

const customFieldBounds = z
  .object({
    minimum_length: z.number().int().nullable(),
    maximum_length: z.number().int().nullable(),
    value: z.string().nullable().describe('What the payer entered.'),
  })
  .strict();

/** A merchant-defined field the payer fills in; `value`s are what they entered. */
export const checkoutCustomFieldSchema = defineComponent(
  'CheckoutCustomField',
  z
    .object({
      key: z.string(),
      label: checkoutCustomFieldLabelSchema,
      type: z.enum(CHECKOUT_CUSTOM_FIELD_TYPES),
      optional: z.boolean(),
      dropdown: z
        .object({
          options: z.array(checkoutCustomFieldDropdownOptionSchema),
          value: z.string().nullable(),
        })
        .strict()
        .nullable(),
      text: customFieldBounds.nullable(),
      numeric: customFieldBounds.nullable(),
    })
    .strict(),
);
export type CheckoutCustomField = z.output<typeof checkoutCustomFieldSchema>;

export const checkoutDiscountSchema = defineComponent(
  'CheckoutDiscount',
  z
    .object({
      coupon: z.string().describe('The coupon applied (merchant-chosen id or `coupon_…`).'),
      promotion_code: z
        .string()
        .nullable()
        .describe('The promotion code it was redeemed through (`promo_…`), or `null`.'),
    })
    .strict(),
);
export type CheckoutDiscount = z.output<typeof checkoutDiscountSchema>;

export const checkoutTotalDetailsSchema = defineComponent(
  'CheckoutTotalDetails',
  z.object({ amount_discount: amount, amount_tax: amount, amount_shipping: amount }).strict(),
);
export type CheckoutTotalDetails = z.output<typeof checkoutTotalDetailsSchema>;

/**
 * `automatic_tax` — Peable Tax (ADR 0011). `requires_location_inputs` until
 * the payer gave an address Peable Tax can locate them with; `failed` when the
 * sale is covered and could not be priced (checkout refuses to proceed: tax
 * fails CLOSED, never zero).
 */
export const checkoutAutomaticTaxSchema = defineComponent(
  'CheckoutAutomaticTax',
  z
    .object({
      enabled: z.boolean(),
      status: z.enum(['complete', 'requires_location_inputs', 'failed']).nullable(),
    })
    .strict(),
);
export type CheckoutAutomaticTax = z.output<typeof checkoutAutomaticTaxSchema>;

export const checkoutConsentCollectionSchema = z
  .object({ terms_of_service: z.enum(['none', 'required']) })
  .strict();
export type CheckoutConsentCollection = z.output<typeof checkoutConsentCollectionSchema>;

export const checkoutConsentSchema = z
  .object({ terms_of_service: z.literal('accepted').nullable() })
  .strict();
export type CheckoutConsent = z.output<typeof checkoutConsentSchema>;

/** The collection options, as a session or link reports them. */
export const collectionResponseFields = {
  billing_address_collection: z.enum(CHECKOUT_BILLING_ADDRESS_COLLECTIONS),
  shipping_address_collection: z
    .object({ allowed_countries: z.array(z.string()) })
    .strict()
    .nullable(),
  phone_number_collection: z.object({ enabled: z.boolean() }).strict(),
  tax_id_collection: z.object({ enabled: z.boolean() }).strict(),
  custom_fields: z.array(checkoutCustomFieldSchema),
  consent_collection: checkoutConsentCollectionSchema.nullable(),
};

/** The public, secret-free merchant identity a payer surface renders. */
export const merchantDisplaySchema = defineComponent(
  'MerchantDisplay',
  z
    .object({
      name: z.string().describe("The merchant's display name, or a neutral fallback when unset."),
      avatar_url: z
        .string()
        .nullable()
        .describe('Resolved server-side; `null` when the merchant has no avatar.'),
      logo_url: z
        .string()
        .nullable()
        .describe("The merchant's `business_logo`, resolved; `null` when unset or not served."),
      description: z.string().nullable(),
    })
    .strict(),
);
export type MerchantDisplay = z.output<typeof merchantDisplaySchema>;

/**
 * Branding as a payer surface renders it: every field resolved (defaults
 * filled in), the logo and icon as URLs the gateway built through Oxy's media
 * chokepoint — a withheld file is `null`, never a broken image.
 */
export const checkoutBrandingSchema = defineComponent(
  'CheckoutBranding',
  z
    .object({
      icon_url: z.string().nullable(),
      logo_url: z.string().nullable(),
      primary_color: z.string(),
      accent_color: z.string(),
      font: z.enum(BRANDING_FONTS),
      border_style: z.enum(BRANDING_BORDER_STYLES),
    })
    .strict(),
);
export type CheckoutBranding = z.output<typeof checkoutBrandingSchema>;

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

export const checkoutIdParam = z.string().min(1).max(255);

export const countryCodeParam = z
  .string()
  .regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 country code');

/** A base-unit amount in a request. */
export const amountParam = z
  .string()
  .regex(BASE_UNIT_PATTERN, 'must be a non-negative integer string in the smallest currency unit');

/**
 * A redirect target. `https` only, except `http://localhost` for development —
 * a payer is sent there after paying, so an `http` URL elsewhere would leak the
 * session id in the clear. `{CHECKOUT_SESSION_ID}` may appear anywhere.
 */
export const redirectUrlParam = z
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
  }, 'must be an https URL (http only on localhost)')
  .describe('`https` (or `http://localhost`); may carry `{CHECKOUT_SESSION_ID}`.');

/** `auto` follows the payer's browser: parsed as `null`. */
export const localeParam = z
  .enum([...CHECKOUT_LOCALES, 'auto'] as [CheckoutLocale | 'auto', ...(CheckoutLocale | 'auto')[]])
  .transform((value) => (value === 'auto' ? null : value))
  .describe("`auto` follows the payer's browser.");

export const checkoutEmailParam = z.string().trim().max(254).email('must be an email address');

const customFieldParam = z
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
export type CheckoutCustomFieldParams = z.input<typeof customFieldParam>;

/** At most three, keys unique. */
export const customFieldsParam = z
  .array(customFieldParam)
  .max(CHECKOUT_LIMITS.customFieldsMax)
  .superRefine((fields, ctx) => {
    const keys = fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', message: 'custom field keys must be unique' });
    }
  });

/** The collection options, as a request names them — shared by sessions and links. */
export const collectionParams = {
  billing_address_collection: z.enum(CHECKOUT_BILLING_ADDRESS_COLLECTIONS).optional(),
  shipping_address_collection: z
    .object({
      allowed_countries: z.array(countryCodeParam).min(1).max(CHECKOUT_LIMITS.shippingCountriesMax),
    })
    .strict()
    .optional(),
  phone_number_collection: z.object({ enabled: z.boolean() }).strict().optional(),
  tax_id_collection: z.object({ enabled: z.boolean() }).strict().optional(),
  consent_collection: z
    .object({ terms_of_service: z.enum(['none', 'required']).optional() })
    .strict()
    .optional(),
  custom_fields: customFieldsParam.optional(),
};

export const adjustableQuantityParam = z
  .object({
    enabled: z.boolean(),
    minimum: z.number().int().min(0).max(CHECKOUT_LIMITS.quantityMax).optional(),
    maximum: z.number().int().min(1).max(CHECKOUT_LIMITS.quantityMax).optional(),
  })
  .strict();
export type AdjustableQuantityParams = z.output<typeof adjustableQuantityParam>;

export const quantityParam = z.number().int().min(1).max(CHECKOUT_LIMITS.quantityMax);

/** Stripe's defaults: 0–99 when enabled. */
export function adjustableBoundsOf(
  adjustable: AdjustableQuantityParams | undefined,
): { minimum: number; maximum: number } | null {
  if (!adjustable?.enabled) return null;
  return { minimum: adjustable.minimum ?? 0, maximum: adjustable.maximum ?? 99 };
}

/** The refusals of a line's `quantity` against its `adjustable_quantity`. */
export function adjustableIssues(
  quantity: number,
  adjustable: AdjustableQuantityParams | undefined,
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
