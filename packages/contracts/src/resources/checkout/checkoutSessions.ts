import { z } from 'zod';
import { CATALOG_LIMITS, PRICE_TAX_BEHAVIORS, RECURRING_INTERVALS } from '../../vocabulary/catalog';
import { SETUP_INTENT_STATUSES } from '../../vocabulary/payments';
import { embedded } from '../../common/objects';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import {
  amount,
  currency,
  livemode,
  metadata,
  network,
  unixSeconds,
} from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  CHECKOUT_CUSTOMER_CREATIONS,
  CHECKOUT_CONTACT_COLLECTIONS,
  CHECKOUT_LIMITS,
  CHECKOUT_LOCALES,
  CHECKOUT_PAYMENT_STATUSES,
  CHECKOUT_SESSION_MODES,
  CHECKOUT_SESSION_STATUSES,
  CHECKOUT_SUBMIT_TYPES,
  CHECKOUT_TAX_ID_TYPES,
  CHECKOUT_UI_MODES,
  FAIRCOIN_UNAVAILABLE_REASONS,
} from '../../vocabulary/checkout';
import {
  adjustableIssues,
  adjustableQuantityParam,
  amountParam,
  checkoutAutomaticTaxSchema,
  checkoutBrandingSchema,
  checkoutConsentSchema,
  checkoutCustomerDetailsSchema,
  checkoutDiscountSchema,
  checkoutIdParam,
  checkoutLineItemSchema,
  checkoutShippingDetailsSchema,
  checkoutTotalDetailsSchema,
  collectionParams,
  collectionResponseFields,
  countryCodeParam,
  checkoutEmailParam,
  localeParam,
  merchantDisplaySchema,
  quantityParam,
  railSchema,
  redirectUrlParam,
} from './shared';

/**
 * Checkout Sessions (`cs_…`, Orbit Phase 3) — Stripe Checkout's session model:
 * a session is an ORDER (line items, discounts, tax, what to collect from the
 * payer) that a payer completes on Peable's hosted or embedded checkout. The
 * PaymentIntent (or SetupIntent) is created when the payer confirms, with the
 * amount the session computed, and linked. Amounts are base-unit strings.
 */

const sessionFields = {
  id: z.string(),
  object: z.literal('checkout_session'),
  contact_collection: z
    .enum(CHECKOUT_CONTACT_COLLECTIONS)
    .optional()
    .describe(
      'Contact policy fixed by the merchant at creation. Absent means email. merchant_account delegates contact and notifications to the merchant account channel; it does not assert a Peable-verified identity.',
    ),
  livemode,
  mode: z.enum(CHECKOUT_SESSION_MODES),
  status: z.enum(CHECKOUT_SESSION_STATUSES),
  payment_status: z.enum(CHECKOUT_PAYMENT_STATUSES),
  ui_mode: z.enum(CHECKOUT_UI_MODES),
  locale: z
    .enum(CHECKOUT_LOCALES)
    .nullable()
    .describe("The language checkout renders in; `null` follows the payer's browser."),
  submit_type: z.enum(CHECKOUT_SUBMIT_TYPES),
  currency,
  rail: railSchema.describe(
    "The rail that settles the order's currency: `faircoin` for a FAIR order, `card` for a fiat one. FairCoin is offered on every order beside it (`payment_method_types`, ADR 0021).",
  ),
  network: network
    .nullable()
    .describe(
      'The FairCoin network a FairCoin payment of this order uses — the merchant’s (or the seller’s); `null` when the payee has no FairCoin key yet (test mode) and in `setup` mode.',
    ),
  payment_method_types: z
    .array(railSchema)
    .describe(
      "What the payer may choose: `['card', 'faircoin']` on a fiat order (`['faircoin']` when the merchant offered FairCoin only), `['faircoin']` on a FAIR one. FairCoin is always offered (ADR 0021); `['card']` in `setup` mode.",
    ),
  amount_subtotal: amount,
  amount_total: amount,
  total_details: checkoutTotalDetailsSchema,
  allow_promotion_codes: z.boolean(),
  automatic_tax: checkoutAutomaticTaxSchema,
  ...collectionResponseFields,
  shipping_details: checkoutShippingDetailsSchema.nullable(),
  consent: checkoutConsentSchema.nullable(),
  expires_at: unixSeconds,
};

