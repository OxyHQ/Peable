import { z } from 'zod';
import { deletedOf, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { livemode, metadata, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  TERMINAL_LIMITS,
  TERMINAL_READER_ACTION_STATUSES,
  TERMINAL_READER_ACTION_TYPES,
  TERMINAL_READER_STATUSES,
} from '../../vocabulary/terminal';

/**
 * Terminal readers (ADR 0024) — Stripe's `terminal.reader`: a card reader
 * registered to one of the merchant's locations with the code it displays.
 * Orbit drives one reader action, collecting a `card_present` PaymentIntent
 * (`process_payment_intent`); the payment's outcome moves the PaymentIntent
 * through its own events, and the reader's action records how the attempt on
 * the device ended.
 */

/** How the reader collects: Orbit never offers on-reader tipping (the amount is the PaymentIntent's). */
export const terminalProcessConfigSchema = defineComponent(
  'TerminalProcessConfig',
  z
    .object({
      enable_customer_cancellation: z
        .boolean()
        .describe('The cardholder may cancel the collection on the reader.'),
      skip_tipping: z.literal(true).describe('Always `true`: Orbit offers no on-reader tipping.'),
    })
    .strict(),
);

/** The reader's current (or last) action. */
export const terminalReaderActionSchema = defineComponent(
  'TerminalReaderAction',
  z
    .object({
      type: z.enum(TERMINAL_READER_ACTION_TYPES),
      status: z.enum(TERMINAL_READER_ACTION_STATUSES),
      failure_code: nullableString.describe(
        "The provider's code for a failed action (`card_declined`, `customer_canceled`, …); `null` unless `failed`.",
      ),
      failure_message: nullableString.describe(
        "Orbit's own sentence for `failure_code` (never the provider's prose); `null` unless `failed`.",
      ),
      process_payment_intent: z
        .object({
          payment_intent: z.string().describe('The PaymentIntent being collected (`pi_…`).'),
          process_config: terminalProcessConfigSchema,
        })
        .strict(),
    })
    .strict(),
);

/** `terminal.reader` (`tmr_…`). */
export const terminalReaderSchema = defineObject(
  'terminal.reader',
  'TerminalReader',
  z
    .object({
      id: z.string(),
      object: z.literal('terminal.reader'),
      livemode,
      label: z.string().describe('Your name for the reader.'),
      device_type: z
        .string()
        .describe(
          "The provider's device type (`stripe_s700`, `bbpos_wisepos_e`, `simulated_wisepos_e`, …).",
        ),
      serial_number: z.string(),
      status: z
        .enum(TERMINAL_READER_STATUSES)
        .nullable()
        .describe('Whether the provider last saw it online; refreshed on a retrieve.'),
      last_seen_at: unixSeconds.nullable().describe('When the provider last heard from it.'),
      location: expandable(
        'terminal.location',
        'The location (`tml_…`) it is registered to, or the TerminalLocation with `expand[]=location`.',
      ).nullable(),
      action: terminalReaderActionSchema
        .nullable()
        .describe(
          'The PaymentIntent collection it is doing, or last did; `null` before the first.',
        ),
      metadata,
    })
    .strict(),
  {
    examples: [
      {
        id: 'tmr_0193b8f2c1a87d3e9f4b',
        object: 'terminal.reader',
        livemode: false,
        label: 'Front counter',
        device_type: 'simulated_wisepos_e',
        serial_number: '259cd19c-b902-4730-96a1-09183be6e7f7',
        status: 'online',
        last_seen_at: 1793750400,
        location: 'tml_0193b8f2c1a87d3e9f4a',
        action: {
          type: 'process_payment_intent',
          status: 'in_progress',
          failure_code: null,
          failure_message: null,
          process_payment_intent: {
            payment_intent: 'pi_0193b8f2c1a87d3e9f4c',
            process_config: { enable_customer_cancellation: false, skip_tipping: true },
          },
        },
        metadata: {},
      },
    ],
  },
);
export type TerminalReader = Expand<z.output<typeof terminalReaderSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'terminal.reader': TerminalReader;
  }
}

export const deletedTerminalReaderSchema = defineComponent(
  'DeletedTerminalReader',
  deletedOf('terminal.reader'),
);

const label = z.string().trim().min(1).max(TERMINAL_LIMITS.labelMax);

