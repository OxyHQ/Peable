import { z } from 'zod';
import { emailParam, shippingParams, shippingSchema } from '../../common/address';
import { listOf, searchResultOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  clearable,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  retrieveQuery,
  searchQuery,
} from '../../common/params';
import {
  amount,
  currency,
  livemode,
  metadata,
  network,
  nullableString,
  unixSeconds,
} from '../../common/primitives';
import { defineRoute } from '../../route';
import { CURRENCY_CODES, isBaseUnitString, NETWORK_TYPES } from '../../vocabulary/money';
import {
  CARD_RAIL_PAYMENT_METHOD_TYPES,
  CLIENT_ACTION_KINDS,
  MERCHANT_CANCELLATION_REASONS,
  PAYMENT_ERROR_TYPES,
  PAYMENT_INTENT_CANCELLATION_REASONS,
  PAYMENT_INTENT_CAPTURE_METHODS,
  PAYMENT_INTENT_RAILS,
  PAYMENT_INTENT_SETUP_FUTURE_USAGES,
  PAYMENT_INTENT_STATUSES,
  PAYMENT_METHOD_TYPES,
} from '../../vocabulary/payments';

/**
 * PaymentIntents (`pi_…`) — Stripe's PaymentIntent, at the root (ADR 0019):
 * one status vocabulary over two rails, the non-custodial FairCoin lifecycle
 * and a fiat card payment served by a provider behind the gateway (ADR 0001).
 */

/** Why the last attempt failed. Peable's words, never the provider's raw prose. */
export const paymentErrorSchema = defineComponent(
  'PaymentError',
  z
    .object({
      type: z
        .enum(PAYMENT_ERROR_TYPES)
        .describe('`card_error` for a declined card; `payment_error` for a FairCoin underpayment.'),
      code: nullableString,
      decline_code: nullableString,
      message: z.string(),
    })
    .strict(),
);
export type PaymentIntentLastPaymentError = z.output<typeof paymentErrorSchema>;

/**
 * What the payer must do next (`status: 'requires_action'`).
 *
 * - `faircoin_payment` — send exactly `amount` (base units) to `address` on
 *   `network`; `uri` is the BIP21-style `faircoin:` URI a wallet scans.
 * - `use_peable_sdk` — a card challenge; `@peable.to/sdk/checkout` fetches the
 *   provider's confirmation credential through `POST …/client_action` and
 *   completes it. The credential is never on the intent itself.
 */
export const paymentIntentNextActionSchema = defineComponent(
  'PaymentIntentNextAction',
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('faircoin_payment'),
        faircoin_payment: z
          .object({
            address: z.string(),
            network,
            amount,
            currency: z.literal('FAIR'),
            uri: z.string().describe('The `faircoin:` URI a wallet scans.'),
          })
          .strict(),
      })
      .strict(),
    z.object({ type: z.literal('use_peable_sdk') }).strict(),
  ]),
);
export type PaymentIntentNextAction = z.output<typeof paymentIntentNextActionSchema>;

/**
 * The chain side of a FairCoin payment. `txid` and `confirmations` describe the
 * transaction the payer reported: `null`/`0` while `requires_action`, the
 * watcher's count against `required_confirmations` while `processing`.
 */
export const paymentIntentFaircoinSchema = defineComponent(
  'PaymentIntentFaircoin',
  z
    .object({
      network,
      address: z
        .string()
        .describe(
          "Watch-only receive address derived per intent from the merchant's (or seller's) xpub.",
        ),
      txid: nullableString,
      confirmations: z.number().int().nonnegative(),
      required_confirmations: z.number().int().nonnegative(),
    })
    .strict(),
);
export type PaymentIntentFaircoin = z.output<typeof paymentIntentFaircoinSchema>;

/** Where a destination charge's funds go (`transfer_data`, ADR 0015 §2). */
export const paymentIntentTransferDataSchema = defineComponent(
  'PaymentIntentTransferData',
  z
    .object({
      destination: z.string().describe('The connected account (`ca_…`).'),
      amount: amount
        .nullable()
        .describe(
          'Base units transferred; `null`: the whole amount less `application_fee_amount`.',
        ),
    })
    .strict(),
);
export type PaymentIntentTransferData = z.output<typeof paymentIntentTransferDataSchema>;

