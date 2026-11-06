import { getNetwork } from '@fairco.in/core';
import type { PaymentIntentStatus } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import {
  faircoinOutputsOf,
  findSettlingIntents,
  findWatchableIntents,
  txidSettlesAnotherIntent,
} from '../db/payments/paymentIntentRepository';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import { toBaseUnits } from '../lib/money';
import { applyEvent } from './intentState';
import { transitionIntent } from './intentTransition';
import {
  addressHasTransaction,
  type ExplorerTx,
  getAddressUsage,
  getTip,
  listAddressTransactions,
  verifyPayment,
} from './explorer';
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
 * How long a SUCCEEDED payment's transaction must read unconfirmed (0
 * confirmations, no block) or in a different block, below the threshold,
 * before it is rewound (ADR 0021 D10, amended 2026-11-06): one block, on two
 * reads, so an Explorer node behind its peers (the API is load-balanced; a
 * block's `confirmations` was read at 1 and its transaction's at 4 in the same
 * minute) never rewinds a payment. A count that merely dips is not a reorg and
 * is not even recorded.
 */
export const REORG_CONFIRM_MS = 2 * 60 * 1000;

/**
 * A reported broadcast the Explorer has not seen for this long, that pays
 * nothing at the payment's addresses, is lost (ADR 0021 D9): the payment is
 * cancelled `abandoned` (its address stays the recipient's, never handed out again).
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

/**
 * Transactions read, at most, when a lost broadcast's address was paid under
 * another txid (ADR 0021 D9, amended) — of those the address's list shows
 * moving at least the output's amount, after the payment was created. Dust
 * never reaches a read, so it cannot push the real payment out of reach.
 */
const SUBSTITUTE_TX_READS = 10;
/** Base units the list's float `amount` may round below the true value. */
const LISTED_AMOUNT_TOLERANCE = 1_000n;
/**
 * How far a block's own timestamp may sit before the payment's creation and
 * still be its payment: a staker's clock, not Peable's, stamps the block.
 */
const SUBSTITUTE_TIME_SLACK_SECONDS = 15 * 60;

