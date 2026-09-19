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
 *
 * ## ...and the CARD rail cannot use any of it
 *
 * Everything above is about a row. A FairCoin payment IS a row here — a payer
 * who did not broadcast left nothing anywhere else — so expiring it locally is
 * the whole of expiring it.
 *
 * A card payment is a row AND a PaymentIntent at an acquirer that stays
 * confirmable, with the payer's browser still holding a credential for it.
 * Expiring the row and emitting `payment_intent.expired` told the merchant a
 * payment was over while the payer could still complete it — minutes later,
 * against a terminal status, for an order already released. So card intents are
 * swept separately, one at a time, cancelled at the provider FIRST, and
 * expired only once that succeeded. `sweepDueCardIntents` carries the argument.
 */

import { getDb } from "../db/postgres";
import {
  expireDueIntents,
  findDueCardIntents,
} from "../db/payments/paymentIntentRepository";
import { cancelCardPaymentAtProvider } from "./cardCancellation";
import { reconcileIntentWithProvider } from "./intentReconciliation";
import {
  announceIntentChange,
  enqueueIntentWebhook,
  transitionIntent,
} from "./intentTransition";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 100;

export interface ExpirySweepDeps {
  readonly batchSize?: number;
  /** Injectable clock, so a suite can age an intent without waiting. */
  readonly now?: Date;
}

export interface ExpirySweepResult {
  /**
   * How many rows this pass LOOKED AT.
   *
   * No longer equal to `expired`, and the gap is the point. On the chain rail
   * the claim is the transition, so the two agree. On the card rail a pass can
   * look at a payment, fail to cancel it at the provider — because the payer
   * just completed it, or because the provider could not be reached — and
   * deliberately leave it alone. That row is examined and not expired, and a
   * monitor watching the difference is watching the thing worth watching.
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
  const db = getDb();

  // The CARD rail first, and one row at a time. See `expireDueCardIntents`.
  const card = await sweepDueCardIntents(now, limit);

  const expired = await db.transaction(async (tx) => {
    const claimed = await expireDueIntents(tx, now, limit);
    for (const intent of claimed) {
      await enqueueIntentWebhook(tx, intent);
    }
    return claimed;
  });

  for (const intent of expired) {
    announceIntentChange(intent);
  }

  return {
    examined: expired.length + card.examined,
    expired: expired.length + card.expired,
  };
}

/**
 * Expire card payments, having first cancelled them at the provider.
 *
 * ## Why this cannot be part of the set-based claim
 *
 * `expireDueIntents` moves a whole batch in one statement, which is what makes
 * it exclusive across tasks. It is also what makes it wrong for the card rail:
 * the row is the SMALLER half of a card payment. The other half is a
 * PaymentIntent at the acquirer that stays confirmable, and the payer's browser
 * is still holding a credential for it. Expiring locally and telling the
 * merchant so — which is what happened — leaves a payment that can complete
 * minutes later, against an intent in a terminal status, for an order the
 * merchant has already released.
 *
 * So a card intent is cancelled at the provider FIRST, per row, and the local
 * transition is a compare-and-swap that only lands if nothing else moved the
 * row. Exclusivity comes from that compare-and-swap rather than from the claim:
 * two sweepers both call cancel — which is idempotent given the same key, and
 * whose second answer is simply "already cancelled" — and only one wins the
 * transition.
 *
 * A cancellation that LOSES is the interesting case. `settled` means the payer
 * confirmed inside the sweep's own window, and the row is reconciled to the
 * truth rather than expired: the money is real, and "nobody paid in time" is
 * the one thing this sweep must never say about a payment that was made.
 */
async function sweepDueCardIntents(
  now: Date,
  limit: number,
): Promise<{ examined: number; expired: number }> {
  const due = await findDueCardIntents(getDb(), now, limit);
  let expired = 0;

  for (const intent of due) {
    const cancellation = await cancelCardPaymentAtProvider(
      intent,
      // Derived from the intent's own id: a retry on the next tick, from this
      // task or another, is the same operation rather than a second one.
      `cancel:${intent.publicId}`,
    );

    if (cancellation.kind === "settled") {
      // The payer won. Record what is true; do not expire it.
      await reconcileIntentWithProvider(intent);
      continue;
    }
    if (cancellation.kind === "unknown" || cancellation.kind === "in_flight") {
      // Unknown: the provider could not be reached, so the payment is still
      // live and nothing may be announced about it. In flight: the provider
      // still has it, and expiring locally is exactly the divergence this pass
      // exists to prevent. Either way the next tick tries again — `expires_at`
      // has passed and will keep having passed.
      continue;
    }

    // `canceled`, or nothing at the provider to cancel (an unlinked create).
    // Now the local transition can be announced truthfully.
    const result = await transitionIntent(intent.id, {
      from: intent.status,
      status: "expired",
    });
    if (result.kind !== "updated") continue;
    announceIntentChange(result.row);
    expired += 1;
  }

  return { examined: due.length, expired };
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
