/**
 * The live tail: a TEST-MODE merchant's newly committed rows, as they commit.
 *
 * `peable listen` and `peable logs tail` (`packages/cli`) show a developer what
 * their integration just caused — the events it produced and the requests it
 * made — without a public webhook URL. This is the server half: a wake-up
 * signal per committed row, fanned out to the open streams of that row's
 * merchant, which then read the row from its table and render it exactly as
 * the API does.
 *
 * ## Why Postgres `NOTIFY`, and not an in-process emitter
 *
 * Two properties, and the obvious alternatives have one each:
 *
 * - **Only what committed.** `NOTIFY` inside a transaction is delivered when —
 *   and only if — that transaction commits; a rolled-back transaction (or a
 *   rolled-back savepoint) never sends it. The signal is therefore sent from
 *   inside the very transaction that writes the row (`recordEvent`, ADR 0014
 *   D4), and cannot announce a change that did not happen. An emitter called
 *   after the commit would need every writer to remember to call it, and one
 *   called inside the transaction would announce rollbacks.
 * - **Every task.** The ECS service runs several tasks behind one load
 *   balancer: the request that settles a payment, the settlement watcher and
 *   the CLI's stream are routinely in three different processes. An in-process
 *   emitter would only ever reach a stream that happened to share a task with
 *   the writer.
 *
 * ## Never a second source of truth
 *
 * The payload is two INTERNAL ids — the merchant and the row — and nothing
 * else. The stream reads the row back through the same repository the API
 * reads it with, scoped to the stream's merchant, so what a developer sees is
 * the stored record and never a copy assembled beside it. The payload never
 * leaves the server.
 *
 * ## Test mode only, and why that is also the cost bound
 *
 * A transaction that issued `NOTIFY` takes a database-wide lock while it
 * commits, which serializes such commits across every app on the shared RDS
 * instance. The tail is a development tool, refused for live credentials, so
 * `notifyLiveTail` is only ever called for a test-mode row: live money
 * transactions never pay for it.
 */
import { sql } from 'drizzle-orm';
import { listenPostgres, type DatabaseOrTransaction, type PostgresListener } from '../db/postgres';

/** The two channels. Constants, never caller input: a channel is an identifier. */
export const LIVE_TAIL_CHANNELS = {
  events: 'peable_test_events',
  requestLogs: 'peable_test_request_logs',
} as const;

export type LiveTailChannel = (typeof LIVE_TAIL_CHANNELS)[keyof typeof LIVE_TAIL_CHANNELS];

/**
 * Signal one committed row to the open streams of its merchant.
 *
 * MUST run on the transaction that writes the row, so the signal is delivered
 * at that transaction's commit and never for a rollback. The caller decides
 * test mode (the row's merchant's `livemode`); this function does not check.
 */
export async function notifyLiveTail(
  tx: DatabaseOrTransaction,
  channel: LiveTailChannel,
  merchantId: string,
  rowId: string,
): Promise<void> {
  await tx.execute(sql`select pg_notify(${channel}, ${`${merchantId}:${rowId}`})`);
}

/** One open stream's half of the hub. */
export interface LiveTailSubscriber {
  /** A row of this subscriber's merchant committed: its INTERNAL id. */
  onRow(rowId: string): void;
  /**
   * The listener reconnected, and notifications sent while it was down are
   * lost: catch up from the table.
   */
  onResync(): void;
}

interface ChannelState {
  readonly subscribers: Map<string, Set<LiveTailSubscriber>>;
  /** The LISTEN, once established; shared by every subscriber of the channel. */
  listening: Promise<PostgresListener> | null;
  /** The first `onListen` is the subscription itself; every later one is a reconnect. */
  established: boolean;
}

/**
 * One `LISTEN` per channel per process, shared by every open stream, opened by
 * the first subscriber and closed with the last — so a task nobody streams
 * from holds no listener connection at all.
 */
class LiveTailHub {
  private readonly channels = new Map<LiveTailChannel, ChannelState>();

  /**
   * Subscribe `subscriber` to `merchantId`'s rows on `channel`. Resolves once
   * the LISTEN is established, so a row committed after it resolves is never
   * missed. The returned function unsubscribes; it is safe to call twice.
   */
  async subscribe(
    channel: LiveTailChannel,
    merchantId: string,
    subscriber: LiveTailSubscriber,
  ): Promise<() => Promise<void>> {
    const state = this.stateOf(channel);
    let forMerchant = state.subscribers.get(merchantId);
    if (!forMerchant) {
      forMerchant = new Set();
      state.subscribers.set(merchantId, forMerchant);
    }
    forMerchant.add(subscriber);

    if (state.listening === null) {
      state.established = false;
      state.listening = listenPostgres(
        channel,
        (payload) => this.dispatch(state, payload),
        () => {
          if (state.established) this.resyncAll(state);
          state.established = true;
        },
      );
      // A failed LISTEN must not poison the channel for the next subscriber.
      state.listening.catch(() => {
        state.listening = null;
      });
    }
    try {
      await state.listening;
    } catch (error) {
      this.remove(state, merchantId, subscriber);
      throw error;
    }

    let removed = false;
    return async () => {
      if (removed) return;
      removed = true;
      await this.removeAndMaybeUnlisten(state, merchantId, subscriber);
    };
  }

  /** How many streams this process holds open for a merchant on a channel. */
  count(channel: LiveTailChannel, merchantId: string): number {
    return this.channels.get(channel)?.subscribers.get(merchantId)?.size ?? 0;
  }

  private stateOf(channel: LiveTailChannel): ChannelState {
    let state = this.channels.get(channel);
    if (!state) {
      state = { subscribers: new Map(), listening: null, established: false };
      this.channels.set(channel, state);
    }
    return state;
  }

  private dispatch(state: ChannelState, payload: string): void {
    const separator = payload.indexOf(':');
    if (separator <= 0) return;
    const merchantId = payload.slice(0, separator);
    const rowId = payload.slice(separator + 1);
    for (const subscriber of state.subscribers.get(merchantId) ?? []) subscriber.onRow(rowId);
  }

  private resyncAll(state: ChannelState): void {
    for (const forMerchant of state.subscribers.values()) {
      for (const subscriber of forMerchant) subscriber.onResync();
    }
  }

  private remove(state: ChannelState, merchantId: string, subscriber: LiveTailSubscriber): void {
    const forMerchant = state.subscribers.get(merchantId);
    forMerchant?.delete(subscriber);
    if (forMerchant?.size === 0) state.subscribers.delete(merchantId);
  }

  private async removeAndMaybeUnlisten(
    state: ChannelState,
    merchantId: string,
    subscriber: LiveTailSubscriber,
  ): Promise<void> {
    this.remove(state, merchantId, subscriber);
    if (state.subscribers.size > 0 || state.listening === null) return;
    const listening = state.listening;
    state.listening = null;
    try {
      await (await listening).unlisten();
    } catch {
      // The connection is already gone (the pool closed): nothing is listening.
    }
  }
}

/** The process's hub. */
export const liveTailHub = new LiveTailHub();
