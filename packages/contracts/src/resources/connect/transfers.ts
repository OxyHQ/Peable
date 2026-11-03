import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import { expandOnlyQuery, idParam, listQuery } from '../../common/params';
import { amount, livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TRANSFER_REVERSAL_STATUSES, TRANSFER_STATUSES } from '../../vocabulary/connect';
import { isBaseUnitString } from '../../vocabulary/money';

/**
 * Transfers (`tr_…`) — a marketplace settling one seller out of a funded
 * payment — and their reversals.
 *
 * The amounts come from the merchant and are recorded, never computed: Peable
 * does not know what a marketplace fee is. The provider's own transfer id never
 * crosses (ADR 0001 D3).
 */

export const transferSchema = defineObject(
  'transfer',
  'Transfer',
  z
    .object({
      id: z.string(),
      object: z.literal('transfer'),
      livemode,
      external_ref: z
        .string()
        .describe("The merchant's OWN id for what this settles. Their idempotency."),
      connected_account: expandable(
        'connected_account',
        "The seller's `ca_…` — never their account id at the provider — or the ConnectedAccount with `expand[]=connected_account`.",
      ),
      payment_intent: expandable(
        'payment_intent',
        'The `pi_…` this settlement was funded by, or the PaymentIntent with `expand[]=payment_intent`.',
      ),
      amount,
      currency: z.string(),
      amount_reversed: amount.describe(
        "CUMULATIVE, in the units of `amount` — the provider's own total, never a sum of the reversals.",
      ),
      status: z.enum(TRANSFER_STATUSES),
      failure_message: z.string().nullable(),
      created: unixSeconds,
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'tr_0193b8f33c5a4b7e9d02',
        object: 'transfer',
        livemode: false,
        external_ref: 'order_6735_seller_4821',
        connected_account: 'ca_0193b8f2d4e1aa07c3b2',
        payment_intent: 'pi_0193b8f2e8a14f6c9d31',
        amount: '1700',
        currency: 'EUR',
        amount_reversed: '0',
        status: 'paid',
        failure_message: null,
        created: 1793750400,
        updated_at: 1793750402,
      },
    ],
  },
);
export type Transfer = Expand<z.output<typeof transferSchema>>;

/**
 * One reversal operation. It exists as an object because an AMOUNT IS NOT AN
 * IDENTITY: two reversals of one settlement for the same amount are two
 * operations, and a caller needs to tell which one a response is about.
 */
export const transferReversalSchema = defineObject(
  'transfer_reversal',
  'TransferReversal',
  z
    .object({
      id: z.string(),
      object: z.literal('transfer_reversal'),
      livemode,
      external_ref: z.string().describe("The merchant's own id for this reversal."),
      amount,
      currency: z.string(),
      status: z.enum(TRANSFER_REVERSAL_STATUSES),
      failure_message: z.string().nullable(),
      created: unixSeconds,
    })
    .strict(),
);
export type TransferReversal = Expand<z.output<typeof transferReversalSchema>>;

/** What `POST /v1/transfers/{transferId}/reversals` answers: the transfer, and the leg. */
export const transferWithReversalSchema = defineComponent(
  'TransferWithReversal',
  transferSchema.extend({ reversal: transferReversalSchema }).strict(),
);
export type TransferWithReversal = Expand<z.output<typeof transferWithReversalSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    transfer: Transfer;
    transfer_reversal: TransferReversal;
  }
}

/**
 * A canonical base-unit integer string, validated with the SAME predicate the
 * database CHECK is rendered from. A `z.number()` here would be a silent
 * precision ceiling on a money value.
 */
const transferAmount = z
  .string()
  .refine(
    isBaseUnitString,
    "amount must be a canonical integer string in the currency's smallest unit",
  )
  // `'0'` passes the predicate above, and a zero transfer is not a transfer:
  // it would consume the merchant's `external_ref`, so the REAL settlement of
  // that order could never be created afterwards.
  .refine((value) => value !== '0', 'a transfer of 0 is not a transfer');

/**
 * `POST /v1/transfers`: settle one seller out of a funded payment. The seller
 * by exactly one of its two addresses; the currency is the payment's, never the
 * request's (a transfer in another currency is an FX conversion nothing here
 * performs).
 */
