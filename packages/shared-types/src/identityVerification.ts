// Identity verification (`vs_…`, `vr_…`, ADR 0023). The wire types are the
// contract's (`@peable.to/contracts`), re-exported here as types; the closed
// value sets come from the zod-free `@peable.to/contracts/vocabulary`. Orbit
// stores each check's outcome only — never the person's documents or data.

export {
  VERIFICATION_CHECK_STATUSES,
  VERIFICATION_DOCUMENT_TYPES,
  VERIFICATION_ERROR_CODES,
  VERIFICATION_ERROR_REASONS,
  VERIFICATION_ID_NUMBER_TYPES,
  VERIFICATION_REDACTION_STATUSES,
  VERIFICATION_SESSION_LIMITS,
  VERIFICATION_SESSION_STATUSES,
  VERIFICATION_SESSION_TYPES,
  VERIFICATION_UNKNOWN_ERROR_REASON,
  isVerificationErrorCode,
  type VerificationCheckStatus,
  type VerificationDocumentType,
  type VerificationErrorCode,
  type VerificationIdNumberType,
  type VerificationRedactionStatus,
  type VerificationSessionStatus,
  type VerificationSessionType,
} from '@peable.to/contracts/vocabulary';

export type {
  CreateVerificationSessionParams,
  ListVerificationReportsParams,
  ListVerificationSessionsParams,
  RetrieveVerificationReportParams,
  RetrieveVerificationSessionParams,
  UpdateVerificationSessionParams,
  VerificationOptionsParams,
  VerificationReport,
  VerificationSession,
  VerificationSessionActionParams,
} from '@peable.to/contracts';
