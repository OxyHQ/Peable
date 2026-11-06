import type { PaymentIntentStatus } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import { faircoinOutputsOf, findWatchableIntents } from '../db/payments/paymentIntentRepository';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { toBaseUnits } from '../lib/money';
import { applyEvent } from './intentState';
import { transitionIntent } from './intentTransition';
import { verifyPayment } from './explorer';

/**
 * How often the fallback poller re-checks the chain for in-flight intents. The
 * Explorer tip WebSocket can drive `check()` directly later; for F1 a periodic
 * poll is sufficient. The timer is `.unref()`-ed so it never keeps the event
 * loop (or a test run) alive.
 */
const POLL_INTERVAL_MS = 5_000;

/**
 * Intents that require settlement tracking are FairCoin intents in
 * `processing` with a payer-reported `txid` (ADR 0019 — the old `broadcast` and
 * `confirming`). `requires_action` (nothing broadcast) and the terminal
 * statuses are never polled.
 */
const WATCHABLE_STATUSES: readonly PaymentIntentStatus[] = ['processing'];

export interface WatcherDeps {
  getTransaction: typeof import('./explorer').getTransaction;
  /**
   * Invoked once per actual write — a status change, or a new confirmation
   * count — with the intent AS PERSISTED by it, never the pre-update one.
   */
  onChange: (intent: PaymentIntentRow) => void | Promise<void>;
}

/**
 * The status a watched intent should be in for the observed on-chain fact:
 *
 *  - the tx is present but does not pay every output its amount → `underpaid` → `canceled`
 *  - paid, confirmations below the threshold        → still `processing`
 *  - paid, confirmations at/above the threshold     → `confirmed` → `succeeded`
 */
function nextStatusFor(
  paid: boolean,
  confirmations: number,
  requiredConfirmations: number,
): PaymentIntentStatus {
  if (!paid) return applyEvent('processing', 'underpaid', 'faircoin');
  if (confirmations < requiredConfirmations) return 'processing';
  return applyEvent('processing', 'confirmed', 'faircoin');
}

/** Peable's words for an underpayment (ADR 0019): the coins are at the address and are not enough. */
const UNDERPAID_ERROR = {
  type: 'payment_error',
  code: 'payment_underpaid',
  decline_code: null,
  message: 'The transaction paid less than the amount due.',
} as const;

/** What the chain says about a watched intent's transaction. */
export interface ChainObservation {
  /** The transaction pays every output of the intent at least its amount (ADR 0021 D6). */
  readonly paid: boolean;
  readonly confirmations: number;
}

/**
 * Advance a `processing` FairCoin intent for one observation of its
 * transaction — THE decision the watcher makes, and the only place it is made.
 *
 * Exported for the one other caller that has an observation without the
 * Explorer: `POST /v1/test_helpers/payment_intents/:id/simulate_faircoin_payment`
 * (`services/testHelpers.ts`), which hands it a synthetic one so a test-mode
 * payment moves through exactly the transitions, events and billing side
 * effects a real one does.
 *
 * @returns the row as persisted when something was written (a status change or
 *   a new confirmation count), else `null` — nothing to announce.
 */
export async function applyChainObservation(
  intent: PaymentIntentRow,
  observation: ChainObservation,
): Promise<PaymentIntentRow | null> {
  if (intent.rail !== 'faircoin' || intent.status !== 'processing') return null;
  const { paid, confirmations } = observation;
  const next = nextStatusFor(paid, confirmations, intent.requiredConfirmations);
  if (next === 'processing') {
    // Still confirming: a new confirmation count is written so the wire's
    // `faircoin.confirmations` is live — no status change, no event.
    if (confirmations === intent.confirmations) return null;
  }

  const result = await transitionIntent(intent.id, {
    from: 'processing',
    status: next,
    confirmations,
    ...(next === 'canceled'
      ? { cancellationReason: 'underpaid' as const, lastPaymentError: UNDERPAID_ERROR }
      : {}),
  });
  return result.kind === 'updated' ? result.row : null;
}

/**
 * Tip-driven, non-custodial settlement watcher. It only ever *reads* the chain
 * (via the injected `getTransaction`) and advances the `PaymentIntent` state
 * machine; the payer signs and broadcasts. Transport (Socket.io emit + signed
 * webhook) is injected as `onChange`, keeping the watcher pure of I/O concerns.
 */
export class SettlementWatcher {
  private readonly deps: WatcherDeps;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WatcherDeps) {
    this.deps = deps;
  }

  /** Reconcile every in-flight intent against its on-chain transaction. */
  async check(): Promise<void> {
    const intents = await findWatchableIntents(getDb(), WATCHABLE_STATUSES);

    for (const intent of intents) {
      await this.reconcile(intent);
    }
  }

  private async reconcile(intent: PaymentIntentRow): Promise<void> {
    const { txid, address, network } = intent;
    // Three guards for one condition — this is a FAIRCOIN intent that has been
    // broadcast. `findWatchableIntents` already filters on the rail and the
    // txid, so none of these fires in practice; they are here because
    // `address` and `network` are nullable since ADR 0001 D6, and a card intent
    // reaching this method would otherwise verify a payment against a null
    // address. A silent `return` is right: there is nothing to watch, and this
    // loop must not throw on one row and stop reconciling the rest.
    if (txid === null || address === null || network === null) return;

    if (intent.status !== 'processing') return;

    const tx = await this.deps.getTransaction(txid, network);
    if (tx === null) return;

    const expected = faircoinOutputsOf(intent).map((output) => ({
      address: output.address,
      amount: toBaseUnits(output.amount),
    }));
    const { paid, confirmations } = verifyPayment(tx, expected);
    const row = await applyChainObservation(intent, { paid, confirmations });
    if (row === null) return;

    await this.deps.onChange(row);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.check().catch((error: unknown) => {
        // A single failed poll must not crash the process or become an
        // unhandled rejection; surface it and let the next tick retry.
        process.emitWarning(error instanceof Error ? error : new Error(String(error)));
      });
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
