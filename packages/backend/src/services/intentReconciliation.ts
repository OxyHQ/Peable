/**
 * Making a card intent agree with the provider, when the two have diverged.
 *
 * ## What diverges, and why re-reading is the only answer
 *
 * The drain turns a stored event into a transition over the status it reads
 * from the row. That is correct when events arrive in order and is not
 * otherwise, and out of order is ordinary: the provider acknowledges receipt
 * before processing, so it redelivers; an endpoint that was briefly unreachable
 * gets a burst; a `payment_failed` for an attempt the payer abandoned can land
 * after the `succeeded` of the attempt they completed.
 *
 * Applied naively, those produce two failures in opposite directions. A stale
 * `payment_failed` after a success would DEGRADE a settled payment — which the
 * state machine refuses, correctly, by throwing. And an event the machine
 * refuses is recorded as a processing FAILURE and retried forever, so one stale
 * delivery pins a row in the drain and reads like a broken handler.
 *
 * The resolution for both is the same and it is not a rule about ordering: ask
 * the provider what is true NOW. The event says something changed; only a fresh
 * read says what.
 */
import type { PaymentIntentLastPaymentError, PaymentIntentStatus } from '@peable.to/shared-types';
import { findIntentById, type PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { getDb } from '../db/postgres';
import { applyEvent, type IntentEvent } from './intentState';
import { announceIntentChange, transitionIntent } from './intentTransition';
import type {
  ProviderPaymentError,
  ProviderPaymentResult,
  ProviderPaymentStatus,
} from './providers/provider';
import { selectStoredProvider } from './providers/environmentGuard';
import { syncChargeSnapshot } from './charges';
import { saveIntentPaymentMethod } from './customers/paymentMethodService';

/**
 * Which card event a provider's own status means — one each, since ADR 0019
 * the two vocabularies are the same. `requires_payment_method` carrying an
 * error is a FAILED ATTEMPT, which is its own event so the merchant is told.
 */
export function eventForProviderStatus(
  status: ProviderPaymentStatus | 'failed',
  failed: boolean,
): IntentEvent {
  switch (status) {
    case 'requires_payment_method':
      return failed ? 'card_failed' : 'card_requires_payment_method';
    case 'failed':
      return 'card_failed';
    case 'requires_confirmation':
      return 'card_requires_confirmation';
    case 'requires_action':
      return 'card_requires_action';
    case 'processing':
      return 'card_processing';
    case 'requires_capture':
      return 'card_requires_capture';
    case 'succeeded':
      return 'card_succeeded';
    case 'canceled':
      return 'card_canceled';
  }
}

/**
 * Peable's own words for a failed attempt (ADR 0019). The provider's prose is
 * never forwarded — it can name the provider, and it is not ours to promise —
 * so the message is chosen from the machine-readable code.
 */
const DECLINE_MESSAGES: Readonly<Record<string, string>> = {
  card_declined: 'The card was declined.',
  expired_card: 'The card has expired.',
  incorrect_cvc: "The card's security code is incorrect.",
  incorrect_number: 'The card number is incorrect.',
  insufficient_funds: 'The card has insufficient funds.',
  processing_error: 'An error occurred while processing the card.',
  authentication_required: 'The card requires authentication.',
  payment_intent_authentication_failure: 'The card could not be authenticated.',
};

export function toLastPaymentError(error: ProviderPaymentError): PaymentIntentLastPaymentError {
  const code = error.code ?? null;
  const declineCode = error.declineCode ?? null;
  return {
    type: error.type,
    code,
    decline_code: declineCode,
    message:
      (declineCode !== null ? DECLINE_MESSAGES[declineCode] : undefined) ??
      (code !== null ? DECLINE_MESSAGES[code] : undefined) ??
      'The payment attempt failed.',
  };
}

export type ReconcileOutcome =
  /** The row moved to match the provider. */
  | {
      readonly kind: 'applied';
      readonly status: PaymentIntentStatus;
      readonly row: PaymentIntentRow;
    }
  /** The provider agrees with the row, or says nothing that changes it. */
  | { readonly kind: 'agreed'; readonly status: PaymentIntentStatus }
  /** There is no provider object to read — a FairCoin intent, or an unlinked one. */
  | { readonly kind: 'unreadable' }
  /** The provider's truth is not a legal move from where the row stands. */
  | { readonly kind: 'irreconcilable'; readonly error: string };

/**
 * Move a card intent to what a provider answer says — the ONE place a provider
 * result becomes a transition, used by reconciliation, a server-side confirm or
 * capture, a create with `confirm`, and the drain's fallback.
 *
 * A failed attempt is written even when the status does not move
 * (`requires_payment_method` → `requires_payment_method`): the error and the
 * `payment_intent.payment_failed` are the news. The charge snapshot is read
 * after the commit, best-effort.
 */
export async function applyProviderPaymentResult(
  intent: PaymentIntentRow,
  result: Pick<ProviderPaymentResult, 'status' | 'lastPaymentError' | 'chargeObjectId'>,
  options: { readonly amountReceived?: string } = {},
): Promise<ReconcileOutcome> {
  const failed =
    result.status === 'requires_payment_method' && result.lastPaymentError !== undefined;
  const event = eventForProviderStatus(result.status, failed);
  let target: PaymentIntentStatus;
  try {
    target = applyEvent(intent.status, event, intent.rail);
  } catch (error) {
    return {
      kind: 'irreconcilable',
      error: error instanceof Error ? error.message : "the provider's state is not reachable",
    };
  }
  if (target === intent.status && !failed) return { kind: 'agreed', status: intent.status };

  const transition = await transitionIntent(intent.id, {
    from: intent.status,
    status: target,
    ...(failed && result.lastPaymentError
      ? { lastPaymentError: toLastPaymentError(result.lastPaymentError) }
      : {}),
    ...(target === 'canceled' ? { cancellationReason: 'automatic' as const } : {}),
    ...(target === 'succeeded' && options.amountReceived !== undefined
      ? { amountReceived: options.amountReceived }
      : {}),
  });
  if (transition.kind !== 'updated') {
    // Something else moved the row between the read and the write. Not an
    // error: the next pass reads the new status and reconciles from there.
    return {
      kind: 'agreed',
      status: transition.kind === 'stale' ? transition.current : intent.status,
    };
  }
  announceIntentChange(transition.row);
  if (result.chargeObjectId !== undefined) {
    await syncChargeSnapshot(transition.row, result.chargeObjectId);
  }
  // A payment that saved its card (ADR 0016): register the `pm_…`. Best-effort.
  await saveIntentPaymentMethod(transition.row);
  return { kind: 'applied', status: transition.row.status, row: transition.row };
}

/**
 * Re-read a card payment and move the row to whatever the provider says.
 *
 * Never throws: every caller is either an HTTP handler or the drain, and both
 * need the outcome as a value. `irreconcilable` is the honest answer for a
 * disagreement no transition can express — a succeeded payment the provider now
 * calls cancelled, say — and it is left for an operator rather than forced.
 */
export async function reconcileIntentWithProvider(
  intent: PaymentIntentRow,
): Promise<ReconcileOutcome> {
  if (!intent.provider || !intent.providerObjectId) return { kind: 'unreadable' };
  const provider = selectStoredProvider(intent.provider, intent.livemode);
  if (!provider) return { kind: 'unreadable' };

  let current: ProviderPaymentResult;
  try {
    current = await provider.getStatus(intent.providerObjectId);
  } catch (error) {
    return {
      kind: 'irreconcilable',
      error: error instanceof Error ? error.message : 'the payment could not be read',
    };
  }

  // Re-read the ROW too: the provider call is a network round trip, and the
  // status this decision is made from must be the one true when the write is
  // attempted — `transitionIntent`'s compare-and-swap enforces it.
  const fresh = (await findIntentById(getDb(), intent.id)) ?? intent;
  // A failed attempt already recorded is not news twice.
  if (fresh.status === 'requires_payment_method' && current.status === 'requires_payment_method') {
    return { kind: 'agreed', status: fresh.status };
  }
  return applyProviderPaymentResult(fresh, current);
}
