import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  queryBoolean,
} from '../../common/params';
import { currency, livemode, metadata, network, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  CHECKOUT_CUSTOMER_CREATIONS,
  CHECKOUT_LOCALES,
  CHECKOUT_SUBMIT_TYPES,
  PAYMENT_LINK_LIMITS,
} from '../../vocabulary/checkout';
import { contributionAmountSchema, contributionDetailsSchema } from './contributions';
import {
  adjustableIssues,
  adjustableQuantityParam,
  checkoutBrandingSchema,
  checkoutIdParam,
  checkoutLineItemSchema,
  collectionParams,
  collectionResponseFields,
  localeParam,
  merchantDisplaySchema,
  quantityParam,
  railSchema,
  redirectUrlParam,
} from './shared';

/**
 * Payment Links (`link_…`, Orbit Phase 3) — Stripe's model: a shareable URL
 * over catalog PRICES. A payer visiting it creates a Checkout Session with the
 * link's line items and options; the session creates the payment when the
 * payer confirms. Nothing about a link mints a payment on its own.
 *
 * A contribution link (an Oxy organization's FairCoin collection) is a payment
 * link whose one line is the contribution itself — a fixed amount, or one the
 * payer chooses — rather than a price.
 */

export const checkoutAfterCompletionSchema = defineComponent(
  'CheckoutAfterCompletion',
  z
    .object({
      type: z.enum(['redirect', 'hosted_confirmation']),
      redirect: z.object({ url: z.string() }).strict().nullable(),
      hosted_confirmation: z.object({ custom_message: z.string().nullable() }).strict().nullable(),
    })
    .strict(),
);
export type CheckoutAfterCompletion = z.output<typeof checkoutAfterCompletionSchema>;

const linkFields = {
  id: z.string(),
  object: z.literal('payment_link'),
  livemode,
  active: z.boolean(),
  currency,
  rail: railSchema,
  network: network.nullable(),
  line_items: z
    .array(checkoutLineItemSchema)
    .describe("The link's prices (`GET /v1/payment_links/{id}/line_items` lists them in full)."),
  contribution: contributionDetailsSchema
    .optional()
    .describe('Present on an organization contribution link (FairCoin).'),
  locale: z.enum(CHECKOUT_LOCALES).nullable(),
};

export const paymentLinkSchema = defineObject(
  'payment_link',
  'PaymentLink',
  z
    .object({
      ...linkFields,
      allow_promotion_codes: z.boolean(),
      ...collectionResponseFields,
      automatic_tax: z.object({ enabled: z.boolean() }).strict(),
      customer_creation: z.enum(CHECKOUT_CUSTOMER_CREATIONS),
      after_completion: checkoutAfterCompletionSchema,
      restrictions: z
        .object({
          completed_sessions: z
            .object({ limit: z.number().int(), count: z.number().int() })
            .strict(),
        })
        .strict()
        .nullable(),
      submit_type: z.enum(CHECKOUT_SUBMIT_TYPES),
      metadata,
      url: z
        .string()
        .describe('`checkout.peable.to/l/<id>` — share it, or render it as a QR code.'),
      created: unixSeconds,
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'link_0193b8f2c1a87d3e9f4a',
        object: 'payment_link',
        livemode: false,
        active: true,
        currency: 'EUR',
        rail: 'card',
        network: null,
        line_items: [],
        allow_promotion_codes: false,
        billing_address_collection: 'auto',
        shipping_address_collection: null,
        phone_number_collection: { enabled: false },
        tax_id_collection: { enabled: false },
        custom_fields: [],
        consent_collection: null,
        automatic_tax: { enabled: false },
        customer_creation: 'if_required',
        after_completion: {
          type: 'hosted_confirmation',
          redirect: null,
          hosted_confirmation: { custom_message: null },
        },
        restrictions: null,
        submit_type: 'auto',
        locale: null,
        metadata: {},
        url: 'https://checkout.peable.to/l/link_0193b8f2c1a87d3e9f4a',
        created: 1793750400,
        updated_at: 1793750400,
      },
    ],
  },
);
export type PaymentLink = Expand<z.output<typeof paymentLinkSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    payment_link: PaymentLink;
  }
}

