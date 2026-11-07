import {
  VERIFICATION_ERROR_REASONS,
  VERIFICATION_UNKNOWN_ERROR_REASON,
  type VerificationErrorCode,
  type VerificationReport,
  type VerificationSession,
} from '@peable.to/shared-types';
import type {
  VerificationCheckRow,
  VerificationReportRow,
  VerificationSessionRow,
} from '../db/identity/verificationRepository';
import type { ProviderVerifiedOutputs } from '../services/providers/provider';
import { toUnix } from './time';

/** `{code, reason}` — the reason is Orbit's sentence for the code, never the provider's. */
function verificationError(code: VerificationErrorCode | null) {
  return {
    code,
    reason: code === null ? VERIFICATION_UNKNOWN_ERROR_REASON : VERIFICATION_ERROR_REASONS[code],
  };
}

/** What only a live provider read can add: the person's single-use credentials and, if asked, their data. */
export interface VerificationSessionLive {
  readonly clientSecret?: string | null;
  readonly url?: string | null;
  readonly verifiedOutputs?: ProviderVerifiedOutputs | null;
}

function toVerifiedOutputsDTO(
  outputs: ProviderVerifiedOutputs | null,
): NonNullable<VerificationSession['verified_outputs']> | null {
  if (outputs === null) return null;
  return {
    first_name: outputs.firstName,
    last_name: outputs.lastName,
    address:
      outputs.address === null
        ? null
        : {
            line1: outputs.address.line1,
            line2: outputs.address.line2,
            city: outputs.address.city,
            state: outputs.address.state,
            postal_code: outputs.address.postalCode,
            country: outputs.address.country,
          },
    email: outputs.email,
    phone: outputs.phone,
    id_number_type: outputs.idNumberType,
    ...(outputs.dob !== undefined ? { dob: outputs.dob } : {}),
    ...(outputs.idNumber !== undefined ? { id_number: outputs.idNumber } : {}),
  };
}

/**
 * A verification session on the wire. Without `live` (a list, an event, a
 * stored replay) `client_secret` and `url` are `null` and `verified_outputs` is
 * absent: Orbit holds none of them.
 */
export function toVerificationSessionDTO(
  row: VerificationSessionRow,
  live: VerificationSessionLive = {},
): VerificationSession {
  const open = row.status === 'requires_input' && row.redactionStatus === null;
  return {
    id: row.publicId,
    object: 'identity.verification_session',
    livemode: row.livemode,
    type: row.type,
    status: row.status,
    options: row.options,
    client_secret: open ? (live.clientSecret ?? null) : null,
    url: open ? (live.url ?? null) : null,
    return_url: row.returnUrl,
    client_reference_id: row.clientReferenceId,
    last_error: row.hasLastError ? verificationError(row.lastErrorCode) : null,
    last_verification_report: row.lastReportPublicId,
    redaction: row.redactionStatus === null ? null : { status: row.redactionStatus },
    ...(live.verifiedOutputs !== undefined
      ? { verified_outputs: toVerifiedOutputsDTO(live.verifiedOutputs) }
      : {}),
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

function checkDTO(check: VerificationCheckRow | null) {
  if (check === null) return null;
  return {
    status: check.status,
    error: check.status === 'unverified' ? verificationError(check.errorCode) : null,
  };
}

/** A report on the wire: each check's outcome, nothing the person submitted. */
export function toVerificationReportDTO(row: VerificationReportRow): VerificationReport {
  return {
    id: row.publicId,
    object: 'identity.verification_report',
    livemode: row.livemode,
    type: row.type,
    verification_session: row.sessionPublicId,
    options: row.options,
    document: checkDTO(row.document),
    id_number: checkDTO(row.idNumber),
    selfie: checkDTO(row.selfie),
    created: toUnix(row.createdAt),
  };
}