export interface WatcherDeps {
  getTransaction: typeof import('./explorer').getTransaction;
  /** The chain tip: proof the Explorer is answering before a missing transaction means anything. */
  getTip?: typeof getTip;
  /** Whether an address ever received anything (the lost-broadcast judgement). */
  getAddressUsage?: typeof getAddressUsage;
  /** Whether a used address's transactions include the reported one (the same judgement). */
  addressHasTransaction?: typeof addressHasTransaction;
  /** A used address's transactions, to find the one that paid it under another txid. */
  listAddressTransactions?: typeof listAddressTransactions;
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
    for (const id of this.rewindSuspectSince.keys()) {
      if (!live.has(id)) this.rewindSuspectSince.delete(id);
    }
    for (const id of this.settledBlock.keys()) {
      if (!live.has(id) && !intents.some((intent) => intent.id === id))
        this.settledBlock.delete(id);
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
  /**
   * The block each settled payment's transaction was last read in (per task:
   * a restart learns it again on the first read). A block that changes is a
   * reorg; a count that dips in the same block is an Explorer behind its peers.
   */
  private readonly settledBlock = new Map<string, string>();
  /** When a settled payment first read unconfirmed or moved, reset by a read that does not. */
  private readonly rewindSuspectSince = new Map<string, number>();

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
   * Re-read a SUCCEEDED payment's transaction (ADR 0021 D10, amended
   * 2026-11-06). Deeper: record the count (same status, no event). A count that
   * dips in the same block is an Explorer node behind its peers and changes
   * nothing. The reorg rewinds it to `processing` (`reorg_below_threshold`) —
   * where the watcher settles it again, or cancels it if the coins never come
   * back — only when the chain says so: the transaction missing for {@link
   * REORG_MISSING_GRACE_MS} while the Explorer answers, or read unconfirmed (0
   * confirmations, no block) or in a different block below the threshold on
   * reads {@link REORG_CONFIRM_MS} apart.
   */
  private async recheckSettled(intent: PaymentIntentRow): Promise<void> {
    const { txid, network } = intent;
    if (txid === null || network === null || intent.status !== 'succeeded') return;
    const tx = await this.deps.getTransaction(txid, network);
    const now = this.now();
    let confirmations: number;
    if (tx === null) {
      this.rewindSuspectSince.delete(intent.id);
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
      const known = this.settledBlock.get(intent.id);
      const unconfirmed = tx.confirmations <= 0 || tx.blockHash === null;
      const moved =
        known !== undefined &&
        typeof tx.blockHash === 'string' &&
        tx.blockHash !== known &&
        tx.confirmations < intent.requiredConfirmations;
      if (!unconfirmed && !moved) {
        this.rewindSuspectSince.delete(intent.id);
        if (typeof tx.blockHash === 'string') this.settledBlock.set(intent.id, tx.blockHash);
        // Only ever deeper: a lower count is a lagging node, not news.
        if (tx.confirmations <= intent.confirmations) return;
        const result = await transitionIntent(intent.id, {
          from: 'succeeded',
          status: 'succeeded',
          confirmations: tx.confirmations,
        });
        if (result.kind === 'updated') await this.deps.onChange(result.row);
        return;
      }
      const since = this.rewindSuspectSince.get(intent.id);
      if (since === undefined) {
        this.rewindSuspectSince.set(intent.id, now);
        return;
      }
      if (now - since < REORG_CONFIRM_MS) return;
      confirmations = Math.max(0, tx.confirmations);
    }
    this.missingSince.delete(intent.id);
    this.rewindSuspectSince.delete(intent.id);
    this.settledBlock.delete(intent.id);
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
   * must not hold a place under the recipient's unpaid bound for ever; the
   * coins stay the recipient's, as every address does). On mainnet an
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
    let paidUnderAnotherTxid: string | null = null;
    for (const output of faircoinOutputsOf(intent)) {
      const answer = await usage(output.address, network);
      if (answer === 'unknown' && network === 'mainnet') return;
      if (answer === 'used') {
        if ((await holds(output.address, network, txid)) !== 'no') return;
        paidUnderAnotherTxid ??= output.address;
      }
    }
    // The address received coins, just not under the txid the payer reported
    // (a malleated or rebroadcast transaction, or a mistyped report): if one of
    // its transactions pays the whole payment, the payment is paid (ADR 0021
    // D9, amended 2026-11-06), never `abandoned`.
    if (paidUnderAnotherTxid !== null) {
      const verdict = await this.findSubstitute(intent, network, paidUnderAnotherTxid);
      if (verdict === 'unknown' || verdict === 'flagged') return;
      if (verdict !== 'none') {
        await this.settleAgainst(intent, verdict);
        return;
      }
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

  /**
   * The transaction at `address` that pays every output of `intent` its
   * amount, seen no earlier than the payment was created (less a staker's
   * clock skew), and not settling
   * another payment. The address's list is filtered by its own `amount` and
   * `time` first, so dust costs no read and cannot push a real payment out of
   * the window. `flagged` when one pays it but is another payment's, or more
   * candidates exist than are read — the payment stays `processing` and is
   * reported, never cancelled;
   * `unknown` when the Explorer cannot answer; `none` when nothing pays it.
   */
  private async findSubstitute(
    intent: PaymentIntentRow,
    network: NonNullable<PaymentIntentRow['network']>,
    address: string,
  ): Promise<ExplorerTx | 'none' | 'flagged' | 'unknown'> {
    const listed = await (this.deps.listAddressTransactions ?? listAddressTransactions)(
      address,
      network,
    );
    if (listed === null) return 'unknown';
    const expected = faircoinOutputsOf(intent).map((output) => ({
      address: output.address,
      amount: toBaseUnits(output.amount),
    }));
    const owed = expected.find((output) => output.address === address)?.amount ?? 0n;
    const created = Math.floor(intent.createdAt.getTime() / 1000) - SUBSTITUTE_TIME_SLACK_SECONDS;
    const candidates = listed.filter(
      (entry) =>
        entry.txid !== intent.txid &&
        (entry.amountSat === null || entry.amountSat + LISTED_AMOUNT_TOLERANCE >= owed) &&
        (entry.time === null || entry.time >= created),
    );
    // More plausible payments than a confirm should ever need to read: never
    // conclude "nothing paid it" from a part of them.
    let flagged = candidates.length > SUBSTITUTE_TX_READS;
    for (const candidate of candidates.slice(0, SUBSTITUTE_TX_READS)) {
      const tx = await this.deps.getTransaction(candidate.txid, network);
      if (tx === null) return 'unknown';
      if (!verifyPayment(tx, expected).paid) continue;
      if (typeof tx.time === 'number' && tx.time < created) continue;
      if (await txidSettlesAnotherIntent(getDb(), network, tx.txid, intent.id)) {
        flagged = true;
        continue;
      }
      return tx;
    }
    if (flagged) {
      process.emitWarning(
        `Peable FairCoin payment ${intent.publicId}: its reported transaction was never seen, and its address was paid by transactions it cannot take (another payment's, or more than it reads); left processing for review`,
      );
      return 'flagged';
    }
    return 'none';
  }

  /** Move the payment onto the transaction that paid it, then settle it as any observation. */
  private async settleAgainst(intent: PaymentIntentRow, tx: ExplorerTx): Promise<void> {
    const moved = await transitionIntent(intent.id, {
      from: 'processing',
      status: 'processing',
      txid: tx.txid,
      confirmations: Math.max(0, tx.confirmations),
    });
    this.unseenCheckedAt.delete(intent.id);
    this.unseenSince.delete(intent.id);
    if (moved.kind !== 'updated') return;
    await this.deps.onChange(moved.row);
    const expected = faircoinOutputsOf(moved.row).map((output) => ({
      address: output.address,
      amount: toBaseUnits(output.amount),
    }));
    const settled = await applyChainObservation(moved.row, verifyPayment(tx, expected));
    if (settled !== null) await this.deps.onChange(settled);
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
    // The block it settles in, so a later re-read can tell a reorg from a lag.
    if (typeof tx.blockHash === 'string') this.settledBlock.set(intent.id, tx.blockHash);
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
