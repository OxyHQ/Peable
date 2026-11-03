import { z } from 'zod';
import { deletedOf, listOf, searchResultOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  rangeParam,
  searchQuery,
  unixSecondsParam,
} from '../../common/params';
import { currency, livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  COLLECTION_METHODS,
  CREATE_PRORATION_BEHAVIORS,
  PAUSE_COLLECTION_BEHAVIORS,
  PAYMENT_BEHAVIORS,
  PRORATION_BEHAVIORS,
  RESUME_BILLING_CYCLE_ANCHORS,
  SUBSCRIPTION_CANCELLATION_REASONS,
  SUBSCRIPTION_LIST_STATUSES,
  SUBSCRIPTION_STATUSES,
  TRIAL_END_BEHAVIORS,
} from '../../vocabulary/subscriptions';
import {
  automaticTaxParam,
  daysUntilDueParam,
  discountsParam,
  embedded,
  quantityParam,
  shortText,
} from './params';

export type { DiscountParams } from './params';

/**
 * Subscriptions (`sub_…`) and their items (`si_…`) — Orbit's native billing
 * engine (ADR 0018 §1). Stripe's object model on Peable's wire (ADR 0014 D1):
 * snake_case, Unix seconds, `livemode`, every amount a base-unit string.
 */

/** A discount applied to a subscription or an invoice. */
export const discountSchema = defineComponent(
  'Discount',
  z
    .object({
      object: z.literal('discount'),
      coupon: z.string().describe('The coupon applied.'),
      promotion_code: z
        .string()
        .nullable()
        .describe('The promotion code (`promo_…`) it was redeemed through, if any.'),
      start: unixSeconds.describe('When it started applying.'),
      end: unixSeconds
        .nullable()
        .describe('When it stops (a `repeating` coupon); `null` for `once` and `forever`.'),
    })
    .strict(),
);
export type Discount = z.output<typeof discountSchema>;

/** One line of a subscription: a price and a quantity. */
export const subscriptionItemSchema = defineObject(
  'subscription_item',
  'SubscriptionItem',
  z
    .object({
      id: z.string(),
      object: z.literal('subscription_item'),
      livemode,
      subscription: z.string().describe('The subscription (`sub_…`) it belongs to.'),
      price: embedded('price', 'The Price, always embedded (Stripe’s shape).'),
      quantity: z.number().int().nonnegative(),
      metadata,
      created: unixSeconds,
    })
    .strict(),
);
export type SubscriptionItem = Expand<z.output<typeof subscriptionItemSchema>>;

/** What `DELETE /v1/subscription_items/:id` answers. */
export const deletedSubscriptionItemSchema = defineComponent(
  'DeletedSubscriptionItem',
  deletedOf('subscription_item'),
);
export type DeletedSubscriptionItem = z.output<typeof deletedSubscriptionItemSchema>;

