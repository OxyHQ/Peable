import type { PaymentIntent, PaymentIntentStatus } from '@peable.to/shared-types';
import { paymentStatusLabel } from './status';

export type TimelineState = 'done' | 'current' | 'upcoming' | 'failed';

export interface TimelineStep {
  key: string;
  label: string;
  state: TimelineState;
  /** Unix seconds — only where the payment itself records the instant. */
  at?: number;
  detail?: string;
}

const TERMINAL_FAILURES: ReadonlySet<PaymentIntentStatus> = new Set([
  'failed',
  'rejected',
  'expired',
]);
const REFUNDS: ReadonlySet<PaymentIntentStatus> = new Set(['refunded', 'partially_refunded']);
/** `EXPIRABLE_STATUSES` (ADR 0012 D9): the gateway is still waiting on a person. */
const EXPIRABLE: ReadonlySet<PaymentIntentStatus> = new Set([
  'created',
  'awaiting_approval',
  'requires_action',
]);

/**
 * The lifecycle a payment on this rail walks, with the optional detours
 * included only when the payment is ON one: the wire records no per-step
 * history, so a step this payment may have skipped is never drawn as passed.
 */
function lifecycle(intent: PaymentIntent): PaymentIntentStatus[] {
  const detour = (status: PaymentIntentStatus) => (intent.status === status ? [status] : []);
  if (intent.rail === 'card') {
    return ['created', ...detour('requires_action'), 'processing', 'settled'];
  }
  return [
    'created',
    ...detour('awaiting_approval'),
    ...detour('approved'),
    'broadcast',
    'confirming',
    'settled',
  ];
}

function detailFor(intent: PaymentIntent, status: PaymentIntentStatus): string | undefined {
  if (status === 'broadcast' && intent.txid) return `Transaction ${intent.txid}`;
  if (status === 'confirming') {
    return `${intent.confirmations} confirmation${intent.confirmations === 1 ? '' : 's'}`;
  }
  return undefined;
}

/**
 * A status timeline built only from fields the PaymentIntent carries: `created`
 * for the first step, `updated_at` for the step it is on now, `txid` and
 * `confirmations` for the chain steps, `expires_at` while it can still expire.
 * Steps between them are known to have happened but not when, and say so by
 * carrying no time.
 */
export function paymentTimeline(intent: PaymentIntent): TimelineStep[] {
  const path = lifecycle(intent);
  const step = (status: PaymentIntentStatus, state: TimelineState, at?: number): TimelineStep => {
    const detail = detailFor(intent, status);
    return {
      key: status,
      label: paymentStatusLabel(status),
      state,
      ...(at === undefined ? {} : { at }),
      ...(detail === undefined ? {} : { detail }),
    };
  };
  const createdAt = (status: PaymentIntentStatus) =>
    status === 'created' ? intent.created : undefined;

  let steps: TimelineStep[];
  if (TERMINAL_FAILURES.has(intent.status)) {
    // How far it got before it ended: a chain payment with a reported txid was
    // broadcast (`underpaid` is only ever decided after that); anything else is
    // known only to have been created.
    const reached = intent.rail === 'faircoin' && intent.txid ? path.indexOf('broadcast') : 0;
    steps = [
      ...path.slice(0, reached + 1).map((status) => step(status, 'done', createdAt(status))),
      step(intent.status, 'failed', intent.updated_at),
    ];
  } else if (REFUNDS.has(intent.status)) {
    steps = [
      ...path.map((status) => step(status, 'done', createdAt(status))),
      step(intent.status, 'done', intent.updated_at),
    ];
  } else {
    const index = path.indexOf(intent.status);
    steps = path.map((status, i) => {
      if (i < index) return step(status, 'done', createdAt(status));
      if (i > index) return step(status, 'upcoming');
      const final = status === 'settled';
      return step(
        status,
        final ? 'done' : 'current',
        status === 'created' ? intent.created : intent.updated_at,
      );
    });
  }

  if (EXPIRABLE.has(intent.status) && intent.can_expire !== false) {
    steps.push({
      key: 'expires',
      label: 'Expires if unpaid',
      state: 'upcoming',
      at: intent.expires_at,
    });
  }
  return steps;
}
