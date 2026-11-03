import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import { emptyQuery, expandOnlyQuery, idParam, listQuery } from '../../common/params';
import { amount, livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';

/**
 * Application fees (`fee_…`, ADR 0015 §3) — Orbit's fee on one payment, taken
 * by the provider from the merchant's account when the charge succeeded.
 * Created from the provider's own record, never computed after the fact, and
 * refunded through `POST /v1/refunds` with `refund_application_fee`.
 */

/** A refund of an application fee (`fr_…`). */
export const feeRefundSchema = defineObject(
  'fee_refund',
  'FeeRefund',
  z
    .object({
      id: z.string(),
      object: z.literal('fee_refund'),
      amount,
      currency: z.string(),
      fee: z.string().describe('The `fee_…` it refunds.'),
      created: unixSeconds,
    })
    .strict(),
);
export type FeeRefund = Expand<z.output<typeof feeRefundSchema>>;

export const applicationFeeSchema = defineObject(
  'application_fee',
  'ApplicationFee',
  z
    .object({
      id: z.string(),
      object: z.literal('application_fee'),
      livemode,
      account: z.string().describe('The account (`ca_…`) the fee was taken from.'),
      amount,
      amount_refunded: amount,
      currency: z.string(),
      charge: z
        .string()
        .nullable()
        .describe('The `ch_…` it was taken on, when Orbit holds the charge.'),
      payment_intent: z.string().describe('The `pi_…` it was taken on.'),
      refunded: z.boolean().describe('Refunded in full.'),
      refunds: listOf(feeRefundSchema).describe('Every refund of the fee: a complete set.'),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'fee_0193b8f32b7f4d0e8a15',
        object: 'application_fee',
        livemode: false,
        account: 'ca_0193b8f2c1a87d3e9f4a',
        amount: '60',
        amount_refunded: '0',
        currency: 'EUR',
        charge: 'ch_0193b8f2f7c94b1d8e02',
        payment_intent: 'pi_0193b8f2e8a14f6c9d31',
        refunded: false,
        refunds: {
          object: 'list',
          data: [],
          has_more: false,
          url: '/v1/application_fees/fee_0193b8f32b7f4d0e8a15/refunds',
        },
        created: 1793750400,
      },
    ],
  },
);
export type ApplicationFee = Expand<z.output<typeof applicationFeeSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    application_fee: ApplicationFee;
    fee_refund: FeeRefund;
  }
}

export const listApplicationFeesQuery = listQuery({
  payment_intent: idParam.optional().describe('Only the fee taken on this payment (`pi_…`).'),
});
export type ListApplicationFeesParams = z.input<typeof listApplicationFeesQuery>;

const feeIdParam = { id: 'The application fee (`fee_…`).' } as const;

export const applicationFeeRoutes = [
  defineRoute({
    operationId: 'listApplicationFees',
    method: 'get',
    path: '/v1/application_fees',
    tag: 'Application fees',
    summary: 'List application fees',
    auth: 'service',
    scope: 'payments:read',
    query: listApplicationFeesQuery,
    response: listOf(applicationFeeSchema),
    sdk: 'applicationFees.list',
    expandable: 'application_fee',
  }),
  defineRoute({
    operationId: 'retrieveApplicationFee',
    method: 'get',
    path: '/v1/application_fees/{id}',
    tag: 'Application fees',
    summary: 'Retrieve an application fee',
    auth: 'service',
    scope: 'payments:read',
    params: feeIdParam,
    query: expandOnlyQuery,
    response: applicationFeeSchema,
    sdk: 'applicationFees.retrieve',
  }),
  defineRoute({
    operationId: 'listApplicationFeeRefunds',
    method: 'get',
    path: '/v1/application_fees/{id}/refunds',
    tag: 'Application fees',
    summary: "List an application fee's refunds",
    description:
      'A complete set (`has_more: false`): one refund per partial refund of the payment.',
    auth: 'service',
    scope: 'payments:read',
    params: feeIdParam,
    query: emptyQuery,
    response: listOf(feeRefundSchema),
    sdk: 'applicationFees.listRefunds',
  }),
] as const;