/** The merchant/SDK-facing session — Stripe's Checkout Session. */
export const checkoutSessionSchema = defineObject(
  'checkout_session',
  'CheckoutSession',
  z
    .object({
      ...sessionFields,
      discounts: z.array(checkoutDiscountSchema),
      customer: expandable(
        'customer',
        '`cus_…` (expandable) — given on create, or created at completion.',
      ).nullable(),
      customer_email: z.string().nullable(),
      customer_creation: z.enum(CHECKOUT_CUSTOMER_CREATIONS),
      customer_details: checkoutCustomerDetailsSchema.nullable(),
      payment_intent: expandable(
        'payment_intent',
        'The payment this session created (`pi_…`, expandable) once the payer confirmed; `null` before, and always in `setup` mode.',
      ).nullable(),
      setup_intent: expandable(
        'setup_intent',
        '`setup` mode: the SetupIntent (`seti_…`, expandable) once confirmed.',
      ).nullable(),
      connected_account: expandable(
        'connected_account',
        'The seller an on-behalf payment pays (`ca_…`, expandable).',
      ).nullable(),
      payment_link: z
        .string()
        .nullable()
        .describe('The payment link this session was created from (`link_…`), if any.'),
      client_reference_id: z.string().nullable(),
      metadata,
      success_url: z
        .string()
        .nullable()
        .describe('With `{CHECKOUT_SESSION_ID}` as given; checkout substitutes it.'),
      cancel_url: z.string().nullable(),
      url: z
        .string()
        .nullable()
        .describe('Hosted mode: the URL to send the payer to. `null` in embedded mode.'),
      client_secret: z
        .string()
        .nullable()
        .describe(
          'Embedded mode: what `PeableCheckout.mountCheckout` takes. `null` in hosted mode.',
        ),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'cs_0193b8f2c1a87d3e9f4a',
        object: 'checkout_session',
        livemode: false,
        mode: 'payment',
        status: 'open',
        payment_status: 'unpaid',
        ui_mode: 'hosted',
        locale: null,
        submit_type: 'auto',
        currency: 'EUR',
        rail: 'card',
        network: 'mainnet',
        payment_method_types: ['card', 'faircoin'],
        amount_subtotal: '1999',
        amount_total: '1999',
        total_details: { amount_discount: '0', amount_tax: '0', amount_shipping: '0' },
        discounts: [],
        allow_promotion_codes: false,
        automatic_tax: { enabled: false, status: null },
        customer: null,
        customer_email: 'jenny@example.com',
        customer_creation: 'if_required',
        customer_details: null,
        billing_address_collection: 'auto',
        shipping_address_collection: null,
        shipping_details: null,
        phone_number_collection: { enabled: false },
        tax_id_collection: { enabled: false },
        custom_fields: [],
        consent_collection: null,
        consent: null,
        payment_intent: null,
        setup_intent: null,
        connected_account: null,
        payment_link: null,
        client_reference_id: null,
        metadata: {},
        success_url: 'https://example.com/thanks?session={CHECKOUT_SESSION_ID}',
        cancel_url: null,
        url: 'https://checkout.peable.to/c/cs_0193b8f2c1a87d3e9f4a#cs=cs_0193b8f2c1a87d3e9f4a_secret_x',
        client_secret: null,
        expires_at: 1793836800,
        created: 1793750400,
      },
    ],
  },
);
export type CheckoutSession = Expand<z.output<typeof checkoutSessionSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    checkout_session: CheckoutSession;
  }
}

/**
 * What the hosted/embedded checkout loads, authorized by the session's
 * `client_secret` (or, for a session wrapping a payment, that payment's). No
 * metadata, no client reference, no internal ids.
 */
