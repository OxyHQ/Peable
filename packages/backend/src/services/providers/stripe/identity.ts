/**
 * Stripe Identity in the gateway's vocabulary (ADR 0023) — and the firewall
 * for the person's data.
 *
 * A Stripe VerificationSession read with its report expanded carries names,
 * dates of birth, document numbers, addresses and the ids of the captured
 * images. Everything that leaves this module is the verdict: statuses, error
 * CODES (never Stripe's prose), and the person's single-use `url` /
 * `client_secret` for the caller to hand on. `verified_outputs` leaves only
 * through {@link toVerifiedOutputs}, for a retrieve that asked for it, and is
 * never stored by anyone.
 */
import type Stripe from 'stripe';
import {
  isVerificationErrorCode,
  VERIFICATION_DOCUMENT_TYPES,
  VERIFICATION_ID_NUMBER_TYPES,
  type VerificationCheckStatus,
  type VerificationDocumentType,
  type VerificationErrorCode,
  type VerificationIdNumberType,
  type VerificationRedactionStatus,
  type VerificationSessionStatus,
  type VerificationSessionType,
} from '@peable.to/shared-types';
import {
  ProviderError,
  type ProviderVerificationCheck,
  type ProviderVerificationOptions,
  type ProviderVerificationReport,
  type ProviderVerificationSession,
  type ProviderVerifiedOutputs,
} from '../provider';

const STATUSES: ReadonlySet<string> = new Set<VerificationSessionStatus>([
  'requires_input',
  'processing',
  'verified',
  'canceled',
]);

function sessionType(type: string | null | undefined): VerificationSessionType {
  if (type === 'document' || type === 'id_number') return type;
  // A dashboard-built verification flow is never created here.
  throw new ProviderError({
    provider: 'stripe',
    stage: 'identity',
    message: `unsupported verification session type '${String(type)}'`,
    retryable: false,
  });
}

function errorCodeOf(code: string | null | undefined): VerificationErrorCode | null {
  return typeof code === 'string' && isVerificationErrorCode(code) ? code : null;
}

function checkOf(
  check: { status: string; error: { code: string | null } | null } | null | undefined,
): ProviderVerificationCheck | null {
  if (!check) return null;
  if (check.status !== 'verified' && check.status !== 'unverified') return null;
  const status: VerificationCheckStatus = check.status;
  return {
    status,
    errorCode: status === 'unverified' ? errorCodeOf(check.error?.code) : null,
  };
}

/** A report's outcomes — the only fields of it that cross. */
export function toVerificationReport(
  report: Stripe.Identity.VerificationReport,
): ProviderVerificationReport {
  return {
    providerObjectId: report.id,
    type: sessionType(report.type),
    document: checkOf(report.document),
    idNumber: checkOf(report.id_number),
    selfie: checkOf(report.selfie),
  };
}

function redactionOf(
  redaction: Stripe.Identity.VerificationSession['redaction'],
): VerificationRedactionStatus | null {
  const status = redaction?.status;
  if (status === 'processing') return 'processing';
  if (status === 'redacted') return 'redacted';
  // `validated` is "associated with a redaction job, not redacted".
  return null;
}

export function toVerificationSession(
  session: Stripe.Identity.VerificationSession,
): ProviderVerificationSession {
  if (!STATUSES.has(session.status)) {
    throw new ProviderError({
      provider: 'stripe',
      stage: 'identity',
      message: `unknown verification session status '${session.status}'`,
      retryable: false,
    });
  }
  const report = session.last_verification_report;
  return {
    providerObjectId: session.id,
    status: session.status as VerificationSessionStatus,
    type: sessionType(session.type),
    lastError: session.last_error ? { errorCode: errorCodeOf(session.last_error.code) } : null,
    clientSecret: session.client_secret ?? null,
    url: session.url ?? null,
    lastReport: report !== null && typeof report === 'object' ? toVerificationReport(report) : null,
    redaction: redactionOf(session.redaction),
  };
}

function isDocumentType(value: string): value is VerificationDocumentType {
  return (VERIFICATION_DOCUMENT_TYPES as readonly string[]).includes(value);
}

function isIdNumberType(value: string): value is VerificationIdNumberType {
  return (VERIFICATION_ID_NUMBER_TYPES as readonly string[]).includes(value);
}

/** The check options as Stripe takes them; an `id_number` session takes none. */
export function toStripeOptions(
  type: VerificationSessionType,
  options: ProviderVerificationOptions,
): Stripe.Identity.VerificationSessionCreateParams.Options | undefined {
  const document = options.document;
  if (type !== 'document' || document === undefined) return undefined;
  return {
    document: {
      ...(document.allowedTypes !== undefined
        ? { allowed_types: document.allowedTypes.filter(isDocumentType) }
        : {}),
      ...(document.requireIdNumber !== undefined
        ? { require_id_number: document.requireIdNumber }
        : {}),
      ...(document.requireLiveCapture !== undefined
        ? { require_live_capture: document.requireLiveCapture }
        : {}),
      ...(document.requireMatchingSelfie !== undefined
        ? { require_matching_selfie: document.requireMatchingSelfie }
        : {}),
    },
  };
}

/** The verified data, for ONE answer. `null` when Stripe holds none. */
export function toVerifiedOutputs(
  session: Stripe.Identity.VerificationSession,
  include: { readonly dob: boolean; readonly idNumber: boolean },
): ProviderVerifiedOutputs | null {
  const outputs = session.verified_outputs;
  if (!outputs) return null;
  const address = outputs.address;
  const idNumberType = outputs.id_number_type;
  return {
    firstName: outputs.first_name ?? null,
    lastName: outputs.last_name ?? null,
    address: address
      ? {
          line1: address.line1 ?? null,
          line2: address.line2 ?? null,
          city: address.city ?? null,
          state: address.state ?? null,
          postalCode: address.postal_code ?? null,
          country: address.country ?? null,
        }
      : null,
    email: outputs.email ?? null,
    phone: outputs.phone ?? null,
    idNumberType:
      typeof idNumberType === 'string' && isIdNumberType(idNumberType) ? idNumberType : null,
    ...(include.dob
      ? {
          dob: outputs.dob
            ? {
                day: outputs.dob.day ?? null,
                month: outputs.dob.month ?? null,
                year: outputs.dob.year ?? null,
              }
            : null,
        }
      : {}),
    ...(include.idNumber ? { idNumber: outputs.id_number ?? null } : {}),
  };
}
