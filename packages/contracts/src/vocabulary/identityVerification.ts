// Identity verification (`vs_…`, `vr_…`, ADR 0023) — the closed value sets its
// schemas are built from. Zod-free: `@peable.to/shared-types` re-exports them,
// and the backend's CHECK constraints are derived from the same tuples.

/** What a verification session checks — Stripe's two (a dashboard-built flow is not offered). */
export const VERIFICATION_SESSION_TYPES = ['document', 'id_number'] as const;
export type VerificationSessionType = (typeof VERIFICATION_SESSION_TYPES)[number];

/**
 * Where a verification session stands — Stripe's four.
 *
 *  - `requires_input` — waiting for the person (a new session, or a failed attempt: `last_error`).
 *  - `processing`     — submitted; the provider is checking it.
 *  - `verified`       — terminal: every check passed.
 *  - `canceled`       — terminal: it can never be submitted again.
 */
export const VERIFICATION_SESSION_STATUSES = [
  'requires_input',
  'processing',
  'verified',
  'canceled',
] as const;
export type VerificationSessionStatus = (typeof VERIFICATION_SESSION_STATUSES)[number];

/** The identity documents a document check can be limited to. */
export const VERIFICATION_DOCUMENT_TYPES = ['driving_license', 'id_card', 'passport'] as const;
export type VerificationDocumentType = (typeof VERIFICATION_DOCUMENT_TYPES)[number];

/** A single check's outcome on a report. */
export const VERIFICATION_CHECK_STATUSES = ['verified', 'unverified'] as const;
export type VerificationCheckStatus = (typeof VERIFICATION_CHECK_STATUSES)[number];

/**
 * Where a redaction stands: `processing` while the provider erases what it
 * collected (up to four days), then `redacted`.
 */
export const VERIFICATION_REDACTION_STATUSES = ['processing', 'redacted'] as const;
export type VerificationRedactionStatus = (typeof VERIFICATION_REDACTION_STATUSES)[number];

/** The ID number kinds a verified output can name. */
export const VERIFICATION_ID_NUMBER_TYPES = ['br_cpf', 'sg_nric', 'us_ssn'] as const;
export type VerificationIdNumberType = (typeof VERIFICATION_ID_NUMBER_TYPES)[number];

/**
 * Why a verification (or one check of it) failed, and the sentence Orbit says
 * for it. The `reason` on the wire is THIS text, chosen from the code — never
 * the provider's prose (the rule `last_payment_error` follows).
 */
export const VERIFICATION_ERROR_REASONS = {
  abandoned: 'The person began the verification but did not submit it.',
  consent_declined: 'The person declined to be verified.',
  country_not_supported: "The person's country is not supported.",
  device_not_supported: 'The device has no camera, or camera access was refused.',
  document_expired: 'The identity document has expired.',
  document_type_not_supported: 'The identity document is not one of the allowed types.',
  document_unverified_other: 'The identity document could not be verified.',
  email_unverified_other: 'The email address could not be verified.',
  email_verification_declined: 'The email address verification was declined.',
  id_number_insufficient_document_data:
    'The document did not contain enough data to match the ID number.',
  id_number_mismatch: 'The ID number could not be matched.',
  id_number_unverified_other: 'The ID number could not be verified.',
  phone_unverified_other: 'The phone number could not be verified.',
  phone_verification_declined: 'The phone number verification was declined.',
  selfie_document_missing_photo: 'The identity document has no photo of a face.',
  selfie_face_mismatch: "The selfie did not match the document's photo.",
  selfie_manipulated: 'The selfie was manipulated.',
  selfie_unverified_other: 'The selfie could not be verified.',
  under_supported_age: 'The person is under the supported age.',
} as const satisfies Record<string, string>;
export type VerificationErrorCode = keyof typeof VERIFICATION_ERROR_REASONS;
export const VERIFICATION_ERROR_CODES = Object.keys(VERIFICATION_ERROR_REASONS) as [
  VerificationErrorCode,
  ...VerificationErrorCode[],
];

/** The reason given for a failure whose code the provider did not name, or Orbit does not know. */
export const VERIFICATION_UNKNOWN_ERROR_REASON = 'The verification could not be completed.';

/** Whether a string is a verification error code Orbit knows. */
export function isVerificationErrorCode(value: string): value is VerificationErrorCode {
  return Object.hasOwn(VERIFICATION_ERROR_REASONS, value);
}

/** Bounds a verification session is checked against. */
export const VERIFICATION_SESSION_LIMITS = {
  clientReferenceIdMax: 255,
  returnUrlMax: 2048,
} as const;
