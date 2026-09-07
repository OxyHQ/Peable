import type { PaymentIntentStatus } from "@peable.to/shared-types";
import { getDb } from "../db/postgres";
import { findWatchableIntents } from "../db/payments/paymentIntentRepository";
import type { PaymentIntentRow } from "../db/payments/paymentIntentRepository";
import { findMerchantById } from "../db/merchants/merchantRepository";
import { toBaseUnits } from "../lib/money";
import { applyEvent } from "./intentState";
import { transitionIntent } from "./intentTransition";
import { verifyPayment } from "./explorer";

/**
 * How often the fallback poller re-checks the chain for in-flight intents. The
 * Explorer tip WebSocket can drive `check()` directly later; for F1 a periodic
 * poll is sufficient. The timer is `.unref()`-ed so it never keeps the event
 * loop (or a test run) alive.
 */
const POLL_INTERVAL_MS = 5_000;

/**
 * Intents that require settlement tracking sit in exactly these two states with
 * a payer-reported `txid`. Terminal/pre-broadcast intents are never polled.
 */
const WATCHABLE_STATUSES: readonly PaymentIntentStatus[] = ["broadcast", "confirming"];

export interface WatcherDeps {
  getTransaction: typeof import("./explorer").getTransaction;
  /**
   * Invoked once per actual status change, with the intent AS PERSISTED by
   * that change — the row `transitionIntent` returned, never the pre-update
   * one. The Mongo path mutated the document in place and saved it, so the
   * handed-over object carried the new state implicitly; here the new state
   * exists only in the returned row.
   */
  onChange: (intent: PaymentIntentRow) => void | Promise<void>;
}

/**
 * Compute the status a watchable intent should advance to for the observed
 * on-chain fact, chaining pure `applyEvent` transitions:
 *
 *  - the tx is present but does not satisfy the amount  → `underpaid` → `failed`
 *  - paid, confirmations below the threshold            → `mempool_seen` → `confirming`
 *  - paid, confirmations at/above the threshold         → …→ `confirmed` → `settled`
 *
 * `applyEvent` is idempotent on a re-poll (e.g. `mempool_seen` while already
 * `confirming`), so a state that has not moved returns unchanged.
 */
function nextStatusFor(
  current: "broadcast" | "confirming",
  paid: boolean,
  confirmations: number,
  requiredConfirmations: number,
): PaymentIntentStatus {
  if (!paid) {
    return applyEvent(current, "underpaid");
  }

  const confirming =
    current === "broadcast" ? applyEvent(current, "mempool_seen") : current;

  if (confirmations < requiredConfirmations) {
    return confirming;
  }

  return applyEvent(confirming, "confirmed");
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

    const current = intent.status;
    if (current !== "broadcast" && current !== "confirming") return;

    const tx = await this.deps.getTransaction(txid, network);
    // Not yet visible on-chain — this is the "not the right tx yet" case; skip
    // and re-check next tick. Only a returned tx can move the intent to failed.
    if (tx === null) return;

    const db = getDb();
    const merchant = await findMerchantById(db, intent.merchantId);
    const requiredConfirmations = merchant?.requiredConfirmations ?? 1;

    const { paid, confirmations } = verifyPayment(
      tx,
      address,
      toBaseUnits(intent.amount),
    );

    const next = nextStatusFor(current, paid, confirmations, requiredConfirmations);
    if (next === current) return;

    // The status, the confirmation count AND the merchant's outbox row move in
    // ONE transaction, and `onChange` receives what the database actually
    // stored. A row that vanished between the poll and the update is not an
    // error: there is simply nothing to announce.
    //
    // `transitionIntent` rather than `updateIntentState`: an event enqueued
    // after this commit rather than inside it is an event a crash loses, with
    // the intent already settled and nothing recording that a merchant was
    // never told.
    const result = await transitionIntent(intent.id, {
      from: current,
      status: next,
      confirmations,
    });
    // Both failures are the same non-event HERE: a row that moved (the expiry
    // sweeper got there first) or vanished has nothing this poll should
    // announce, and the next tick re-reads whatever it became.
    if (result.kind !== 'updated') return;

    await this.deps.onChange(result.row);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.check().catch((error: unknown) => {
        // A single failed poll must not crash the process or become an
        // unhandled rejection; surface it and let the next tick retry.
        process.emitWarning(
          error instanceof Error ? error : new Error(String(error)),
        );
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
