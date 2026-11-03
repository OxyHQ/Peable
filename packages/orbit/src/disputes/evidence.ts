import type {
  Dispute,
  DisputeEvidenceField,
  DisputeEvidenceParams,
  DisputeFileEvidenceField,
  DisputeReason,
  DisputeStatus,
  DisputeTextEvidenceField,
  FilePurpose,
  FileType,
  FileUploadPurpose,
} from '@peable.to/shared-types';
import { labelFor, t } from '../i18n';
import type { StatusTone } from '../payments/status';

/**
 * The dispute and file vocabulary Orbit needs at runtime, restated from
 * `@peable.to/shared-types` (whose root barrel a browser bundle must not load,
 * see `format/money.ts`) and pinned to the originals by `evidence.test.ts`.
 */
export const ORBIT_DISPUTE_TEXT_FIELDS: readonly DisputeTextEvidenceField[] = [
  'product_description',
  'customer_name',
  'customer_email_address',
  'customer_purchase_ip',
  'billing_address',
  'shipping_address',
  'shipping_carrier',
  'shipping_date',
  'shipping_tracking_number',
  'service_date',
  'access_activity_log',
  'cancellation_policy_disclosure',
  'cancellation_rebuttal',
  'duplicate_charge_explanation',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'uncategorized_text',
];

export const ORBIT_DISPUTE_FILE_FIELDS: readonly DisputeFileEvidenceField[] = [
  'receipt',
  'customer_communication',
  'customer_signature',
  'shipping_documentation',
  'service_documentation',
  'refund_policy',
  'cancellation_policy',
  'duplicate_charge_documentation',
  'uncategorized_file',
];

/** Which text fields deserve a multi-line input. */
const LONG_TEXT_FIELDS: ReadonlySet<DisputeTextEvidenceField> = new Set([
  'product_description',
  'billing_address',
  'shipping_address',
  'access_activity_log',
  'cancellation_policy_disclosure',
  'cancellation_rebuttal',
  'duplicate_charge_explanation',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'uncategorized_text',
]);

export function isLongTextField(field: DisputeTextEvidenceField): boolean {
  return LONG_TEXT_FIELDS.has(field);
}

export function evidenceFieldLabel(field: DisputeEvidenceField): string {
  return labelFor('evidence.field', field);
}

export const ORBIT_DISPUTE_STATUSES: readonly DisputeStatus[] = [
  'needs_response',
  'under_review',
  'won',
  'lost',
];

const STATUS_TONES: Record<DisputeStatus, StatusTone> = {
  needs_response: 'warning',
  under_review: 'info',
  won: 'success',
  lost: 'danger',
};

export function disputeStatusLabel(status: DisputeStatus): string {
  return labelFor('dispute.status', status);
}

export function disputeStatusTone(status: DisputeStatus): StatusTone {
  return STATUS_TONES[status] ?? 'neutral';
}

/** Every reason Orbit can word (`dispute.reason.*`); pinned to `DISPUTE_REASONS`. */
export const ORBIT_DISPUTE_REASONS: readonly DisputeReason[] = [
  'bank_cannot_process',
  'check_returned',
  'credit_not_processed',
  'customer_initiated',
  'debit_not_authorized',
  'duplicate',
  'fraudulent',
  'general',
  'incorrect_account_details',
  'insufficient_funds',
  'noncompliant',
  'product_not_received',
  'product_unacceptable',
  'subscription_canceled',
  'unrecognized',
];

export function disputeReasonLabel(reason: DisputeReason): string {
  return labelFor('dispute.reason', reason);
}

/** Restated `FILE_PURPOSE_POLICIES`, pinned by test: the gateway stays the authority. */
export const ORBIT_FILE_POLICIES: Readonly<
  Record<FilePurpose, { readonly types: readonly FileType[]; readonly max_bytes: number }>