const clientActionFields = {
  kind: z
    .enum(CLIENT_ACTION_KINDS)
    .describe('`client_secret`: confirm with the provider; `redirect`: send the payer to `value`.'),
  value: z
    .string()
    .describe(
      'Opaque and provider-specific: a confirmation credential or a redirect target. Never store, log or put it in a URL.',
    ),
  publishable_key: z
    .string()
    .optional()
    .describe("The provider's PUBLIC key for this payment's mode, when the deployment has one."),
};

/**
 * The payer's next step on the card rail, as `POST …/client_action` answers it:
 * read live from the provider, `Cache-Control: no-store`, never on a list.
 */
export const clientActionSchema = defineComponent(
  'ClientAction',
  z.object({ object: z.literal('client_action'), ...clientActionFields }).strict(),
);
export type ClientAction = z.output<typeof clientActionSchema>;

/** The same next step, as a create or a single merchant retrieve carries it on the intent. */
export const paymentIntentClientActionSchema = defineComponent(
  'PaymentIntentClientAction',
  z.object(clientActionFields).strict(),
);
export type PaymentIntentClientAction = z.output<typeof paymentIntentClientActionSchema>;

export const paymentIntentSchema = defineObject(
  'payment_intent',
  'PaymentIntent',
  z
    .object({
      id: z.string(),
      object: z.literal('payment_intent'),
      livemode,
      status: z.enum(PAYMENT_INTENT_STATUSES),
      rail: z
        .enum(PAYMENT_INTENT_RAILS)
        .describe('Which rail moves this payment. Decides which fields below are populated.'),
      payment_method_types: z
        .array(z.enum(PAYMENT_METHOD_TYPES))
        .describe(
          'What the payer may pay with: `["faircoin"]` on the chain; on the card rail the types named at creation, or those the configuration offers in this currency.',
        ),
      payment_method_configuration_details: z
        .object({ id: z.string() })
        .strict()
        .nullable()
        .describe(
          'The `pmc_…` whose methods this card payment offers; `null` on the chain and when types were named.',
        ),
      amount: amount.describe(
        'Base units of `currency` as a canonical integer string: m⊜ (10⁻⁸ FAIR) on the faircoin rail, cents on a fiat one.',
      ),
      amount_capturable: amount.describe(
        'What can still be captured: the authorized amount while `requires_capture`, else `"0"`.',
      ),
      amount_received: amount.describe(
        'What was received: the captured amount once `succeeded`, else `"0"`.',
      ),
      amount_refunded: amount.describe(
        'The sum of SUCCEEDED refunds on this payment. Refund state lives on the refunds.',
      ),
      currency,
      capture_method: z.enum(PAYMENT_INTENT_CAPTURE_METHODS),
      setup_future_usage: z.enum(PAYMENT_INTENT_SETUP_FUTURE_USAGES).nullable(),
      customer: expandable(
        'customer',
        '`cus_…`, or the Customer with `expand[]=customer`.',
      ).nullable(),
      payment_method: expandable(
        'payment_method',
        '`pm_…`, or the PaymentMethod with `expand[]=payment_method`. Card only.',
      ).nullable(),
      latest_charge: expandable(
        'charge',
        '`ch_…`, or the Charge with `expand[]=latest_charge`. Card only.',
      ).nullable(),
      next_action: paymentIntentNextActionSchema.nullable(),
      last_payment_error: paymentErrorSchema.nullable(),
      cancellation_reason: z.enum(PAYMENT_INTENT_CANCELLATION_REASONS).nullable(),
      canceled_at: unixSeconds.nullable(),
      description: nullableString,
      receipt_email: nullableString,
      statement_descriptor_suffix: nullableString.describe('Card only.'),
      shipping: shippingSchema.nullable(),
      faircoin: paymentIntentFaircoinSchema
        .nullable()
        .describe('The chain side. FairCoin rail only; `null` on a card payment.'),
      merchant_id: z.string().describe("The merchant's public `merch_…`."),
      connected_account: expandable(
        'connected_account',
        'The seller this payment is made ON BEHALF OF (`ca_…`, ADR 0012 D5), or the ConnectedAccount with `expand[]=connected_account`; `null` for a payment to the merchant itself.',
      ).nullable(),
      application_fee_amount: amount
        .nullable()
        .describe(
          "Orbit's fee on this card payment, taken from the destination account when the charge succeeds (ADR 0015 §3); `null` on a platform charge.",
        ),
      transfer_data: paymentIntentTransferDataSchema.nullable(),
      on_behalf_of: nullableString.describe(
        'The account (`ca_…`) that is the merchant of record, or `null` (the platform).',
      ),
      client_secret: z
        .string()
        .describe("The payer's capability over this intent (`submit_tx`, the payer's retrieve)."),
      client_action: paymentIntentClientActionSchema
        .optional()
        .describe(
          "The card payer's next step — ONLY on the create's answer and a single merchant retrieve of a card payment that can still be paid; never on a list or an event.",
        ),
      metadata,
      expires_at: unixSeconds.describe(
        'When an UNPAID intent expires. Meaningful only while `can_expire`.',
      ),
      can_expire: z.boolean().describe('Whether this intent can still expire (ADR 0012 D9).'),
      created: unixSeconds,
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'pi_0193b8f2c1a87d3e9f4a',
        object: 'payment_intent',
        livemode: false,
        status: 'requires_action',
        rail: 'faircoin',
        payment_method_types: ['faircoin'],
        payment_method_configuration_details: null,
        amount: '150000000',
        amount_capturable: '0',
        amount_received: '0',
        amount_refunded: '0',
        currency: 'FAIR',
        capture_method: 'automatic',
        setup_future_usage: null,
        customer: null,
        payment_method: null,
        latest_charge: null,
        next_action: {
          type: 'faircoin_payment',
          faircoin_payment: {
            address: 'fLx9bJ3Wv2kq8mT4sR6nZ1cY7pD5eH0aG',
            network: 'testnet',
            amount: '150000000',
            currency: 'FAIR',
            uri: 'faircoin:fLx9bJ3Wv2kq8mT4sR6nZ1cY7pD5eH0aG?amount=1.5',
          },
        },
        last_payment_error: null,
        cancellation_reason: null,
        canceled_at: null,
        description: null,
        receipt_email: null,
        statement_descriptor_suffix: null,
        shipping: null,
        faircoin: {
          network: 'testnet',
          address: 'fLx9bJ3Wv2kq8mT4sR6nZ1cY7pD5eH0aG',
          txid: null,
          confirmations: 0,
          required_confirmations: 6,
        },
        merchant_id: 'merch_0193b8f2c1a87d3e9f4a',
        connected_account: null,
        application_fee_amount: null,
        transfer_data: null,
        on_behalf_of: null,
        client_secret: 'pi_0193b8f2c1a87d3e9f4a_secret_3c9f2a',
        metadata: { order_id: '6735' },
        expires_at: 1793751300,
        can_expire: true,
        created: 1793750400,
        updated_at: 1793750400,
      },
    ],
  },
);
export type PaymentIntent = Expand<z.output<typeof paymentIntentSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    payment_intent: PaymentIntent;
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** A base-unit amount in a request body. */
const amountParam = (name: string) =>
  z.string().refine(isBaseUnitString, `${name} must be a minor-unit integer string`);

