import { getNetwork } from '@fairco.in/core';
import type { PaymentIntentStatus } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import {
  faircoinOutputsOf,
  findSettlingIntents,
  findWatchableIntents,
} from '../db/payments/paymentIntentRepository';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { toBaseUnits } from '../lib/money';
import { applyEvent } from './intentState';
import { transitionIntent } from './intentTransition';
import { addressHasTransaction, getAddressUsage, getTip, verifyPayment } from './explorer';
import { checkRecipientKeys, readCurrentKeyFresh } from './faircoin/keyBinding';

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

/**
 * How long a SUCCEEDED payment's transaction must be missing from the Explorer
 * before it is called reorged out (ADR 0021 D10): five blocks, so one failed
 * read never rewinds a payment.
 */
export const REORG_MISSING_GRACE_MS = 10 * 60 * 1000;

/**
 * A reported broadcast the Explorer has not seen for this long, that pays
 * nothing at the payment's addresses, is lost (ADR 0021 D9): the payment is
 * cancelled `abandoned`, and an address that received nothing can be recycled.
 * FairCoin's blocks are two minutes and nearly empty; a real transaction is
 * seen within minutes.
 */
export const BROADCAST_UNSEEN_MS = 24 * 60 * 60 * 1000;
/**
 * How long THIS watcher must have seen a broadcast missing, on every read,
 * before it may be judged lost — so an Explorer whose transaction API is down
 * (it answers "missing" too) cannot cancel a payment by being down.
 */
const UNSEEN_OBSERVED_MS = 60 * 60 * 1000;
/** How often one unseen broadcast is re-judged (each judgement reads the chain). */
const UNSEEN_RECHECK_MS = 10 * 60 * 1000;

/**
 * How long after success a payment's transaction is still re-read: past the
 * chain's own reorg bound (`maxReorgDepth` blocks of 2 minutes, ~3.3 hours)
 * with room for an Explorer outage. Older rows are final, whatever they record.
 */
const SETTLED_RECHECK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Settled payments re-read per poll. */
const SETTLED_RECHECK_BATCH = 200;
/** How often one settled payment is re-read. */
const SETTLED_RECHECK_INTERVAL_MS = 60 * 1000;

export interface WatcherDeps {
  getTransaction: typeof import('./explorer').getTransaction;
  /** The chain tip: proof the Explorer is answering before a missing transaction means anything. */
  getTip?: typeof getTip;
  /** Whether an address ever received anything (the lost-broadcast judgement). */
  getAddressUsage?: typeof getAddressUsage;
  /** Whether a used address's transactions include the reported one (the same judgement). */
  addressHasTransaction?: typeof addressHasTransaction;
  /** The clock; tests move it. */
  now?: () => number;
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

  // Before `succeeded` is ever written, the recipients' keys are read FRESH
  // (ADR 0002, amended 2026-11-06): coins at an address of a replaced key are
  // received, and say so — the stamp lands in this transition's own statement,
  // so `payment_intent.succeeded` carries it. When Oxy cannot be asked the
  // settlement waits for the next poll rather than claim the key held.
  let recipientKeyReplaced = false;
  if (next === 'succeeded' && !intent.faircoinRecipientKeyReplacedAt) {
    const check = await checkRecipientKeys(intent, readCurrentKeyFresh);
    if (check === 'unknown') return null;
    recipientKeyReplaced = check === 'replaced';
  }

