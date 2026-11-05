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
 * Refunds (`re_…`) and the settlement figures of a payment, a refund or a
 * dispute. The provider's own
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
 * One movement of the settlement balance, as the PROVIDER reports it: what a
 * payment brought in (`GET /v1/payment_intents/{intentId}/settlement`), what a
 * refund took out (`GET /v1/refunds/{id}/settlement`) or what a dispute
 * withdrew (`GET /v1/disputes/{disputeId}/settlement`). `refund` and `dispute`
 * say which: both `null` for a payment's.
 *
 * Every figure is nullable and that is the contract: "the fee was zero" and
 * "the fee is not known yet" are different facts, and `status` says which
 * produced the nulls. It reports what the provider took; it attributes that
 * cost to nobody.
 *
 * The signs: `gross` is the MAGNITUDE of the movement, `fee` the provider's fee
 * on it (positive when charged, negative when returned), `net` its SIGNED
 * effect on the balance — so `net = gross − fee` for a payment and
 * `net = −gross − fee` for a refund or a dispute.
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
        'The `pi_…` this describes (the refunded or disputed payment, for a refund or a dispute), or the PaymentIntent with `expand[]=payment_intent`.',
      ),
      refund: expandable(
        'refund',
        'The `re_…` whose movement this is, or the Refund with `expand[]=refund`; `null` unless this is the settlement of a refund.',
      ).nullable(),
      dispute: expandable(
        'dispute',
        'The `dp_…` whose withdrawal this is, or the Dispute with `expand[]=dispute`; `null` unless this is the settlement of a dispute.',
      ).nullable(),
      status: z
        .enum(SETTLEMENT_STATUSES)
        .describe(
          '`available`: settled, the figures are final; `pending`: not final yet; `unknown`: there is none to read — **not zero**. A dispute inquiry, which moves no money, and a refund that failed or was canceled are `unknown`.',
        ),
      gross: amount
        .nullable()
        .describe(
          'The MAGNITUDE of the movement, never negative, in base units of `currency`: what the payment brought in, the refund took out or the dispute withdrew.',
        ),
      fee: signedAmount
        .nullable()
        .describe(
          "The provider's fee on THIS movement, as the provider signs it: positive when charged to the balance (a payment's processing fee, a dispute fee), negative when returned to it (part of the original fee on some refunds). A refund's is usually `0`.",
        ),
      net: signedAmount
        .nullable()
        .describe(
          'The SIGNED effect on the balance: positive for a payment, negative for a refund or a dispute. Always `gross − fee` for a payment and `−gross − fee` for a refund or a dispute.',
        ),
      currency: nullableString.describe(
        "The SETTLEMENT currency (uppercase ISO 4217) every figure is in, which may differ from the payment's, refund's or dispute's.",
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
    operationId: 'retrieveRefundSettlement',
    method: 'get',
    path: '/v1/refunds/{id}/settlement',
    tag: 'Refunds',
    summary: "Retrieve a refund's settlement",
    description:
      'What the refund took off the settlement balance — `gross`, `fee`, a negative `net` — in the settlement currency, read live from the provider. A missing figure is `null` with a `status`, never `0`; a refund that failed or was canceled is `unknown`.',
    auth: 'service',
    scope: 'payments:read',
    params: refundId,
    query: expandOnlyQuery,
    response: settlementSchema,
    sdk: 'refunds.refundSettlement',
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
