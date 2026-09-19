import {
  type PaymentIntentStatus,
  isValidStatusTransition,
} from "@peable.to/shared-types";

/**
 * Events that drive a PaymentIntent through its lifecycle. Each event maps to a
 * single target status; the target is validated against the shared transition
 * table (the one exception is documented below).
 */
export type IntentEvent =
  | "deliver"
  | "approve"
  | "reject"
  | "broadcast"
  | "mempool_seen"
  | "confirmed"
  | "underpaid"
  | "expire"
  | "reorg_below_threshold"
  // ── Card rail (ADR 0001 D5) ──────────────────────────────────────────────
  // Named `card_*` rather than reusing the chain events, because the two rails
  // reach some of the same statuses by different routes and a shared event name
  // would make `LEGAL_SOURCES` unable to say which route it meant. `confirmed`
  // in particular is a CHAIN event with `['confirming']` as its only legal
  // source; a card charge that settles in one call comes from `created`.
  | "card_requires_action"
  | "card_processing"
  | "card_settled"
  | "card_failed"
  | "card_canceled"
  // Money going back. Named for the OUTCOME rather than for the refund, because
  // the target depends on the total that has come back and not on this leg: a
  // second partial refund that exhausts the payment is `refund_full`.
  | "refund_partial"
  | "refund_full"
  // ...and money that came back can go away again. A bank can reject a refund
  // days after the provider accepted it (`refund.failed`), and the succeeded
  // total drops — to zero, here. Without this the payment claims `refunded`
  // forever while the money is still with the merchant.
  | "refund_voided";

function targetStatusFor(event: IntentEvent): PaymentIntentStatus {
  switch (event) {
    case "deliver":
      return "awaiting_approval";
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "broadcast":
      return "broadcast";
    case "mempool_seen":
      return "confirming";
    case "confirmed":
      return "settled";
    // Both broadcast and confirming can fail on an under-value tx; target is failed.
    case "underpaid":
      return "failed";
    // Both created and awaiting_approval can expire; target is expired.
    case "expire":
      return "expired";
    // Rewind of a settled intent — see the exception branch in applyEvent.
    case "reorg_below_threshold":
      return "confirming";
    case "card_requires_action":
      return "requires_action";
    case "card_processing":
      return "processing";
    case "card_settled":
      return "settled";
    case "card_failed":
      return "failed";
    // A provider-side cancellation is a REJECTION, not an expiry: expiry is
    // this gateway's own clock running out, and conflating them would make the
    // expiry sweeper's numbers include payments it never expired.
    case "card_canceled":
      return "rejected";
    case "refund_partial":
      return "partially_refunded";
    case "refund_full":
      return "refunded";
    // Every succeeded refund on this payment has since failed, so the money is
    // where it was: with the merchant.
    case "refund_voided":
      return "settled";
  }
}

/**
 * Where an event may act FROM, when the shared table alone is too permissive.
 *
 * The transition table is ONE table for both rails (ADR 0001 D5): it answers
 * "is this a legal lifecycle edge at all", and the card rail legitimately needs
 * `created → settled` for a charge that confirms in a single call with no SCA
 * challenge. That edge is not legal on the chain — a FairCoin payment cannot be
 * confirmed before it was broadcast — and `confirmed` is a CHAIN event, emitted
 * only by the settlement watcher.
 *
 * Without this map, opening that edge for the card rail would have silently
 * legalized `applyEvent('created', 'confirmed')`. The database still refuses the
 * result (`payment_intents_broadcast_requires_txid_check` demands a txid for a
 * settled FairCoin row), so the damage would have been a 500 from a constraint
 * instead of the loud, located error this module exists to raise. An event
 * absent from this map is governed by the shared table alone.
 */
const LEGAL_SOURCES: Partial<Record<IntentEvent, readonly PaymentIntentStatus[]>> = {
  confirmed: ['confirming'],
  mempool_seen: ['broadcast', 'confirming'],
  underpaid: ['broadcast', 'confirming', 'approved'],
  // The card events, bounded to the statuses a card payment can actually be in.
  // The shared table alone would let `card_settled` act from `confirming`,
  // which is a CHAIN status — and the lookup that finds an intent for a
  // provider event cannot reach a faircoin row (it has no provider), so this is
  // defence in depth rather than the only guard. It is here so that if that
  // lookup ever does go wrong, it is a located error naming the event and the
  // status, instead of a settled chain payment with no transaction behind it.
  card_requires_action: ['created'],
  card_processing: ['created', 'requires_action'],
  card_settled: ['created', 'requires_action', 'processing'],
  card_failed: ['created', 'requires_action', 'processing'],
  card_canceled: ['created', 'requires_action'],
  // Money can only come back if it arrived. `partially_refunded` is a legal
  // source for `refund_full` — a second refund exhausting the payment — and is
  // NOT one for `refund_partial` when nothing else changed, which `applyEvent`
  // absorbs as a self-transition while the amounts change.
  //
  // `refunded` IS a source for `refund_partial`: a fully-refunded payment whose
  // second refund was rejected by the bank drops back to partial, and the
  // target is recomputed from the sum rather than stepped.
  refund_partial: ['settled', 'refunded'],
  refund_full: ['settled', 'partially_refunded'],
  // Only from a status that claims money came back. A `settled` payment with no
  // refunds is absorbed by the self-transition; anything else reaching here
  // would be this event inventing a settlement.
  refund_voided: ['refunded', 'partially_refunded'],
};

/**
 * Advance an intent's status by applying an event. Fails loud (throws) on any
 * illegal transition — never a silent no-op — so a mis-sequenced caller is
 * caught rather than silently corrupting state.
 */
export function applyEvent(
  current: PaymentIntentStatus,
  event: IntentEvent,
): PaymentIntentStatus {
  const target = targetStatusFor(event);

  // Documented exception: a chain reorg can drop an already-settled intent
  // below the confirmation threshold, rewinding settled -> confirming. This is
  // the ONE transition that bypasses the happy-path table (settled is
  // otherwise terminal), so it is NOT validated via isValidStatusTransition.
  // It is only ever legal from settled.
  if (event === "reorg_below_threshold") {
    if (current !== "settled") {
      throw new Error(
        `invalid event 'reorg_below_threshold' from '${current}': only a settled intent can reorg below threshold`,
      );
    }
    return target;
  }

  // Idempotent re-poll: the settlement watcher may re-observe the same mempool
  // state (e.g. mempool_seen while already confirming). Returning the current
  // status unchanged lets the watcher re-check safely without tripping the
  // fail-loud guard below.
  //
  // Checked BEFORE `LEGAL_SOURCES`, and the order is load-bearing: `confirming`
  // is a legal source for `mempool_seen` precisely so this branch can absorb the
  // re-poll, and a source check placed first would have to list every status an
  // event may idempotently re-observe from as well as act from.
  if (current === target) {
    return current;
  }

  const legalSources = LEGAL_SOURCES[event];
  if (legalSources && !legalSources.includes(current)) {
    throw new Error(
      `illegal transition: cannot apply '${event}' from '${current}' (${legalSources.join(', ')} only)`,
    );
  }

  if (!isValidStatusTransition(current, target)) {
    throw new Error(
      `illegal transition: cannot apply '${event}' (${current} -> ${target})`,
    );
  }

  return target;
}
