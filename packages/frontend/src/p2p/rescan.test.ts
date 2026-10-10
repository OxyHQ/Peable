/**
 * Tests for the historical rescan scheduler (SPV_AUDIT.md §6.3).
 *
 * Covers the windowed iteration, resumability (progress is persisted and the
 * scan resumes from where it stopped), and the plan that decides where a rescan
 * should start (resume an incomplete scan, catch up newly-synced blocks, or do
 * nothing when already up to date).
 *
 * The block-discovery / crediting itself is the SAME idempotent receive path
 * proven in `wallet/receive.test.ts`; here we verify the scheduling that drives
 * the merkle-block requests across that path so a known historical tx can be
 * (re-)discovered without double-counting.
 */

import { describe, test, expect } from 'bun:test';
import { Rescanner, planRescan, type RescanCallbacks, type RescanProgress } from './rescan';

// ---------------------------------------------------------------------------
// A fake SPV/header environment for the Rescanner.
// ---------------------------------------------------------------------------

interface FakeEnv {
  callbacks: RescanCallbacks;
  requestedHeights: number[][];
  persisted: RescanProgress[];
}

function makeEnv(tipHeight: number, opts: { hasPeer?: boolean; stopAfter?: number } = {}): FakeEnv {
  const requestedHeights: number[][] = [];
  const persisted: RescanProgress[] = [];
  const hasPeer = opts.hasPeer ?? true;
  let requestCount = 0;

  // Map height -> a deterministic 32-byte hash so we can assert which blocks
  // were requested.
  const hashAt = (h: number): Uint8Array => {
    const b = new Uint8Array(32);
    b[0] = h & 0xff;
    b[1] = (h >>> 8) & 0xff;
    return b;
  };

  const callbacks: RescanCallbacks = {
    getBlockHashesInRange: async (from, to) => {
      const out: Uint8Array[] = [];
      for (let h = from; h <= Math.min(to, tipHeight); h++) {
        out.push(hashAt(h));
      }
      return out;
    },
    requestMerkleBlocks: async (hashes) => {
      requestCount++;
      requestedHeights.push(hashes.map((h) => h[0] | (h[1] << 8)));
      return hasPeer;
    },
    persist: async (progress) => {
      persisted.push(progress);
    },
    waitForWindow: async () => {
      // no-op in tests
    },
    isRunning: () => (opts.stopAfter === undefined ? true : requestCount < opts.stopAfter),
  };

  return { callbacks, requestedHeights, persisted };
}

// ---------------------------------------------------------------------------
// Rescanner
// ---------------------------------------------------------------------------

describe('Rescanner', () => {
  test('scans every block in the range across windows', async () => {
    const env = makeEnv(450);
    const scanner = new Rescanner(env.callbacks, 200);
    const result = await scanner.run(0, 450);

    expect(result.completed).toBe(true);
    expect(result.nextHeight).toBe(451);

    // Windows: [0..199], [200..399], [400..450].
    const all = env.requestedHeights.flat();
    expect(all.length).toBe(451);
    expect(all[0]).toBe(0);
    expect(all[all.length - 1]).toBe(450);
    expect(env.requestedHeights.length).toBe(3);
  });

  test('persists progress after each window for resumability', async () => {
    const env = makeEnv(450);
    const scanner = new Rescanner(env.callbacks, 200);
    await scanner.run(0, 450);

    // One persist per window, last marks completion.
    const nexts = env.persisted.map((p) => p.nextHeight);
    expect(nexts).toEqual([200, 400, 451]);
    expect(env.persisted[env.persisted.length - 1].completed).toBe(true);
  });

  test('resumes from a persisted next-height and does not re-request earlier blocks', async () => {
    const env = makeEnv(450);
    const scanner = new Rescanner(env.callbacks, 200);
    // Resume as if [0..399] were already scanned.
    const result = await scanner.run(0, 450, 400);

    expect(result.completed).toBe(true);
    const all = env.requestedHeights.flat();
    expect(Math.min(...all)).toBe(400); // nothing below the resume point
    expect(Math.max(...all)).toBe(450);
  });

  test('stops and persists without completing when no peer is available', async () => {
    const env = makeEnv(450, { hasPeer: false });
    const scanner = new Rescanner(env.callbacks, 200);
    const result = await scanner.run(0, 450);

    expect(result.completed).toBe(false);
    expect(result.nextHeight).toBe(0); // could not make progress
    expect(env.persisted[env.persisted.length - 1].completed).toBe(false);
  });

  test('an empty range completes immediately', async () => {
    const env = makeEnv(-1);
    const scanner = new Rescanner(env.callbacks, 200);
    const result = await scanner.run(5, 4);
    expect(result.completed).toBe(true);
    expect(env.requestedHeights.length).toBe(0);
  });

  test('refuses to run two scans concurrently', async () => {
    const env = makeEnv(1000);
    const scanner = new Rescanner(env.callbacks, 100);
    const first = scanner.run(0, 1000);
    await expect(scanner.run(0, 1000)).rejects.toThrow(/already in progress/i);
    await first;
  });
});

// ---------------------------------------------------------------------------
// planRescan
// ---------------------------------------------------------------------------

describe('planRescan', () => {
  test('starts from the birthday when nothing is persisted', () => {
    const plan = planRescan(null, 0, 500);
    expect(plan).toEqual({ startHeight: 0, resumeFrom: 0, targetHeight: 500 });
  });

  test('resumes an incomplete scan and extends to the new tip', () => {
    const persisted: RescanProgress = {
      startHeight: 0,
      nextHeight: 300,
      targetHeight: 450,
      completed: false,
    };
    const plan = planRescan(persisted, 0, 600);
    expect(plan).toEqual({ startHeight: 0, resumeFrom: 300, targetHeight: 600 });
  });

  test('does nothing when a completed scan already covers the tip', () => {
    const persisted: RescanProgress = {
      startHeight: 0,
      nextHeight: 501,
      targetHeight: 500,
      completed: true,
    };
    expect(planRescan(persisted, 0, 500)).toBeNull();
  });

  test('catches up only the new range after a completed scan', () => {
    const persisted: RescanProgress = {
      startHeight: 0,
      nextHeight: 501,
      targetHeight: 500,
      completed: true,
    };
    const plan = planRescan(persisted, 0, 700);
    expect(plan).toEqual({
      startHeight: 501,
      resumeFrom: 501,
      targetHeight: 700,
    });
  });

  test('returns null when the tip is below the birthday', () => {
    expect(planRescan(null, 1000, 500)).toBeNull();
  });
});
