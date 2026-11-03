import { markDisputeEvidenceSubmitted, type DisputeRow } from '../db/disputes/disputeRepository';
import { getDb } from '../db/postgres';
import { selectStoredProvider } from './providers/environmentGuard';
import {
  isDisputeHandlingProvider,
  type DisputeEvidence,
  type ProviderId,
} from './providers/provider';

/** The rail cannot answer disputes — true of the chain rail, which has none. */
export class DisputesUnanswerableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputesUnanswerableError';
  }
}

/** The dispute is not in a state that accepts a response. */
export class DisputeNotAnswerableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeNotAnswerableError';
  }
}

export interface SubmitEvidenceInput {
  readonly dispute: DisputeRow;
  readonly evidence: DisputeEvidence;
}

export interface SubmitEvidenceResult {
  readonly dispute: DisputeRow;
  /** `false` when this dispute had already been answered. */
  readonly submitted: boolean;
}

/**
 * Send a merchant's response to the network.
 *
 * The ORDER is the opposite of every money movement in this gateway, and
 * deliberately: those write a row first so a crash leaves evidence of an
 * attempt that recovery can finish. Here the row is not a record of an attempt
 * — it is a record of a fact at the network — and writing it first would claim
 * a merchant had responded while the call might still fail. With a deadline
 * running, a false "answered" is worse than a retry.
 */
export async function submitDisputeEvidence(
  input: SubmitEvidenceInput,
): Promise<SubmitEvidenceResult> {
  const { dispute } = input;
  if (dispute.evidenceSubmittedAt !== null) {
    // Already answered. History, and submitting is one-way — so this is
    // reported rather than repeated.
    return { dispute, submitted: false };
  }
  if (dispute.status !== 'needs_response') {
    throw new DisputeNotAnswerableError(
      `this dispute is '${dispute.status}' and is not accepting a response`,
    );
  }
  if (dispute.evidenceDueAt !== null && dispute.evidenceDueAt.getTime() <= Date.now()) {
    // The deadline has passed. Refused HERE rather than by the provider,
    // because the merchant needs to know it was the clock and not their
    // request — and because a late submission is the one failure on this
    // surface that no retry fixes.
    throw new DisputeNotAnswerableError('the deadline for responding to this dispute has passed');
  }
  if (!hasAnyEvidence(input.evidence)) {
    // An empty response would be submitted, final, and would say nothing — the
    // worst possible use of a one-shot action.
    throw new DisputeNotAnswerableError('a response needs at least one field');
  }

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

  await provider.submitDisputeEvidence({
    providerObjectId: dispute.providerObjectId,
    evidence: input.evidence,
    // Derived from the dispute's own public id: a retry after a lost response
    // presents the same key, so the provider answers with the submission it
    // already accepted rather than refusing a second one.
    idempotencyKey: `dpev:${dispute.publicId}`,
  });

  // The CLAIM, guarded on the column still being null, so two requests racing
  // cannot both report a submission they made.
  const updated = await markDisputeEvidenceSubmitted(getDb(), dispute.id, new Date());
  return { dispute: updated ?? dispute, submitted: updated !== null };
}

/** Whether the merchant said anything at all. */
function hasAnyEvidence(evidence: DisputeEvidence): boolean {
  return Object.values(evidence).some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}
