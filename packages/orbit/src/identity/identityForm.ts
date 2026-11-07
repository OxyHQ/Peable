import type {
  CreateVerificationSessionParams,
  VerificationCheckStatus,
  VerificationDocumentType,
  VerificationSession,
  VerificationSessionStatus,
  VerificationSessionType,
} from '@peable.to/shared-types';
import { isOrbitApiError } from '../api/transport';
import type { StatusTone } from '../payments/status';

/**
 * Identity verification as pure data (ADR 0023): the "Verify someone" form,
 * the exact request body, what a session's status allows, and which refusal a
 * gateway answer is.
 *
 * The value sets are restated rather than imported: the
 * `@peable.to/shared-types` root barrel also exports the `node:crypto` webhook
 * signer, which a browser bundle cannot load. `identityForm.test.ts` pins each
 * one to its shared-types original.
 */

export const ORBIT_VERIFICATION_STATUSES: readonly VerificationSessionStatus[] = [
  'requires_input',
  'processing',
  'verified',
  'canceled',
];

export const ORBIT_VERIFICATION_TYPES: readonly VerificationSessionType[] = [
  'document',
  'id_number',
];

export const ORBIT_DOCUMENT_TYPES: readonly VerificationDocumentType[] = [
  'driving_license',
  'id_card',
  'passport',
];

/** `client_reference_id` and `return_url` bounds (`VERIFICATION_SESSION_LIMITS`). */
export const ORBIT_VERIFICATION_LIMITS = {
  clientReferenceIdMax: 255,
  returnUrlMax: 2048,
} as const;

export interface VerificationForm {
  type: VerificationSessionType;
  /** Empty: every document type is accepted. */
  allowedTypes: VerificationDocumentType[];
  requireLiveCapture: boolean;
  requireMatchingSelfie: boolean;
  requireIdNumber: boolean;
  returnUrl: string;
  clientReferenceId: string;
}

export const EMPTY_VERIFICATION_FORM: VerificationForm = {
  type: 'document',
  allowedTypes: [],
  requireLiveCapture: false,
  requireMatchingSelfie: false,
  requireIdNumber: false,
  returnUrl: '',
  clientReferenceId: '',
};

export type VerificationFormError = 'returnUrl' | 'clientReferenceId';

/** Where the hosted flow may send the person back: https, or http on a loopback host. */
export function isReturnUrl(value: string): boolean {
  if (value.length > ORBIT_VERIFICATION_LIMITS.returnUrlMax) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/**
 * The create body, or the first field the gateway would refuse. Document
 * options are sent only on a document session, and only the ones turned on —
 * an option left off is the provider's default.
 */
export function buildVerificationBody(
  form: VerificationForm,
):
  | { ok: true; body: CreateVerificationSessionParams }
  | { ok: false; error: VerificationFormError } {
  const returnUrl = form.returnUrl.trim();
  if (returnUrl !== '' && !isReturnUrl(returnUrl)) return { ok: false, error: 'returnUrl' };
  const reference = form.clientReferenceId.trim();
  if (reference.length > ORBIT_VERIFICATION_LIMITS.clientReferenceIdMax) {
    return { ok: false, error: 'clientReferenceId' };
  }
  const document = {
    ...(form.allowedTypes.length > 0 ? { allowed_types: [...new Set(form.allowedTypes)] } : {}),
    ...(form.requireLiveCapture ? { require_live_capture: true } : {}),
    ...(form.requireMatchingSelfie ? { require_matching_selfie: true } : {}),
    ...(form.requireIdNumber ? { require_id_number: true } : {}),
  };
  return {
    ok: true,
    body: {
      type: form.type,
      ...(form.type === 'document' && Object.keys(document).length > 0
        ? { options: { document } }
        : {}),
      ...(returnUrl !== '' ? { return_url: returnUrl } : {}),
      ...(reference !== '' ? { client_reference_id: reference } : {}),
    },
  };
}

const STATUS_TONES: Record<VerificationSessionStatus, StatusTone> = {
  requires_input: 'warning',
  processing: 'info',
  verified: 'success',
  canceled: 'neutral',
};

export function verificationStatusTone(status: VerificationSessionStatus): StatusTone {
  return STATUS_TONES[status] ?? 'neutral';
}

export function checkStatusTone(status: VerificationCheckStatus): StatusTone {
  return status === 'verified' ? 'success' : 'danger';
}

export type VerificationScreenAction = 'cancel' | 'redact';

/**
 * What the gateway accepts from where the session stands: cancel only while
 * `requires_input`; redact anything not `processing` and not already redacted.
 */
export function verificationActions(
  session: Pick<VerificationSession, 'status' | 'redaction'>,
): VerificationScreenAction[] {
  if (session.redaction !== null) return [];
  const actions: VerificationScreenAction[] = [];
  if (session.status === 'requires_input') actions.push('cancel');
  if (session.status !== 'processing') actions.push('redact');
  return actions;
}

/** Why redact is not offered while `processing` — shown instead of a disabled button with no reason. */
export function redactWaitsForProcessing(
  session: Pick<VerificationSession, 'status' | 'redaction'>,
): boolean {
  return session.redaction === null && session.status === 'processing';
}

/** The hosted link is only on a session the person can still open. */
export function hostedLinkOf(
  session: Pick<VerificationSession, 'status' | 'redaction' | 'url'>,
): string | null {
  return session.status === 'requires_input' && session.redaction === null ? session.url : null;
}

export type IdentityRefusal = 'unavailable' | 'state' | null;

/**
 * Which identity refusal an error is: `identity_unavailable` (503 — Identity is
 * not enabled for this mode) or `verification_session_unexpected_state` (409 —
 * the session moved). Anything else is the gateway's own message.
 */
export function identityRefusal(error: unknown): IdentityRefusal {
  if (!isOrbitApiError(error)) return null;
  if (error.code === 'identity_unavailable') return 'unavailable';
  if (error.code === 'verification_session_unexpected_state') return 'state';
  return null;
}
