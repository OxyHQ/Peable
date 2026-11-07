/**
 * What a stored provider event MEANS.
 *
 * The other half of ADR 0001 D11's split: `ingress.ts` decides whether a
 * delivery is authentic and writes it down; this decides what it does to a
 * payment. They are separate because the provider is waiting on the first and
 * must not be waiting on the second — an event whose handling fails is a row to
 * retry, not a delivery to re-request.
 *
 * **The stored payload is AUTHENTIC but LOSSY, and the difference matters.** It
 * reached this table only through a signature check, so what is in it is what
 * the provider sent — but `redactProviderPayload` is an allow-list, so most of
 * it is gone by design. A handler may read a field the allow-list KEEPS
 * (`amount_reversed` is one, and is why the reversal handler below can work);
 * it must never depend on one the allow-list drops, because that field will be
 * `"[redacted]"` rather than missing, and a numeric read of it silently
 * produces `NaN`. The routing decisions — which object, which handler — are
 * made from `object_ids` and `type`, which the ingress derived at verification
 * time and which redaction never touches.
 */
import type { ProviderEventRow } from '../../db/providers/providerEventRepository';
import {
  markProviderEventFailed,
  markProviderEventProcessed,
} from '../../db/providers/providerEventRepository';
import {
  findIntentById,
  findIntentByProviderCharge,
  findIntentByProviderObject,
  type PaymentIntentRow,
} from '../../db/payments/paymentIntentRepository';
import {
  applyRefundState,
  findRefundByProviderObject,
  importProviderRefund,
  type RefundStatus,
} from '../../db/refunds/refundRepository';
import { newId } from '../../lib/ids';
import { emitRefundEvents } from '../refunds/refundService';
import { syncChargeFromProvider, syncChargeSnapshot } from '../charges';
import { saveIntentPaymentMethod } from '../customers/paymentMethodService';
import { applySetupResult } from '../customers/setupIntentService';
import { findSetupIntentByProviderObject } from '../../db/customers/setupIntentRepository';
import { isIdentityVerifyingProvider, isSetupHoldingProvider } from './provider';
import { findVerificationSessionByProviderObject } from '../../db/identity/verificationRepository';
import { applyVerificationSnapshot } from '../identity/verificationSessions';
import { findTerminalReaderByProviderObject } from '../../db/terminal/terminalRepository';
import { reconcileReader } from '../terminal/terminal';
import { selectStoredProvider } from './environmentGuard';
import { toLastPaymentError } from '../intentReconciliation';
import type { ProviderPaymentError } from './provider';
import {
  findAccountByProviderAccountId,
  hasCardHalf,
} from '../../db/accounts/connectedAccountRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { recordEvent } from '../events';
import { handleApplicationFeeEvent } from '../money/applicationFees';
import { readBalance, syncAccountLedger, syncLedgerAfterPayment } from '../money/ledger';
import { handlePayoutEvent } from '../money/payouts';
import {
  applyTransferReversal,
  findTransferByProviderObject,
} from '../../db/transfers/transferRepository';
import { refreshConnectedAccount } from '../accounts/connectedAccountService';
import { getDb } from '../../db/postgres';
import { applyEvent, type IntentEvent } from '../intentState';
import { reconcileIntentWithProvider } from '../intentReconciliation';
import { announceIntentChange, recordDisputeEvent, transitionIntent } from '../intentTransition';
import { kickWebhookOutbox } from '../webhookOutbox';
import { findDisputeByProviderObject, upsertDispute } from '../../db/disputes/disputeRepository';
import { toDisputeDTO } from '../../lib/serialize';
import type { DisputeStatus } from '../../db/schema/valueSets';
import { toDisputeStatus } from './disputeStatus';
import { redactProviderMessage } from './redact';
import { providerModeOf, type ProviderId } from './provider';
import { providerModeConfigured } from './registry';

/**
 * Which provider event types move a payment, and where to.
 *
 * A CLOSED map, and everything absent from it is handled — see `no_mapping`
 * below. That is the difference between "we have not taught the drain about
 * this event yet" and "this event is broken", and only the second should ever
 * look like a problem.
 *
 * Refunds and disputes are absent from THIS map and are not unhandled: they
 * have their own handlers below, because neither moves a payment through the
 * lifecycle. A refund changes the payment's status only as a consequence of the
 * refund ROWS (`applyRefundToIntent` recomputes from their sum), and a dispute
 * changes it not at all — it is the network's process running alongside a
 * payment that stays `settled` throughout.
 *
 * The comment here used to say they were "the next phase, and until then their
 * events are stored, marked handled, and act on nothing". That stopped being
 * true when the handlers landed, and it is the kind of stale sentence a reader
 * trusts over the code beneath it.
 */
const INTENT_EVENT_FOR: Readonly<Record<string, IntentEvent>> = {
  'payment_intent.succeeded': 'card_succeeded',
  'payment_intent.payment_failed': 'card_failed',
  'payment_intent.canceled': 'card_canceled',
  'payment_intent.processing': 'card_processing',
  'payment_intent.requires_action': 'card_requires_action',
  // Authorized and held for capture (ADR 0019, `capture_method: manual`).
  'payment_intent.amount_capturable_updated': 'card_requires_capture',
};

/**
 * Charge events that mean "re-read the charge's outcome and card" — the
 * `ch_…` snapshot (ADR 0019). They move no status; refunds and disputes on the
 * charge have their own handlers below.
 */
const CHARGE_SNAPSHOT_EVENTS: ReadonlySet<string> = new Set([
  'charge.succeeded',
  'charge.captured',
  'charge.updated',
]);

/** Which key in `object_ids` names the payment this event is about. */
const PAYMENT_OBJECT_KEY = 'payment_intent';
/** ...the connected account. */
const ACCOUNT_OBJECT_KEY = 'account';
/** ...the transfer. */
const TRANSFER_OBJECT_KEY = 'transfer';

/**
 * Account events that mean "re-read this account".
 *
 * All of them do the same thing, and deliberately: the event says something
 * changed, and the only trustworthy account of WHAT is a fresh read. Parsing
 * the account out of the delivery would also work until the payload is
 * redacted — which it is — and then it would work partially, which is worse.
 */
const ACCOUNT_REFRESH_EVENTS: ReadonlySet<string> = new Set([
  'account.updated',
  'account.application.authorized',
  'account.application.deauthorized',
  'capability.updated',
]);

