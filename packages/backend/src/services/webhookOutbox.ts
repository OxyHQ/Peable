/**
 * The webhook outbox dispatcher — what turns a durable promise into a delivery.
 *
 * `db/webhooks/webhookOutboxRepository.ts` owns the statements; this owns the
 * schedule, the attempt budget and the loop. Modelled on Mercaria's
 * `payment_outboxes` dispatcher, and on the settlement watcher next door: an
 * `.unref()`-ed timer that cannot hold a test run or the event loop open.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/postgres';
import { findWebhookTarget } from '../db/merchants/merchantRepository';
import {
  claimDueDeliveries,
  recordDeliveryAttempt,
  releaseDeliveryClaim,
  type ClaimedDeliveryRow,
} from '../db/webhooks/webhookOutboxRepository';
import { attemptDelivery, type SafeFetchFn } from './webhookDispatcher';

/**
 * The backoff schedule, in milliseconds, one entry per elapsed attempt.
 *
 * Eight entries, reaching a little over eight hours in total — long enough to
 * ride out a merchant's deploy, a certificate renewal or a night, which is the
 * class of outage the previous 150ms budget could not survive. Bounded rather
 * than infinite because an endpoint that has been refusing for eight hours
 * needs an operator, not another request.
 *
 * Read by INDEX of the attempt just completed, so `SCHEDULE_MS[0]` is the wait
 * after the first failure. Running past the end is what makes a row `dead`.
 */
const SCHEDULE_MS: readonly number[] = [
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  5 * 60 * 60_000,
];

/** Up to ±20% of the delay, so a shared outage does not resynchronize every retry. */
const JITTER_FRACTION = 0.2;

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 25;
/**
 * Comfortably longer than any single attempt can take (`safeFetch` bounds its
 * own timeout well below this) and short enough that a dispatcher killed
 * mid-attempt frees its rows within a poll cycle or two.
 */
const DEFAULT_LEASE_MS = 60_000;

/**
 * When the next attempt is due after `attemptsCompleted` failures, or `null`
 * when the budget is spent.
 */
export function nextAttemptDelayMs(
  attemptsCompleted: number,
  random: () => number = Math.random,
): number | null {
  const base = SCHEDULE_MS[attemptsCompleted - 1];
  if (base === undefined) return null;
  // Symmetric jitter: `random()` at 0 gives -20%, at 1 gives +20%.
  const jitter = base * JITTER_FRACTION * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

export interface OutboxPassDeps {
  readonly safeFetch?: SafeFetchFn | undefined;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly now?: Date;
  readonly random?: () => number;
}

export interface OutboxPassResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly terminal: number;
}

/**
 * Claim a batch of due deliveries and attempt each once.
 *
 * Sequential rather than concurrent, on purpose: the batch is small, the
 * bottleneck is a merchant's endpoint rather than this process, and firing 25
 * simultaneous requests at one recovering server is how a retry storm turns a
 * brief outage into a longer one.
 *
 * Never throws for one row's sake. A row whose attempt blew up in an
 * unanticipated way must not abort the pass and strand the rest of the batch
 * holding leases.
 */
