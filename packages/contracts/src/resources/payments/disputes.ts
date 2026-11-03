import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import { expandOnlyQuery, idParam, listQuery, metadataUpdateParam } from '../../common/params';
import { amount, currency, livemode, metadata, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  DISPUTE_EVIDENCE_TEXT_MAX,
  DISPUTE_FILE_EVIDENCE_FIELDS,
  DISPUTE_REASONS,
  DISPUTE_STATUSES,
  DISPUTE_TEXT_EVIDENCE_FIELDS,
  type DisputeEvidenceField,
  type DisputeFileEvidenceField,
  type DisputeTextEvidenceField,
} from '../../vocabulary/payments';

/**
 * Disputes (`dp_…`) — the card network holding a payment's money while a
 * cardholder contests it. A dispute is a DEADLINE: `evidence_details.due_by`
 * arrives with it. The network's own dispute id never appears.
 */

/** Every evidence field, `null` when unset. */
const evidenceFields = <T extends z.ZodType>(field: T) =>
  Object.fromEntries(
    [...DISPUTE_TEXT_EVIDENCE_FIELDS, ...DISPUTE_FILE_EVIDENCE_FIELDS].map((name) => [name, field]),
  ) as Record<DisputeEvidenceField, T>;

/**
 * A merchant's evidence as the dispute holds it. Present ONLY on a live read
 * (`GET /v1/disputes/{id}` and the answers of its update and close): the text
 * is read from the provider, where a draft lives (Peable keeps none of its
 * words); the file half is the `file_…` ids attached. Lists and events never
 * carry it.
 */
export const disputeEvidenceSchema = defineComponent(
  'DisputeEvidence',
  z.object(evidenceFields(z.string().nullable())).strict(),
);
export type DisputeEvidence = z.output<typeof disputeEvidenceSchema>;

export const disputeEvidenceDetailsSchema = defineComponent(
  'DisputeEvidenceDetails',
  z
    .object({
      due_by: unixSeconds
        .nullable()
        .describe('When the network stops accepting evidence; `null` once the dispute is closed.'),
      has_evidence: z.boolean().describe('Whether any evidence has been staged or submitted.'),
      past_due: z.boolean().describe('Whether the deadline passed without a submission.'),
      submission_count: z
        .number()
        .int()
        .min(0)
        .max(1)
        .describe('`0` or `1`: a response is one-shot at the network.'),
      submitted_at: unixSeconds
        .nullable()
        .describe('When the response reached the network; `null` while it has not.'),
    })
    .strict(),
);
export type DisputeEvidenceDetails = z.output<typeof disputeEvidenceDetailsSchema>;

export const disputeSchema = defineObject(
  'dispute',
  'Dispute',
  z
    .object({
      id: z.string(),
      object: z.literal('dispute'),
      livemode,
      amount: amount.describe(
        "The DISPUTED amount, which may be less than the payment's: a cardholder can contest part of a charge.",
      ),
      currency,
      charge: expandable('charge', '`ch_…`, or the Charge with `expand[]=charge`.').nullable(),
      payment_intent: expandable(
        'payment_intent',
        'The disputed payment (`pi_…`), or the PaymentIntent with `expand[]=payment_intent`.',
      ),
      status: z
        .enum(DISPUTE_STATUSES)
        .describe(
          '`needs_response` and `under_review` are open; `won` and `lost` are terminal and say where the money ended up.',
        ),
      reason: z.enum(DISPUTE_REASONS),
      is_charge_refundable: z
        .boolean()
        .describe('Whether the disputed payment can still be refunded.'),
      evidence_details: disputeEvidenceDetailsSchema,
      evidence: disputeEvidenceSchema
        .optional()
        .describe('Live reads only: never on a list or an event.'),
      metadata,
      created: unixSeconds,
      updated_at: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'dp_0193b8f2c1a87d3e9f4a',
        object: 'dispute',
        livemode: false,
        amount: '2500',
        currency: 'EUR',
        charge: 'ch_0193b8f2c1a87d3e9f4a',
        payment_intent: 'pi_0193b8f2c1a87d3e9f4a',
        status: 'needs_response',
        reason: 'product_not_received',
        is_charge_refundable: true,
        evidence_details: {
          due_by: 1794355200,
          has_evidence: false,
          past_due: false,
          submission_count: 0,
          submitted_at: null,
        },
        metadata: {},
        created: 1793750400,
        updated_at: 1793750400,
      },
    ],
  },
);
export type Dispute = Expand<z.output<typeof disputeSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    dispute: Dispute;
  }
}

