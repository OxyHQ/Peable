import {
  type PaymentIntentRail,
  type PaymentIntentStatus,
  EXPIRABLE_STATUSES,
  isValidStatusTransition,
} from '@peable.to/shared-types';

/**
 * Events that drive a PaymentIntent through its lifecycle (ADR 0019). Each
 * event maps to a single target status; the target is validated against the
 * shared transition table, against the rail the event belongs to, and against
 * the statuses it may act FROM.
 *
 * Refunds are not here: money coming back is `amount_refunded` and the refund
 * rows, never a status (ADR 0019). A dispute never was.
 */
export type IntentEvent =
  // ── FairCoin (the chain) ─────────────────────────────────────────────────
  /** The payer reported a broadcast txid (`submit_tx`). */
  | 'broadcast'
  /** The watcher saw enough confirmations of a transaction that paid in full. */
  | 'confirmed'
  /** The watcher saw a transaction at the address that paid LESS than the amount. */
  | 'underpaid'
  /** A reorg dropped a succeeded payment back below its threshold. */
  | 'reorg_below_threshold'
  /**
   * The reported transaction was never seen on the chain for a day and its
   * address received nothing: the broadcast is lost (ADR 0021 D9).
   */
  | 'broadcast_lost'
  // ── Either rail ──────────────────────────────────────────────────────────
  /** The expiry clock ran out on a payer who never paid (`abandoned`). */
  | 'expire'
  /** The merchant cancelled it (`POST …/cancel`). */
  | 'cancel'
  // ── Card (ADR 0001 D5) — the provider's own status, one event each ───────
  // Named `card_*` so `RAIL_OF` and `LEGAL_SOURCES` can say which route they
  // mean: since ADR 0019 `requires_action` and `processing` are SHARED with the
  // chain, and only the event can tell a card's `processing` from a payer's
  // broadcast.
  | 'card_requires_payment_method'
  | 'card_requires_confirmation'
  | 'card_requires_action'
  | 'card_processing'
  | 'card_requires_capture'
  | 'card_succeeded'
  /** An attempt failed: the payment returns to `requires_payment_method`. */
  | 'card_failed'
  | 'card_canceled';

function targetStatusFor(event: IntentEvent): PaymentIntentStatus {
  switch (event) {
    case 'broadcast':
      return 'processing';
    case 'confirmed':
      return 'succeeded';
    // Coins arrived and were not enough. Peable never holds them, so it cannot
    // ask for the difference on the same intent: the intent ends, `underpaid`.
    case 'underpaid':
      return 'canceled';
    // Rewind of a succeeded intent — see the exception branch in applyEvent.
    case 'reorg_below_threshold':
      return 'processing';
    case 'broadcast_lost':
      return 'canceled';
    case 'expire':
    case 'cancel':
      return 'canceled';
    case 'card_requires_payment_method':
    case 'card_failed':
      return 'requires_payment_method';
    case 'card_requires_confirmation':
      return 'requires_confirmation';
    case 'card_requires_action':
      return 'requires_action';
    case 'card_processing':
      return 'processing';
    case 'card_requires_capture':
      return 'requires_capture';
    case 'card_succeeded':
      return 'succeeded';
    case 'card_canceled':
      return 'canceled';
  }
}

/** Which rail an event belongs to; `null` for the two that apply to both. */
const RAIL_OF: Record<IntentEvent, PaymentIntentRail | null> = {
  broadcast: 'faircoin',
  confirmed: 'faircoin',
  underpaid: 'faircoin',
  reorg_below_threshold: 'faircoin',
  broadcast_lost: 'faircoin',
  expire: null,
  cancel: null,
  card_requires_payment_method: 'card',
  card_requires_confirmation: 'card',
  card_requires_action: 'card',
  card_processing: 'card',
  card_requires_capture: 'card',
  card_succeeded: 'card',
  card_failed: 'card',
  card_canceled: 'card',
};

/**
 * Where an event may act FROM, narrower than the shared table.
 *
 * The table is ONE table for both rails: it answers "is this a legal edge at
 * all", and it must contain `requires_action → succeeded` for a card whose
 * challenge completed. That edge is not legal on the chain — a FairCoin payment
 * cannot succeed before it was broadcast — so `confirmed` acts only from
 * `processing`, and `broadcast` only from `requires_action`.
 *
 * The cancellable set is Stripe's: anything not yet moving money, plus a held
 * authorization (which a cancellation releases). `processing` is absent — coins
 * on the chain or a charge at the acquirer cannot be called off.
 */
const CANCELLABLE: readonly PaymentIntentStatus[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
];

const LEGAL_SOURCES: Record<IntentEvent, readonly PaymentIntentStatus[]> = {
  broadcast: ['requires_action'],
  confirmed: ['processing'],
  underpaid: ['processing'],
  reorg_below_threshold: ['succeeded'],
  broadcast_lost: ['processing'],
  expire: EXPIRABLE_STATUSES,
  cancel: CANCELLABLE,
  card_requires_payment_method: ['requires_confirmation', 'requires_action', 'processing'],
  card_requires_confirmation: ['requires_payment_method'],
  card_requires_action: ['requires_payment_method', 'requires_confirmation'],
  card_processing: [
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'requires_capture',
  ],
  card_requires_capture: [
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
  ],
  card_succeeded: [
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
  ],
  card_failed: ['requires_confirmation', 'requires_action', 'processing'],
  card_canceled: [...CANCELLABLE, 'processing'],
};

/**
 * Advance an intent's status by applying an event. Fails loud (throws) on any
 * illegal transition — never a silent no-op — so a mis-sequenced caller is
 * caught rather than silently corrupting state.
 *
 * `rail` is required: two rails share `requires_action` and `processing`, and a
 * card event must never move a chain payment (or the reverse) because the
 * statuses happen to match.
 */
export function applyEvent(
  current: PaymentIntentStatus,
  event: IntentEvent,
  rail: PaymentIntentRail,
): PaymentIntentStatus {
  const eventRail = RAIL_OF[event];
  if (eventRail !== null && eventRail !== rail) {
    throw new Error(
      `illegal transition: '${event}' is a ${eventRail} event and this is a ${rail} payment`,
    );
  }
  const target = targetStatusFor(event);

  // Documented exception: a chain reorg can drop an already-succeeded intent
  // below the confirmation threshold, rewinding succeeded -> processing. The
  // ONE transition that bypasses the table (succeeded is otherwise terminal).
  if (event === 'reorg_below_threshold') {
    if (current !== 'succeeded') {
      throw new Error(
        `invalid event 'reorg_below_threshold' from '${current}': only a succeeded intent can reorg below threshold`,
      );
    }
    return target;
  }

  // Idempotent re-poll: the settlement watcher re-observes the same state, and
  // a provider redelivers. Checked BEFORE the source check, so a redelivery is
  // absorbed rather than refused.
  if (current === target) {
    return current;
  }

  const legalSources = LEGAL_SOURCES[event];
  if (!legalSources.includes(current)) {
    throw new Error(
      `illegal transition: cannot apply '${event}' from '${current}' (${legalSources.join(', ')} only)`,
    );
  }

  if (!isValidStatusTransition(current, target)) {
    throw new Error(`illegal transition: cannot apply '${event}' (${current} -> ${target})`);
  }

  return target;
}