/**
 * Refund events.
 *
 * These exist for the refund a merchant did NOT make — one issued from the
 * provider's dashboard, or a dispute the network resolved. Without them the
 * payer's money is back and this gateway still calls the payment `settled`,
 * which is the disagreement a merchant reconciles against and cannot explain.
 */
const REFUND_EVENTS: ReadonlySet<string> = new Set([
  'charge.refunded',
  'refund.updated',
  'refund.created',
  // `refund.failed` was ABSENT, and its absence is the expensive half. A bank
  // can reject a refund days after the provider accepted it; without this
  // event the row stays `succeeded`, the payment stays `refunded`, and the
  // merchant's books say money went back that is still with them.
  'refund.failed',
]);

/**
 * The provider's refund vocabulary, mapped onto the gateway's three states.
 *
 * `canceled` lands on `failed` rather than on a fourth state: from the
 * merchant's and the payer's side the two are the same fact — the money is not
 * coming — and a state nothing can act on differently is a state that only
 * makes "how much came back" harder to compute.
 *
 * Anything unrecognised answers `null`, which the handler treats as "leave the
 * row alone" rather than as a failure: a provider adding a state is not a
 * reason to mark a payment's refund dead.
 */
function toRefundStatus(status: unknown): RefundStatus | null {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  // Its own state since Orbit can cancel a refund (`POST /v1/refunds/:id/cancel`).
  if (status === 'canceled') return 'canceled';
  if (status === 'pending' || status === 'requires_action') return 'pending';
  return null;
}

/**
 * Dispute events, and the gateway status each one means when the payload
 * carries none.
 *
 * A CLOSED map from the provider's seven-state vocabulary to the gateway's
 * four (ADR 0001 D3: the acquirer stays invisible, so its vocabulary does not
 * reach the wire). The payload's own `status` decides first
 * (`toDisputeStatus`, `providers/disputeStatus.ts`); this is only the fallback.
 *
 * `charge.dispute.closed` maps to `needs_response` on purpose — never to an
 * outcome: it closes a dispute the merchant may have WON or LOST, and a close
 * whose outcome cannot be read is refused rather than guessed (it used to
 * answer `won`, and a merchant told they won does not reconcile).
 *
 * `funds_withdrawn` and `funds_reinstated` are the money MOVING, not the
 * dispute's outcome — the network can reinstate funds on a dispute it later
 * decides — so they never change the status by their type: they keep what the
 * payload or the row says, and are told to the merchant as what they are.
 */
const DISPUTE_STATUS_FOR_EVENT: Readonly<Record<string, DisputeStatus | null>> = {
  'charge.dispute.created': 'needs_response',
  'charge.dispute.updated': 'under_review',
  'charge.dispute.closed': 'needs_response',
  'charge.dispute.funds_withdrawn': null,
  'charge.dispute.funds_reinstated': null,
};

/** The money-movement events, told to the merchant every time they arrive. */
const DISPUTE_FUNDS_EVENTS = new Set([
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
] as const);

/** Transfer events that carry a cumulative reversed total. */
const TRANSFER_REVERSAL_EVENTS: ReadonlySet<string> = new Set([
  'transfer.reversed',
  'transfer.updated',
]);

/**
 * Refuse an event that names an object of the OTHER mode (ADR 0017).
 *
 * Provider object ids do not collide across modes, so this is not expected to
 * fire — which is why it is a failure the drain keeps visible rather than a
 * no-op. An event's `livemode` is a fact about the endpoint secret that
 * verified it (`ingress.ts`), and a row's is its merchant's; if they disagree,
 * applying the event would let one mode's key move the other mode's money.
 */
async function refuseCrossMode(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
  row: { readonly livemode: boolean },
): Promise<ProcessOutcome | null> {
  if (row.livemode === event.livemode) return null;
  const message = `a ${providerModeOf(event.livemode)} event names a ${providerModeOf(row.livemode)} object`;
  await markProviderEventFailed(db, event.id, message);
  return { kind: 'failed', error: message };
}

export type ProcessOutcome =
  /** The intent moved. */
  | { readonly kind: 'applied'; readonly intentId: string; readonly status: string }
  /** Authentic, understood, and the intent is already there. A provider redelivery. */
  | { readonly kind: 'noop'; readonly intentId: string }
  /** An event type this drain does not act on. Handled, not failed. */
  | { readonly kind: 'no_mapping' }
  /** The event names an object no intent claims. */
  | { readonly kind: 'unmatched' }
  /** Something went wrong. The row keeps its error and stays in the drain's set. */
  | { readonly kind: 'failed'; readonly error: string };

/**
 * Interpret one event and apply it.
 *
 * Never throws: the drain processes a batch, and one poisonous row must not
 * stop the rows behind it. A failure is recorded on the row and reported.
 */
