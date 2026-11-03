/**
 * Answering a dispute: stage evidence, submit it ONCE, or accept the dispute.
 *
 * ## The provider is the store of a draft, and Peable keeps none of it
 *
 * Stripe's `disputes.update` holds a response in progress (`submit: false`) and
 * delivers it (`submit: true`). Peable forwards the TEXT of a draft there and
 * records only what the provider answered: THAT evidence is staged
 * (`disputes.has_evidence`). A merchant reading their dispute back gets the
 * text live from the provider (`readDisputeEvidence`), never from a copy —
 * because there is no copy. The words carry a customer's name, email, address
 * and correspondence, and this gateway does not keep that class of data.
 *
 * FILES are the merchant's own uploads (`file_…`, purpose `dispute_evidence`),
 * attached by id (`dispute_evidence_files`). Their bytes go to the provider at
 * SUBMISSION time and only then: each is uploaded under a key derived from the
 * dispute, the field and the File, so a retried submission uploads nothing
 * twice, and the provider's file ids are used in that one call and forgotten.
 *
 * ## One shot
 *
 * Submitting is one-way at the network. A dispute already submitted refuses
 * every further evidence write — a second submission and a late draft alike —
 * by reading `evidence_submitted_at` rather than asking the provider, and the
 * write that records the submission is a CLAIM guarded on that column still
 * being null, so two racing submissions cannot both report one.
 *
 * ## The order is the opposite of a money movement's
 *
 * Those write a row first so a crash leaves evidence of an attempt. Here the
 * row records a FACT at the network: writing "submitted" before the provider
 * accepted it would claim a response the merchant may not have given, and with
 * a deadline running a false "answered" is worse than a retry.
 */
import {
  DISPUTE_FILE_EVIDENCE_FIELDS,
  DISPUTE_TEXT_EVIDENCE_FIELDS,
  type DisputeEvidence,
  type DisputeEvidenceParams,
  type DisputeFileEvidenceField,
  type DisputeTextEvidenceField,
} from '@peable.to/shared-types';
import {
  closeDisputeAsLost,
  findDisputeByPublicId,
  listDisputeEvidenceFiles,
  markDisputeEvidenceSubmitted,
  recordDisputeDraft,
  setDisputeEvidenceFiles,
  updateDisputeMetadata,
  type DisputeRow,
} from '../db/disputes/disputeRepository';
import { findFileByPublicId, findFilesByIds, type FileRow } from '../db/files/fileRepository';
import type { MetadataPatch } from '../db/metadata';
import { findIntentById, type PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { getDb } from '../db/postgres';
import { disputes } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { toDisputeDTO } from '../lib/serialize';
import { recordDisputeEvent } from './intentTransition';
import type { OxyFilesClient } from './oxyFiles/client';
import { FileRequestError, readFileBytes } from './files';
import { selectStoredProvider } from './providers/environmentGuard';
import {
  isDisputeHandlingProvider,
  type DisputeHandlingProvider,
  type ProviderDisputeEvidence,
  type ProviderDisputeSnapshot,
  type ProviderId,
} from './providers/provider';

/**
 * The combined size of the files one submission may carry — the card
 * networks' ceiling for a whole response, restated so it is refused before
 * anything is uploaded rather than by the network after.
 */
export const DISPUTE_EVIDENCE_SUBMISSION_MAX_BYTES = 5 * 1024 * 1024;

/** The rail cannot answer disputes, or its key for this mode is absent: a 503. */
export class DisputesUnanswerableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputesUnanswerableError';
  }
}

/** The dispute is not in a state that accepts this — a 409. */
export class DisputeNotAnswerableError extends Error {
  constructor(
    message: string,
    readonly code: 'dispute_already_submitted' | 'dispute_not_answerable',
  ) {
    super(message);
    this.name = 'DisputeNotAnswerableError';
  }
}

/** A field the merchant sent cannot be used — a 400 naming it. */
export class DisputeParameterError extends Error {
  constructor(
    message: string,
    readonly param: string,
  ) {
    super(message);
    this.name = 'DisputeParameterError';
  }
}

const TEXT_FIELDS: ReadonlySet<string> = new Set(DISPUTE_TEXT_EVIDENCE_FIELDS);
const FILE_FIELDS: ReadonlySet<string> = new Set(DISPUTE_FILE_EVIDENCE_FIELDS);