/**
 * The rail/amount/currency/network fragment a creating route takes. Coherence
 * (rail + currency + network agreeing with each other and the merchant) is the
 * service's rule, not a refinement here.
 */
export const railParams = {
  amount: amountParam('amount').describe(
    'Base units of `currency`, as a canonical integer string (m⊜ for FAIR, cents for EUR).',
  ),
  rail: z.enum(PAYMENT_INTENT_RAILS).optional().describe('Defaults to `faircoin`.'),
  currency: z
    .enum(CURRENCY_CODES)
    .optional()
    .describe('Defaults to `FAIR` on the faircoin rail; required on the card rail.'),
  network: z
    .enum(NETWORK_TYPES)
    .optional()
    .describe('Required on the faircoin rail; refused on the card rail, which has none.'),
} as const;

/** The seller an on-behalf create pays (`ca_…`, ADR 0012 D5). FairCoin only. */
export const connectedAccountParam = {
  connected_account: idParam.optional().describe('FairCoin only: pay this seller (`ca_…`).'),
} as const;

const setupFutureUsage = z.enum(PAYMENT_INTENT_SETUP_FUTURE_USAGES);
const returnUrl = z.string().url().max(2048);

export const createPaymentIntentParams = z
  .object({
    ...railParams,
    ...connectedAccountParam,
    metadata: metadataCreateParam.optional(),
    expires_in_seconds: z.number().int().positive().optional(),
    payment_method_types: z
      .array(z.enum(PAYMENT_METHOD_TYPES))
      .min(1)
      .max(CARD_RAIL_PAYMENT_METHOD_TYPES.length)
      .optional()
      .describe(
        '`["faircoin"]` on the chain rail; on the card rail any of the card-rail types the provider offers in `currency`, instead of a configuration.',
      ),
    payment_method_configuration: idParam
      .optional()
      .describe(
        "Card only: the `pmc_…` whose methods to offer. Defaults to the merchant's default.",
      ),
    customer: idParam.optional().describe('`cus_…`.'),
    payment_method: idParam
      .optional()
      .describe('Card only: a saved payment method (`pm_…`) of `customer`.'),
    confirm: z
      .boolean()
      .optional()
      .describe('Card only: confirm in the same call (needs `payment_method`).'),
    off_session: z
      .boolean()
      .optional()
      .describe('Card only, with `confirm`: the customer is not present (needs `customer`).'),
    setup_future_usage: setupFutureUsage.optional().describe('Card only.'),
    capture_method: z
      .enum(PAYMENT_INTENT_CAPTURE_METHODS)
      .optional()
      .describe('Card only. Defaults to `automatic`.'),
    receipt_email: emailParam.optional(),
    description: z.string().max(1000).optional(),
    // Stripe's bound; the account prefix and this together must fit 22.
    statement_descriptor_suffix: z
      .string()
      .min(1)
      .max(22)
      .regex(/^[^<>\\'"*]*$/, 'statement_descriptor_suffix may not contain < > \\ \' " *')
      .optional()
      .describe('Card only.'),
    shipping: shippingParams.optional(),
    return_url: returnUrl
      .optional()
      .describe('Card only, with `confirm`: where a redirect-based challenge returns.'),
    // A destination charge for one of the platform's connected accounts
    // (ADR 0015 §2). Card only; the service decides the routing.
    application_fee_amount: amountParam('application_fee_amount')
      .optional()
      .describe(
        "Card only, a platform acting for a connected account: Orbit's fee for this payment. Needs `transfer_data` (or `on_behalf_of`); refused beside `transfer_data.amount`.",
      ),
    transfer_data: z
      .object({
        destination: idParam.describe('The connected account (`ca_…`) the funds go to.'),
        amount: amountParam('transfer_data.amount').optional(),
      })
      .strict()
      .optional()
      .describe("Card only: a destination charge to one of the platform's connected accounts."),
    on_behalf_of: idParam
      .optional()
      .describe('Card only: make this connected account (`ca_…`) the merchant of record.'),
  })
  .strict();
export type CreatePaymentIntentParams = z.input<typeof createPaymentIntentParams>;

/**
 * The merchant's own bookkeeping only — the amount, rail and status ARE the
 * payment and move through their own operations. `""` clears a field;
 * `metadata` is a patch.
 */
export const updatePaymentIntentParams = z
  .object({
    metadata: metadataUpdateParam.optional(),
    description: clearable(z.string().max(1000)).optional(),
    receipt_email: clearable(emailParam).optional(),
    shipping: clearable(shippingParams).optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdatePaymentIntentParams = z.input<typeof updatePaymentIntentParams>;

/** Card only. */
export const confirmPaymentIntentParams = z
  .object({
    payment_method: idParam.optional().describe("`pm_…`; defaults to the intent's own."),
    off_session: z.boolean().optional(),
    setup_future_usage: setupFutureUsage.optional(),
    return_url: returnUrl.optional(),
    receipt_email: emailParam.optional(),
    shipping: shippingParams.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type ConfirmPaymentIntentParams = z.input<typeof confirmPaymentIntentParams>;

/** Card only, `requires_capture`. */
export const capturePaymentIntentParams = z
  .object({
    amount_to_capture: amountParam('amount_to_capture')
      .refine((value) => value !== '0', 'amount_to_capture must be positive')
      .optional()
      .describe('Base units, at most the authorized amount; defaults to all of it.'),
    expand: expandParam.optional(),
  })
  .strict();
export type CapturePaymentIntentParams = z.input<typeof capturePaymentIntentParams>;

export const cancelPaymentIntentParams = z
  .object({
    cancellation_reason: z.enum(MERCHANT_CANCELLATION_REASONS).optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CancelPaymentIntentParams = z.input<typeof cancelPaymentIntentParams>;

/**
 * The payer proves possession of the intent with its `client_secret`; the
 * reported txid is what the settlement watcher then verifies on-chain.
 */
export const submitPaymentIntentTxParams = z
  .object({
    client_secret: z.string().min(1),
    txid: z.string().min(1).describe('The broadcast transaction.'),
  })
  .strict();
export type SubmitPaymentIntentTxParams = z.input<typeof submitPaymentIntentTxParams>;

/** The list's own filters, beside the shared list parameters. */
export const listPaymentIntentsQuery = listQuery({
  status: z.enum(PAYMENT_INTENT_STATUSES).optional(),
  connected_account: idParam
    .optional()
    .describe('Only the payments made on behalf of this seller (`ca_…`, ADR 0012).'),
  customer: idParam.optional().describe("Only this customer's payments (`cus_…`)."),
});
export type ListPaymentIntentsParams = z.input<typeof listPaymentIntentsQuery>;

/**
 * The payer's capability, on a route either party may call. The
 * `X-Peable-Client-Secret` header is preferred: a query string lands in access
 * logs.
 */
export const clientSecretParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Without a service credential: the object's `client_secret` (prefer the `X-Peable-Client-Secret` header).",
  );

/** A merchant retrieve takes `expand[]`; the payer's takes `client_secret` and nothing to expand. */
export const retrievePaymentIntentQuery = retrieveQuery({ client_secret: clientSecretParam });

/** The query of a route either party may call that takes nothing else (`client_action`). */
export const clientSecretQuery = z.object({ client_secret: clientSecretParam }).strict();
export type RetrievePaymentIntentParams = z.input<typeof retrievePaymentIntentQuery>;

const intentId = { id: 'The payment intent (`pi_…`).' };

export const paymentIntentRoutes = [
  defineRoute({
    operationId: 'createPaymentIntent',
    method: 'post',
    path: '/v1/payment_intents',
    tag: 'Payment intents',
    summary: 'Create a payment intent',
    description:
      "`Idempotency-Key` also keys the intent itself: a key replayed after the 24-hour window answers 200 with the payment it created. On the card rail the answer carries `client_action`, the payer's next step.",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createPaymentIntentParams,
    response: paymentIntentSchema,
    status: 201,
    sdk: 'paymentIntents.create',
  }),
  defineRoute({
    operationId: 'listPaymentIntents',
    method: 'get',
    path: '/v1/payment_intents',
    tag: 'Payment intents',
    summary: 'List payment intents',
    auth: 'service',
    scope: 'payments:read',
    query: listPaymentIntentsQuery,
    response: listOf(paymentIntentSchema),
    sdk: 'paymentIntents.list',
    expandable: 'payment_intent',
  }),
  defineRoute({
    operationId: 'retrievePaymentIntent',
    method: 'get',
    path: '/v1/payment_intents/{id}',
    tag: 'Payment intents',
    summary: 'Retrieve a payment intent',
    description:
      "With the merchant credential: the intent, expandable, and — for a card payment that can still be paid — its `client_action` (`Cache-Control: no-store`). Without one, the PAYER reads it with the intent's `client_secret` (the `X-Peable-Client-Secret` header, or the query): no expansion and no client action.",
    auth: 'service',
    scope: 'payments:read',
    params: intentId,
    query: retrievePaymentIntentQuery,
    response: paymentIntentSchema,
    sdk: 'paymentIntents.retrieve',
    expandable: 'payment_intent',
  }),
  defineRoute({
    operationId: 'updatePaymentIntent',
    method: 'post',
    path: '/v1/payment_intents/{id}',
    tag: 'Payment intents',
    summary: 'Update a payment intent',
    description:
      'The merchant\'s own fields only: `metadata` (a patch), `description`, `receipt_email`, `shipping` (`""` clears). Sends no webhook.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: intentId,
    body: updatePaymentIntentParams,
    response: paymentIntentSchema,
    sdk: 'paymentIntents.update',
    expandable: 'payment_intent',
  }),
  defineRoute({
    operationId: 'retrievePaymentIntentClientAction',
    method: 'post',
    path: '/v1/payment_intents/{id}/client_action',
    tag: 'Payment intents',
    summary: "Retrieve a card payment's client action",
    description:
      "What the payer's client must do next, to RESUME a card payment rather than create a second one. The merchant credential, or the payer's `client_secret` (`X-Peable-Client-Secret`). A POST so the credential never reaches a URL; answered `Cache-Control: no-store`. A FairCoin payment is a 400 (it is paid by sending coins to `next_action.faircoin_payment.address`); a payment that can no longer be paid is a 409.",
    auth: 'service',
    scope: 'payments:read',
    params: intentId,
    query: clientSecretQuery,
    response: clientActionSchema,
    sdk: 'paymentIntents.clientAction',
  }),
  defineRoute({
    operationId: 'confirmPaymentIntent',
    method: 'post',
    path: '/v1/payment_intents/{id}/confirm',
    tag: 'Payment intents',
    summary: 'Confirm a payment intent',
    description:
      "Card only: confirm server-side with a saved payment method attached to the intent's customer. A decline answers 402 `card_error` carrying the intent; a challenge answers `status: 'requires_action'` with `next_action: use_peable_sdk`.",
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: intentId,
    body: confirmPaymentIntentParams,
    response: paymentIntentSchema,
    sdk: 'paymentIntents.confirm',
    expandable: 'payment_intent',
  }),
  defineRoute({
    operationId: 'capturePaymentIntent',
    method: 'post',
    path: '/v1/payment_intents/{id}/capture',
    tag: 'Payment intents',
    summary: 'Capture a payment intent',
    description:
      'Card only, `requires_capture`: capture the held authorization in full, or `amount_to_capture` of it (the rest is released).',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: intentId,
    body: capturePaymentIntentParams,
    response: paymentIntentSchema,
    sdk: 'paymentIntents.capture',
    expandable: 'payment_intent',
  }),
  defineRoute({
    operationId: 'cancelPaymentIntent',
    method: 'post',
    path: '/v1/payment_intents/{id}/cancel',
    tag: 'Payment intents',
    summary: 'Cancel a payment intent',
    description:
      'While nothing is moving money: `requires_payment_method`, `requires_confirmation`, `requires_action`, or a held authorization (`requires_capture`, released). The card payment is cancelled at the provider first. Cancelling a cancelled intent answers it again.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: intentId,
    body: cancelPaymentIntentParams,
    response: paymentIntentSchema,
    sdk: 'paymentIntents.cancel',
    expandable: 'payment_intent',
  }),
  defineRoute({
    operationId: 'submitPaymentIntentTx',
    method: 'post',
    path: '/v1/payment_intents/{id}/submit_tx',
    tag: 'Payment intents',
    summary: 'Report a FairCoin transaction',
    description:
      "The PAYER's call, authorized by the intent's `client_secret`: report the txid their wallet broadcast. The intent moves to `processing`; the settlement watcher verifies the transaction on-chain. FairCoin only.",
    auth: 'public',
    params: intentId,
    body: submitPaymentIntentTxParams,
    response: paymentIntentSchema,
  }),
  defineRoute({
    operationId: 'searchPaymentIntents',
    method: 'get',
    path: '/v1/payment_intents/search',
    tag: 'Payment intents',
    summary: 'Search payment intents',
    description:
      "Stripe's query language over `amount`, `currency`, `customer`, `status`, `created`, `metadata['key']`, `description` and `receipt_email`.",
    auth: 'service',
    scope: 'payments:read',
    query: searchQuery,
    response: searchResultOf(paymentIntentSchema),
    sdk: 'paymentIntents.search',
    expandable: 'payment_intent',
  }),
] as const;