export const checkoutSessionPublicSchema = defineComponent(
  'CheckoutSessionPublic',
  z
    .object({
      ...sessionFields,
      line_items: z.array(checkoutLineItemSchema),
      discount: z
        .object({
          promotion_code: z.string().nullable().describe('The code the payer typed.'),
          coupon_name: z.string().nullable(),
          amount_off: amount.nullable(),
          percent_off: z.number().nullable(),
        })
        .strict()
        .nullable()
        .describe('The discount applied, as the payer sees it.'),
      customer_details: checkoutCustomerDetailsSchema.describe(
        'Prefilled from `customer_email` / the customer; then what the payer entered.',
      ),
      customer_email_locked: z
        .boolean()
        .describe('Whether the email is fixed by the merchant (a `customer` or `customer_email`).'),
      terms_of_service_url: z
        .string()
        .nullable()
        .describe(
          "The merchant's terms URL when `consent_collection.terms_of_service` is required.",
        ),
      payment_intent: embedded('payment_intent')
        .nullable()
        .describe(
          "The payment the payer confirmed — with its `client_secret`, the payer's capability.",
        ),
      setup_intent: z
        .object({
          id: z.string(),
          client_secret: z.string(),
          status: z.enum(SETUP_INTENT_STATUSES),
        })
        .strict()
        .nullable()
        .describe('`setup` mode: the SetupIntent id and client secret, once confirmed.'),
      success_url: z
        .string()
        .nullable()
        .describe('`success_url` with `{CHECKOUT_SESSION_ID}` substituted; only once `complete`.'),
      cancel_url: z.string().nullable().describe('Shown as "Back to <merchant>" before payment.'),
      confirmation_message: z
        .string()
        .nullable()
        .describe("A payment link's hosted confirmation, shown once `complete`."),
      merchant: merchantDisplaySchema,
      branding: checkoutBrandingSchema,
      publishable_key: z
        .string()
        .nullable()
        .describe(
          "The card provider's PUBLIC key for this session's mode, so the payment fields can mount before the payment exists. `null` on FairCoin.",
        ),
      faircoin: z
        .object({
          available: z.boolean(),
          unavailable_reason: z
            .enum(FAIRCOIN_UNAVAILABLE_REASONS)
            .nullable()
            .describe(
              'Why FairCoin cannot be paid with right now; it is still shown, never hidden.',
            ),
        })
        .strict()
        .nullable()
        .describe(
          'Whether the payer can choose FairCoin now (ADR 0021). On a fiat order the FAIR amount is quoted when the payer chooses it (`payment_intent.faircoin.quote`). `null` in `setup` mode.',
        ),
    })
    .strict(),
);
export type CheckoutSessionPublic = Expand<z.output<typeof checkoutSessionPublicSchema>>;

// ---- Merchant create/update ---------------------------------------------------

const productDataParams = z
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
      .regex(/^txcd_[0-9]{8}$/, 'is not a Peable Tax code (GET /v1/tax/codes lists them)')
      .optional()
      .describe('A Peable Tax code (`GET /v1/tax/codes`).'),
  })
  .strict();
export type CheckoutProductDataParams = z.input<typeof productDataParams>;