function answeringProvider(dispute: DisputeRow): DisputeHandlingProvider {
  // The dispute's own mode (ADR 0017): it is answered through the key whose
  // charge was disputed.
  const provider = selectStoredProvider(dispute.provider as ProviderId, dispute.livemode);
  if (!provider) {
    throw new DisputesUnanswerableError(
      `the ${dispute.provider} rail is not configured for ${dispute.livemode ? 'live' : 'test'} mode on this deployment`,
    );
  }
  if (!isDisputeHandlingProvider(provider)) {
    throw new DisputesUnanswerableError(`the ${provider.id} rail cannot answer disputes`);
  }
  return provider;
}

/** The disputed payment. Structurally present: `on delete restrict`. */
async function intentOf(dispute: DisputeRow): Promise<PaymentIntentRow> {
  const intent = await findIntentById(getDb(), dispute.paymentIntentId);
  if (!intent) {
    throw new Error(`dispute ${dispute.publicId} names an intent that cannot be read`);
  }
  return intent;
}

/** The provider's text and Peable's file ids, as one evidence object. */
function assembleEvidence(
  text: Readonly<Record<DisputeTextEvidenceField, string | null>>,
  attached: readonly { field: DisputeFileEvidenceField; filePublicId: string }[],
): DisputeEvidence {
  const evidence = {} as Record<string, string | null>;
  for (const field of DISPUTE_TEXT_EVIDENCE_FIELDS) evidence[field] = text[field] ?? null;
  for (const field of DISPUTE_FILE_EVIDENCE_FIELDS) evidence[field] = null;
  for (const file of attached) evidence[file.field] = file.filePublicId;
  return evidence as DisputeEvidence;
}

/**
 * The evidence of a dispute, read LIVE: the text from the provider (where a
 * draft lives), the files from this database (ids only).
 */
export async function readDisputeEvidence(dispute: DisputeRow): Promise<DisputeEvidence> {
  const snapshot = await answeringProvider(dispute).getDispute(dispute.providerObjectId);
  return assembleEvidence(snapshot.evidence, await listDisputeEvidenceFiles(getDb(), dispute.id));
}

/** Refuse an evidence write the dispute can no longer take. */
function assertAnswerable(dispute: DisputeRow, now: Date): void {
  if (dispute.evidenceSubmittedAt !== null) {
    throw new DisputeNotAnswerableError(
      'this dispute has already been answered: a response is submitted once, and the network takes no second one',
      'dispute_already_submitted',
    );
  }
  if (dispute.status !== 'needs_response') {
    throw new DisputeNotAnswerableError(
      `this dispute is '${dispute.status}' and is not accepting a response`,
      'dispute_not_answerable',
    );
  }
  if (dispute.evidenceDueAt !== null && dispute.evidenceDueAt.getTime() <= now.getTime()) {
    // Refused HERE rather than by the provider: the merchant needs to know it
    // was the clock and not their request, and no retry fixes a late answer.
    throw new DisputeNotAnswerableError(
      'the deadline for responding to this dispute has passed',
      'dispute_not_answerable',
    );
  }
}

/** Split the request into text for the provider and file changes for this database. */
async function resolveEvidence(
  dispute: DisputeRow,
  evidence: DisputeEvidenceParams,
): Promise<{
  text: Partial<Record<DisputeTextEvidenceField, string>>;
  fileChanges: { field: DisputeFileEvidenceField; file: FileRow | null }[];
}> {
  const text: Partial<Record<DisputeTextEvidenceField, string>> = {};
  const fileChanges: { field: DisputeFileEvidenceField; file: FileRow | null }[] = [];
  for (const [field, value] of Object.entries(evidence)) {
    if (value === undefined) continue;
    if (TEXT_FIELDS.has(field)) {
      text[field as DisputeTextEvidenceField] = value;
      continue;
    }
    if (!FILE_FIELDS.has(field)) continue; // the route's strict schema refused it already
    if (value === '') {
      fileChanges.push({ field: field as DisputeFileEvidenceField, file: null });
      continue;
    }
    // The merchant's OWN file, for disputes, still there. The composite
    // reference refuses anything else; this makes it a 400 naming the field.
    const file = await findFileByPublicId(getDb(), dispute.merchantId, value);
    if (file?.purpose !== 'dispute_evidence' || file.removedAt !== null) {
      throw new DisputeParameterError(
        `evidence[${field}] must name one of your files of purpose dispute_evidence`,
        `evidence[${field}]`,
      );
    }
    fileChanges.push({ field: field as DisputeFileEvidenceField, file });
  }
  return { text, fileChanges };
}

export interface UpdateDisputeInput {
  readonly dispute: DisputeRow;
  readonly evidence?: DisputeEvidenceParams;
  readonly metadata?: MetadataPatch;
  readonly submit: boolean;
  readonly files: OxyFilesClient;
  readonly now?: Date;
}