/** What an anonymous visitor may see before checkout starts — no metadata, no counts. */
export const publicPaymentLinkSchema = defineComponent(
  'PublicPaymentLink',
  z
    .object({
      ...linkFields,
      contribution_amount: z
        .string()
        .nullable()
        .describe(
          "A fixed contribution's amount; `null` when the payer chooses (or for a price link).",
        ),
      merchant: merchantDisplaySchema,
      branding: checkoutBrandingSchema,
    })
    .strict(),
);
export type PublicPaymentLink = Expand<z.output<typeof publicPaymentLinkSchema>>;

/** `POST /v1/payment_links/{id}/checkout_sessions`' answer: the hosted session and the secret that opens it. */
export const paymentLinkSessionStartSchema = defineComponent(
  'PaymentLinkSessionStart',
  z
    .object({
      object: z.literal('checkout_session_start'),
      id: z.string().describe('The Checkout Session (`cs_…`).'),
      client_secret: z.string(),
      url: z.string().describe('The hosted checkout to send the payer to.'),
    })
    .strict(),
);
export type PaymentLinkSessionStart = z.output<typeof paymentLinkSessionStartSchema>;

// ---- Requests --------------------------------------------------------------------

/** One `line_items[]` entry of a payment link — a catalog price only. */
export const linkLineItemParams = z
  .object({
    price: checkoutIdParam,
    quantity: quantityParam,
    adjustable_quantity: adjustableQuantityParam.optional(),
  })
  .strict()
  .superRefine((line, ctx) => adjustableIssues(line.quantity, line.adjustable_quantity, ctx));
export type PaymentLinkLineItemParams = z.input<typeof linkLineItemParams>;

