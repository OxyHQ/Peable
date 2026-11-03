import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  retrieveQuery,
} from '../../common/params';
import { livemode, metadata, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  SETUP_INTENT_CANCELLATION_REASONS,
  SETUP_INTENT_STATUSES,
  SETUP_INTENT_USAGES,
} from '../../vocabulary/payments';
import {
  clientActionSchema,
  clientSecretParam,
  clientSecretQuery,
  paymentErrorSchema,
} from './paymentIntents';

/**
 * SetupIntents (`seti_…`) — saving a card for later without charging it
 * (ADR 0016, ADR 0019). The provider SetupIntent is an internal binding; its
 * success is what creates the Peable `pm_…`, attached to the customer.
 */
export const setupIntentSchema = defineObject(
  'setup_intent',
  'SetupIntent',
  z
    .object({
      id: z.string(),
      object: z.literal('setup_intent'),
      livemode,
      status: z.enum(SETUP_INTENT_STATUSES),
      usage: z.enum(SETUP_INTENT_USAGES),
      payment_method_types: z.tuple([z.literal('card')]),
      customer: expandable(
        'customer',
        '`cus_…`, or the Customer with `expand[]=customer`.',
      ).nullable(),
      payment_method: expandable(
        'payment_method',
        'The `pm_…` it saved, once `succeeded`, or the PaymentMethod with `expand[]=payment_method`.',
      ).nullable(),
      client_secret: z
        .string()
        .describe("Possession of it lets the payer's browser confirm this SetupIntent."),
      next_action: z
        .object({ type: z.literal('use_peable_sdk') })
        .strict()
        .nullable(),
      last_setup_error: paymentErrorSchema.nullable(),
      cancellation_reason: z.enum(SETUP_INTENT_CANCELLATION_REASONS).nullable(),
      description: nullableString,
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'seti_0193b8f2c1a87d3e9f4a',
        object: 'setup_intent',
        livemode: false,
        status: 'requires_payment_method',
        usage: 'off_session',
        payment_method_types: ['card'],
        customer: 'cus_0193b8f2c1a87d3e9f4a',
        payment_method: null,
        client_secret: 'seti_0193b8f2c1a87d3e9f4a_secret_9a1b2c',
        next_action: null,
        last_setup_error: null,
        cancellation_reason: null,
        description: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type SetupIntent = Expand<z.output<typeof setupIntentSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    setup_intent: SetupIntent;
  }
}

export const createSetupIntentParams = z
  .object({
    customer: idParam
      .optional()
      .describe(
        'The customer (`cus_…`) the card is saved to. Required: a `pm_…` is born attached.',
      ),
    usage: z.enum(SETUP_INTENT_USAGES).optional().describe('Defaults to `off_session`.'),
    payment_method_types: z.tuple([z.literal('card')]).optional(),
    description: z.string().max(1000).optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateSetupIntentParams = z.input<typeof createSetupIntentParams>;

export const cancelSetupIntentParams = z
  .object({
    cancellation_reason: z.enum(SETUP_INTENT_CANCELLATION_REASONS).optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CancelSetupIntentParams = z.input<typeof cancelSetupIntentParams>;

export const listSetupIntentsQuery = listQuery({
  customer: idParam.optional().describe("Only this customer's setup intents (`cus_…`)."),
});
export type ListSetupIntentsParams = z.input<typeof listSetupIntentsQuery>;

/** A merchant retrieve takes `expand[]`; the payer's takes `client_secret` and nothing to expand. */
export const retrieveSetupIntentQuery = retrieveQuery({ client_secret: clientSecretParam });
export type RetrieveSetupIntentParams = z.input<typeof retrieveSetupIntentQuery>;

const setupIntentId = { id: 'The setup intent (`seti_…`).' };

export const setupIntentRoutes = [
  defineRoute({
    operationId: 'createSetupIntent',
    method: 'post',
    path: '/v1/setup_intents',
    tag: 'Setup intents',
    summary: 'Create a setup intent',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createSetupIntentParams,
    response: setupIntentSchema,
    status: 201,
    sdk: 'setupIntents.create',
    expandable: 'setup_intent',
  }),
  defineRoute({
    operationId: 'listSetupIntents',
    method: 'get',
    path: '/v1/setup_intents',
    tag: 'Setup intents',
    summary: 'List setup intents',
    auth: 'service',
    scope: 'payments:read',
    query: listSetupIntentsQuery,
    response: listOf(setupIntentSchema),
    sdk: 'setupIntents.list',
    expandable: 'setup_intent',
  }),
  defineRoute({
    operationId: 'retrieveSetupIntent',
    method: 'get',
    path: '/v1/setup_intents/{id}',
    tag: 'Setup intents',
    summary: 'Retrieve a setup intent',
    description:
      'With the merchant credential: reconciled with the provider when not terminal, expandable. Without one, the PAYER reads the row as stored with its `client_secret` (the `X-Peable-Client-Secret` header, or the query).',
    auth: 'service',
    scope: 'payments:read',
    params: setupIntentId,
    query: retrieveSetupIntentQuery,
    response: setupIntentSchema,
    sdk: 'setupIntents.retrieve',
    expandable: 'setup_intent',
  }),
  defineRoute({
    operationId: 'cancelSetupIntent',
    method: 'post',
    path: '/v1/setup_intents/{id}/cancel',
    tag: 'Setup intents',
    summary: 'Cancel a setup intent',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: setupIntentId,
    body: cancelSetupIntentParams,
    response: setupIntentSchema,
    sdk: 'setupIntents.cancel',
    expandable: 'setup_intent',
  }),
  defineRoute({
    operationId: 'retrieveSetupIntentClientAction',
    method: 'post',
    path: '/v1/setup_intents/{id}/client_action',
    tag: 'Setup intents',
    summary: "Retrieve a setup intent's client action",
    description:
      "The provider credential the payer's client confirms the SetupIntent with — read fresh, `Cache-Control: no-store`, never on the object. The merchant credential, or the payer's `client_secret` (`X-Peable-Client-Secret`). A succeeded or canceled setup intent answers 409.",
    auth: 'service',
    scope: 'payments:read',
    params: setupIntentId,
    query: clientSecretQuery,
    response: clientActionSchema,
    sdk: 'setupIntents.clientAction',
  }),
] as const;