export async function runWebhookOutboxPass(deps: OutboxPassDeps = {}): Promise<OutboxPassResult> {
  const db = getDb();
  const leaseOwner = randomUUID();
  const now = deps.now ?? new Date();

  const claimed = await claimDueDeliveries(db, {
    limit: deps.batchSize ?? DEFAULT_BATCH_SIZE,
    leaseOwner,
    leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
    now,
  });

  let delivered = 0;
  let retrying = 0;
  let terminal = 0;

  for (const row of claimed) {
    try {
      const outcome = await deliverOne(row, deps, now);
      if (outcome === 'delivered') delivered += 1;
      else if (outcome === 'retry') retrying += 1;
      else terminal += 1;
    } catch (error) {
      // The row keeps its lease and becomes claimable again when that expires.
      // Losing a cycle is the right cost here; losing the rest of the batch to
      // one bad row is not.
      process.emitWarning(
        `Peable webhook outbox pass failed for delivery ${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { claimed: claimed.length, delivered, retrying, terminal };
}

async function deliverOne(
  row: ClaimedDeliveryRow,
  deps: OutboxPassDeps,
  now: Date,
): Promise<'delivered' | 'retry' | 'terminal'> {
  const db = getDb();

  // Re-read the target rather than trusting the row's snapshot: a merchant who
  // moved their endpoint mid-backoff should receive the retry at the new one.
  // This is also the one read allowed to select `webhook_secret`.
  const target = await findWebhookTarget(db, row.merchantId);
  if (!target) {
    // Not an attempt and not the target's fault — the merchant removed their
    // webhook configuration between enqueue and now. Terminal: there is nothing
    // left to deliver to, and holding the row pending forever would keep a
    // queue that no configuration can ever drain.
    await releaseDeliveryClaim(db, row.id, {
      nextAttemptAt: null,
      reason: 'merchant has no webhook endpoint configured',
    });
    return 'terminal';
  }

  const outcome = await attemptDelivery(
    row.payload,
    { url: target.url, secret: target.secret },
    deps.safeFetch ? { safeFetch: deps.safeFetch } : {},
  );

  const delayMs =
    outcome.kind === 'retry'
      ? nextAttemptDelayMs(row.attempts + 1, deps.random ?? Math.random)
      : null;

  await recordDeliveryAttempt(db, {
    id: row.id,
    outcome,
    url: target.url,
    nextAttemptAt: delayMs === null ? null : new Date(now.getTime() + delayMs),
  });

  if (outcome.kind === 'delivered') return 'delivered';
  return delayMs === null ? 'terminal' : 'retry';
}

let timer: ReturnType<typeof setInterval> | null = null;
/**
 * The deps the running dispatcher was started with, or `null` when none is.
 *
 * Kept so `kickWebhookOutbox` runs the SAME pass the loop does — same injected
 * `safeFetch`, same batch size — rather than a differently-configured one, and
 * so it can tell whether a loop exists at all.
 */
let runningWith: OutboxPassDeps | null = null;

export interface StartOutboxOptions extends OutboxPassDeps {
  readonly intervalMs?: number;
}

/**
 * Start the background pass. Idempotent — a second call is a no-op rather than
 * a second timer, because two loops in one process would double every claim
 * attempt for no throughput (`SKIP LOCKED` protects correctness, not effort).
 */
export function startWebhookOutbox(options: StartOutboxOptions = {}): void {
  if (timer !== null) return;
  runningWith = options;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  timer = setInterval(() => {
    void runWebhookOutboxPass(options).catch((error: unknown) => {
      process.emitWarning(
        `Peable webhook outbox tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, intervalMs);
  // Same as the settlement watcher's: the loop must never be the reason a
  // process or a test run refuses to exit.
  timer.unref?.();
}

export function stopWebhookOutbox(): void {
  runningWith = null;
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Run one pass now, without waiting for the next tick.
 *
 * What gives a freshly-enqueued event its immediate first attempt: the loop's
 * interval is a floor on how long a retry waits, and it should not also be a
 * floor on how long a merchant waits for a settlement they are watching for.
 * Fire-and-forget by design — the caller is a request handler or the settlement
 * watcher, and neither should block on a merchant's endpoint.
 *
 * **A no-op when no dispatcher is running**, and that is the point rather than
 * a shortcut. "Kick" means run the existing loop early; with no loop there is
 * nothing to run early, and the alternative — firing a pass anyway — makes
 * every transition in a test suite reach for the real network and burn an
 * attempt from a delivery's budget against a host that does not resolve. The
 * event is already durably enqueued either way; a missed kick costs latency,
 * never delivery.
 */
export function kickWebhookOutbox(): void {
  if (runningWith === null) return;
  void runWebhookOutboxPass(runningWith).catch((error: unknown) => {
    process.emitWarning(
      `Peable webhook outbox kick failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