export const createTerminalReaderParams = z
  .object({
    registration_code: z
      .string()
      .trim()
      .min(1)
      .max(TERMINAL_LIMITS.registrationCodeMax)
      .describe(
        'The code the reader shows. In test mode a simulated code (`simulated-wpe`, `simulated-s700`) registers a simulated reader.',
      ),
    location: idParam.describe('The location (`tml_…`) to register it to.'),
    label: label.optional().describe('Defaults to the provider’s name for the device.'),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateTerminalReaderParams = z.input<typeof createTerminalReaderParams>;

export const updateTerminalReaderParams = z
  .object({
    label: label.optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateTerminalReaderParams = z.input<typeof updateTerminalReaderParams>;

export const listTerminalReadersQuery = listQuery({
  location: idParam.optional().describe('Only readers at this location (`tml_…`).'),
  status: z.enum(TERMINAL_READER_STATUSES).optional(),
});
export type ListTerminalReadersParams = z.input<typeof listTerminalReadersQuery>;

export const retrieveTerminalReaderQuery = expandOnlyQuery;
export type RetrieveTerminalReaderParams = z.input<typeof retrieveTerminalReaderQuery>;

export const processPaymentIntentParams = z
  .object({
    payment_intent: idParam.describe(
      'A `card_present` PaymentIntent (`pi_…`) of this merchant that is still waiting for a payment method.',
    ),
    process_config: z
      .object({
        enable_customer_cancellation: z.boolean().optional(),
        skip_tipping: z
          .literal(true)
          .optional()
          .describe('Orbit offers no on-reader tipping: only `true` is accepted.'),
      })
      .strict()
      .optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type ProcessPaymentIntentParams = z.input<typeof processPaymentIntentParams>;

export const terminalReaderActionParams = z.object({ expand: expandParam.optional() }).strict();
export type TerminalReaderActionParams = z.input<typeof terminalReaderActionParams>;

const readerId = { id: 'The reader (`tmr_…`).' };

export const terminalReaderRoutes = [
  defineRoute({
    operationId: 'createTerminalReader',
    method: 'post',
    path: '/v1/terminal/readers',
    tag: 'Terminal',
    summary: 'Register a reader',
    description:
      'Registers the reader showing `registration_code` to a location, at the provider first. Simulated codes are refused in live mode. 503 `terminal_unavailable` when Terminal is not enabled in this mode.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createTerminalReaderParams,
    response: terminalReaderSchema,
    status: 201,
    sdk: 'terminal.readers.create',
    expandable: 'terminal.reader',
  }),
  defineRoute({
    operationId: 'listTerminalReaders',
    method: 'get',
    path: '/v1/terminal/readers',
    tag: 'Terminal',
    summary: 'List readers',
    auth: 'service',
    scope: 'payments:read',
    query: listTerminalReadersQuery,
    response: listOf(terminalReaderSchema),
    sdk: 'terminal.readers.list',
    expandable: 'terminal.reader',
  }),
  defineRoute({
    operationId: 'retrieveTerminalReader',
    method: 'get',
    path: '/v1/terminal/readers/{id}',
    tag: 'Terminal',
    summary: 'Retrieve a reader',
    description:
      'Reconciled with the provider: its `status`, `last_seen_at` and the outcome of an action in progress.',
    auth: 'service',
    scope: 'payments:read',
    params: readerId,
    query: retrieveTerminalReaderQuery,
    response: terminalReaderSchema,
    sdk: 'terminal.readers.retrieve',
    expandable: 'terminal.reader',
  }),
  defineRoute({
    operationId: 'updateTerminalReader',
    method: 'post',
    path: '/v1/terminal/readers/{id}',
    tag: 'Terminal',
    summary: 'Update a reader',
    description: 'The label is sent to the provider; metadata stays in Orbit.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: readerId,
    body: updateTerminalReaderParams,
    response: terminalReaderSchema,
    sdk: 'terminal.readers.update',
    expandable: 'terminal.reader',
  }),
  defineRoute({
    operationId: 'deleteTerminalReader',
    method: 'delete',
    path: '/v1/terminal/readers/{id}',
    tag: 'Terminal',
    summary: 'Delete a reader',
    description:
      'Unregisters it at the provider. Refused with 409 `terminal_reader_busy` while it is collecting a payment.',
    auth: 'service',
    scope: 'payments:write',
    params: readerId,
    response: deletedTerminalReaderSchema,
    sdk: 'terminal.readers.del',
  }),
  defineRoute({
    operationId: 'processTerminalReaderPaymentIntent',
    method: 'post',
    path: '/v1/terminal/readers/{id}/process_payment_intent',
    tag: 'Terminal',
    summary: 'Collect a PaymentIntent on a reader',
    description:
      'The reader asks the cardholder to tap, insert or swipe. Answers the reader with its action `in_progress`; the outcome arrives as `terminal.reader.action_succeeded` or `…action_failed`, and the PaymentIntent moves through its own events. A declined card leaves it `requires_payment_method` with `last_payment_error`, collectable again. 409 `terminal_reader_busy` or `terminal_reader_offline` when the reader cannot take it.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: readerId,
    body: processPaymentIntentParams,
    response: terminalReaderSchema,
    sdk: 'terminal.readers.processPaymentIntent',
    expandable: 'terminal.reader',
  }),
  defineRoute({
    operationId: 'cancelTerminalReaderAction',
    method: 'post',
    path: '/v1/terminal/readers/{id}/cancel_action',
    tag: 'Terminal',
    summary: 'Cancel the reader’s action',
    description:
      'Stops a collection in progress. The PaymentIntent is not canceled: it stays payable, on this reader or another.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: readerId,
    body: terminalReaderActionParams,
    response: terminalReaderSchema,
    sdk: 'terminal.readers.cancelAction',
    expandable: 'terminal.reader',
  }),
] as const;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export const presentPaymentMethodParams = z
  .object({
    type: z
      .literal('card_present')
      .optional()
      .describe(
        'A test card tapped on a simulated reader. To simulate a decline, collect an amount ending in `01` (`call_issuer`) or `05` (`generic_decline`), as on the provider.',
      ),
    expand: expandParam.optional(),
  })
  .strict();
export type PresentPaymentMethodParams = z.input<typeof presentPaymentMethodParams>;

export const terminalTestHelperRoutes = [
  defineRoute({
    operationId: 'presentTerminalReaderPaymentMethod',
    method: 'post',
    path: '/v1/test_helpers/terminal/readers/{id}/present_payment_method',
    tag: 'Test helpers',
    summary: 'Present a card to a simulated reader',
    description:
      'Taps a test card on a simulated reader collecting a PaymentIntent. The outcome follows the same path as a real one: the provider decides it, and its events move the reader and the PaymentIntent. A live credential is refused with 403 `test_mode_only`.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    testModeOnly: true,
    params: readerId,
    body: presentPaymentMethodParams,
    response: terminalReaderSchema,
    sdk: 'testHelpers.terminal.readers.presentPaymentMethod',
    expandable: 'terminal.reader',
  }),
] as const;
