import { describe, test, expect } from 'bun:test';
import type { AddressActivity } from '../services/explorer-address';
import {
  SOCIAL_RECEIVE_RESYNC_INTERVAL_MS,
  checkSocialReceiveAddresses,
  createResyncScheduler,
  type SocialReceiveCheckDeps,
} from './social-receive-sync';

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

function window(count: number): { index: number; address: string }[] {
  return Array.from({ length: count }, (_, index) => ({ index, address: `F${String(index)}` }));
}

function harness(overrides: Partial<SocialReceiveCheckDeps> & { paid?: Record<string, number[]> }) {
  const fetched: string[][] = [];
  const marks: number[] = [];
  const rescans: number[] = [];
  const paid = overrides.paid ?? {};
  const deps: SocialReceiveCheckDeps = {
    watched: window(42),
    checkedThrough: -1,
    scanHasBegun: true,
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
    markCheckedThrough: async (index) => {
      marks.push(index);
    },
    isCurrent: () => true,
    batchSize: 10,
    ...overrides,
  };
  return { deps, fetched, marks, rescans };
}

describe('checkSocialReceiveAddresses', () => {
  // F3: the window grew from 20 to 42 because 21 checkouts were abandoned and
  // a payer was then handed index 22 — which they paid at block 1234, before
  // this phone watched it. Only the new indices are read, and the rescan goes
  // back to the block that pays it.
  test('reads every index above the checked mark and rescans from the paid block', async () => {
    const { deps, fetched, marks, rescans } = harness({
      checkedThrough: 19,
      paid: { F22: [1234, 1300] },
    });
    const result = await checkSocialReceiveAddresses(deps);
    expect(fetched.flat()).toEqual(
      window(42)
        .slice(20)
        .map(({ address }) => address),
    );
    expect(rescans).toEqual([1234]);
    expect(marks).toEqual([29, 39, 41]);
    expect(result).toEqual({ checkedThrough: 41, rescanFrom: 1234 });
  });

  test('every reserved index ends up checked, however far from the last payment', async () => {
    const { deps, marks } = harness({ watched: window(2_000), batchSize: 50 });
    const result = await checkSocialReceiveAddresses(deps);
    expect(result.checkedThrough).toBe(1_999);
    expect(marks[marks.length - 1]).toBe(1_999);
  });

  test('nothing above the mark: no read', async () => {
    const { deps, fetched } = harness({ checkedThrough: 41 });
    expect(await checkSocialReceiveAddresses(deps)).toEqual({
      checkedThrough: 41,
      rescanFrom: null,
    });
    expect(fetched).toHaveLength(0);
  });

  test('before any scan has begun, the first scan covers what is watched', async () => {
    const { deps, fetched, marks } = harness({ scanHasBegun: false });
    expect(await checkSocialReceiveAddresses(deps)).toEqual({
      checkedThrough: 41,
      rescanFrom: null,
    });
    expect(fetched).toHaveLength(0);
    expect(marks).toEqual([41]);
  });

  // An Explorer outage is not "never paid": the batch that failed, and every
  // one after it, stays unchecked for the next resync.
  test('a failed read records no progress past the last batch that answered', async () => {
    const marks: number[] = [];
    let calls = 0;
    const { deps } = harness({
      fetchActivity: async (addresses) => {
        calls += 1;
        if (calls === 2) throw new Error('Explorer 502');
        return new Map(addresses.map((address) => [address, EMPTY]));
      },
      markCheckedThrough: async (index) => {
        marks.push(index);
      },
    });
    await expect(checkSocialReceiveAddresses(deps)).rejects.toThrow('Explorer 502');
    expect(marks).toEqual([9]);
  });

  test('a mempool-only coin needs no rescan: its block is still ahead', async () => {
    const { deps, rescans } = harness({
      fetchActivity: async (addresses) =>
        new Map(
          addresses.map((address) => [
            address,
            address === 'F3' ? { confirmedHeights: [], hasUnconfirmed: true } : EMPTY,
          ]),
        ),
    });
    await checkSocialReceiveAddresses(deps);
    expect(rescans).toEqual([]);
  });

  test('a wallet closed mid-check writes nothing more', async () => {
    let live = true;
    const { deps, marks } = harness({
      fetchActivity: async (addresses) => {
        live = false;
        return new Map(addresses.map((address) => [address, EMPTY]));
      },
      isCurrent: () => live,
    });
    await checkSocialReceiveAddresses(deps);
    expect(marks).toEqual([]);
  });
});
