/**
 * Keeping the social-receive watch set honest while the wallet RUNS (ADR 0021
 * D9, amended 2026-11-06).
 *
 * The gateway hands out a fresh address of this account on every FairCoin
 * payment and every `@username` request, and none of that reaches the phone by
 * itself. So the wallet pulls the set the gateway reports
 * (`GET /v1/social/me/receive_addresses`) on request and on an interval.
 *
 * Three pieces, each pure over injected effects so they are unit-tested
 * without SQLite, SPV or a network:
 *
 * - {@link createResyncScheduler}: WHEN to resync — on request (the app coming
 *   to the foreground, a push, a social payment landing, the Receive sheet
 *   opening) and on a bounded interval — never two at once.
 * - {@link pullSocialReceiveSet}: paging the set from the stored sync cursor,
 *   and once a week from the start again.
 * - {@link checkSocialReceiveDue}: reading through the Explorer the addresses
 *   whose turn came (`social-receive-watch.ts` decides which). An address that
 *   joins the Bloom filter is watched from then on, but blocks the historical
 *   rescan already passed are never revisited, and a dormant address is not in
 *   the filter at all; any coin a read finds sends the SPV rescan back to the
 *   block it confirmed in.
 */

import type { AddressActivity } from '../services/explorer-address';
import type { WatchSetCheck, WatchSetRow } from './social-receive-watch';
import { nextSocialReceiveCheckAt } from './social-receive-watch';

/** How often a running wallet resyncs with nothing prompting it. */
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
  /** The rows to read, in the order to read them (`planSocialReceiveChecks`). */
  readonly due: readonly WatchSetRow[];
  /** The clock, Unix seconds. */
  readonly now: () => number;
  /** {@link fetchAddressActivity}; throws on any failure but a 404. */
  readonly fetchActivity: (addresses: readonly string[]) => Promise<Map<string, AddressActivity>>;
  /** Send the SPV rescan back to `height` (persisted, applied by the driver). */
  readonly requestRescanFrom: (height: number) => Promise<void>;
  /** Persist one batch's checks. Called only after the reads it covers answered. */
  readonly record: (checks: readonly WatchSetCheck[]) => Promise<void>;
  /** False once the wallet closed or switched: stop without writing. */
  readonly isCurrent: () => boolean;
  readonly batchSize?: number;
}

export interface SocialReceiveCheckResult {
  /** How many rows were read and recorded. */
  readonly checked: number;
  /** The addresses a read showed coins at (confirmed or in the mempool). */
  readonly found: readonly string[];
  /** The lowest height a rescan was requested from, or `null`. */
  readonly rescanFrom: number | null;
}

/**
 * Read every due row through the Explorer, a batch at a time. A batch is
 * recorded only once all its reads answered, so an Explorer outage leaves the
 * rest due for the next resync instead of recording them as empty. A coin
 * found sends the rescan back to its block and marks the row found, which
 * puts it in the Bloom filter: a coin still in the mempool is then seen in the
 * block that confirms it.
 */
export async function checkSocialReceiveDue(
  deps: SocialReceiveCheckDeps,
): Promise<SocialReceiveCheckResult> {
  const batchSize = deps.batchSize ?? CHECK_BATCH;
  let checked = 0;
  let rescanFrom: number | null = null;
  const found: string[] = [];
  for (let offset = 0; offset < deps.due.length; offset += batchSize) {
    const batch = deps.due.slice(offset, offset + batchSize);
    const activity = await deps.fetchActivity(batch.map(({ address }) => address));
    if (!deps.isCurrent()) break;
    const now = deps.now();
    let lowest: number | null = null;
    const checks: WatchSetCheck[] = [];
    for (const row of batch) {
      const seen = activity.get(row.address);
      const first = seen?.confirmedHeights[0];
      if (first !== undefined && (lowest === null || first < lowest)) lowest = first;
      const hasCoins = first !== undefined || seen?.hasUnconfirmed === true;
      if (hasCoins) found.push(row.address);
      checks.push({
        address: row.address,
        checkedAt: now,
        nextCheckAt: nextSocialReceiveCheckAt(row.createdAt, now),
        ...(hasCoins ? { foundAt: now } : {}),
      });
    }
    if (lowest !== null) {
      await deps.requestRescanFrom(lowest);
      rescanFrom = rescanFrom === null ? lowest : Math.min(rescanFrom, lowest);
    }
    if (!deps.isCurrent()) break;
    await deps.record(checks);
    checked += checks.length;
  }
  return { checked, found, rescanFrom };
}

