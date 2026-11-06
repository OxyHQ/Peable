import { describe, test, expect } from 'bun:test';
import type { AddressActivity } from '../services/explorer-address';
import {
  SOCIAL_RECEIVE_FULL_SYNC_SECONDS,
  SOCIAL_RECEIVE_RESYNC_INTERVAL_MS,
  checkSocialReceiveDue,
  createResyncScheduler,
  pullSocialReceiveSet,
  type SocialReceiveCheckDeps,
  type SocialReceivePage,
  type SocialReceiveSyncState,
} from './social-receive-sync';
import type { WatchSetCheck, WatchSetRow } from './social-receive-watch';

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('createResyncScheduler', () => {
  test('a request runs a resync', async () => {
    let runs = 0;
    const scheduler = createResyncScheduler({
      run: async () => {
        runs += 1;
      },
      now: () => 0,
    });
    await scheduler.request();
    expect(runs).toBe(1);
  });

  // Two pushes arriving while a resync reads the cursor must not start two
  // concurrent reads — but the one that arrived mid-run must be answered by a
  // read that started AFTER it, not by the one already in flight.
  test('requests during a run coalesce into exactly one follow-up run', async () => {
    const gates = [deferred(), deferred()];
    let runs = 0;
    const scheduler = createResyncScheduler({
      run: async () => {
        const gate = gates[runs];
        runs += 1;
        await gate?.promise;
      },
      now: () => 0,
    });
    const first = scheduler.request();
    const second = scheduler.request();
    const third = scheduler.request();
    expect(runs).toBe(1);
    gates[0]?.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    gates[1]?.resolve();
    await Promise.all([first, second, third]);
    expect(runs).toBe(2);
  });

  test('the interval tick runs only once a resync is due', async () => {
    let clock = 1_000;
    let runs = 0;
    const scheduler = createResyncScheduler({
      run: async () => {
        runs += 1;
      },
      now: () => clock,
    });
    // Nothing has run yet: the first tick is due.
    scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(1);
    clock += SOCIAL_RECEIVE_RESYNC_INTERVAL_MS - 1;
    scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(1);
    clock += 1;
    scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
  });

  test('a request always runs, whatever the interval says', async () => {
    let runs = 0;
    const scheduler = createResyncScheduler({
      run: async () => {
        runs += 1;
      },
      now: () => 0,
    });
    await scheduler.request();
    await scheduler.request();
    expect(runs).toBe(2);
  });

  test('a failed resync is reported and does not stop the next one', async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const scheduler = createResyncScheduler({
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error('gateway down');
      },
      now: () => 0,
      onError: (error) => errors.push(error),
    });
    await scheduler.request();
    await scheduler.request();
    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
  });

  test('reset drops the follow-up a closed wallet had queued', async () => {
    const gate = deferred();
    let runs = 0;
    const scheduler = createResyncScheduler({
      run: async () => {
        runs += 1;
        await gate.promise;
      },
      now: () => 0,
    });
    void scheduler.request();
    void scheduler.request();
    scheduler.reset();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(1);
    // The next wallet's request runs at once.
    await scheduler.request();
    expect(runs).toBe(2);
  });
});

const EMPTY: AddressActivity = { confirmedHeights: [], hasUnconfirmed: false };
const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

function row(index: number, overrides: Partial<WatchSetRow> = {}): WatchSetRow {
  return {
    address: `F${String(index)}`,
    index,
    identityPublicKey: null,
    createdAt: NOW - 30 * DAY,
    used: false,
    checkedAt: null,
    nextCheckAt: null,
    foundAt: null,
    origin: 'gateway',
    ...overrides,
  };
}

function rows(count: number): WatchSetRow[] {
  return Array.from({ length: count }, (_, index) => row(index + 1));
}

function harness(overrides: Partial<SocialReceiveCheckDeps> & { paid?: Record<string, number[]> }) {
  const fetched: string[][] = [];
  const recorded: WatchSetCheck[][] = [];
  const rescans: number[] = [];
  const paid = overrides.paid ?? {};
  const deps: SocialReceiveCheckDeps = {
    due: rows(42),
    now: () => NOW,
    fetchActivity: async (addresses) => {
      fetched.push([...addresses]);
      return new Map(
        addresses.map((address) => [
          address,
          paid[address] ? { confirmedHeights: paid[address], hasUnconfirmed: false } : EMPTY,
        ]),
      );
    },
    requestRescanFrom: async (height) => {
      rescans.push(height);
    },
    record: async (checks) => {
      recorded.push([...checks]);
    },
    isCurrent: () => true,
    batchSize: 10,
    ...overrides,
  };
  return { deps, fetched, recorded, rescans };
}