export async function processProviderEvent(event: ProviderEventRow): Promise<ProcessOutcome> {
  const db = getDb();

  // Routed by the event's own mode (ADR 0017). A mode this deployment holds no
  // key for cannot act on anything — every follow-up read would need that key —
  // so the event is refused and left visible in the drain's set, to finish if
  // the key is configured, rather than processed through the other mode's.
  const mode = providerModeOf(event.livemode);
  if (!providerModeConfigured(event.provider as ProviderId, mode)) {
    const message = `no ${mode} ${event.provider} key is configured on this deployment`;
    await markProviderEventFailed(db, event.id, message).catch(() => undefined);
    return { kind: 'failed', error: message };
  }

  try {
    if (ACCOUNT_REFRESH_EVENTS.has(event.type)) {
      return await handleAccountEvent(db, event);
    }
    if (event.type.startsWith('payout.')) {
      return await handlePayoutProviderEvent(db, event);
    }
    if (event.type.startsWith('application_fee.')) {
      return await handleApplicationFeeProviderEvent(db, event);
    }
    if (event.type === 'balance.available') {
      return await handleBalanceAvailableEvent(db, event);
    }
    if (TRANSFER_REVERSAL_EVENTS.has(event.type)) {
      return await handleTransferEvent(db, event);
    }
    if (REFUND_EVENTS.has(event.type)) {
      return await handleRefundEvent(db, event);
    }
    if (event.type in DISPUTE_STATUS_FOR_EVENT) {
      return await handleDisputeEvent(db, event);
    }
    if (SETUP_INTENT_EVENTS.has(event.type)) {
      return await handleSetupIntentEvent(db, event);
    }
    if (VERIFICATION_SESSION_EVENTS.has(event.type)) {
      return await handleVerificationSessionEvent(db, event);
    }
    if (TERMINAL_READER_EVENTS.has(event.type)) {
      return await handleTerminalReaderEvent(db, event);
    }
    if (CHARGE_SNAPSHOT_EVENTS.has(event.type)) {
      return await handleChargeEvent(db, event);
    }

    const intentEvent = INTENT_EVENT_FOR[event.type];
    if (!intentEvent) {
      await markProviderEventProcessed(db, event.id);
      return { kind: 'no_mapping' };
    }

    const objectId = event.objectIds[PAYMENT_OBJECT_KEY];
    if (!objectId) {
      // Mapped to an intent event but carrying no payment id: the envelope and
      // the map disagree, which is a bug here rather than at the provider.
      await markProviderEventFailed(db, event.id, `no ${PAYMENT_OBJECT_KEY} id on a ${event.type}`);
      return { kind: 'failed', error: `no ${PAYMENT_OBJECT_KEY} id on a ${event.type}` };
    }

    const intent = await findIntentByProviderObject(db, event.provider as ProviderId, objectId);
    if (!intent) {
      /**
       * No intent claims this object, and that is NOT marked processed.
       *
       * The overwhelmingly likely cause is the two-step create's own window: the
       * row exists but has not been linked yet, and the provider's event beat
       * our own `linkProviderObject` — a race that resolves itself in
       * milliseconds. Marking it handled would drop a real settlement on the
       * floor. Left unprocessed, the drain simply picks it up again.
       *
       * The other cause — an object this gateway never created — resolves the
       * same way from the drain's point of view: it stays, visibly, for an
       * operator, which is the right outcome for an event about money nobody
       * here can account for.
       */
      return { kind: 'unmatched' };
    }
    const crossed = await refuseCrossMode(db, event, intent);
    if (crossed) return crossed;

    // Already there. A provider redelivering a `succeeded` for a settled
    // payment is ordinary and must not look like an error.
    let target: ReturnType<typeof applyEvent>;
    try {
      target = applyEvent(intent.status, intentEvent, intent.rail);
    } catch {
      /**
       * The event cannot legally act from where the row stands, which is not
       * the same as the event being wrong.
       *
       * Out-of-order delivery is ordinary: the provider acknowledges receipt
       * before processing, so it redelivers; a burst follows an endpoint being
       * briefly unreachable; a `payment_failed` for an attempt the payer
       * abandoned can land after the `succeeded` of the attempt they
       * completed. Applied to the stored status, that last one asks to DEGRADE
       * a settled payment — refused, correctly, by `applyEvent`.
       *
       * What used to happen next was the defect: the throw reached the outer
       * catch, the row was marked FAILED, and the drain retried it forever. One
       * stale delivery pinned a row in the queue and read like a broken
       * handler.
       *
       * The event says something changed; only a fresh read says what. So the
       * provider is asked, and its answer is applied — which for a stale
       * `payment_failed` is "still succeeded", and the event is handled.
       */
      const reconciled = await reconcileIntentWithProvider(intent);
      if (reconciled.kind === 'applied' || reconciled.kind === 'agreed') {
        await markProviderEventProcessed(db, event.id);
        return reconciled.kind === 'applied'
          ? { kind: 'applied', intentId: intent.id, status: reconciled.status }
          : { kind: 'noop', intentId: intent.id };
      }
      // The provider's own truth is not reachable from this row either — a
      // settled payment the provider now calls cancelled, say. Recorded and
      // left for an operator rather than forced: money is involved and no
      // transition here can describe what happened.
      const message =
        reconciled.kind === 'irreconcilable'
          ? reconciled.error
          : `a ${event.type} cannot act on an intent that is '${intent.status}'`;
      await markProviderEventFailed(db, event.id, redactProviderMessage(message));
      return { kind: 'failed', error: message };
    }

    // A failed attempt is news even when the status does not move: a decline
    // on an intent still waiting for a payment method is recorded with its
    // codes, and the merchant gets `payment_intent.payment_failed`.
    const failed = intentEvent === 'card_failed';
    if (target === intent.status && !failed) {
      await markProviderEventProcessed(db, event.id);
      return { kind: 'noop', intentId: intent.id };
    }

    const result = await transitionIntent(intent.id, {
      from: intent.status,
      status: target,
      ...(failed ? { lastPaymentError: toLastPaymentError(readPaymentError(event.payload)) } : {}),
      ...(target === 'canceled' ? { cancellationReason: 'automatic' as const } : {}),
    });
    if (result.kind !== 'updated') {
      // The row moved between the read and the update — which this comment has
      // always claimed and which only became true when `updateIntentState`
      // grew its compare-and-swap. Not marked processed: the next pass re-reads
      // and either applies the event or finds the intent already there.
      return {
        kind: 'failed',
        error:
          result.kind === 'stale'
            ? `the intent moved to '${result.current}' underneath the update`
            : 'the intent vanished underneath the update',
      };
    }
    const updated = result.row;

    await markProviderEventProcessed(db, event.id);
    // Outside the transition's transaction, and after it — a socket frame is
    // not durable and must never be sent for a change that did not commit.
    announceIntentChange(updated);
    if (updated.status === 'succeeded' || updated.status === 'requires_capture') {
      await syncChargeFromProvider(updated);
      // A payment that saved its card (ADR 0016): register the `pm_…`. Best-effort.
      await saveIntentPaymentMethod(updated);
    }
    if (updated.status === 'succeeded') await syncLedgerFor(db, updated);
    return { kind: 'applied', intentId: updated.id, status: updated.status };
  } catch (error) {
    // Redacted before it is stored: a provider's message quotes the input back,
    // and this column is operator-facing.
    const message = redactProviderMessage(
      error instanceof Error ? error.message : 'unknown processing error',
    );
    await markProviderEventFailed(db, event.id, message).catch(() => undefined);
    return { kind: 'failed', error: message };
  }
}

/**
 * An account changed at the provider: re-read it.
 *
 * This is what makes a seller's readiness arrive without anyone polling — and
 * the reason `card_payments` is requested beside transfers, because a
 * recipient-only account emits none of these at all (Mercaria's ADR 0008 D2-D).
 * A deployment that dropped that capability would find this handler correct and
 * never invoked.
 */
