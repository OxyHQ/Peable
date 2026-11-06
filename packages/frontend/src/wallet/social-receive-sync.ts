/**
 * Keeping the social-receive watch window honest while the wallet RUNS.
 *
 * The gateway advances this account's cursor on every `next_address` — every
 * `@username` lookup, every FairCoin checkout, abandoned or not — and none of
 * that reaches the phone. Reading the cursor only at unlock meant a running
 * wallet fell behind after the gap limit's worth of unpaid reservations, and
 * the payment after them was never seen: the gateway said succeeded, the
 * wallet never showed the coins.
 *
 * Two halves, both pure over injected effects so they are unit-tested without
 * SQLite, SPV or a network:
 *
 * - {@link createResyncScheduler}: WHEN to re-read the cursor — on request
 *   (the app coming to the foreground, a push, a social payment landing, the
 *   Receive sheet opening) and on a bounded interval — never two at once.
 * - {@link checkSocialReceiveAddresses}: making sure every watched index has
 *   actually been LOOKED AT. An address that joins the Bloom filter is watched
 *   from then on; blocks the historical rescan already passed are never
 *   revisited. So each new index is read once through the Explorer, and any
 *   coin found there sends the SPV rescan back to the block it confirmed in.
 */

import type { AddressActivity } from '../services/explorer-address';

/** How often a running wallet re-reads the cursor with nothing prompting it. */
export const SOCIAL_RECEIVE_RESYNC_INTERVAL_MS = 2 * 60_000;

export interface ResyncScheduler {
  /**
   * Run a resync now, or — when one is already running — once more right
   * after it, so an event that arrived mid-run is not answered by a read that
   * started before it. Resolves when the run it joined (or caused) finishes.
   */
  request(): Promise<void>;
  /** Run a resync if the last one STARTED at least an interval ago. */
  tick(): void;
  /** Forget the history (the wallet closed); a run in flight is not awaited. */
  reset(): void;
}

export function createResyncScheduler(deps: {
  readonly run: () => Promise<void>;
  readonly now: () => number;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}): ResyncScheduler {
  const intervalMs = deps.intervalMs ?? SOCIAL_RECEIVE_RESYNC_INTERVAL_MS;
  let inFlight: Promise<void> | null = null;
  let again = false;
  let lastStartedAt: number | null = null;
  let epoch = 0;

  const start = (): Promise<void> => {
    const mine = epoch;
    lastStartedAt = deps.now();
    const run = (async () => {
      try {
        await deps.run();
      } catch (error) {
        deps.onError?.(error);
      }
    })();
    inFlight = run.then(() => {
      if (mine !== epoch) return;
      inFlight = null;
      if (again) {
        again = false;
        return start();
      }
    });
    return inFlight;
  };

  return {
    request() {
      if (inFlight) {
        again = true;
        return inFlight;
      }
      return start();
    },
    tick() {
      if (inFlight) return;
      if (lastStartedAt !== null && deps.now() - lastStartedAt < intervalMs) return;
      void start();
    },
    reset() {
      epoch += 1;
      inFlight = null;
      again = false;
      lastStartedAt = null;
    },
  };
}

/** How many addresses one Explorer round reads before recording progress. */
const CHECK_BATCH = 50;

export interface SocialReceiveCheckDeps {
  /** Every watched index with its address (any order). */
  readonly watched: readonly { readonly index: number; readonly address: string }[];
  /** Every index up to and including this one has been checked (-1: none). */
  readonly checkedThrough: number;
  /**
   * False when no historical rescan has ever started: the first one scans from
   * the wallet birthday with whatever the Bloom filter holds by then, which
   * covers every address already watched — no Explorer read needed.
   */
  readonly scanHasBegun: boolean;
  /** {@link fetchAddressActivity}; throws on any failure but a 404. */
  readonly fetchActivity: (addresses: readonly string[]) => Promise<Map<string, AddressActivity>>;
  /** Send the SPV rescan back to `height` (persisted, applied by the driver). */
  readonly requestRescanFrom: (height: number) => Promise<void>;
  /** Persist progress. Called only after the reads it covers answered. */
  readonly markCheckedThrough: (index: number) => Promise<void>;
  /** False once the wallet closed or switched: stop without writing. */
  readonly isCurrent: () => boolean;
  readonly batchSize?: number;
}

export interface SocialReceiveCheckResult {
  readonly checkedThrough: number;
  /** The lowest height a rescan was requested from, or `null`. */
  readonly rescanFrom: number | null;
}

/**
 * Look at every watched index above `checkedThrough`, in index order, a batch
 * at a time. Progress is recorded only for a batch whose reads all answered,
 * so an Explorer outage leaves the rest to the next resync instead of
 * recording them as empty. A coin still in the mempool needs nothing: the
 * block that confirms it is above the rescan's target and is scanned with the
 * filter as it is now.
 */
export async function checkSocialReceiveAddresses(
  deps: SocialReceiveCheckDeps,
): Promise<SocialReceiveCheckResult> {
  const pending = deps.watched
    .filter(({ index }) => index > deps.checkedThrough)
    .sort((a, b) => a.index - b.index);
  const last = pending[pending.length - 1];
  if (!last) return { checkedThrough: deps.checkedThrough, rescanFrom: null };

  if (!deps.scanHasBegun) {
    await deps.markCheckedThrough(last.index);
    return { checkedThrough: last.index, rescanFrom: null };
  }

  const batchSize = deps.batchSize ?? CHECK_BATCH;
  let checkedThrough = deps.checkedThrough;
  let rescanFrom: number | null = null;
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const activity = await deps.fetchActivity(batch.map(({ address }) => address));
    if (!deps.isCurrent()) break;
    let lowest: number | null = null;
    for (const { address } of batch) {
      const first = activity.get(address)?.confirmedHeights[0];
      if (first !== undefined && (lowest === null || first < lowest)) lowest = first;
    }
    if (lowest !== null) {
      await deps.requestRescanFrom(lowest);
      rescanFrom = rescanFrom === null ? lowest : Math.min(rescanFrom, lowest);
    }
    const batchLast = batch[batch.length - 1];
    if (!batchLast || !deps.isCurrent()) break;
    await deps.markCheckedThrough(batchLast.index);
    checkedThrough = batchLast.index;
  }
  return { checkedThrough, rescanFrom };
}
