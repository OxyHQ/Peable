import { z } from 'zod';
import { listOf, searchResultOf } from '../../common/envelopes';
import { defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  searchQuery,
} from '../../common/params';
import {
  amount,
  currency,
  livemode,
  metadata,
  nullableString,
  signedAmount,
  unixSeconds,
} from '../../common/primitives';
import { defineRoute } from '../../route';
import { isBaseUnitString } from '../../vocabulary/money';
import {
  REFUND_ORIGINS,
  REFUND_REASONS,
  REFUND_STATUSES,
  SETTLEMENT_STATUSES,
} from '../../vocabulary/payments';

/**
 * Refunds (`re_…`) and a payment's settlement figures. The provider's own
 * refund id never appears: a merchant integrates against Peable and never
 * learns which acquirer sat behind it (ADR 0001 D3).
 */

export const refundSchema = defineObject(
  'refund',
  'Refund',
  z
    .object({
      id: z.string(),
      object: z.literal('refund'),
      livemode,
      external_ref: nullableString.describe(
        "YOUR id for this refund (its idempotency); `null` on a refund imported from the provider (`origin: 'provider'`).",
      ),
      origin: z
        .enum(REFUND_ORIGINS)
        .describe(
          '`provider`: it appeared at the acquirer (a dashboard refund, a dispute resolved) and was imported.',
        ),
      payment_intent: expandable(
        'payment_intent',
        'The refunded payment (`pi_…`), or the PaymentIntent with `expand[]=payment_intent`.',
      ),
      amount,
      currency,
      status: z
        .enum(REFUND_STATUSES)
        .describe(
          "The MONEY's own lifecycle: a bank can reject a refund days later (`failed`); `canceled` only through `POST /v1/refunds/{id}/cancel`.",
        ),
      reason: z.enum(REFUND_REASONS).nullable(),
      failure_code: nullableString.describe(
        "The provider's machine-readable reason, when it failed.",
      ),
      metadata,
      created: unixSeconds,
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 're_0193b8f2c1a87d3e9f4a',
        object: 'refund',
        livemode: false,
        external_ref: 'order_6735_refund_1',
        origin: 'merchant',
        payment_intent: 'pi_0193b8f2c1a87d3e9f4a',
        amount: '1000',
        currency: 'EUR',
        status: 'succeeded',
        reason: 'requested_by_customer',
        failure_code: null,
        metadata: {},
        created: 1793750400,
        updated_at: 1793750460,
      },
    ],
  },
);
export type Refund = Expand<z.output<typeof refundSchema>>;

/**
 * What a payment actually came to, as the PROVIDER reports it. Every figure is
 * nullable and that is the contract: "the fee was zero" and "the fee is not
 * known yet" are different facts, and `status` says which produced the nulls.
 * It reports what the provider took; it attributes that cost to nobody.
 */
export const settlementSchema = defineObject(
  'settlement',
  'Settlement',
  z
    .object({
      object: z.literal('settlement'),
      livemode,
      payment_intent: expandable(
        'payment_intent',
        'The `pi_…` this describes, or the PaymentIntent with `expand[]=payment_intent`.',
      ),
      status: z
        .enum(SETTLEMENT_STATUSES)
        .describe(
          '`available`: settled, the figures are final; `pending`: not final yet; `unknown`: there is none to read — **not zero**.',
        ),
      gross: amount.nullable().describe('Base units of `currency`.'),
      fee: amount.nullable(),
      net: signedAmount.nullable(),
      currency: nullableString.describe(
        "The SETTLEMENT currency (uppercase ISO 4217), which may differ from the payment's.",
      ),
      available_on: unixSeconds.nullable().describe('When the funds become available.'),
      exchange_rate: z
        .number()
        .nullable()
        .describe('Present only when a conversion happened. `null` is not a rate of 1.'),
    })
    .strict(),
);
export type Settlement = Expand<z.output<typeof settlementSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    refund: Refund;
    settlement: Settlement;
  }
}

export const createRefundParams = z
  .object({
    payment_intent: z.string().min(1).describe('The `pi_…` being refunded.'),
    external_ref: z
      .string()
      .min(1)
      .max(255)
      .describe('YOUR id for this refund. The idempotency: the same ref answers the same refund.'),
    // A zero refund is refused separately: `'0'` is a canonical integer string,
    // and a zero refund would consume the merchant's `external_ref` so the REAL
    // refund for that order could never be created afterwards.
    amount: z
      .string()
      .refine(isBaseUnitString, 'amount must be a canonical integer string in minor units')
      .refine((value) => value !== '0', 'a refund of 0 is not a refund')
      .describe('Base units, as a canonical integer string. Zero is refused.'),
    reason: z.enum(REFUND_REASONS).optional(),
    metadata: metadataCreateParam.optional(),
    refund_application_fee: z
      .boolean()
      .optional()
      .describe("Also refund Orbit's application fee, in proportion (a destination charge)."),
    reverse_transfer: z
      .boolean()
      .optional()
      .describe('Also reverse the transfer to the destination account, in proportion.'),
  })
  .strict();