async function handleAccountEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const providerAccountId = event.objectIds[ACCOUNT_OBJECT_KEY] ?? event.providerAccountId;
  if (!providerAccountId) {
    await markProviderEventFailed(db, event.id, `no ${ACCOUNT_OBJECT_KEY} id on a ${event.type}`);
    return { kind: 'failed', error: `no ${ACCOUNT_OBJECT_KEY} id on a ${event.type}` };
  }

  const account = await findAccountByProviderAccountId(
    db,
    event.provider as ProviderId,
    providerAccountId,
  );
  if (!account) {
    /**
     * An account this gateway never opened.
     *
     * Left UNPROCESSED, the same as an unmatched payment, and for the same
     * reason: the overwhelmingly likely cause is that our own create has not
     * committed yet. The other cause — a connected account belonging to a
     * different platform integration on the same Stripe account — resolves the
     * same way from here: it stays, visibly, for an operator.
     */
    return { kind: 'unmatched' };
  }
  const crossed = await refuseCrossMode(db, event, account);
  if (crossed) return crossed;

  await refreshConnectedAccount(account);
  await markProviderEventProcessed(db, event.id);
  return { kind: 'applied', intentId: account.id, status: 'account_refreshed' };
}

/**
 * A transfer changed at the provider.
 *
 * The cumulative reversed total is read from the stored payload, which is legal
 * precisely because `amount_reversed` is on the redaction allow-list — see this
 * file's header. Anything else about the transfer is not read, and must not be:
 * the fields that were dropped read as `"[redacted]"`, not as missing.
 */
async function handleTransferEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const transferObjectId = event.objectIds[TRANSFER_OBJECT_KEY];
  if (!transferObjectId) {
    await markProviderEventFailed(db, event.id, `no ${TRANSFER_OBJECT_KEY} id on a ${event.type}`);
    return { kind: 'failed', error: `no ${TRANSFER_OBJECT_KEY} id on a ${event.type}` };
  }

  const transfer = await findTransferByProviderObject(
    db,
    event.provider as ProviderId,
    transferObjectId,
  );
  if (!transfer) return { kind: 'unmatched' };
  const crossed = await refuseCrossMode(db, event, transfer);
  if (crossed) return crossed;

  const total = readReversedTotal(event.payload);
  if (total === null) {
    // The event names a transfer we have but carries no usable total. Recorded
    // rather than skipped: it means the allow-list and this handler disagree,
    // which is a bug here and not at the provider.
    await markProviderEventFailed(db, event.id, `no usable amount_reversed on a ${event.type}`);
    return { kind: 'failed', error: `no usable amount_reversed on a ${event.type}` };
  }

  const updated = await applyTransferReversal(db, transfer.id, total);
  await markProviderEventProcessed(db, event.id);
  // `null` means the stored total was already at least this one — an
  // out-of-order delivery, which is ordinary and not a failure.
  return updated
    ? { kind: 'applied', intentId: updated.id, status: updated.status }
    : { kind: 'noop', intentId: transfer.id };
}

/**
 * The cumulative reversed total out of a stored Stripe transfer event.
 *
 * Returns `null` rather than guessing. Stripe reports it as a NUMBER of minor
 * units; the column holds a canonical integer string, so the conversion is
 * explicit and refuses anything that is not a safe non-negative integer —
 * `"[redacted]"` and a float both land here and both must not become an amount.
 */
function readReversedTotal(payload: Record<string, unknown>): string | null {
  const data = payload.data;
  if (typeof data !== 'object' || data === null) return null;
  const object = (data as Record<string, unknown>).object;
  if (typeof object !== 'object' || object === null) return null;
  const value = (object as Record<string, unknown>).amount_reversed;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return String(value);
}

/**
 * A refund the provider reports.
 *
 * ## What this used to do, and what it missed
 *
 * It looked the refund up by provider object, and if it found one, recomputed
 * the payment's status from the rows. Two things were wrong with that.
 *
 * First it never READ the event: a `refund.updated` carrying `failed` was
 * processed by re-summing rows that still said `succeeded`, so the row's own
 * state never moved and the payment kept claiming money had gone back. The
 * status on the payload is the provider's authoritative word about THIS refund
 * and is now what the row is set from.
 *
 * Second, a refund with no local row was `unmatched` forever. The comment
 * argued that inventing a merchant `external_ref` for a refund the merchant
 * never made would put an amount in this database that nothing chose — right
 * about the reference, wrong about the refund. A dashboard refund, or the
 * network resolving a dispute, is money that left; the payer has it and this
 * gateway called the payment `settled`. `refunds.origin` and a nullable
 * `external_ref` let it be recorded as what it is: imported, with no merchant
 * reference, because there is none.
 */
async function handleRefundEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const provider = event.provider as ProviderId;
  const refundObjectId = event.objectIds.refund;
  if (!refundObjectId) {
    // `charge.refunded` names the CHARGE, not the refund, so there is no row to
    // move. The payment's status is still recomputed from whatever rows exist:
    // the refund that produced this charge event arrives as its own
    // `refund.created`/`refund.updated`, and those are what import it.
    // Since ADR 0019 nothing is recomputed from it: the payment's status does
    // not move with a refund, and `amount_refunded` is read from the rows.
    const chargeId = event.objectIds.charge;
    const byCharge = chargeId ? await findIntentByProviderCharge(db, provider, chargeId) : null;
    if (byCharge) {
      const crossed = await refuseCrossMode(db, event, byCharge);
      if (crossed) return crossed;
    }
    await markProviderEventProcessed(db, event.id);
    return byCharge ? { kind: 'noop', intentId: byCharge.id } : { kind: 'no_mapping' };
  }

  const detail = readRefundDetail(event.payload);
  const refund = await findRefundByProviderObject(db, provider, refundObjectId);

  if (!refund) {
    const imported = await importRefundFromEvent(db, event, refundObjectId, detail);
    if (!imported) return { kind: 'unmatched' };
    if ('failed' in imported) return imported.failed;
    await markProviderEventProcessed(db, event.id);
    kickWebhookOutbox();
    return { kind: 'applied', intentId: imported.intent.id, status: imported.status };
  }

  const intent = await findIntentById(db, refund.paymentIntentId);
  if (!intent) {
    await markProviderEventFailed(db, event.id, 'the refund names an intent that cannot be read');
    return { kind: 'failed', error: 'the refund names an intent that cannot be read' };
  }
  const crossedRefund = await refuseCrossMode(db, event, intent);
  if (crossedRefund) return crossedRefund;

  // The row FIRST, from the provider's own word, and the payment afterwards
  // from the rows. `applyRefundState` refuses to move a row that already
  // reached a terminal state, so a `pending` arriving after the `succeeded`
  // that followed it cannot walk the money back.
  //
  // The row and the merchant's `refund.*` / `charge.refunded` commit together
  // (ADR 0001 D7).
  const status = detail.status;
  const moved =
    status === null
      ? null
      : await db.transaction(async (tx) => {
          const row = await applyRefundState(tx, refund.id, status, detail.failureCode);
          if (row) await emitRefundEvents(tx, intent, row, refund.status);
          return row;
        });
  await markProviderEventProcessed(db, event.id);
  if (moved) kickWebhookOutbox();
  if (moved?.status === 'succeeded') await syncLedgerFor(db, intent);
  return moved
    ? { kind: 'applied', intentId: intent.id, status: moved.status }
    : { kind: 'noop', intentId: intent.id };
}