const priceDataParams = z
  .object({
    currency,
    unit_amount: amountParam,
    product: checkoutIdParam.optional(),
    product_data: productDataParams.optional(),
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
export type CheckoutPriceDataParams = z.input<typeof priceDataParams>;

/** One `line_items[]` entry of a session: exactly one of `price` and `price_data`. */
export const sessionLineItemParams = z
  .object({
    price: checkoutIdParam.optional(),
    price_data: priceDataParams.optional(),
    quantity: quantityParam,
    adjustable_quantity: adjustableQuantityParam.optional(),
    connected_account: checkoutIdParam
      .optional()
      .describe(
        "The seller (`ca_…`) this line is sold by (ADR 0021 D6). A FairCoin payment pays every seller of the order its share directly, in one transaction, split by each seller's lines' `amount_subtotal`; a line without one is the merchant's own sale. The card payment stays the merchant's charge. Exclusive with the session's `connected_account`.",
      ),
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
export type CheckoutLineItemParams = z.input<typeof sessionLineItemParams>;

const discountParam = z.union([
  z.object({ coupon: checkoutIdParam }).strict(),
  z.object({ promotion_code: checkoutIdParam }).strict(),
]);

export const createCheckoutSessionParams = z
  .object({
    mode: z.enum(CHECKOUT_SESSION_MODES).optional().describe('Default `payment`.'),
    line_items: z
      .array(sessionLineItemParams)
      .min(1)
      .max(CHECKOUT_LIMITS.lineItemsMax)
      .optional()
      .describe('Required in `payment` and `subscription` mode; refused in `setup` mode.'),
    currency: currency
      .optional()
      .describe('`setup` mode: the currency of the method being saved (card rail only).'),
    discounts: z
      .array(discountParam)
      .max(1)
      .optional()
      .describe('At most one; mutually exclusive with `allow_promotion_codes`.'),
    allow_promotion_codes: z.boolean().optional(),
    customer: checkoutIdParam
      .optional()
      .describe('`cus_…`; mutually exclusive with `customer_email`.'),
    customer_email: checkoutEmailParam.optional(),
    contact_collection: z
      .enum(CHECKOUT_CONTACT_COLLECTIONS)
      .optional()
      .describe(
        'Defaults to email. merchant_account delegates contact and payment notifications to the merchant, which must have its own authenticated account channel. This is not identity verification by Peable. Payers cannot change this policy.',
      ),
    customer_creation: z
      .enum(CHECKOUT_CUSTOMER_CREATIONS)
      .optional()
      .describe('Default `if_required` (a customer is created only when something needs one).'),
    ...collectionParams,
    automatic_tax: z.object({ enabled: z.boolean() }).strict().optional(),
    payment_method_types: z
      .array(z.enum(['card', 'faircoin']))
      .min(1)
      .max(2)
      .optional()
      .describe(
        "Must include `faircoin`, which is always offered (ADR 0021; leaving it out is 400 `payment_method_locked`). On a fiat order `['card', 'faircoin']` (the default) or `['faircoin']` — a FairCoin-only order, the fiat methods being the merchant's to turn off; on a FAIR order `['faircoin']`. Which card methods are offered comes from the payment method configuration.",
      ),
    locale: localeParam.optional(),
    ui_mode: z.enum(CHECKOUT_UI_MODES).optional(),
    success_url: redirectUrlParam
      .optional()
      .describe('Required in hosted mode; may carry `{CHECKOUT_SESSION_ID}`.'),
    cancel_url: redirectUrlParam
      .optional()
      .describe('Hosted mode only: the "Back to merchant" link.'),
    expires_at: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Unix seconds, 30 minutes to 24 hours from now. Default 24 hours.'),
    client_reference_id: z.string().min(1).max(CHECKOUT_LIMITS.clientReferenceIdMax).optional(),
    metadata: metadataCreateParam.optional(),
    submit_type: z.enum(CHECKOUT_SUBMIT_TYPES).optional(),
    connected_account: checkoutIdParam
      .optional()
      .describe(
        'Pay this seller (`ca_…`) rather than the merchant (ADR 0012); FairCoin only. Exclusive with `line_items[].connected_account`.',
      ),
    payment_intent_data: z
      .object({
        metadata: metadataCreateParam
          .optional()
          .describe(
            'Copied to EVERY payment this session creates (each method the payer confirms, each fresh quote), so its events carry your own identifiers (ADR 0021 D8).',
          ),
      })
      .strict()
      .optional(),
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
    if (body.line_items?.some((line) => line.connected_account !== undefined)) {
      if (body.connected_account !== undefined) {
        issue(
          'connected_account',
          'connected_account and line_items[].connected_account are mutually exclusive',
        );
      }
      if (mode !== 'payment') issue('line_items', 'a line names its seller in payment mode only');
    }
    if (body.payment_intent_data !== undefined && mode === 'setup') {
      issue('payment_intent_data', 'a setup session creates no payment');
    }
  });
export type CreateCheckoutSessionParams = z.input<typeof createCheckoutSessionParams>;

/** `POST /v1/checkout_sessions/{id}` — the merchant's `metadata`, as a patch. */
export const updateCheckoutSessionParams = z
  .object({ metadata: metadataUpdateParam.optional(), expand: expandParam.optional() })
  .strict();
export type UpdateCheckoutSessionParams = z.input<typeof updateCheckoutSessionParams>;

export const expireCheckoutSessionParams = z.object({ expand: expandParam.optional() }).strict();
export type ExpireCheckoutSessionParams = z.input<typeof expireCheckoutSessionParams>;

export const listCheckoutSessionsQuery = listQuery({
  payment_intent: checkoutIdParam.optional().describe('Sessions that created this payment.'),
  payment_link: checkoutIdParam.optional().describe('Sessions started from this link.'),
  customer: checkoutIdParam.optional(),
  status: z.enum(CHECKOUT_SESSION_STATUSES).optional(),
});
export type ListCheckoutSessionsParams = z.input<typeof listCheckoutSessionsQuery>;

/** A session's lines, in their order; `created` does not apply to them. */
export const listCheckoutSessionLineItemsQuery = listQuery({});

// ---- Payer side ------------------------------------------------------------------

const payerAddressParams = z
  .object({
    line1: z.string().trim().min(1).max(200).optional(),
    line2: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(200).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    postal_code: z.string().trim().min(1).max(20).optional(),
    country: countryCodeParam.optional(),
  })
  .strict();

/** `POST /v1/checkout_sessions/{id}/public` — what the payer changes before confirming. */
export const updateCheckoutSessionPublicParams = z
  .object({
    line_items: z
      .array(
        z
          .object({
            id: checkoutIdParam,
            quantity: z.number().int().min(0).max(CHECKOUT_LIMITS.quantityMax),
          })
          .strict(),
      )
      .max(CHECKOUT_LIMITS.lineItemsMax)
      .optional()
      .describe("Adjust a line's quantity, within its `adjustable_quantity` bounds."),
    promotion_code: z
      .union([z.literal(''), z.string().trim().min(1).max(CATALOG_LIMITS.promotionCodeMax)])
      .optional()
      .describe('A code to redeem (`allow_promotion_codes`), or `""` to remove the one applied.'),
    customer_details: z
      .object({
        email: checkoutEmailParam.optional(),
        name: z.string().trim().min(1).max(200).optional(),
        phone: z
          .string()
          .trim()
          .regex(/^\+?[0-9 ()-]{5,25}$/, 'must be a phone number')
          .optional(),
        address: payerAddressParams.optional(),
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
      .object({ name: z.string().trim().min(1).max(200), address: payerAddressParams })
      .strict()
      .nullable()
      .optional(),
    custom_fields: z
      .array(z.object({ key: z.string().min(1).max(200), value: z.string().max(255) }).strict())
      .max(CHECKOUT_LIMITS.customFieldsMax)
      .optional()
      .describe("By `key`: the payer's value for each custom field."),
    consent: z
      .object({ terms_of_service: z.literal('accepted').optional() })
      .strict()
      .optional(),
  })
  .strict();
export type UpdateCheckoutSessionPublicParams = z.input<typeof updateCheckoutSessionPublicParams>;

/**
 * `POST /v1/checkout_sessions/{id}/public/confirm` — the order is the
 * session's; the payer only chooses how to pay it (ADR 0021 D3).
 */
export const confirmCheckoutSessionPublicParams = z
  .object({
    payment_method_type: z
      .enum(['card', 'faircoin'])
      .optional()
      .describe(
        "How the payer pays: one of the session's `payment_method_types`. Default: the rail of the order's currency (`card` on a fiat order). `faircoin` on a fiat order quotes its total in FAIR for 10 minutes; confirming again with the other method replaces a payment that has not started moving money.",
      ),
    locale: z
      .enum(CHECKOUT_LOCALES)
      .optional()
      .describe(
        "The language the payer is completing checkout in. Recorded on the session (never on its `locale`) and given to a customer checkout creates as its `preferred_locales`; the session's emails are written in it when the customer has no preferred language.",
      ),
  })
  .strict();
export type ConfirmCheckoutSessionPublicParams = z.input<typeof confirmCheckoutSessionPublicParams>;

/** `POST /v1/test_helpers/checkout_sessions/{id}/expire` takes nothing. */
export const expireCheckoutSessionTestHelperParams = z.object({}).strict();

const sessionId = { id: 'The Checkout Session (`cs_…`).' } as const;

const payerAuth =
  "Authorized by the session's `client_secret` (or, for a session wrapping a payment, that payment's) in the `X-Peable-Client-Secret` header — never a URL. Unauthenticated and rate-limited; the answer is `Cache-Control: no-store`.";

export const checkoutSessionRoutes = [
  defineRoute({
    operationId: 'createCheckoutSession',
    method: 'post',
    path: '/v1/checkout_sessions',
    tag: 'Checkout Sessions',
    summary: 'Create a Checkout Session',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createCheckoutSessionParams,
    response: checkoutSessionSchema,
    status: 201,
    sdk: 'checkout.sessions.create',
    expandable: 'checkout_session',
  }),
  defineRoute({
    operationId: 'listCheckoutSessions',
    method: 'get',
    path: '/v1/checkout_sessions',
    tag: 'Checkout Sessions',
    summary: 'List Checkout Sessions',
    auth: 'service',
    scope: 'payments:read',
    query: listCheckoutSessionsQuery,
    response: listOf(checkoutSessionSchema),
    sdk: 'checkout.sessions.list',
    expandable: 'checkout_session',
  }),
  defineRoute({
    operationId: 'retrieveCheckoutSession',
    method: 'get',
    path: '/v1/checkout_sessions/{id}',
    tag: 'Checkout Sessions',
    summary: 'Retrieve a Checkout Session',
    auth: 'service',
    scope: 'payments:read',
    params: sessionId,
    query: expandOnlyQuery,
    response: checkoutSessionSchema,
    sdk: 'checkout.sessions.retrieve',
    expandable: 'checkout_session',
  }),
  defineRoute({
    operationId: 'updateCheckoutSession',
    method: 'post',
    path: '/v1/checkout_sessions/{id}',
    tag: 'Checkout Sessions',
    summary: 'Update a Checkout Session',
    description: '`metadata` only, as a patch.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: sessionId,
    body: updateCheckoutSessionParams,
    response: checkoutSessionSchema,
    sdk: 'checkout.sessions.update',
    expandable: 'checkout_session',
  }),
  defineRoute({
    operationId: 'expireCheckoutSession',
    method: 'post',
    path: '/v1/checkout_sessions/{id}/expire',
    tag: 'Checkout Sessions',
    summary: 'Expire a Checkout Session',
    description: 'An `open` session the payer has not confirmed; it can no longer be completed.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: sessionId,
    body: expireCheckoutSessionParams,
    response: checkoutSessionSchema,
    sdk: 'checkout.sessions.expire',
    expandable: 'checkout_session',
  }),
  defineRoute({
    operationId: 'listCheckoutSessionLineItems',
    method: 'get',
    path: '/v1/checkout_sessions/{id}/line_items',
    tag: 'Checkout Sessions',
    summary: "List a Checkout Session's line items",
    description: "In their order (at most twenty); the cursor is a line's own `li_…`.",
    auth: 'service',
    scope: 'payments:read',
    params: sessionId,
    query: listCheckoutSessionLineItemsQuery,
    response: listOf(checkoutLineItemSchema),
    sdk: 'checkout.sessions.listLineItems',
    expandable: 'item',
  }),
  defineRoute({
    operationId: 'retrieveCheckoutSessionPublic',
    method: 'get',
    path: '/v1/checkout_sessions/{id}/public',
    tag: 'Checkout Sessions',
    summary: 'Retrieve a Checkout Session as its payer',
    description: payerAuth,
    auth: 'public',
    params: sessionId,
    response: checkoutSessionPublicSchema,
  }),
  defineRoute({
    operationId: 'updateCheckoutSessionPublic',
    method: 'post',
    path: '/v1/checkout_sessions/{id}/public',
    tag: 'Checkout Sessions',
    summary: 'Update a Checkout Session as its payer',
    description: `Quantities, promotion code, the payer's details. ${payerAuth}`,
    auth: 'public',
    params: sessionId,
    body: updateCheckoutSessionPublicParams,
    response: checkoutSessionPublicSchema,
  }),
  defineRoute({
    operationId: 'confirmCheckoutSessionPublic',
    method: 'post',
    path: '/v1/checkout_sessions/{id}/public/confirm',
    tag: 'Checkout Sessions',
    summary: 'Confirm a Checkout Session as its payer',
    description: `Locks the order and creates its payment (or setup): the answer carries \`payment_intent\` / \`setup_intent\`. Resolving is not completion — \`complete\` is only ever what the gateway says. ${payerAuth}`,
    auth: 'public',
    params: sessionId,
    body: confirmCheckoutSessionPublicParams,
    response: checkoutSessionPublicSchema,
  }),
  defineRoute({
    operationId: 'expireCheckoutSessionTestHelper',
    method: 'post',
    path: '/v1/test_helpers/checkout_sessions/{id}/expire',
    tag: 'Test helpers',
    summary: 'Expire a test-mode Checkout Session now',
    description:
      'A session nobody confirmed expires on its own deadline; one around a payment expires with that payment, in the same transition.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    testModeOnly: true,
    params: sessionId,
    body: expireCheckoutSessionTestHelperParams,
    response: checkoutSessionSchema,
    sdk: 'testHelpers.checkoutSessions.expire',
  }),
] as const;