export interface UpdateDisputeResult {
  readonly dispute: DisputeRow;
  /** The evidence as it now stands, read back from the provider — for THIS response only. */
  readonly evidence: DisputeEvidence;
}

/**
 * `POST /v1/disputes/:id`: metadata (any state), a draft, or the submission.
 *
 * @throws {DisputeNotAnswerableError} evidence on a dispute that takes none.
 * @throws {DisputeParameterError} a file field naming an unusable File.
 * @throws {DisputesUnanswerableError} the rail cannot answer here.
 * @throws {ProviderError} the provider refused or could not be reached; nothing
 *   was recorded as submitted.
 */
export async function updateDispute(input: UpdateDisputeInput): Promise<UpdateDisputeResult> {
  const now = input.now ?? new Date();
  let dispute = input.dispute;
  const evidence = input.evidence ?? {};
  const touchesEvidence = input.submit || Object.keys(evidence).length > 0;

  if (input.metadata !== undefined) {
    const updated = await updateDisputeMetadata(getDb(), dispute.id, input.metadata);
    if (updated === 'limit_exceeded') {
      throw new DisputeParameterError('metadata holds at most 50 keys', 'metadata');
    }
    // Recorded with the rest below; a metadata-only update emits on its own.
    if (!touchesEvidence) {
      const intent = await intentOf(dispute);
      await recordDisputeEvent(
        getDb(),
        intent,
        toDisputeDTO(updated, intent.publicId),
        'charge.dispute.updated',
        { metadata: dispute.metadata },
      );
      return { dispute: updated, evidence: await readDisputeEvidence(updated) };
    }
    dispute = updated;
  }
  if (!touchesEvidence) {
    return { dispute, evidence: await readDisputeEvidence(dispute) };
  }

  assertAnswerable(dispute, now);
  const provider = answeringProvider(dispute);
  const { text, fileChanges } = await resolveEvidence(dispute, evidence);
  const db = getDb();

  // The file attachments are ids, and they are the merchant's draft state —
  // written before the provider is asked, so a submission below reads them.
  if (fileChanges.length > 0) {
    await setDisputeEvidenceFiles(
      db,
      dispute,
      fileChanges.map((change) => ({ field: change.field, fileId: change.file?.id ?? null })),
    );
  }
  const attached = await listDisputeEvidenceFiles(db, dispute.id);

  if (!input.submit) {
    // A DRAFT: the text goes to the provider, which is where it lives.
    const snapshot: ProviderDisputeSnapshot =
      Object.keys(text).length > 0
        ? await provider.updateDisputeEvidence({
            providerObjectId: dispute.providerObjectId,
            evidence: text,
            submit: false,
          })
        : await provider.getDispute(dispute.providerObjectId);
    const staged = await db.transaction(async (tx) => {
      const row = await recordDisputeDraft(tx, dispute.id, {
        hasEvidence: snapshot.hasEvidence || attached.length > 0,
        isChargeRefundable: snapshot.isChargeRefundable,
      });
      if (!row) throw new Error(`dispute ${dispute.publicId} vanished while staging evidence`);
      const intent = await intentOf(row);
      await recordDisputeEvent(
        tx,
        intent,
        toDisputeDTO(row, intent.publicId),
        'charge.dispute.updated',
      );
      return row;
    });
    return { dispute: staged, evidence: assembleEvidence(snapshot.evidence, attached) };
  }

  // THE SUBMISSION.
  const saysSomething =
    Object.values(text).some((value) => value.trim().length > 0) ||
    attached.length > 0 ||
    dispute.hasEvidence;
  if (!saysSomething) {
    // An empty response would be final and would say nothing — the worst
    // possible use of a one-shot action.
    throw new DisputeNotAnswerableError(
      'a response needs at least one field',
      'dispute_not_answerable',
    );
  }

  const fileRows = await findFilesByIds(
    db,
    dispute.merchantId,
    attached.map((file) => file.fileId),
  );
  const byId = new Map(fileRows.map((row) => [row.id, row]));
  const total = fileRows.reduce((sum, row) => sum + row.size, 0);
  if (total > DISPUTE_EVIDENCE_SUBMISSION_MAX_BYTES) {
    throw new DisputeParameterError(
      `the files of one response are at most ${String(DISPUTE_EVIDENCE_SUBMISSION_MAX_BYTES)} bytes together; these are ${String(total)}`,
      'evidence',
    );
  }

  // Each file's bytes go to the provider NOW, under a key derived from the
  // dispute, the field and the File — a retry uploads nothing twice.
  const forwarded: ProviderDisputeEvidence = { ...text };
  for (const file of attached) {
    const row = byId.get(file.fileId);
    if (!row) throw new Error(`file ${file.filePublicId} vanished while submitting`);
    let bytes: { bytes: Uint8Array; mime: string };
    try {
      bytes = await readFileBytes(input.files, row, `evidence[${file.field}]`);
    } catch (error) {
      if (error instanceof FileRequestError) {
        throw new DisputeParameterError(error.message, error.param);
      }
      throw error;
    }
    const uploaded = await provider.uploadDisputeEvidenceFile({
      bytes: bytes.bytes,
      mime: bytes.mime,
      filename: row.filename ?? `${row.publicId}.${row.type}`,
      idempotencyKey: `dpfile:${dispute.publicId}:${file.field}:${row.publicId}`,
    });
    forwarded[file.field] = uploaded.providerFileId;
  }

  const snapshot = await provider.updateDisputeEvidence({
    providerObjectId: dispute.providerObjectId,
    evidence: forwarded,
    submit: true,
    // Derived from the dispute's own public id: a retry after a lost response
    // presents the same key, so the provider answers with the submission it
    // already accepted rather than taking a second one.
    idempotencyKey: `dpev:${dispute.publicId}`,
  });

  const submitted = await db.transaction(async (tx) => {
    // The CLAIM, guarded on the column still being null.
    const claimed = await markDisputeEvidenceSubmitted(tx, dispute.id, now);
    if (!claimed) return null;
    const row = await recordDisputeDraft(tx, dispute.id, {
      hasEvidence: true,
      isChargeRefundable: snapshot.isChargeRefundable,
    });
    if (!row) return null;
    // The network is now reviewing; the provider's event will say so too, and
    // finds the status already moved, so the merchant is told once.
    let reviewed = row;
    if (snapshot.status === 'under_review' && row.status === 'needs_response') {
      await tx
        .update(disputes)
        .set({ status: 'under_review' })
        .where(and(eq(disputes.id, row.id), eq(disputes.status, 'needs_response')));
      reviewed = (await findDisputeByPublicId(tx, row.merchantId, row.publicId)) ?? row;
    }
    const intent = await intentOf(reviewed);
    await recordDisputeEvent(
      tx,
      intent,
      toDisputeDTO(reviewed, intent.publicId),
      'charge.dispute.updated',
      { status: dispute.status },
    );
    return reviewed;
  });
  if (!submitted) {
    // Another request claimed the submission first: this one sent nothing new
    // (same idempotency key), and says so rather than reporting a second one.
    throw new DisputeNotAnswerableError(
      'this dispute has already been answered: a response is submitted once, and the network takes no second one',
      'dispute_already_submitted',
    );
  }
  return { dispute: submitted, evidence: assembleEvidence(snapshot.evidence, attached) };
}