/**
 * Bring the ledger a card payment belongs to up to date (ADR 0015 §4) after it
 * or one of its refunds moved: the destination account's, or — for an Oxy
 * first-party merchant — the platform-attributed one. Best-effort: never fails
 * the event; the daily reconciliation catches up.
 */
async function syncLedgerFor(
  db: ReturnType<typeof getDb>,
  intent: PaymentIntentRow,
): Promise<void> {
  const merchant = await findMerchantById(db, intent.merchantId);
  if (!merchant) return;
  const current = (await findIntentById(db, intent.id)) ?? intent;
  await syncLedgerAfterPayment(current, merchant.firstParty);
}

/**
 * `payout.*` on the Connect endpoint (ADR 0015 §5): re-read the payout from the
 * account and mirror it — the payload is redacted, the fresh read is the truth.
 */
async function handlePayoutProviderEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const payoutId = event.objectIds.payout;
  const accountId = event.objectIds[ACCOUNT_OBJECT_KEY];
  if (!payoutId || !accountId) {
    // A payout of the PLATFORM's own balance: the operator's treasury, on no
    // merchant's ledger (ADR 0015). Handled, not failed.
    await markProviderEventProcessed(db, event.id);
    return { kind: 'no_mapping' };
  }
  const outcome = await handlePayoutEvent(event.provider as ProviderId, accountId, payoutId);
  if (outcome === 'unmatched') {
    await markProviderEventProcessed(db, event.id);
    return { kind: 'no_mapping' };
  }
  await markProviderEventProcessed(db, event.id);
  return { kind: 'noop', intentId: payoutId };
}

/** `application_fee.*`: re-read the fee and record it and its refunds (ADR 0015 §3). */
async function handleApplicationFeeProviderEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const feeId = event.objectIds.application_fee ?? event.objectIds.fee;
  if (!feeId) {
    await markProviderEventProcessed(db, event.id);
    return { kind: 'no_mapping' };
  }
  const outcome = await handleApplicationFeeEvent(
    event.provider as ProviderId,
    event.livemode,
    feeId,
  );
  // Unmatched stays in the drain: the charge may not be bound to its payment yet.
  if (outcome === 'unmatched') return { kind: 'unmatched' };
  await markProviderEventProcessed(db, event.id);
  return { kind: 'noop', intentId: feeId };
}

/**
 * `balance.available` for an account: ingest its new transactions and tell the
 * merchant, with the balance read from the ledger (ADR 0015 §4).
 */
async function handleBalanceAvailableEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const accountId = event.objectIds[ACCOUNT_OBJECT_KEY];
  const account = accountId
    ? await findAccountByProviderAccountId(db, event.provider as ProviderId, accountId)
    : null;
  if (!account || !hasCardHalf(account)) {
    await markProviderEventProcessed(db, event.id);
    return { kind: 'no_mapping' };
  }
  await syncAccountLedger(account);
  const figures = await readBalance({
    merchantId: account.merchantId,
    connectedAccountId: account.id,
  });
  await db.transaction(async (tx) => {
    await recordEvent(tx, {
      merchantId: account.merchantId,
      type: 'balance.available',
      object: {
        object: 'balance',
        livemode: account.livemode,
        ...figures,
        account: account.publicId,
      },
      account: account.publicId,
    });
    await markProviderEventProcessed(tx, event.id);
  });
  kickWebhookOutbox();
  return { kind: 'noop', intentId: account.publicId };
}

/** What a refund payload says, narrowed to what a row needs. */
interface RefundDetail {
  readonly amount: string | null;
  readonly status: RefundStatus | null;
  readonly failureCode: string | null;
}

/**
 * Read a stored refund payload.
 *
 * Every field it reads is on the redaction allow-list — `amount`, `status` and
 * `failure_reason` — which is the constraint this file's header states: a
 * handler may read a field the allow-list KEEPS and must never depend on one it
 * drops, because a dropped field reads as `"[redacted]"` rather than as
 * missing. `failure_reason` was added to that list alongside this handler; it
 * had been silently redacted, so a failed refund's reason was unreadable.
 */
function readRefundDetail(payload: Record<string, unknown>): RefundDetail {
  const empty: RefundDetail = { amount: null, status: null, failureCode: null };
  const data = payload.data;
  if (typeof data !== 'object' || data === null) return empty;
  const object = (data as Record<string, unknown>).object;
  if (typeof object !== 'object' || object === null) return empty;
  const fields = object as Record<string, unknown>;

  const rawAmount = fields.amount;
  const amount =
    typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount) && rawAmount > 0
      ? String(rawAmount)
      : null;

  const failure = fields.failure_reason;
  return {
    amount,
    status: toRefundStatus(fields.status),
    failureCode: typeof failure === 'string' && failure.length > 0 ? failure : null,
  };
}

/**
 * Record a refund that was created OUTSIDE this gateway.
 *
 * `null` when the event does not name a payment this gateway knows, or carries
 * no usable amount — both of which the caller reports as `unmatched` and the
 * drain retries, because the likelier cause is our own two-step create's window
 * rather than a refund we can never account for.
 */
