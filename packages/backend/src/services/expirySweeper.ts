/**
 * The expiry sweeper — what makes `expiresAt` mean something.
 *
 * `expire` has been in `intentState.ts`'s event set and in its unit tests since
 * the first release, and `payment_intent.expired` has been in the published
 * webhook contract just as long. Nothing emitted either: an intent whose
 * `expiresAt` passed simply stayed `created` forever, so a merchant integrating
 * on that event to release an inventory reservation would have held it
 * indefinitely, and a payer's abandoned checkout stayed open. ADR 0001 D7 names
 * this as part of making delivery trustworthy — an event type a merchant can
 * subscribe to and never receive is worse than one that does not exist.
 *
 * ## Three properties, and no version of this file has ever had all three
 *
 * This sweep needs to be **exclusive** across tasks, **durable** in its
 * delivery, and **bounded** per pass. Two implementations of this file existed
 * and each had a different two of the three:
 *
 *  - The one that shipped read candidates with a SELECT and then transitioned
 *    them one at a time through `transitionIntent`. Durable and bounded — the
 *    outbox row commits with the status change — but the read and the write are
 *    two statements, so two ECS tasks sweeping at once select the same rows and
 *    the merchant is told twice about one intent.
 *  - The one in `feat/web-read-only-wallet` claimed with a single
 *    `UPDATE … RETURNING` and announced over `onChange` → a socket and an inline
 *    `fetch`. Exclusive, but unbounded, and its delivery is precisely the
 *    best-effort path ADR 0001 D7 replaced: an endpoint unreachable for a
 *    fifth of a second loses the event with only a log line saying so.
 *
 * What is here is all three. `expireDueIntents` claims a BOUNDED batch with
 * `for update skip locked` — exclusive without either sweeper waiting on the
 * other — and the enqueue runs on the SAME transaction through
 * `enqueueIntentWebhook`, so the state change and the merchant's event still
 * commit together or neither does.
 *
 * ## What the claim replaces, and the guard that replaces it
 *
 * Transitioning through `applyEvent` per row let the state machine refuse a
 * status the sweep should not have selected. A set-based claim cannot ask it.
 * The guard that takes its place is `EXPIRABLE_STATUSES` in the repository —
 * `created` and `awaiting_approval` only, never `approved`, `broadcast` or
 * `confirming`, whose coins are already moving — and it is not trusted to a
 * comment: `expirySweeper.test.ts` re-derives that list from `applyEvent` and
 * fails if the constant drifts from the table.
 */

import { getDb } from "../db/postgres";
import { expireDueIntents } from "../db/payments/paymentIntentRepository";
import { announceIntentChange, enqueueIntentWebhook } from "./intentTransition";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 100;

export interface ExpirySweepDeps {
  readonly batchSize?: number;
  /** Injectable clock, so a suite can age an intent without waiting. */
  readonly now?: Date;
}

export interface ExpirySweepResult {
  /**
   * How many rows this pass CLAIMED.
   *
   * Equal to `expired` by construction now, where it once could differ: the
   * claim IS the transition, so there is no longer a candidate the sweep looked
   * at and declined. Kept as two fields because a future pass that skipped a
   * row would need somewhere to say so, and a caller reading one of them is
   * reading the number it means either way.
   */
  readonly examined: number;
  readonly expired: number;
}

/**
 * Expire every intent whose time has passed, once, up to `batchSize`.
 *
 * One transaction: claim the batch, enqueue each merchant's event on the same
 * `tx`, commit. The socket frame and the outbox kick happen AFTER it returns —
 * neither is durable, and sending either for a transition that then failed to
 * commit would tell a payer their checkout expired when it did not.
 */
export async function runExpirySweep(
  deps: ExpirySweepDeps = {},
): Promise<ExpirySweepResult> {
  const now = deps.now ?? new Date();
  const limit = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  const expired = await getDb().transaction(async (tx) => {
    const claimed = await expireDueIntents(tx, now, limit);
    for (const intent of claimed) {
      await enqueueIntentWebhook(tx, intent);
    }
    return claimed;
  });

  for (const intent of expired) {
    announceIntentChange(intent);
  }

  return { examined: expired.length, expired: expired.length };
}

let timer: ReturnType<typeof setInterval> | null = null;

export interface StartExpirySweeperOptions extends ExpirySweepDeps {
  readonly intervalMs?: number;
}

/** Start the background sweep. Idempotent — a second call is a no-op. */
export function startExpirySweeper(options: StartExpirySweeperOptions = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runExpirySweep(options).catch((error: unknown) => {
      // One failed sweep must not crash the process. The next tick retries and
      // the claim is safe to repeat — nothing it already committed is re-read.
      process.emitWarning(
        `Peable expiry sweep tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
}

export function stopExpirySweeper(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