> = {
  dispute_evidence: { types: ['pdf', 'png', 'jpg'], max_bytes: 5 * 1024 * 1024 },
  business_logo: { types: ['png', 'jpg'], max_bytes: 512 * 1024 },
  identity_document: { types: ['pdf', 'png', 'jpg'], max_bytes: 10 * 1024 * 1024 },
  additional_verification: { types: ['pdf', 'png', 'jpg'], max_bytes: 10 * 1024 * 1024 },
  // A report run's CSV: written by Peable, never uploaded (not a `FileUploadPurpose`).
  finance_report_run: { types: ['csv'], max_bytes: 64 * 1024 * 1024 },
};

/** Filename extensions a picker should offer for `purpose` (`jpg` also as `jpeg`). */
export function allowedExtensions(purpose: FileUploadPurpose): string[] {
  return ORBIT_FILE_POLICIES[purpose].types.flatMap((type) =>
    type === 'jpg' ? ['jpg', 'jpeg'] : [type],
  );
}

/**
 * A friendly refusal before an upload the gateway would refuse anyway, or
 * `null` when the file looks acceptable. Judged by extension and size only:
 * the gateway recognises the format from the bytes and is the authority.
 */
export function fileRefusal(
  file: { name: string; size: number },
  purpose: FileUploadPurpose,
): string | null {
  const policy = ORBIT_FILE_POLICIES[purpose];
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
  if (!extension || !allowedExtensions(purpose).includes(extension)) {
    return t('files.refusal.type', {
      types: policy.types.map((type) => type.toUpperCase()).join(', '),
    });
  }
  if (file.size > policy.max_bytes) {
    return t('files.refusal.size', { size: formatBytes(policy.max_bytes) });
  }
  if (file.size === 0) return t('files.refusal.empty');
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The evidence as the form edits it: every field a string, `''` when unset. */
export type EvidenceForm = Record<DisputeEvidenceField, string>;

const ALL_FIELDS: readonly DisputeEvidenceField[] = [
  ...ORBIT_DISPUTE_TEXT_FIELDS,
  ...ORBIT_DISPUTE_FILE_FIELDS,
];

export function formFromDispute(dispute: Dispute): EvidenceForm {
  const form = {} as EvidenceForm;
  for (const field of ALL_FIELDS) form[field] = dispute.evidence?.[field] ?? '';
  return form;
}

/**
 * Only what changed since the gateway's own copy: a field the merchant edited,
 * and `''` for one they cleared (which UNSETS it). Text is trimmed so trailing
 * whitespace is never a change.
 */
export function evidenceChanges(dispute: Dispute, form: EvidenceForm): DisputeEvidenceParams {
  const changes: DisputeEvidenceParams = {};
  for (const field of ALL_FIELDS) {
    const before = dispute.evidence?.[field] ?? '';
    const after = form[field].trim();
    if (after !== before) changes[field] = after;
  }
  return changes;
}

/** Whether the response would carry anything at all — an empty submission is refused. */
export function formHasEvidence(form: EvidenceForm): boolean {
  return ALL_FIELDS.some((field) => form[field].trim().length > 0);
}

/**
 * Whether the response can still be edited. A response is one-shot at the
 * card network: once submitted, or once the dispute left `needs_response`, or
 * once the deadline passed, the form is read-only.
 */
export function evidenceLocked(dispute: Dispute, now: number): boolean {
  const details = dispute.evidence_details;
  if (details.submission_count >= 1) return true;
  if (dispute.status !== 'needs_response') return true;
  if (details.past_due) return true;
  return details.due_by !== null && details.due_by <= now;
}

/** Why the form is read-only, in the merchant's words. */
export function lockedReason(dispute: Dispute, now: number): string | null {
  if (!evidenceLocked(dispute, now)) return null;
  if (dispute.evidence_details.submission_count >= 1) return t('dispute.locked.submitted');
  if (dispute.status === 'won' || dispute.status === 'lost') return t('dispute.locked.closed');
  if (dispute.status === 'under_review') return t('dispute.locked.review');
  return t('dispute.locked.pastDue');
}