export type CreateRefundParams = z.input<typeof createRefundParams>;

/** The merchant's own bookkeeping on a refund: `metadata`, a patch. */
export const updateRefundParams = z.object({ metadata: metadataUpdateParam.optional() }).strict();
export type UpdateRefundParams = z.input<typeof updateRefundParams>;

export const cancelRefundParams = z.object({}).strict();

export const listRefundsQuery = listQuery({
  payment_intent: idParam.optional().describe("Only this payment's refunds (`pi_…`)."),
});
export type ListRefundsParams = z.input<typeof listRefundsQuery>;

/** The per-payment sub-list: the payment is in the path. */
export const listPaymentIntentRefundsQuery = listQuery({});

/**
 * A payment's refunds, with what is still refundable beside the envelope — the
 * figure every merchant would otherwise compute by summing the list, and get
 * wrong by counting a `pending` or `failed` refund.
 */
export const paymentIntentRefundListSchema = listOf(refundSchema).extend({
  remaining_refundable: amount.describe(
    'What can still be refunded on this payment, in base units. The same on every page.',
  ),
});
export type PaymentIntentRefundList = Expand<z.output<typeof paymentIntentRefundListSchema>>;

const refundId = { id: 'The refund (`re_…`).' };
const intentId = { intentId: 'The payment intent (`pi_…`).' };

export const refundRoutes = [
  defineRoute({
    operationId: 'createRefund',
    method: 'post',
    path: '/v1/refunds',
    tag: 'Refunds',
    summary: 'Create a refund',
    description:
      '`external_ref` decides whether money moves twice: a retry with the same ref answers the refund it made (200) whatever is still refundable.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createRefundParams,
    response: refundSchema,
    status: 201,
    sdk: 'refunds.create',
  }),
  defineRoute({
    operationId: 'listRefunds',
    method: 'get',
    path: '/v1/refunds',
    tag: 'Refunds',
    summary: 'List refunds',
    description:
      "Every refund of the merchant, or of one payment — including those made outside Peable (`origin: 'provider'`).",
    auth: 'service',
    scope: 'payments:read',
    query: listRefundsQuery,
    response: listOf(refundSchema),
    sdk: 'refunds.list',
    expandable: 'refund',
  }),
  defineRoute({
    operationId: 'retrieveRefund',
    method: 'get',
    path: '/v1/refunds/{id}',
    tag: 'Refunds',
    summary: 'Retrieve a refund',
    auth: 'service',
    scope: 'payments:read',
    params: refundId,
    query: expandOnlyQuery,
    response: refundSchema,
    sdk: 'refunds.retrieve',
    expandable: 'refund',
  }),
  defineRoute({
    operationId: 'updateRefund',
    method: 'post',
    path: '/v1/refunds/{id}',
    tag: 'Refunds',
    summary: 'Update a refund',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: refundId,
    body: updateRefundParams,
    response: refundSchema,
    sdk: 'refunds.update',
  }),
  defineRoute({
    operationId: 'cancelRefund',
    method: 'post',
    path: '/v1/refunds/{id}/cancel',
    tag: 'Refunds',
    summary: 'Cancel a refund',
    description: 'Only while the provider still holds it; otherwise 400 `refund_not_cancelable`.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: refundId,
    body: cancelRefundParams,
    response: refundSchema,
    sdk: 'refunds.cancel',
  }),
  defineRoute({
    operationId: 'listPaymentIntentRefunds',
    method: 'get',
    path: '/v1/payment_intents/{intentId}/refunds',
    tag: 'Refunds',
    summary: "List a payment's refunds",
    auth: 'service',
    scope: 'payments:read',
    params: intentId,
    query: listPaymentIntentRefundsQuery,
    response: paymentIntentRefundListSchema,
    sdk: 'refunds.listForPaymentIntent',
    expandable: 'refund',
  }),
  defineRoute({
    operationId: 'retrievePaymentIntentSettlement',
    method: 'get',
    path: '/v1/payment_intents/{intentId}/settlement',
    tag: 'Refunds',
    summary: "Retrieve a payment's settlement",
    description:
      'Gross, fee and net, read live from the provider. A missing figure is `null` with a `status`, never `0`.',
    auth: 'service',
    scope: 'payments:read',
    params: intentId,
    query: expandOnlyQuery,
    response: settlementSchema,
    sdk: 'refunds.settlement',
    expandable: 'settlement',
  }),
  defineRoute({
    operationId: 'searchRefunds',
    method: 'get',
    path: '/v1/refunds/search',
    tag: 'Refunds',
    summary: 'Search refunds',
    description:
      "Stripe's query language over `amount`, `currency`, `status`, `reason`, `payment_intent`, `created` and `metadata['key']`.",
    auth: 'service',
    scope: 'payments:read',
    query: searchQuery,
    response: searchResultOf(refundSchema),
    sdk: 'refunds.search',
    expandable: 'refund',
  }),
] as const;