describe('checkSocialReceiveDue', () => {
  // A payer paid an address handed out a month ago, after its quote lapsed,
  // at block 1234: the address is dormant (not in the Bloom filter), so only
  // this read can find it, and the rescan goes back to the block that pays it.
  test('reads every due row, records each, and rescans from the paid block', async () => {
    const { deps, fetched, recorded, rescans } = harness({ paid: { F22: [1234, 1300] } });
    const result = await checkSocialReceiveDue(deps);
    expect(fetched.flat()).toEqual(rows(42).map(({ address }) => address));
    expect(rescans).toEqual([1234]);
    expect(recorded.map((batch) => batch.length)).toEqual([10, 10, 10, 10, 2]);
    expect(result).toEqual({ checked: 42, found: ['F22'], rescanFrom: 1234 });
    const paidCheck = recorded.flat().find((check) => check.address === 'F22');
    expect(paidCheck?.foundAt).toBe(NOW);
    // A month old: read again in a month (the doubling schedule).
    expect(paidCheck?.nextCheckAt).toBe(NOW + 30 * DAY);
    expect(recorded.flat().find((check) => check.address === 'F1')?.foundAt).toBeUndefined();
  });

  test('nothing due: no read', async () => {
    const { deps, fetched } = harness({ due: [] });
    expect(await checkSocialReceiveDue(deps)).toEqual({ checked: 0, found: [], rescanFrom: null });
    expect(fetched).toHaveLength(0);
  });

  // An Explorer outage is not "never paid": the batch that failed, and every
  // one after it, stays due for the next resync.
  test('a failed read records nothing past the last batch that answered', async () => {
    let calls = 0;
    const { deps, recorded } = harness({
      fetchActivity: async (addresses) => {
        calls += 1;
        if (calls === 2) throw new Error('Explorer 502');
        return new Map(addresses.map((address) => [address, EMPTY]));
      },
    });
    await expect(checkSocialReceiveDue(deps)).rejects.toThrow('Explorer 502');
    expect(recorded.flat().map((check) => check.address)).toEqual(
      rows(10).map(({ address }) => address),
    );
  });

  // A mempool-only coin needs no rescan, but the row is FOUND, which puts it
  // in the Bloom filter so the block that confirms it is seen.
  test('a mempool-only coin is found without a rescan', async () => {
    const { deps, rescans } = harness({
      fetchActivity: async (addresses) =>
        new Map(
          addresses.map((address) => [
            address,
            address === 'F3' ? { confirmedHeights: [], hasUnconfirmed: true } : EMPTY,
          ]),
        ),
    });
    const result = await checkSocialReceiveDue(deps);
    expect(rescans).toEqual([]);
    expect(result.found).toEqual(['F3']);
  });

  test('a wallet closed mid-check writes nothing more', async () => {
    let live = true;
    const { deps, recorded } = harness({
      fetchActivity: async (addresses) => {
        live = false;
        return new Map(addresses.map((address) => [address, EMPTY]));
      },
      isCurrent: () => live,
    });
    await checkSocialReceiveDue(deps);
    expect(recorded).toEqual([]);
  });
});

/** A gateway holding `count` addresses at indices 1..count, paged like the route. */
function gateway(count: number, pageSize: number) {
  const calls: number[] = [];
  const list = async (after: number): Promise<SocialReceivePage<number>> => {
    calls.push(after);
    const addresses: number[] = [];
    for (let index = after + 1; index <= count && addresses.length < pageSize; index += 1) {
      addresses.push(index);
    }
    const last = addresses[addresses.length - 1];
    return {
      addresses,
      has_more: last !== undefined && last < count,
      sync_cursor: last ?? after,
    };
  };
  return { list, calls };
}