  const result = await transitionIntent(intent.id, {
    from: 'processing',
    status: next,
    confirmations,
    ...(recipientKeyReplaced ? { recipientKeyReplaced: true as const } : {}),
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

    // A succeeded payment is not final until the chain cannot undo it (ADR 0021
    // D10): it is re-read until it is `maxReorgDepth` deep.
    const depth = Math.max(
      getNetwork('mainnet').maxReorgDepth,
      getNetwork('testnet').maxReorgDepth,
    );
    const settling = await findSettlingIntents(
      getDb(),
      depth,
      SETTLED_RECHECK_MAX_AGE_SECONDS,
      SETTLED_RECHECK_BATCH,
    );
    const now = this.now();
    const live = new Set(settling.map((intent) => intent.id));
    for (const id of this.settledCheckedAt.keys()) {
      if (!live.has(id)) this.settledCheckedAt.delete(id);
    }
    for (const intent of settling) {
      // A block is two minutes: once a minute is as often as the answer can change.
      const last = this.settledCheckedAt.get(intent.id);
      if (last !== undefined && now - last < SETTLED_RECHECK_INTERVAL_MS) continue;
      this.settledCheckedAt.set(intent.id, now);
      await this.recheckSettled(intent);
    }
  }

  /** When each settled payment was last re-read. */
  private readonly settledCheckedAt = new Map<string, number>();

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** When each watched payment's transaction was first found missing (per task; a restart starts over). */
  private readonly missingSince = new Map<string, number>();
  /** When this watcher first found each broadcast missing, reset by any sighting. */
  private readonly unseenSince = new Map<string, number>();
  /** When each unseen broadcast was last judged. */
  private readonly unseenCheckedAt = new Map<string, number>();

  /** Whether the Explorer is answering at all: a missing transaction means nothing otherwise. */
  private async explorerAnswers(network: NonNullable<PaymentIntentRow['network']>) {
    try {
      await (this.deps.getTip ?? getTip)(network);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-read a SUCCEEDED payment's transaction (ADR 0021 D10). Deeper: record
   * the count (same status, no event). Below the merchant's threshold, or
   * missing for {@link REORG_MISSING_GRACE_MS} while the Explorer answers: the
   * reorg rewinds it to `processing` (`reorg_below_threshold`), where the
   * watcher settles it again — or cancels it, if the coins never come back.
   */
  private async recheckSettled(intent: PaymentIntentRow): Promise<void> {
    const { txid, network } = intent;
    if (txid === null || network === null || intent.status !== 'succeeded') return;
    const tx = await this.deps.getTransaction(txid, network);
    let confirmations: number;
    if (tx === null) {
      const now = this.now();
      const since = this.missingSince.get(intent.id);
      if (since === undefined) {
        this.missingSince.set(intent.id, now);
        return;
      }
      if (now - since < REORG_MISSING_GRACE_MS) return;
      if (!(await this.explorerAnswers(network))) return;
      confirmations = 0;
    } else {
      this.missingSince.delete(intent.id);
      confirmations = tx.confirmations;
      if (confirmations >= intent.requiredConfirmations) {
        if (confirmations === intent.confirmations) return;
        const result = await transitionIntent(intent.id, {
          from: 'succeeded',
          status: 'succeeded',
          confirmations,
        });
        if (result.kind === 'updated') await this.deps.onChange(result.row);
        return;
      }
    }
    this.missingSince.delete(intent.id);
    const result = await transitionIntent(intent.id, {
      from: 'succeeded',
      status: applyEvent('succeeded', 'reorg_below_threshold', 'faircoin'),
      confirmations,
    });
    if (result.kind === 'updated') await this.deps.onChange(result.row);
  }

  /**
   * A broadcast is LOST (`broadcast_lost` → `canceled` `abandoned`, ADR 0021
   * D9) when the REPORTED transaction provably pays nothing here: the intent's
   * last write is {@link BROADCAST_UNSEEN_MS} old; THIS watcher has seen the
   * transaction missing on every read for {@link UNSEEN_OBSERVED_MS} (a
   * transaction-API outage also answers "missing"); the Explorer's tip
   * answers; and for every output the address reads UNUSED, or reads USED with
   * the reported txid absent from its transaction list (coins someone sent
   * there are not the payment that was reported — a made-up txid plus dust
   * must not hold an address, and a place under the cap, for ever; the coins
   * stay the recipient's and that address is never recycled). On mainnet an
   * answer that cannot tell (`unknown`) keeps the payment `processing`.
   * Testnet's node has no address index and only ever answers `unknown`, so
   * there the missing transaction alone decides.
   */
  private async judgeUnseen(intent: PaymentIntentRow): Promise<void> {
    const { network } = intent;
    if (network === null) return;
    const now = this.now();
    const firstMissing = this.unseenSince.get(intent.id);
    if (firstMissing === undefined) {
      this.unseenSince.set(intent.id, now);
      return;
    }
    if (now - intent.updatedAt.getTime() < BROADCAST_UNSEEN_MS) return;
    if (now - firstMissing < UNSEEN_OBSERVED_MS) return;
    const last = this.unseenCheckedAt.get(intent.id);
    if (last !== undefined && now - last < UNSEEN_RECHECK_MS) return;
    this.unseenCheckedAt.set(intent.id, now);
    if (!(await this.explorerAnswers(network))) return;
    const usage = this.deps.getAddressUsage ?? getAddressUsage;
    const holds = this.deps.addressHasTransaction ?? addressHasTransaction;
    const txid = intent.txid;
    if (txid === null) return;
    for (const output of faircoinOutputsOf(intent)) {
      const answer = await usage(output.address, network);
      if (answer === 'unknown' && network === 'mainnet') return;
      if (answer === 'used' && (await holds(output.address, network, txid)) !== 'no') return;
    }
    const result = await transitionIntent(intent.id, {
      from: 'processing',
      status: applyEvent('processing', 'broadcast_lost', 'faircoin'),
      cancellationReason: 'abandoned',
    });
    this.unseenCheckedAt.delete(intent.id);
    this.unseenSince.delete(intent.id);
    if (result.kind === 'updated') await this.deps.onChange(result.row);
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
    if (tx === null) {
      await this.judgeUnseen(intent);
      return;
    }
    this.unseenCheckedAt.delete(intent.id);
    this.unseenSince.delete(intent.id);

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
