import type { PaymentIntent, PaymentIntentStatus } from '@peable.to/shared-types';
import { formatAmount } from '../format/money';
import { cancellationReasonLabel, paymentStatusLabel } from './status';

export type TimelineState = 'done' | 'current' | 'upcoming' | 'failed';

export interface TimelineStep {
  key: string;
  label: string;
  state: TimelineState;
  /** Unix seconds — only where the payment itself records the instant. */
  at?: number;
  detail?: string;
}

/** `EXPIRABLE_STATUSES` (ADR 0012 D9): the gateway is still waiting on a person. */
const EXPIRABLE: ReadonlySet<PaymentIntentStatus> = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

/**
 * The lifecycle a payment on this rail walks (ADR 0019), with the optional
 * detours included only when the payment is ON one: the wire records no
 * per-step history, so a step this payment may have skipped is never drawn as
 * passed. A FairCoin payment waits on its payer (`requires_action`), is
 * `processing` once a transaction is reported, and succeeds; a card starts
 * waiting for a payment method.
 */
function lifecycle(intent: PaymentIntent): PaymentIntentStatus[] {
  const detour = (status: PaymentIntentStatus) => (intent.status === status ? [status] : []);
  if (intent.rail === 'card') {
    return [
      'requires_payment_method',
      ...detour('requires_confirmation'),
      ...detour('requires_action'),
      'processing',
      ...(intent.capture_method === 'manual' ? (['requires_capture'] as const) : []),
      'succeeded',
    ];
  }
  return ['requires_action', 'processing', 'succeeded'];
}

function detailFor(intent: PaymentIntent, status: PaymentIntentStatus): string | undefined {
  const chain = intent.faircoin;
  if (status === 'processing' && chain?.txid) {
    const { confirmations, required_confirmations: required } = chain;
    return `Transaction ${chain.txid} · ${confirmations} of ${required} confirmation${required === 1 ? '' : 's'}`;
  }
  if (status === 'requires_payment_method' && intent.last_payment_error) {
    return `Last attempt failed: ${intent.last_payment_error.message}`;
  }
  return undefined;
}

/**
 * A status timeline built only from fields the PaymentIntent carries: `created`
 * for the first step, `updated_at` for the step it is on now, the `faircoin`
 * transaction for the chain steps, `expires_at` while it can still expire, and
 * `amount_refunded` for money that came back. Steps between them are known to
 * have happened but not when, and say so by carrying no time.
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
  const first = path[0];
  const createdAt = (status: PaymentIntentStatus) =>
    status === first ? intent.created : undefined;

  let steps: TimelineStep[];
  if (intent.status === 'canceled') {
    // How far it got before it ended: a chain payment with a reported txid was
    // processing (`underpaid` is only ever decided after that); anything else
    // is known only to have been created.
    const reached = intent.faircoin?.txid ? path.indexOf('processing') : 0;
    steps = [
      ...path.slice(0, reached + 1).map((status) => step(status, 'done', createdAt(status))),
      {
        key: 'canceled',
        label: paymentStatusLabel('canceled'),
        state: 'failed',
        at: intent.canceled_at ?? intent.updated_at,
        detail: cancellationReasonLabel(intent.cancellation_reason),
      },
    ];
  } else {
    const index = path.indexOf(intent.status);
    steps = path.map((status, i) => {
      if (i < index) return step(status, 'done', createdAt(status));
      if (i > index) return step(status, 'upcoming');
      const final = status === 'succeeded';
      return step(
        status,
        final ? 'done' : 'current',
        status === first ? intent.created : intent.updated_at,
      );
    });
  }

  // Money back is an amount, not a status (ADR 0019); when it was refunded is
  // the refunds' to say, not the payment's.
  if (intent.amount_refunded !== '0') {
    const full = intent.amount_refunded === intent.amount_received;
    steps.push({
      key: 'refunded',
      label: full ? 'Refunded' : 'Partially refunded',
      state: 'done',
      detail: `${formatAmount(intent.amount_refunded, intent.currency)} refunded`,
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