async function importRefundFromEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
  refundObjectId: string,
  detail: RefundDetail,
): Promise<
  | { readonly intent: PaymentIntentRow; readonly status: string }
  | { readonly failed: ProcessOutcome }
  | null
> {
  if (detail.amount === null) return null;

  const provider = event.provider as ProviderId;
  const paymentObjectId = event.objectIds[PAYMENT_OBJECT_KEY];
  const chargeId = event.objectIds.charge;
  const intent = paymentObjectId
    ? await findIntentByProviderObject(db, provider, paymentObjectId)
    : chargeId
      ? await findIntentByProviderCharge(db, provider, chargeId)
      : null;
  if (!intent) return null;
  const crossed = await refuseCrossMode(db, event, intent);
  if (crossed) return { failed: crossed };

  const amount = detail.amount;
  const imported = await db.transaction(async (tx) => {
    const row = await importProviderRefund(tx, {
      publicId: newId('re'),
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      amount,
      currency: intent.currency,
      provider,
      providerObjectId: refundObjectId,
      // Defaults to `pending` rather than `succeeded` when the payload says
      // nothing: claiming money came back is the answer that is expensive to be
      // wrong about, and the next `refund.updated` corrects it.
      status: detail.status ?? 'pending',
    });
    // `refund.created` (and `charge.refunded` if it already succeeded) with the row.
    if (row) await emitRefundEvents(tx, intent, row, null);
    return row;
  });
  return { intent, status: imported?.status ?? detail.status ?? 'pending' };
}

/**
 * A dispute the card network opened, updated or closed.
 *
 * ## The inversion, which is why this is not `handleRefundEvent` with a rename
 *
 * `handleRefundEvent` treats "no refund row for this provider object" as
 * `unmatched` and lets the drain retry. That is right there: Peable writes the
 * refund row BEFORE calling the provider, so absence means our own write has
 * not landed yet and waiting is what resolves it.
 *
 * Here absence is the NORMAL first state. Peable never creates a dispute —
 * the network does — so a missing row means this is the first time we have
 * heard of it, and waiting would wait forever. It CREATES.
 *
 * The lookup that CAN legitimately be absent is the intent, and that one keeps
 * refund semantics: `unmatched` and retryable, because it is the two-step
 * create's own window (the row is written before the provider call returns, so
 * a dispute event racing that window finds nothing and will find it next pass).
 *
 * ## The merchant is told ONCE
 *
 * `upsertDispute` reports whether it created the row, and only a creation
 * enqueues `charge.dispute.created`. A provider WILL redeliver — receipt is
 * acknowledged before processing — and a merchant told twice that one payment
 * is disputed has no way to tell that from two disputes on it.
 *
 * A close is the exception and enqueues every time it changes the status,
 * because `charge.dispute.closed` carries the outcome and arriving twice with the same
 * outcome is idempotent for the merchant in a way "you have a new dispute" is
 * not.
 */
async function handleDisputeEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const disputeObjectId = event.objectIds.dispute;
  if (!disputeObjectId) {
    // Mapped as a dispute event and carrying no dispute id: the envelope and
    // the map disagree, which is a bug here rather than at the provider.
    await markProviderEventFailed(db, event.id, 'the dispute event names no dispute');
    return { kind: 'failed', error: 'the dispute event names no dispute' };
  }

  const intentObjectId = event.objectIds[PAYMENT_OBJECT_KEY];
  if (!intentObjectId) {
    await markProviderEventFailed(db, event.id, 'the dispute event names no payment');
    return { kind: 'failed', error: 'the dispute event names no payment' };
  }

  const provider = event.provider as ProviderId;
  const intent = await findIntentByProviderObject(db, provider, intentObjectId);
  // The ONE place refund semantics still apply: retryable, because a dispute
  // arriving inside the two-step create's window finds no intent yet.
  if (!intent) return { kind: 'unmatched' };
  const crossed = await refuseCrossMode(db, event, intent);
  if (crossed) return crossed;

  const detail = readDisputeDetail(event.payload);
  if (!detail) {
    await markProviderEventFailed(db, event.id, 'the dispute event carries no amount');
    return { kind: 'failed', error: 'the dispute event carries no amount' };
  }

  /**
   * The PAYLOAD decides the status; the event type is only the fallback.
   *
   * This used to be the other way round, and `charge.dispute.closed` mapped to
   * `won`. So a close whose status could not be read — a redacted payload, a
   * status Stripe renamed — told the merchant they had WON a dispute they may
   * well have lost. That is the wrong half of a coin flip to land on by
   * default: a merchant told they won does not reconcile, does not re-bill, and
   * finds out from their balance.
   */
  const closing = event.type === 'charge.dispute.closed';
  const known = await findDisputeByProviderObject(db, provider, disputeObjectId);
  const status =
    detail.status ?? DISPUTE_STATUS_FOR_EVENT[event.type] ?? known?.status ?? 'needs_response';

  if (closing && status !== 'won' && status !== 'lost') {
    // A close with no readable outcome is recorded and left VISIBLE rather than
    // guessed. The drain retries it, and a redelivery carrying a readable
    // status resolves it; if none ever comes, an operator has a row naming the
    // dispute rather than a merchant with a wrong answer.
    const message = `a ${event.type} carried no recognisable outcome`;
    await markProviderEventFailed(db, event.id, message);
    return { kind: 'failed', error: message };
  }

  // A closed dispute has no deadline left to meet, and the CHECK refuses the
  // combination — so the status decides the column rather than the payload.
  const closed = status === 'won' || status === 'lost';

  /**
   * The row and the merchant's notification commit TOGETHER (ADR 0001 D7).
   *
   * They did not. `upsertDispute` ran on `db` and `recordDisputeEvent` ran
   * on `db` after it, as two statements with no transaction around them — so a
   * crash between them stored the dispute and lost its first notification
   * permanently. `created` is false on every redelivery afterwards, which is
   * exactly the guard that makes a merchant told once stay told once, so
   * nothing would ever enqueue it again: a merchant would be contesting a
   * payment they were never told about, with a deadline they never saw.
   */
  const { dispute } = await db.transaction(async (tx) => {
    const before = await findDisputeByProviderObject(tx, provider, disputeObjectId);
    const upserted = await upsertDispute(tx, {
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      provider,
      providerObjectId: disputeObjectId,
      amount: detail.amount,
      currency: intent.currency,
      status,
      ...(detail.reason === null ? {} : { reason: detail.reason }),
      evidenceDueAt: closed ? null : detail.evidenceDueAt,
      ...(detail.isChargeRefundable === null
        ? {}
        : { isChargeRefundable: detail.isChargeRefundable }),
    });

    // The DISPUTE is the payload, not the intent. `created` is a deadline, and
    // a merchant who has to make a second call to learn when evidence is due is
    // a merchant who can miss it while their integration works as documented.
    // `updated` only when the status moved — a redelivery is not news.
    // `closed` only when the outcome is NEWS: the merchant's own `…/close`
    // already recorded it (and told them) before the provider's event arrived.
    const changed = before !== null && before.status !== upserted.dispute.status;
    const funds = DISPUTE_FUNDS_EVENTS.has(event.type as 'charge.dispute.funds_withdrawn')
      ? (event.type as 'charge.dispute.funds_withdrawn' | 'charge.dispute.funds_reinstated')
      : null;
    const eventType = upserted.created
      ? ('charge.dispute.created' as const)
      : funds !== null
        ? funds
        : closed && changed
          ? ('charge.dispute.closed' as const)
          : changed
            ? ('charge.dispute.updated' as const)
            : null;
    if (eventType !== null) {
      await recordDisputeEvent(
        tx,
        intent,
        toDisputeDTO(upserted.dispute, intent.publicId),
        eventType,
      );
    }
    return upserted;
  });

  await markProviderEventProcessed(db, event.id);
  return { kind: 'applied', intentId: intent.id, status: dispute.status };
}

