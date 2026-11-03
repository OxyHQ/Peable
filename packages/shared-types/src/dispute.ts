// A Dispute (`dp_…`) — the card network holding a payment's money while a
// cardholder contests it. The wire type is the contract's
// (`@peable.to/contracts` `disputeSchema`), re-exported here as a type; the
// value sets are the contract's zod-free vocabulary. `normalizeDisputeReason`
// stays here: it is the one runtime rule over them.
import { DISPUTE_REASONS, type DisputeReason } from '@peable.to/contracts/vocabulary';

export type {
  Dispute,
  DisputeEvidence,
  DisputeEvidenceDetails,
  DisputeEvidenceParams,
  ListDisputesParams,
  UpdateDisputeParams,
} from '@peable.to/contracts';
export {
  DISPUTE_EVIDENCE_TEXT_MAX,
  DISPUTE_FILE_EVIDENCE_FIELDS,
  DISPUTE_REASONS,
  DISPUTE_STATUSES,
  DISPUTE_TEXT_EVIDENCE_FIELDS,
  type DisputeEvidenceField,
  type DisputeFileEvidenceField,
  type DisputeReason,
  type DisputeStatus,
  type DisputeTextEvidenceField,
} from '@peable.to/contracts/vocabulary';

/** Map any provider reason onto {@link DisputeReason}: unknown or absent is `general`. */
export function normalizeDisputeReason(reason: string | null | undefined): DisputeReason {
  return (DISPUTE_REASONS as readonly string[]).includes(reason ?? '')
    ? (reason as DisputeReason)
    : 'general';
}