function puller(
  state: SocialReceiveSyncState,
  source: ReturnType<typeof gateway>,
  options: { now?: number; maxPages?: number; isCurrent?: () => boolean } = {},
) {
  const stored: number[] = [];
  const saved: SocialReceiveSyncState[] = [];
  return {
    stored,
    saved,
    run: () =>
      pullSocialReceiveSet<number>({
        state,
        now: () => options.now ?? NOW,
        list: source.list,
        store: async (items) => {
          for (const item of items) stored.push(item);
        },
        saveState: async (next) => {
          saved.push(next);
        },
        isCurrent: options.isCurrent ?? (() => true),
        maxPages: options.maxPages,
      }),
  };
}

describe('pullSocialReceiveSet', () => {
  test('pages a fresh set from the start to the end, and that read is the first full one', async () => {
    const source = gateway(2_500, 1_000);
    const pull = puller({ cursor: 0, fullAfter: null, fullAt: null }, source);
    const result = await pull.run();
    expect(source.calls).toEqual([0, 1_000, 2_000]);
    expect(pull.stored).toHaveLength(2_500);
    expect(result).toMatchObject({
      complete: true,
      state: { cursor: 2_500, fullAfter: null, fullAt: NOW },
    });
    expect(pull.saved.map((state) => state.cursor)).toEqual([1_000, 2_000, 2_500]);
  });

  test('continues from the stored cursor: only what was handed out since', async () => {
    const source = gateway(2_510, 1_000);
    const pull = puller({ cursor: 2_500, fullAfter: null, fullAt: NOW - DAY }, source);
    const result = await pull.run();
    expect(source.calls).toEqual([2_500]);
    expect(pull.stored).toEqual(Array.from({ length: 10 }, (_, i) => 2_501 + i));
    expect(result.state).toEqual({ cursor: 2_510, fullAfter: null, fullAt: NOW - DAY });
  });

  test('stops after the page budget and resumes on the next resync', async () => {
    const source = gateway(50, 10);
    const first = await puller({ cursor: 0, fullAfter: null, fullAt: null }, source, {
      maxPages: 2,
    }).run();
    expect(first).toMatchObject({ complete: false, state: { cursor: 20, fullAt: null } });
    const second = await puller(first.state, source, { maxPages: 20 }).run();
    expect(second).toMatchObject({ complete: true, state: { cursor: 50, fullAt: NOW } });
  });

  test('once a week the set is read again from the start, without moving the cursor back', async () => {
    const source = gateway(30, 10);
    const state = { cursor: 30, fullAfter: null, fullAt: NOW - SOCIAL_RECEIVE_FULL_SYNC_SECONDS };
    const partial = await puller(state, source, { maxPages: 1 }).run();
    expect(source.calls).toEqual([0]);
    expect(partial.state).toEqual({ cursor: 30, fullAfter: 10, fullAt: state.fullAt });
    const rest = await puller(partial.state, source).run();
    expect(source.calls).toEqual([0, 10, 20]);
    expect(rest).toMatchObject({
      complete: true,
      state: { cursor: 30, fullAfter: null, fullAt: NOW },
    });
  });

  test('not yet a week: no full read', async () => {
    const source = gateway(30, 10);
    await puller({ cursor: 30, fullAfter: null, fullAt: NOW - DAY }, source).run();
    expect(source.calls).toEqual([30]);
  });

  test('a wallet closed mid-pull stores nothing more and saves no state', async () => {
    const source = gateway(30, 10);
    const pull = puller({ cursor: 0, fullAfter: null, fullAt: null }, source, {
      isCurrent: () => false,
    });
    await pull.run();
    expect(pull.stored).toEqual([]);
    expect(pull.saved).toEqual([]);
  });

  test('a failed page keeps every page stored before it', async () => {
    let calls = 0;
    const source = gateway(30, 10);
    const failing = {
      calls: source.calls,
      list: async (after: number) => {
        calls += 1;
        if (calls === 2) throw new Error('gateway 503');
        return source.list(after);
      },
    };
    const pull = puller({ cursor: 0, fullAfter: null, fullAt: null }, failing);
    await expect(pull.run()).rejects.toThrow('gateway 503');
    expect(pull.saved).toEqual([{ cursor: 10, fullAfter: null, fullAt: null }]);
  });
});
