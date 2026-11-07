import { z } from 'zod';
import { addressSchema } from '../../common/address';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  retrieveQuery,
} from '../../common/params';
import { livemode, metadata, nullableString, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  VERIFICATION_DOCUMENT_TYPES,
  VERIFICATION_ERROR_CODES,
  VERIFICATION_ID_NUMBER_TYPES,
  VERIFICATION_REDACTION_STATUSES,
  VERIFICATION_SESSION_LIMITS,
  VERIFICATION_SESSION_STATUSES,
  VERIFICATION_SESSION_TYPES,
} from '../../vocabulary/identityVerification';

/**
 * Identity verification (ADR 0023) — Stripe's `identity.verification_session`
 * over the provider's hosted flow. Orbit keeps the session's configuration, its
 * status and the outcome of each check; the person's documents, images and
 * personal data stay at the provider, and `verified_outputs` is read from it
 * live, only when asked for.
 */

/** What the document check requires. Every field is `null` when not set. */
export const verificationDocumentOptionsSchema = defineComponent(
  'VerificationDocumentOptions',
  z
    .object({
      allowed_types: z
        .array(z.enum(VERIFICATION_DOCUMENT_TYPES))
        .nullable()
        .describe('The documents accepted; `null` accepts all three.'),
      require_id_number: z
        .boolean()
        .nullable()
        .describe('Also collect an ID number and check it against the document.'),
      require_live_capture: z
        .boolean()
        .nullable()
        .describe('Refuse uploads: the document must be captured with the camera.'),
      require_matching_selfie: z
        .boolean()
        .nullable()
        .describe("Capture a selfie and compare it with the document's photo."),
    })
    .strict(),
);

/** A session's (and a report's) check options: `document` on a document check, `id_number` on an ID number check. */
export const verificationOptionsSchema = defineComponent(
  'VerificationOptions',
  z
    .object({
      document: verificationDocumentOptionsSchema.optional(),
      id_number: z.object({}).strict().optional(),
    })
    .strict(),
);

/** Why a verification failed: the code, and Orbit's own sentence for it. */
export const verificationErrorSchema = defineComponent(
  'VerificationError',
  z
    .object({
      code: z.enum(VERIFICATION_ERROR_CODES).nullable(),
      reason: z.string().describe("Orbit's explanation of `code` (never the provider's prose)."),
    })
    .strict(),
);

const dateParts = z
  .object({
    day: z.number().int().nullable(),
    month: z.number().int().nullable(),
    year: z.number().int().nullable(),
  })
  .strict();

/**
 * The person's verified data, read from the provider when asked for
 * (`expand[]=verified_outputs` on a retrieve) and never stored by Orbit. `dob`
 * and `id_number` need their own paths (`verified_outputs.dob`,
 * `verified_outputs.id_number`), as on Stripe.
 */
export const verifiedOutputsSchema = defineComponent(
  'VerifiedOutputs',
  z
    .object({
      first_name: nullableString,
      last_name: nullableString,
      address: addressSchema.nullable(),
      email: nullableString,
      phone: nullableString,
      id_number_type: z.enum(VERIFICATION_ID_NUMBER_TYPES).nullable(),
      dob: dateParts.nullable().optional(),
      id_number: nullableString.optional(),
    })
    .strict(),
);

/** `identity.verification_session` (`vs_…`). */
export const verificationSessionSchema = defineObject(
  'identity.verification_session',
  'VerificationSession',
  z
    .object({
      id: z.string(),
      object: z.literal('identity.verification_session'),
      livemode,
      type: z.enum(VERIFICATION_SESSION_TYPES),
      status: z.enum(VERIFICATION_SESSION_STATUSES),
      options: verificationOptionsSchema,
      client_secret: z
        .string()
        .nullable()
        .describe(
          "The provider's short-lived secret for its in-page verification modal. Only on a create or retrieve while `requires_input`; never stored by Orbit, never on a list or an event.",
        ),
      url: z
        .string()
        .nullable()
        .describe(
          'The provider-hosted page that verifies the person (single use, 48 hours). Only on a create or retrieve while `requires_input`; never stored by Orbit, never on a list or an event.',
        ),
      return_url: nullableString.describe('Where the hosted page sends the person when done.'),
      client_reference_id: nullableString.describe('Your own reference for the person.'),
      last_error: verificationErrorSchema
        .nullable()
        .describe('Why the last attempt failed, while `requires_input`.'),
      last_verification_report: expandable(
        'identity.verification_report',
        'The newest report (`vr_…`), or the VerificationReport with `expand[]=last_verification_report`.',
      ).nullable(),
      redaction: z
        .object({ status: z.enum(VERIFICATION_REDACTION_STATUSES) })
        .strict()
        .nullable()
        .describe('`null` until the session is redacted.'),
      verified_outputs: verifiedOutputsSchema
        .nullable()
        .optional()
        .describe(
          'Only with `expand[]=verified_outputs` on a retrieve: read live from the provider, `null` until `verified` or once redacted.',
        ),
      metadata,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'vs_0193b8f2c1a87d3e9f4a',
        object: 'identity.verification_session',
        livemode: false,
        type: 'document',
        status: 'requires_input',
        options: {
          document: {
            allowed_types: ['passport', 'id_card'],
            require_id_number: null,
            require_live_capture: true,
            require_matching_selfie: true,
          },
        },
        client_secret: null,
        url: null,
        return_url: 'https://example.com/verified',
        client_reference_id: 'user_42',
        last_error: null,
        last_verification_report: null,
        redaction: null,
        metadata: {},
        created: 1793750400,
      },
    ],
  },
);
export type VerificationSession = Expand<z.output<typeof verificationSessionSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'identity.verification_session': VerificationSession;
  }
}