const FILE_ID_MAX = 255;
/** `""` unsets a field, as on Stripe. */
const textEvidence = z.string().max(DISPUTE_EVIDENCE_TEXT_MAX).optional();
const fileEvidence = z.string().max(FILE_ID_MAX).optional();

/**
 * The evidence fields, in the network's names — a CLOSED set. Unknown keys are
 * REFUSED rather than dropped: a merchant who sent `tracking_number` instead of
 * `shipping_tracking_number` would otherwise submit, finally, a response
 * missing the field they relied on.
 */
export const disputeEvidenceParams = z
  .object({
    ...(Object.fromEntries(
      DISPUTE_TEXT_EVIDENCE_FIELDS.map((field) => [field, textEvidence]),
    ) as Record<DisputeTextEvidenceField, typeof textEvidence>),
    ...(Object.fromEntries(
      DISPUTE_FILE_EVIDENCE_FIELDS.map((field) => [field, fileEvidence]),
    ) as Record<DisputeFileEvidenceField, typeof fileEvidence>),
  })
  .strict()
  .describe(
    'Any subset of the fields: a text field is your words (at most 20,000 characters), a file field a `file_…` of purpose `dispute_evidence`. `""` unsets a field.',
  );
export type DisputeEvidenceParams = z.input<typeof disputeEvidenceParams>;

/**
 * `submit: false` (the default) STAGES the evidence: text goes to the provider
 * as a draft, files are attached by id. `submit: true` uploads the attached
 * files and submits everything — ONCE; a second submission is refused.
 */
export const updateDisputeParams = z
  .object({
    evidence: disputeEvidenceParams.optional(),
    metadata: metadataUpdateParam.optional(),
    submit: z.boolean().optional(),
  })
  .strict();
export type UpdateDisputeParams = z.input<typeof updateDisputeParams>;

export const closeDisputeParams = z.object({}).strict();

export const listDisputesQuery = listQuery({
  payment_intent: idParam.optional().describe("Only this payment's disputes (`pi_…`)."),
  charge: idParam.optional().describe("Only this charge's disputes (`ch_…`)."),
});
export type ListDisputesParams = z.input<typeof listDisputesQuery>;

/** The per-payment sub-list: the payment is in the path. */
export const listPaymentIntentDisputesQuery = listQuery({});

const disputeId = { disputeId: 'The dispute (`dp_…`).' };

export const disputeRoutes = [
  defineRoute({
    operationId: 'listPaymentIntentDisputes',
    method: 'get',
    path: '/v1/payment_intents/{intentId}/disputes',
    tag: 'Disputes',
    summary: "List a payment's disputes",
    auth: 'service',
    scope: 'payments:read',
    params: { intentId: 'The payment intent (`pi_…`).' },
    query: listPaymentIntentDisputesQuery,
    response: listOf(disputeSchema),
    sdk: 'disputes.listForPaymentIntent',
    expandable: 'dispute',
  }),
  defineRoute({
    operationId: 'listDisputes',
    method: 'get',
    path: '/v1/disputes',
    tag: 'Disputes',
    summary: 'List disputes',
    auth: 'service',
    scope: 'payments:read',
    query: listDisputesQuery,
    response: listOf(disputeSchema),
    sdk: 'disputes.list',
    expandable: 'dispute',
  }),
  defineRoute({
    operationId: 'retrieveDispute',
    method: 'get',
    path: '/v1/disputes/{disputeId}',
    tag: 'Disputes',
    summary: 'Retrieve a dispute',
    description: 'The one read that carries `evidence`, read live from the provider.',
    auth: 'service',
    scope: 'payments:read',
    params: disputeId,
    query: expandOnlyQuery,
    response: disputeSchema,
    sdk: 'disputes.retrieve',
    expandable: 'dispute',
  }),
  defineRoute({
    operationId: 'updateDispute',
    method: 'post',
    path: '/v1/disputes/{disputeId}',
    tag: 'Disputes',
    summary: 'Update a dispute',
    description:
      'Metadata, a staged draft of evidence, or — with `submit: true` — the one submission. A dispute that no longer takes evidence answers 409.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: disputeId,
    body: updateDisputeParams,
    response: disputeSchema,
    sdk: 'disputes.update',
  }),
  defineRoute({
    operationId: 'closeDispute',
    method: 'post',
    path: '/v1/disputes/{disputeId}/close',
    tag: 'Disputes',
    summary: 'Close a dispute',
    description: 'Accept the dispute: it is lost.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: disputeId,
    body: closeDisputeParams,
    response: disputeSchema,
    sdk: 'disputes.close',
  }),
] as const;