/** Pages one resync reads at most; the rest is read on the next. */
export const SOCIAL_RECEIVE_SYNC_PAGES_PER_RESYNC = 20;

/** How often the whole set is read again from the start (defence in depth). */
export const SOCIAL_RECEIVE_FULL_SYNC_SECONDS = 7 * 24 * 60 * 60;

/** Where the pull stands, persisted between resyncs. */
export interface SocialReceiveSyncState {
  /** The incremental sync cursor: every address at or below it is stored. */
  readonly cursor: number;
  /** A full re-read in progress: where it stands; `null` when none is. */
  readonly fullAfter: number | null;
  /** When a read last reached the end from the start; `null`: never. */
  readonly fullAt: number | null;
}

/** One page as the route answers it. */
export interface SocialReceivePage<Item> {
  readonly addresses: readonly Item[];
  readonly has_more: boolean;
  readonly sync_cursor: number;
}

export interface SocialReceivePullDeps<Item> {
  readonly state: SocialReceiveSyncState;
  /** Unix seconds. */
  readonly now: () => number;
  /** `GET /v1/social/me/receive_addresses` after `after`. */
  readonly list: (after: number) => Promise<SocialReceivePage<Item>>;
  /** Store a page's addresses (idempotent: a full re-read stores them again). */
  readonly store: (items: readonly Item[]) => Promise<void>;
  /** Persist the state after a page was stored. */
  readonly saveState: (state: SocialReceiveSyncState) => Promise<void>;
  readonly isCurrent: () => boolean;
  readonly maxPages?: number;
  readonly fullSyncSeconds?: number;
}

export interface SocialReceivePullResult<Item> {
  readonly state: SocialReceiveSyncState;
  /** Every address this pull stored, in the order it came. */
  readonly items: readonly Item[];
  /** Whether the set is read to its end (nothing left for the next resync). */
  readonly complete: boolean;
}

/**
 * Page the set from the stored sync cursor until the gateway says there is no
 * more, at most `maxPages` pages; a page is stored before the cursor moves past
 * it, so a crash re-reads a page rather than skipping one. The cursor is
 * monotonic on the gateway (a later address has a higher index), so the
 * incremental read misses nothing; once every {@link SOCIAL_RECEIVE_FULL_SYNC_SECONDS}
 * the set is read again from the start anyway, resumable across resyncs,
 * never moving the incremental cursor back. Errors propagate to the caller,
 * with every stored page kept.
 */
export async function pullSocialReceiveSet<Item>(
  deps: SocialReceivePullDeps<Item>,
): Promise<SocialReceivePullResult<Item>> {
  const maxPages = deps.maxPages ?? SOCIAL_RECEIVE_SYNC_PAGES_PER_RESYNC;
  const fullSyncSeconds = deps.fullSyncSeconds ?? SOCIAL_RECEIVE_FULL_SYNC_SECONDS;
  let state = deps.state;
  if (
    state.fullAfter === null &&
    state.fullAt !== null &&
    deps.now() - state.fullAt >= fullSyncSeconds
  ) {
    state = { ...state, fullAfter: 0 };
  }
  const items: Item[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const full = state.fullAfter !== null;
    const after = state.fullAfter ?? state.cursor;
    const answer = await deps.list(after);
    if (!deps.isCurrent()) return { state, items, complete: false };
    await deps.store(answer.addresses);
    for (const item of answer.addresses) items.push(item);
    const reached = Math.max(after, answer.sync_cursor);
    const done = !answer.has_more;
    if (full) {
      state = {
        cursor: Math.max(state.cursor, reached),
        fullAfter: done ? null : reached,
        fullAt: done ? deps.now() : state.fullAt,
      };
    } else {
      state = {
        cursor: reached,
        fullAfter: null,
        // The cursor starts at 0, so the first read to the end IS a full read.
        fullAt: done && state.fullAt === null ? deps.now() : state.fullAt,
      };
    }
    if (!deps.isCurrent()) return { state, items, complete: false };
    await deps.saveState(state);
    // A page that moved nothing while saying "more" would loop: stop and retry later.
    if (done || reached === after) return { state, items, complete: done };
  }
  return { state, items, complete: false };
}
