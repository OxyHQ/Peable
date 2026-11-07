import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import { expandOnlyQuery, idParam, listQuery } from '../../common/params';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import {
  VERIFICATION_CHECK_STATUSES,
  VERIFICATION_SESSION_TYPES,
} from '../../vocabulary/identityVerification';
import { verificationErrorSchema, verificationOptionsSchema } from './verificationSessions';

/** One check's outcome: whether it verified, and why not. */
export const verificationCheckSchema = defineComponent(
  'VerificationCheck',
  z
    .object({
      status: z.enum(VERIFICATION_CHECK_STATUSES),
      error: verificationErrorSchema.nullable().describe('Present when `unverified`.'),
    })
    .strict(),
);

/**
 * `identity.verification_report` (`vr_…`) — one attempt's result. Orbit keeps
 * ONLY each check's outcome: the names, dates, numbers, addresses and images
 * the provider read are never stored and never on this object (the session's
 * `verified_outputs` reads the verified data live). A check that did not run is
 * `null`.
 */
export const verificationReportSchema = defineObject(
  'identity.verification_report',
  'VerificationReport',
  z
    .object({
      id: z.string(),
      object: z.literal('identity.verification_report'),
      livemode,
      type: z.enum(VERIFICATION_SESSION_TYPES),
      verification_session: expandable(
        'identity.verification_session',
        'The session (`vs_…`) this attempt belongs to, or the VerificationSession with `expand[]=verification_session`.',
      ),
      options: verificationOptionsSchema,
      document: verificationCheckSchema.nullable(),
      id_number: verificationCheckSchema.nullable(),
      selfie: verificationCheckSchema.nullable(),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'vr_0193b8f2c1a87d3e9f4b',
        object: 'identity.verification_report',
        livemode: false,
        type: 'document',
        verification_session: 'vs_0193b8f2c1a87d3e9f4a',
        options: {
          document: {
            allowed_types: null,
            require_id_number: null,
            require_live_capture: null,
            require_matching_selfie: true,
          },
        },
        document: { status: 'verified', error: null },
        id_number: null,
        selfie: { status: 'verified', error: null },
        created: 1793750460,
      },
    ],
  },
);
export type VerificationReport = Expand<z.output<typeof verificationReportSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'identity.verification_report': VerificationReport;
  }
}

export const listVerificationReportsQuery = listQuery({
  verification_session: idParam.optional().describe("Only this session's reports (`vs_…`)."),
  type: z.enum(VERIFICATION_SESSION_TYPES).optional(),
});
export type ListVerificationReportsParams = z.input<typeof listVerificationReportsQuery>;

export const retrieveVerificationReportQuery = expandOnlyQuery;
export type RetrieveVerificationReportParams = z.input<typeof retrieveVerificationReportQuery>;

export const verificationReportRoutes = [
  defineRoute({
    operationId: 'listVerificationReports',
    method: 'get',
    path: '/v1/identity/verification_reports',
    tag: 'Identity',
    summary: 'List verification reports',
    auth: 'service',
    scope: 'payments:read',
    query: listVerificationReportsQuery,
    response: listOf(verificationReportSchema),
    sdk: 'identity.verificationReports.list',
    expandable: 'identity.verification_report',
  }),
  defineRoute({
    operationId: 'retrieveVerificationReport',
    method: 'get',
    path: '/v1/identity/verification_reports/{id}',
    tag: 'Identity',
    summary: 'Retrieve a verification report',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The verification report (`vr_…`).' },
    query: retrieveVerificationReportQuery,
    response: verificationReportSchema,
    sdk: 'identity.verificationReports.retrieve',
    expandable: 'identity.verification_report',
  }),
] as const;
