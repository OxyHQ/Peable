import type { DisputeStatus } from '@peable.to/shared-types';

/**
 * The PROVIDER's dispute vocabulary, mapped onto the gateway's four states.
 *
 * Stripe distinguishes `warning_needs_response` from `needs_response`, and
 * `warning_closed` from `won`/`lost`, because it is describing an inquiry that
 * has not become a formal chargeback yet. A merchant on this gateway needs to
 * know only whether evidence is DUE, whether it is being looked at, and how it
 * ended — so a warning collapses onto the state it is a warning ABOUT (ADR 0001
 * D3: the acquirer's vocabulary does not reach the wire).
 *
 * `warning_closed` maps to `under_review` rather than to an outcome: an inquiry
 * closing is not a dispute being won, and calling it one would report a result
 * the network never gave.
 *
 * `null` for anything unrecognised, which the caller treats as "the event type
 * decides" — a provider adding a state must not silently become an outcome.
 *
 * ONE implementation, read by the event drain and by the Stripe adapter's
 * answers to an update or a close.
 */
export function toDisputeStatus(status: unknown): DisputeStatus | null {
  switch (status) {
    case 'warning_needs_response':
    case 'needs_response':
      return 'needs_response';
    case 'warning_under_review':
    case 'under_review':
    case 'warning_closed':
      return 'under_review';
    case 'won':
      return 'won';
    case 'lost':
      return 'lost';
    default:
      return null;
  }
}