export const createTransferParams = z
  .object({
    payment_intent: z.string().min(1).describe('The `pi_…` this settles out of.'),
    connected_account: z.string().min(1).optional().describe("The seller's `ca_…`."),
    connected_account_ref: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Or your own id for the seller (its `external_ref`).'),
    external_ref: z
      .string()
      .min(1)
      .max(255)
      .describe(
        'Your own id for what this settles — the idempotency: the same ref answers the stored settlement (200), a different payment or amount under it is a 409.',
      ),
    amount: transferAmount,
  })
  .strict()
  .refine((body) => Boolean(body.connected_account) !== Boolean(body.connected_account_ref), {
    message: 'name the seller by exactly one of connected_account or connected_account_ref',
  });
export type CreateTransferParams = z.input<typeof createTransferParams>;

export const reverseTransferParams = z
  .object({
    amount: transferAmount,
    // Required, and durable. It used to be satisfiable by the
    // `Idempotency-Key` header instead; that header is now the generic 24-hour
    // retry layer (ADR 0014 D3), which the SDK fills with a fresh uuid per call
    // — accepting it here would hand every un-referenced reversal a random
    // identity, and an application's own retry a second reversal.
    external_ref: z
      .string()
      .min(1)
      .max(255)
      .describe(
        'Your own id for THIS reversal — required and durable: two reversals for the same amount are two operations.',
      ),
  })
  .strict();
export type ReverseTransferParams = z.input<typeof reverseTransferParams>;

export const listTransfersQuery = listQuery({
  payment_intent: idParam.optional().describe('Only the settlements of this payment (`pi_…`).'),
  connected_account: idParam.optional().describe('Only the settlements to this seller (`ca_…`).'),
});
export type ListTransfersParams = z.input<typeof listTransfersQuery>;

/** The per-payment list: the payment is in the path. */
export const listPaymentIntentTransfersQuery = listQuery({});

const transferIdParam = { transferId: 'The transfer (`tr_…`).' } as const;

export const transferRoutes = [
  defineRoute({
    operationId: 'createTransfer',
    method: 'post',
    path: '/v1/transfers',
    tag: 'Transfers',
    summary: 'Create a transfer',
    description:
      'Settles one seller out of a funded payment (201). An order already settled answers the stored settlement (200): a merchant retrying after a timeout needs to know whether they just paid a seller twice.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createTransferParams,
    response: transferSchema,
    status: 201,
    sdk: 'transfers.create',
  }),
  defineRoute({
    operationId: 'createTransferReversal',
    method: 'post',
    path: '/v1/transfers/{transferId}/reversals',
    tag: 'Transfers',
    summary: 'Reverse a transfer',
    description:
      'Takes some or all of a settlement back (201), or answers the reversal this `external_ref` already made (200).',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: transferIdParam,
    body: reverseTransferParams,
    response: transferWithReversalSchema,
    status: 201,
    sdk: 'transfers.reverse',
  }),
  defineRoute({
    operationId: 'listTransferReversals',
    method: 'get',
    path: '/v1/transfers/{transferId}/reversals',
    tag: 'Transfers',
    summary: "List a transfer's reversals",
    description:
      'Newest first. A complete set (`has_more: false`): a settlement can only be reversed down to zero.',
    auth: 'service',
    scope: 'payments:read',
    params: transferIdParam,
    query: expandOnlyQuery,
    response: listOf(transferReversalSchema),
    sdk: 'transfers.listReversals',
  }),
  defineRoute({
    operationId: 'listTransfers',
    method: 'get',
    path: '/v1/transfers',
    tag: 'Transfers',
    summary: 'List transfers',
    description: 'Newest first, narrowed by `payment_intent` and/or `connected_account`.',
    auth: 'service',
    scope: 'payments:read',
    query: listTransfersQuery,
    response: listOf(transferSchema),
    sdk: 'transfers.list',
    expandable: 'transfer',
  }),
  defineRoute({
    operationId: 'retrieveTransfer',
    method: 'get',
    path: '/v1/transfers/{transferId}',
    tag: 'Transfers',
    summary: 'Retrieve a transfer',
    auth: 'service',
    scope: 'payments:read',
    params: transferIdParam,
    query: expandOnlyQuery,
    response: transferSchema,
    sdk: 'transfers.retrieve',
    expandable: 'transfer',
  }),
  defineRoute({
    operationId: 'listPaymentIntentTransfers',
    method: 'get',
    path: '/v1/payment_intents/{intentId}/transfers',
    tag: 'Transfers',
    summary: "List a payment's transfers",
    description: 'What one payment settled, newest first. The reconciliation read.',
    auth: 'service',
    scope: 'payments:read',
    params: { intentId: 'The payment intent (`pi_…`).' },
    query: listPaymentIntentTransfersQuery,
    response: listOf(transferSchema),
    sdk: 'transfers.listForPaymentIntent',
    expandable: 'transfer',
  }),
] as const;