/** Where the hosted flow returns the person: https, or http on a loopback host. */
const returnUrlParam = z
  .string()
  .max(VERIFICATION_SESSION_LIMITS.returnUrlMax)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      );
    } catch {
      return false;
    }
  }, 'must be an https URL');

export const verificationOptionsParams = z
  .object({
    document: z
      .object({
        allowed_types: z.array(z.enum(VERIFICATION_DOCUMENT_TYPES)).min(1).max(3).optional(),
        require_id_number: z.boolean().optional(),
        require_live_capture: z.boolean().optional(),
        require_matching_selfie: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type VerificationOptionsParams = z.input<typeof verificationOptionsParams>;

export const createVerificationSessionParams = z
  .object({
    type: z.enum(VERIFICATION_SESSION_TYPES).describe('The check to perform.'),
    options: verificationOptionsParams
      .optional()
      .describe('`document` options apply to a `document` session only.'),
    return_url: returnUrlParam.optional(),
    client_reference_id: z
      .string()
      .min(1)
      .max(VERIFICATION_SESSION_LIMITS.clientReferenceIdMax)
      .optional(),
    metadata: metadataCreateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateVerificationSessionParams = z.input<typeof createVerificationSessionParams>;

export const updateVerificationSessionParams = z
  .object({
    type: z.enum(VERIFICATION_SESSION_TYPES).optional(),
    options: verificationOptionsParams.optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateVerificationSessionParams = z.input<typeof updateVerificationSessionParams>;

export const verificationSessionActionParams = z
  .object({ expand: expandParam.optional() })
  .strict();
export type VerificationSessionActionParams = z.input<typeof verificationSessionActionParams>;

export const listVerificationSessionsQuery = listQuery({
  status: z.enum(VERIFICATION_SESSION_STATUSES).optional(),
  client_reference_id: idParam.optional().describe('Only sessions with this reference.'),
});
export type ListVerificationSessionsParams = z.input<typeof listVerificationSessionsQuery>;

/**
 * A retrieve's `expand[]` also takes `verified_outputs` (and
 * `verified_outputs.dob`, `verified_outputs.id_number`): the person's data,
 * read from the provider for this answer only.
 */
export const retrieveVerificationSessionQuery = retrieveQuery({});
export type RetrieveVerificationSessionParams = z.input<typeof retrieveVerificationSessionQuery>;

const sessionId = { id: 'The verification session (`vs_…`).' };

export const verificationSessionRoutes = [
  defineRoute({
    operationId: 'createVerificationSession',
    method: 'post',
    path: '/v1/identity/verification_sessions',
    tag: 'Identity',
    summary: 'Create a verification session',
    description:
      'Creates the session at the provider and answers its hosted `url` and `client_secret` — this answer and a retrieve are the only places they appear. 503 `identity_unavailable` when identity verification is not enabled in this mode.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createVerificationSessionParams,
    response: verificationSessionSchema,
    status: 201,
    sdk: 'identity.verificationSessions.create',
    expandable: 'identity.verification_session',
  }),
  defineRoute({
    operationId: 'listVerificationSessions',
    method: 'get',
    path: '/v1/identity/verification_sessions',
    tag: 'Identity',
    summary: 'List verification sessions',
    auth: 'service',
    scope: 'payments:read',
    query: listVerificationSessionsQuery,
    response: listOf(verificationSessionSchema),
    sdk: 'identity.verificationSessions.list',
    expandable: 'identity.verification_session',
  }),
  defineRoute({
    operationId: 'retrieveVerificationSession',
    method: 'get',
    path: '/v1/identity/verification_sessions/{id}',
    tag: 'Identity',
    summary: 'Retrieve a verification session',
    description:
      'Reconciled with the provider while not terminal; carries `url` and `client_secret` while `requires_input`. `expand[]=verified_outputs` reads the verified data live.',
    auth: 'service',
    scope: 'payments:read',
    params: sessionId,
    query: retrieveVerificationSessionQuery,
    response: verificationSessionSchema,
    sdk: 'identity.verificationSessions.retrieve',
    expandable: 'identity.verification_session',
  }),
  defineRoute({
    operationId: 'updateVerificationSession',
    method: 'post',
    path: '/v1/identity/verification_sessions/{id}',
    tag: 'Identity',
    summary: 'Update a verification session',
    description:
      'Only while `requires_input`: its `type` and `options` (sent to the provider) and its metadata.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: sessionId,
    body: updateVerificationSessionParams,
    response: verificationSessionSchema,
    sdk: 'identity.verificationSessions.update',
    expandable: 'identity.verification_session',
  }),
  defineRoute({
    operationId: 'cancelVerificationSession',
    method: 'post',
    path: '/v1/identity/verification_sessions/{id}/cancel',
    tag: 'Identity',
    summary: 'Cancel a verification session',
    description: 'Only while `requires_input`; the person can never submit it again.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: sessionId,
    body: verificationSessionActionParams,
    response: verificationSessionSchema,
    sdk: 'identity.verificationSessions.cancel',
    expandable: 'identity.verification_session',
  }),
  defineRoute({
    operationId: 'redactVerificationSession',
    method: 'post',
    path: '/v1/identity/verification_sessions/{id}/redact',
    tag: 'Identity',
    summary: 'Redact a verification session',
    description:
      'Erases what was collected: the provider redacts the session and its reports (`redaction.status` `processing`, then `redacted`); Orbit erases the metadata and `client_reference_id` of the session and of its stored events. A `requires_input` session is also canceled. Irreversible; refused while `processing`.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: sessionId,
    body: verificationSessionActionParams,
    response: verificationSessionSchema,
    sdk: 'identity.verificationSessions.redact',
    expandable: 'identity.verification_session',
  }),
] as const;