/** What a dispute payload says, narrowed to what the row needs. */
interface DisputeDetail {
  readonly amount: string;
  readonly reason: string | null;
  readonly evidenceDueAt: Date | null;
  /** The provider's own status, mapped — `null` when it said nothing readable. */
  readonly status: DisputeStatus | null;
  /** `is_charge_refundable`, or `null` when the payload did not say. */
  readonly isChargeRefundable: boolean | null;
}

/**
 * Read a dispute payload.
 *
 * `amount` is required and everything else is optional, which is the honest
 * split: a dispute with no amount is one this gateway cannot record (the CHECK
 * refuses a zero), while a missing reason or deadline is a provider that did
 * not send one — common, and not a failure.
 *
 * The status is read from the PAYLOAD rather than from the event type because
 * `charge.dispute.closed` closes a dispute the merchant may have WON or LOST,
 * and defaulting either way would tell them the opposite of what happened for
 * half of all closed disputes.
 *
 * `evidence_details.due_by` is read here and is on the redaction allow-list —
 * it was not, so it stored as the string `"[redacted]"`, the `typeof by ===
 * "number"` guard below answered false, and the deadline was silently null on
 * EVERY dispute. A merchant could be told they were being disputed without
 * being told when evidence was due, and would discover it by losing.
 */
function readDisputeDetail(payload: Record<string, unknown>): DisputeDetail | null {
  const data = payload.data;
  if (typeof data !== 'object' || data === null) return null;
  const object = (data as Record<string, unknown>).object;
  if (typeof object !== 'object' || object === null) return null;
  const fields = object as Record<string, unknown>;

  const amount = fields.amount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null;

  const reason =
    typeof fields.reason === 'string' && fields.reason.length > 0 ? fields.reason : null;

  // Seconds since the epoch, as every provider timestamp in this payload is.
  const due = fields.evidence_details;
  let evidenceDueAt: Date | null = null;
  if (typeof due === 'object' && due !== null) {
    const by = (due as Record<string, unknown>).due_by;
    if (typeof by === 'number' && Number.isSafeInteger(by) && by > 0) {
      evidenceDueAt = new Date(by * 1000);
    }
  }

  return {
    amount: String(amount),
    reason,
    evidenceDueAt,
    // The WHOLE vocabulary, not just the two outcomes. This used to read `won`
    // and `lost` and nothing else, so `under_review` and the three `warning_*`
    // states fell through to the event type — which is how a close with no
    // readable outcome became `won`.
    status: toDisputeStatus(fields.status),
    isChargeRefundable:
      typeof fields.is_charge_refundable === 'boolean' ? fields.is_charge_refundable : null,
  };
}

/**
 * A charge changed at the provider (`charge.succeeded|captured|updated`):
 * re-read its outcome and card into the `ch_…` snapshot. The stored payload is
 * redacted, so the snapshot is never read from it.
 */
async function handleChargeEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const provider = event.provider as ProviderId;
  const chargeId = event.objectIds.charge;
  if (!chargeId) {
    await markProviderEventProcessed(db, event.id);
    return { kind: 'no_mapping' };
  }
  const paymentObjectId = event.objectIds[PAYMENT_OBJECT_KEY];
  const intent = paymentObjectId
    ? await findIntentByProviderObject(db, provider, paymentObjectId)
    : await findIntentByProviderCharge(db, provider, chargeId);
  if (!intent) return { kind: 'unmatched' };
  const crossed = await refuseCrossMode(db, event, intent);
  if (crossed) return crossed;
  await syncChargeSnapshot(intent, chargeId);
  await markProviderEventProcessed(db, event.id);
  return { kind: 'noop', intentId: intent.id };
}

/**
 * The failed attempt's CODES out of a stored `payment_intent.payment_failed`
 * — `code`, `decline_code` and `type` are on the redaction allow-list; the
 * provider's `message` is not, and is never wanted (Peable writes its own).
 */
function readPaymentError(payload: Record<string, unknown>): ProviderPaymentError {
  const data = payload.data;
  const object =
    typeof data === 'object' && data !== null ? (data as Record<string, unknown>).object : null;
  const error =
    typeof object === 'object' && object !== null
      ? (object as Record<string, unknown>).last_payment_error
      : null;
  if (typeof error !== 'object' || error === null) return { type: 'card_error' };
  const fields = error as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 && value !== '[redacted]' ? value : undefined;
  const code = text(fields.code);
  const declineCode = text(fields.decline_code);
  return {
    type: fields.type === 'card_error' || fields.type === undefined ? 'card_error' : 'api_error',
    ...(code !== undefined ? { code } : {}),
    ...(declineCode !== undefined ? { declineCode } : {}),
  };
}