const afterCompletionParams = z
  .object({
    type: z.enum(['redirect', 'hosted_confirmation']),
    redirect: z.object({ url: redirectUrlParam }).strict().optional(),
    hosted_confirmation: z
      .object({
        custom_message: z
          .string()
          .trim()
          .min(1)
          .max(PAYMENT_LINK_LIMITS.customMessageMax)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === 'redirect' && !value.redirect) {
      ctx.addIssue({ code: 'custom', path: ['redirect'], message: 'redirect.url is required' });
    }
    if (value.type === 'redirect' && value.hosted_confirmation) {
      ctx.addIssue({
        code: 'custom',
        path: ['hosted_confirmation'],
        message: 'hosted_confirmation is for type hosted_confirmation',
      });
    }
    if (value.type === 'hosted_confirmation' && value.redirect) {
      ctx.addIssue({
        code: 'custom',
        path: ['redirect'],
        message: 'redirect is for type redirect',
      });
    }
  });
export type PaymentLinkAfterCompletionParams = z.input<typeof afterCompletionParams>;

const restrictionsParams = z
  .object({
    completed_sessions: z.object({ limit: z.number().int().min(1).max(1_000_000) }).strict(),
  })
  .strict();

const optionParams = {
  allow_promotion_codes: z.boolean().optional(),
  ...collectionParams,
  automatic_tax: z.object({ enabled: z.boolean() }).strict().optional(),
  customer_creation: z.enum(CHECKOUT_CUSTOMER_CREATIONS).optional(),
  after_completion: afterCompletionParams.optional(),
  submit_type: z.enum(CHECKOUT_SUBMIT_TYPES).optional(),
  locale: localeParam.optional(),
};

/** `POST /v1/payment_links`: 1–20 one-time prices of ONE currency. */
export const createPaymentLinkParams = z
  .object({
    line_items: z.array(linkLineItemParams).min(1).max(PAYMENT_LINK_LIMITS.lineItemsMax),
    ...optionParams,
    restrictions: restrictionsParams.optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreatePaymentLinkParams = z.input<typeof createPaymentLinkParams>;

/**
 * `POST /v1/payment_links/{id}` — everything but the line items, which are
 * fixed once shared (a payer may hold a session priced from them). `""`
 * clears; `metadata` is a patch.
 */
export const updatePaymentLinkParams = z
  .object({
    active: z.boolean().optional(),
    ...optionParams,
    shipping_address_collection: z
      .union([collectionParams.shipping_address_collection.unwrap(), z.literal('')])
      .optional(),
    custom_fields: z.union([collectionParams.custom_fields.unwrap(), z.literal('')]).optional(),
    restrictions: z.union([restrictionsParams, z.literal('')]).optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdatePaymentLinkParams = z.input<typeof updatePaymentLinkParams>;

export const listPaymentLinksQuery = listQuery({ active: queryBoolean.optional() });
export type ListPaymentLinksParams = z.input<typeof listPaymentLinksQuery>;

/** A link's lines: a complete set of at most twenty (`has_more` is `false`). */
export const listPaymentLinkLineItemsQuery = listQuery({});

/**
 * `POST /v1/payment_links/{id}/checkout_sessions` — a payer starting checkout.
 * A contribution link the payer prices takes `amount`; nothing else is the
 * payer's to say.
 */
export const createPaymentLinkSessionParams = z
  .object({
    amount: z
      .string()
      .refine(
        (value) => contributionAmountSchema.safeParse(value).success,
        'Enter a positive FairCoin base-unit amount within the supported range',
      )
      .optional()
      .describe("A free contribution's amount, in FAIR base units."),
  })
  .strict();
export type CreatePaymentLinkSessionParams = z.input<typeof createPaymentLinkSessionParams>;

const linkId = { id: 'The payment link (`link_…`).' } as const;

export const paymentLinkRoutes = [
  defineRoute({
    operationId: 'createPaymentLink',
    method: 'post',
    path: '/v1/payment_links',
    tag: 'Payment Links',
    summary: 'Create a payment link',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createPaymentLinkParams,
    response: paymentLinkSchema,
    status: 201,
    sdk: 'paymentLinks.create',
    expandable: 'payment_link',
  }),
  defineRoute({
    operationId: 'listPaymentLinks',
    method: 'get',
    path: '/v1/payment_links',
    tag: 'Payment Links',
    summary: 'List payment links',
    auth: 'service',
    scope: 'payments:read',
    query: listPaymentLinksQuery,
    response: listOf(paymentLinkSchema),
    sdk: 'paymentLinks.list',
    expandable: 'payment_link',
  }),
  defineRoute({
    operationId: 'retrievePaymentLink',
    method: 'get',
    path: '/v1/payment_links/{id}',
    tag: 'Payment Links',
    summary: 'Retrieve a payment link',
    auth: 'service',
    scope: 'payments:read',
    params: linkId,
    query: expandOnlyQuery,
    response: paymentLinkSchema,
    sdk: 'paymentLinks.retrieve',
    expandable: 'payment_link',
  }),
  defineRoute({
    operationId: 'updatePaymentLink',
    method: 'post',
    path: '/v1/payment_links/{id}',
    tag: 'Payment Links',
    summary: 'Update a payment link',
    description: 'Everything but the line items. `""` clears a field; `metadata` is a patch.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: linkId,
    body: updatePaymentLinkParams,
    response: paymentLinkSchema,
    sdk: 'paymentLinks.update',
    expandable: 'payment_link',
  }),
  defineRoute({
    operationId: 'listPaymentLinkLineItems',
    method: 'get',
    path: '/v1/payment_links/{id}/line_items',
    tag: 'Payment Links',
    summary: "List a payment link's line items",
    description: 'A complete set of at most twenty lines: `has_more` is always `false`.',
    auth: 'service',
    scope: 'payments:read',
    params: linkId,
    query: listPaymentLinkLineItemsQuery,
    response: listOf(checkoutLineItemSchema),
    sdk: 'paymentLinks.listLineItems',
    expandable: 'item',
  }),
  defineRoute({
    operationId: 'retrievePaymentLinkPublic',
    method: 'get',
    path: '/v1/payment_links/{id}/public',
    tag: 'Payment Links',
    summary: 'Retrieve a payment link as a visitor',
    description:
      'Anonymous and rate-limited: what a visitor sees before checkout starts. An inactive (or expired contribution) link answers with `active: false`, so the page can say so.',
    auth: 'public',
    params: linkId,
    response: publicPaymentLinkSchema,
  }),
  defineRoute({
    operationId: 'createPaymentLinkCheckoutSession',
    method: 'post',
    path: '/v1/payment_links/{id}/checkout_sessions',
    tag: 'Payment Links',
    summary: 'Start checkout from a payment link',
    description:
      'Anonymous and rate-limited. Creates a Checkout Session from the STORED link — never a payment. A contribution link requires a UUID `Idempotency-Key` header, written by the page before the request, so a lost answer recovers the same session.',
    auth: 'public',
    params: linkId,
    body: createPaymentLinkSessionParams,
    response: paymentLinkSessionStartSchema,
    status: 201,
  }),
] as const;