/**
 * `POST /v1/disputes/:id/close` — accept the dispute: it is LOST, and nothing
 * more can be submitted. Asked of the provider first; the row moves only once
 * the provider has accepted, by a compare-and-swap on `needs_response`.
 */
export async function closeDispute(dispute: DisputeRow): Promise<UpdateDisputeResult> {
  if (dispute.status !== 'needs_response' || dispute.evidenceSubmittedAt !== null) {
    throw new DisputeNotAnswerableError(
      `this dispute is '${dispute.status}'${dispute.evidenceSubmittedAt !== null ? ' and answered' : ''} and cannot be accepted`,
      'dispute_not_answerable',
    );
  }
  const provider = answeringProvider(dispute);
  const snapshot = await provider.closeDispute({
    providerObjectId: dispute.providerObjectId,
    idempotencyKey: `dpclose:${dispute.publicId}`,
  });
  const db = getDb();
  const closed = await db.transaction(async (tx) => {
    const row = await closeDisputeAsLost(tx, dispute.id);
    if (!row) return null;
    const intent = await intentOf(row);
    await recordDisputeEvent(
      tx,
      intent,
      toDisputeDTO(row, intent.publicId),
      'charge.dispute.closed',
      {
        status: dispute.status,
      },
    );
    return row;
  });
  // A null is the network's own decision landing first; the row already says it.
  const current = closed ?? (await findDisputeByPublicId(db, dispute.merchantId, dispute.publicId));
  if (!current) throw new Error(`dispute ${dispute.publicId} vanished while closing`);
  return {
    dispute: current,
    evidence: assembleEvidence(snapshot.evidence, await listDisputeEvidenceFiles(db, dispute.id)),
  };
}