/**
 * SetupIntent events (ADR 0016). All of them mean the same thing — "re-read
 * this SetupIntent" — because the stored payload is redacted and a fresh read
 * is the only trustworthy account of what changed; the read is then applied
 * through `applySetupResult`, the one path a provider SetupIntent becomes a
 * transition (compare-and-swap, events in the same commit, the `pm_…` created
 * on success).
 */
const SETUP_INTENT_EVENTS: ReadonlySet<string> = new Set([
  'setup_intent.succeeded',
  'setup_intent.setup_failed',
  'setup_intent.requires_action',
  'setup_intent.canceled',
  'setup_intent.created',
]);

async function handleSetupIntentEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const provider = event.provider as ProviderId;
  const objectId = event.objectIds.setup_intent;
  if (!objectId) {
    await markProviderEventFailed(db, event.id, `no setup_intent id on a ${event.type}`);
    return { kind: 'failed', error: `no setup_intent id on a ${event.type}` };
  }
  const setup = await findSetupIntentByProviderObject(db, provider, objectId);
  // The two-step create's window, as for a payment: retried, not dropped.
  if (!setup) return { kind: 'unmatched' };
  const crossed = await refuseCrossMode(db, event, setup);
  if (crossed) return crossed;
  const adapter = selectStoredProvider(setup.provider, setup.livemode);
  if (!adapter || !isSetupHoldingProvider(adapter)) {
    const message = `the ${setup.provider} rail cannot read setup intents in this mode`;
    await markProviderEventFailed(db, event.id, message);
    return { kind: 'failed', error: message };
  }
  const outcome = await applySetupResult(setup, await adapter.getSetup(objectId));
  if (outcome.kind === 'irreconcilable') {
    await markProviderEventFailed(db, event.id, redactProviderMessage(outcome.error));
    return { kind: 'failed', error: outcome.error };
  }
  await markProviderEventProcessed(db, event.id);
  return outcome.kind === 'applied'
    ? { kind: 'applied', intentId: setup.id, status: outcome.row.status }
    : { kind: 'noop', intentId: setup.id };
}

/**
 * Identity verification events (ADR 0023). Like SetupIntents, every one means
 * "re-read this session": the stored payload is redacted, and the provider's
 * read — reduced to its verdict by the adapter — is applied through
 * `applyVerificationSnapshot`, the one path a provider session becomes a
 * change (compare-and-swap, the report's outcomes, events in the same commit).
 */
const VERIFICATION_SESSION_EVENTS: ReadonlySet<string> = new Set([
  'identity.verification_session.created',
  'identity.verification_session.processing',
  'identity.verification_session.verified',
  'identity.verification_session.requires_input',
  'identity.verification_session.canceled',
  'identity.verification_session.redacted',
]);

/** Which key in `object_ids` names the session (the provider object's own `object`). */
const VERIFICATION_SESSION_OBJECT_KEY = 'identity.verification_session';

async function handleVerificationSessionEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const provider = event.provider as ProviderId;
  const objectId = event.objectIds[VERIFICATION_SESSION_OBJECT_KEY];
  if (!objectId) {
    const message = `no verification session id on a ${event.type}`;
    await markProviderEventFailed(db, event.id, message);
    return { kind: 'failed', error: message };
  }
  const session = await findVerificationSessionByProviderObject(db, provider, objectId);
  // Created at the provider first and stored a moment later: its own
  // `created` can arrive in that window, and is retried rather than dropped.
  if (!session) return { kind: 'unmatched' };
  const crossed = await refuseCrossMode(db, event, session);
  if (crossed) return crossed;
  const adapter = selectStoredProvider(session.provider, session.livemode);
  if (!adapter || !isIdentityVerifyingProvider(adapter)) {
    const message = `the ${session.provider} rail cannot read verification sessions in this mode`;
    await markProviderEventFailed(db, event.id, message);
    return { kind: 'failed', error: message };
  }
  const outcome = await applyVerificationSnapshot(
    session,
    await adapter.getVerificationSession(objectId),
  );
  if (outcome.kind === 'irreconcilable') {
    await markProviderEventFailed(db, event.id, redactProviderMessage(outcome.error));
    return { kind: 'failed', error: outcome.error };
  }
  await markProviderEventProcessed(db, event.id);
  return outcome.kind === 'applied'
    ? { kind: 'applied', intentId: session.id, status: outcome.row.status }
    : { kind: 'noop', intentId: session.id };
}

/**
 * Terminal reader events (ADR 0024). Like identity, every one means "re-read
 * this reader": the provider's CURRENT reader is applied through
 * `reconcileReader`, the one path — never the event's own copy of the action,
 * which can describe an earlier attempt on the same reader. The PaymentIntent
 * the reader collected moves on its own `payment_intent.*` events (and is
 * reconciled by `reconcileReader` when the action settles).
 */
const TERMINAL_READER_EVENTS: ReadonlySet<string> = new Set([
  'terminal.reader.action_succeeded',
  'terminal.reader.action_failed',
  'terminal.reader.action_updated',
]);

/** Which key in `object_ids` names the reader (the provider object's own `object`). */
const TERMINAL_READER_OBJECT_KEY = 'terminal.reader';

async function handleTerminalReaderEvent(
  db: ReturnType<typeof getDb>,
  event: ProviderEventRow,
): Promise<ProcessOutcome> {
  const objectId = event.objectIds[TERMINAL_READER_OBJECT_KEY];
  if (!objectId) {
    const message = `no reader id on a ${event.type}`;
    await markProviderEventFailed(db, event.id, message);
    return { kind: 'failed', error: message };
  }
  const reader = await findTerminalReaderByProviderObject(
    db,
    event.provider as ProviderId,
    objectId,
  );
  // A reader Orbit never registered (or one registered a moment ago) is not
  // dropped: the drain retries it, and an operator sees what it never matched.
  if (!reader) return { kind: 'unmatched' };
  const crossed = await refuseCrossMode(db, event, reader);
  if (crossed) return crossed;
  const settled = await reconcileReader(reader);
  await markProviderEventProcessed(db, event.id);
  return settled.action?.status !== reader.action?.status && settled.action !== null
    ? { kind: 'applied', intentId: reader.id, status: settled.action.status }
    : { kind: 'noop', intentId: reader.id };
}
