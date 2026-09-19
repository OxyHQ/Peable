/**
 * Answering a dispute — the half of this surface that did not exist.
 *
 * ## Why there was no write here, and why there is one now
 *
 * `routes/disputes.ts` was read-only, and its own docblock explained that:
 * submitting evidence needs a provider-port method that did not exist, and
 * *"adding the route without it would give merchants a surface that accepts
 * their evidence and does nothing with it, which is worse for them than having
 * no route at all: they would believe they had responded."*
 *
 * That was the right call while the port was missing. It is not a permanent
 * position — the deadline was exposed and the response was not, so a merchant
 * could read `evidenceDueAt`, watch it pass, and lose a dispute this gateway
 * had told them about and given them no way to answer. The port has the method
 * now (`DisputeHandlingProvider`), so the route exists.
 *
 * ## One shot, and nothing kept
 *
 * **Submitting is one-way at the network.** Stripe's update call doubles as a
 * draft save and the draft is final once submitted, so offering both would owe
 * every draft a durable identity to keep a retry from becoming a second write —
 * cost out of proportion to the value. This submits. A second attempt is
 * refused by reading `evidence_submitted_at`, not by asking the provider and
 * interpreting an error.
 *
 * **The evidence is never stored.** It carries a customer's name, their email,
 * a billing address and correspondence: `redactProviderPayload` exists because
 * this gateway does not keep that class of data, and a dispute response is the
 * richest example of it the system handles. It is forwarded and forgotten; what
 * is recorded is THAT a response was submitted and when. What it said is at the
 * acquirer, readable by someone with their own authorization.
 *
 * **Files are out of scope, explicitly.** Attachments need the provider's
 * upload API, a size and type policy, and somewhere for the bytes to live on
 * the way through. Offering half of that would let a merchant submit a defence
 * missing the receipt it rests on — which is the same failure the read-only
 * route was avoiding, one level down.
 */
import type { MerchantEnvironment } from "@peable.to/shared-types";
import {
  markDisputeEvidenceSubmitted,
  type DisputeRow,
} from "../db/disputes/disputeRepository";
import { getDb } from "../db/postgres";
import { assertEnvironmentMatchesProvider } from "./providers/environmentGuard";
import {
  isDisputeHandlingProvider,
  type DisputeEvidence,
  type ProviderId,
} from "./providers/provider";
import { resolveProvider } from "./providers/registry";

/** The rail cannot answer disputes — true of the chain rail, which has none. */
export class DisputesUnanswerableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisputesUnanswerableError";
  }
}

/** The dispute is not in a state that accepts a response. */
export class DisputeNotAnswerableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisputeNotAnswerableError";
  }
}

export interface SubmitEvidenceInput {
  readonly environment: MerchantEnvironment;
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
  // FIRST, like every other money-adjacent operation: a wrong-mode credential
  // must not be able to act, nor to learn a dispute's state from which refusal
  // it gets back.
  assertEnvironmentMatchesProvider(input.environment);

  if (dispute.evidenceSubmittedAt !== null) {
    // Already answered. History, and submitting is one-way — so this is
    // reported rather than repeated.
    return { dispute, submitted: false };
  }
  if (dispute.status !== "needs_response") {
    throw new DisputeNotAnswerableError(
      `this dispute is '${dispute.status}' and is not accepting a response`,
    );
  }
  if (dispute.evidenceDueAt !== null && dispute.evidenceDueAt.getTime() <= Date.now()) {
    // The deadline has passed. Refused HERE rather than by the provider,
    // because the merchant needs to know it was the clock and not their
    // request — and because a late submission is the one failure on this
    // surface that no retry fixes.
    throw new DisputeNotAnswerableError(
      "the deadline for responding to this dispute has passed",
    );
  }
  if (!hasAnyEvidence(input.evidence)) {
    // An empty response would be submitted, final, and would say nothing — the
    // worst possible use of a one-shot action.
    throw new DisputeNotAnswerableError("a response needs at least one field");
  }

  const provider = resolveProvider(dispute.provider as ProviderId);
  if (!provider) {
    throw new DisputesUnanswerableError(
      `the ${dispute.provider} rail is not configured on this deployment`,
    );
  }
  if (!isDisputeHandlingProvider(provider)) {
    throw new DisputesUnanswerableError(
      `the ${provider.id} rail cannot answer disputes`,
    );
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
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}