export const subscriptionSchema = defineObject(
  'subscription',
  'Subscription',
  z
    .object({
      id: z.string(),
      object: z.literal('subscription'),
      livemode,
      customer: expandable('customer', '`cus_…`, or the Customer with `expand[]=customer`.'),
      status: z.enum(SUBSCRIPTION_STATUSES),
      currency,
      items: listOf(subscriptionItemSchema).describe('Every live item, on one page.'),
      collection_method: z.enum(COLLECTION_METHODS),
      days_until_due: z
        .number()
        .int()
        .nullable()
        .describe("`send_invoice` only: days from finalization to the invoice's due date."),
      default_payment_method: expandable(
        'payment_method',
        '`pm_…`, or the PaymentMethod with `expand[]=default_payment_method`.',
      ).nullable(),
      description: z.string().nullable(),
      billing_cycle_anchor: unixSeconds,
      current_period_start: unixSeconds,
      current_period_end: unixSeconds,
      start_date: unixSeconds,
      trial_start: unixSeconds.nullable(),
      trial_end: unixSeconds.nullable(),
      trial_settings: z
        .object({
          end_behavior: z.object({ missing_payment_method: z.enum(TRIAL_END_BEHAVIORS) }).strict(),
        })
        .strict(),
      cancel_at_period_end: z.boolean(),
      cancel_at: unixSeconds.nullable(),
      canceled_at: unixSeconds.nullable(),
      ended_at: unixSeconds.nullable(),
      cancellation_details: z
        .object({
          reason: z.enum(SUBSCRIPTION_CANCELLATION_REASONS).nullable(),
          comment: z.string().nullable(),
        })
        .strict(),
      pause_collection: z
        .object({
          behavior: z.enum(PAUSE_COLLECTION_BEHAVIORS),
          resumes_at: unixSeconds.nullable(),
        })
        .strict()
        .nullable(),
      automatic_tax: z.object({ enabled: z.boolean() }).strict(),
      discount: discountSchema.nullable(),
      latest_invoice: expandable(
        'invoice',
        '`in_…`, or the Invoice with `expand[]=latest_invoice`.',
      ).nullable(),
      test_clock: z
        .string()
        .nullable()
        .describe('The test clock (`clock_…`) the customer is attached to; test mode only.'),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'sub_0193b8f2c1a87d3e9f4a',
        object: 'subscription',
        livemode: false,
        customer: 'cus_0193b8f2c1a87d3e9f4a',
        status: 'active',
        currency: 'EUR',
        items: {
          object: 'list',
          data: [],
          has_more: false,
          url: '/v1/subscription_items?subscription=sub_0193b8f2c1a87d3e9f4a',
        },
        collection_method: 'charge_automatically',
        days_until_due: null,
        default_payment_method: 'pm_0193b8f2c1a87d3e9f4a',
        description: null,
        billing_cycle_anchor: 1793750400,
        current_period_start: 1793750400,
        current_period_end: 1796428800,
        start_date: 1793750400,
        trial_start: null,
        trial_end: null,
        trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
        cancel_at_period_end: false,
        cancel_at: null,
        canceled_at: null,
        ended_at: null,
        cancellation_details: { reason: null, comment: null },
        pause_collection: null,
        automatic_tax: { enabled: false },
        discount: null,
        latest_invoice: 'in_0193b8f2c1a87d3e9f4a',
        test_clock: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type Subscription = Expand<z.output<typeof subscriptionSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    subscription: Subscription;
    subscription_item: SubscriptionItem;
  }
}

// ---- Requests ------------------------------------------------------------------------

/** `trial_end`: Unix seconds, or `'now'` to end the trial at once. */
const trialEndParam = z.union([unixSecondsParam, z.literal('now')]);

/**
 * An item's metadata in `items[]` of an update and on an item update: the
 * named keys are set on the item (a merge, never an unset).
 */
const itemMetadataParam = z.record(z.string().max(40), z.string().max(500));

const createSubscriptionItemEntry = z
  .object({
    price: idParam,
    quantity: quantityParam.optional(),
    metadata: metadataCreateParam.optional(),
  })
  .strict();

export const createSubscriptionParams = z
  .object({
    customer: idParam,
    items: z.array(createSubscriptionItemEntry).min(1).max(20),
    default_payment_method: idParam.optional(),
    collection_method: z.enum(COLLECTION_METHODS).optional(),
    days_until_due: daysUntilDueParam.optional(),
    description: shortText(500).optional(),
    trial_period_days: z.number().int().min(1).max(730).optional(),
    trial_end: trialEndParam.optional(),
    trial_settings: z
      .object({
        end_behavior: z.object({ missing_payment_method: z.enum(TRIAL_END_BEHAVIORS) }).strict(),
      })
      .strict()
      .optional(),
    billing_cycle_anchor: unixSecondsParam.optional(),
    proration_behavior: z.enum(CREATE_PRORATION_BEHAVIORS).optional(),
    cancel_at_period_end: z.boolean().optional(),
    cancel_at: unixSecondsParam.optional(),
    coupon: idParam.optional(),
    promotion_code: idParam.optional(),
    discounts: discountsParam.optional(),
    payment_behavior: z.enum(PAYMENT_BEHAVIORS).optional(),
    automatic_tax: automaticTaxParam.optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateSubscriptionParams = z.input<typeof createSubscriptionParams>;

/** A subscription item as `items[]` of an update names it. */
const updateSubscriptionItemEntry = z
  .object({
    id: idParam.optional().describe('The `si_…` to change or remove; absent, a new item.'),
    price: idParam.optional(),
    quantity: quantityParam.optional(),
    deleted: z.boolean().optional().describe('Remove this item.'),
    metadata: itemMetadataParam.optional(),
  })
  .strict();
export type SubscriptionItemParams = z.input<typeof updateSubscriptionItemEntry>;

/** A field sent as `""` is cleared; `metadata` is a patch. */
export const updateSubscriptionParams = z
  .object({
    items: z.array(updateSubscriptionItemEntry).min(1).max(20).optional(),
    proration_behavior: z.enum(PRORATION_BEHAVIORS).optional(),
    proration_date: unixSecondsParam
      .optional()
      .describe('The instant prorations are computed at; defaults to now.'),
    default_payment_method: z.union([idParam, z.literal('')]).optional(),
    collection_method: z.enum(COLLECTION_METHODS).optional(),
    days_until_due: daysUntilDueParam.optional(),
    description: z.union([shortText(500), z.literal('')]).optional(),
    cancel_at_period_end: z.boolean().optional(),
    cancel_at: z.union([unixSecondsParam, z.literal('')]).optional(),
    pause_collection: z
      .union([
        z
          .object({
            behavior: z.enum(PAUSE_COLLECTION_BEHAVIORS),
            resumes_at: unixSecondsParam.optional(),
          })
          .strict(),
        z.literal(''),
      ])
      .optional()
      .describe('`""` resumes collection.'),
    trial_end: trialEndParam.optional(),
    coupon: z.union([idParam, z.literal('')]).optional(),
    promotion_code: idParam.optional(),
    discounts: z.union([discountsParam, z.literal('')]).optional(),
    payment_behavior: z.enum(PAYMENT_BEHAVIORS).optional(),
    automatic_tax: automaticTaxParam.optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateSubscriptionParams = z.input<typeof updateSubscriptionParams>;

/** `DELETE /v1/subscriptions/:id`: cancel now. */
export const cancelSubscriptionParams = z
  .object({
    invoice_now: z
      .boolean()
      .optional()
      .describe('Bill pending items and prorations now, in a final invoice.'),
    prorate: z.boolean().optional().describe('Credit the unused time of the current period.'),
    cancellation_details: z
      .object({ comment: shortText(5000).optional() })
      .strict()
      .optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CancelSubscriptionParams = z.input<typeof cancelSubscriptionParams>;

/** `POST /v1/subscriptions/:id/resume` — a `paused` subscription. */
export const resumeSubscriptionParams = z
  .object({
    billing_cycle_anchor: z
      .enum(RESUME_BILLING_CYCLE_ANCHORS)
      .optional()
      .describe('`now` (default) starts a new period at once; `unchanged` keeps the anchor.'),
    proration_behavior: z.enum(PRORATION_BEHAVIORS).optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type ResumeSubscriptionParams = z.input<typeof resumeSubscriptionParams>;

export const listSubscriptionsQuery = listQuery({
  customer: idParam.optional(),
  price: idParam.optional(),
  status: z
    .enum(SUBSCRIPTION_LIST_STATUSES)
    .optional()
    .describe(
      'A status, `all` (including canceled), or `ended` (canceled and incomplete_expired).',
    ),
  test_clock: idParam.optional(),
  current_period_end: rangeParam.optional(),
});
export type SubscriptionListParams = z.input<typeof listSubscriptionsQuery>;

export const createSubscriptionItemParams = z
  .object({
    subscription: idParam,
    price: idParam,
    quantity: quantityParam.optional(),
    proration_behavior: z.enum(PRORATION_BEHAVIORS).optional(),
    proration_date: unixSecondsParam.optional(),
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateSubscriptionItemParams = z.input<typeof createSubscriptionItemParams>;

export const updateSubscriptionItemParams = z
  .object({
    price: idParam.optional(),
    quantity: quantityParam.optional(),
    proration_behavior: z.enum(PRORATION_BEHAVIORS).optional(),
    proration_date: unixSecondsParam.optional(),
    metadata: itemMetadataParam.optional(),
  })
  .strict();
export type UpdateSubscriptionItemParams = z.input<typeof updateSubscriptionItemParams>;

export const deleteSubscriptionItemParams = z
  .object({
    proration_behavior: z.enum(PRORATION_BEHAVIORS).optional(),
    proration_date: unixSecondsParam.optional(),
  })
  .strict();
export type DeleteSubscriptionItemParams = z.input<typeof deleteSubscriptionItemParams>;

/** `subscription` is REQUIRED: items are listed per subscription. */
export const listSubscriptionItemsQuery = listQuery({
  subscription: idParam.describe('The subscription (`sub_…`) whose items to list.'),
});
export type SubscriptionItemListParams = z.input<typeof listSubscriptionItemsQuery>;

// ---- Routes --------------------------------------------------------------------------

const subscriptionId = { id: 'The subscription (`sub_…`).' } as const;
const itemId = { id: 'The subscription item (`si_…`).' } as const;

export const subscriptionRoutes = [
  defineRoute({
    operationId: 'createSubscription',
    method: 'post',
    path: '/v1/subscriptions',
    tag: 'Subscriptions',
    summary: 'Create a subscription',
    description:
      '`payment_behavior` decides what happens when the first invoice cannot be paid at once.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createSubscriptionParams,
    response: subscriptionSchema,
    sdk: 'subscriptions.create',
    expandable: 'subscription',
  }),
  defineRoute({
    operationId: 'listSubscriptions',
    method: 'get',
    path: '/v1/subscriptions',
    tag: 'Subscriptions',
    summary: 'List subscriptions',
    description: 'Newest first. Without `status`, every subscription but the canceled ones.',
    auth: 'service',
    scope: 'payments:read',
    query: listSubscriptionsQuery,
    response: listOf(subscriptionSchema),
    sdk: 'subscriptions.list',
    expandable: 'subscription',
  }),
  defineRoute({
    operationId: 'retrieveSubscription',
    method: 'get',
    path: '/v1/subscriptions/{id}',
    tag: 'Subscriptions',
    summary: 'Retrieve a subscription',
    auth: 'service',
    scope: 'payments:read',
    params: subscriptionId,
    query: expandOnlyQuery,
    response: subscriptionSchema,
    sdk: 'subscriptions.retrieve',
    expandable: 'subscription',
  }),
  defineRoute({
    operationId: 'updateSubscription',
    method: 'post',
    path: '/v1/subscriptions/{id}',
    tag: 'Subscriptions',
    summary: 'Update a subscription',
    description:
      'Items, plan changes (prorated as `proration_behavior` says), collection, trial, cancellation at period end, pausing and discounts. A field sent as `""` is cleared; `metadata` is a patch.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: subscriptionId,
    body: updateSubscriptionParams,
    response: subscriptionSchema,
    sdk: 'subscriptions.update',
    expandable: 'subscription',
  }),
  defineRoute({
    operationId: 'cancelSubscription',
    method: 'delete',
    path: '/v1/subscriptions/{id}',
    tag: 'Subscriptions',
    summary: 'Cancel a subscription',
    description:
      'Now, optionally prorating the unused time and invoicing at once. Answers the canceled subscription.',
    auth: 'service',
    scope: 'payments:write',
    params: subscriptionId,
    body: cancelSubscriptionParams,
    response: subscriptionSchema,
    sdk: 'subscriptions.cancel',
    expandable: 'subscription',
  }),
  defineRoute({
    operationId: 'resumeSubscription',
    method: 'post',
    path: '/v1/subscriptions/{id}/resume',
    tag: 'Subscriptions',
    summary: 'Resume a paused subscription',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: subscriptionId,
    body: resumeSubscriptionParams,
    response: subscriptionSchema,
    sdk: 'subscriptions.resume',
    expandable: 'subscription',
  }),
  defineRoute({
    operationId: 'searchSubscriptions',
    method: 'get',
    path: '/v1/subscriptions/search',
    tag: 'Subscriptions',
    summary: 'Search subscriptions',
    description: "Stripe's query language over the subscription's fields and `metadata['key']`.",
    auth: 'service',
    scope: 'payments:read',
    query: searchQuery,
    response: searchResultOf(subscriptionSchema),
    sdk: 'subscriptions.search',
    expandable: 'subscription',
  }),
  defineRoute({
    operationId: 'createSubscriptionItem',
    method: 'post',
    path: '/v1/subscription_items',
    tag: 'Subscription items',
    summary: 'Add an item to a subscription',
    description: 'Prorated as `proration_behavior` says.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createSubscriptionItemParams,
    response: subscriptionItemSchema,
    sdk: 'subscriptionItems.create',
  }),
  defineRoute({
    operationId: 'listSubscriptionItems',
    method: 'get',
    path: '/v1/subscription_items',
    tag: 'Subscription items',
    summary: "List a subscription's items",
    auth: 'service',
    scope: 'payments:read',
    query: listSubscriptionItemsQuery,
    response: listOf(subscriptionItemSchema),
    sdk: 'subscriptionItems.list',
    expandable: 'subscription_item',
  }),
  defineRoute({
    operationId: 'retrieveSubscriptionItem',
    method: 'get',
    path: '/v1/subscription_items/{id}',
    tag: 'Subscription items',
    summary: 'Retrieve a subscription item',
    auth: 'service',
    scope: 'payments:read',
    params: itemId,
    query: expandOnlyQuery,
    response: subscriptionItemSchema,
    sdk: 'subscriptionItems.retrieve',
    expandable: 'subscription_item',
  }),
  defineRoute({
    operationId: 'updateSubscriptionItem',
    method: 'post',
    path: '/v1/subscription_items/{id}',
    tag: 'Subscription items',
    summary: 'Update a subscription item',
    description: 'Its price or quantity, prorated as `proration_behavior` says.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: itemId,
    body: updateSubscriptionItemParams,
    response: subscriptionItemSchema,
    sdk: 'subscriptionItems.update',
  }),
  defineRoute({
    operationId: 'deleteSubscriptionItem',
    method: 'delete',
    path: '/v1/subscription_items/{id}',
    tag: 'Subscription items',
    summary: 'Remove an item from a subscription',
    description: 'Prorated as `proration_behavior` says.',
    auth: 'service',
    scope: 'payments:write',
    params: itemId,
    body: deleteSubscriptionItemParams,
    response: deletedSubscriptionItemSchema,
    sdk: 'subscriptionItems.del',
  }),
] as const;
