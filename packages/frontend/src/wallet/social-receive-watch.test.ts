import { describe, expect, test } from 'bun:test';
import { bytesToHex, deriveSocialReceiveAddress, getNetwork, hexToBytes } from '@fairco.in/core';
import { getPublicKey } from '@noble/secp256k1';
import {
  SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS,
  SOCIAL_RECEIVE_ACTIVE_FLOOR,
  SOCIAL_RECEIVE_ACTIVE_MAX,
  SOCIAL_RECEIVE_FUNDED_MAX,
  SOCIAL_RECEIVE_CHECKS_PER_RESYNC,
  SOCIAL_RECEIVE_RECHECK_MAX_SECONDS,
  SOCIAL_RECEIVE_RECHECK_MIN_SECONDS,
  nextSocialReceiveCheckAt,
  planActiveSet,
  planSocialReceiveChecks,
  verifyGatewayRows,
  watchableRows,
  type WatchSetRow,
} from './social-receive-watch';

const TESTNET = getNetwork('testnet');
const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

const DEVICE_COMPRESSED = bytesToHex(getPublicKey(hexToBytes('11'.repeat(32)), true));
const DEVICE_UNCOMPRESSED = bytesToHex(getPublicKey(hexToBytes('11'.repeat(32)), false));
const PREVIOUS_KEY = bytesToHex(getPublicKey(hexToBytes('22'.repeat(32)), true));

function addressOf(key: string, index: number): string {
  return deriveSocialReceiveAddress(hexToBytes(key), index, TESTNET);
}

function row(index: number, overrides: Partial<WatchSetRow> = {}): WatchSetRow {
  return {
    address: `F${String(index)}`,
    index,
    identityPublicKey: DEVICE_COMPRESSED,
    createdAt: NOW - 30 * DAY,
    used: false,
    checkedAt: NOW - DAY,
    nextCheckAt: NOW + DAY,
    foundAt: null,
    origin: 'gateway',
    ...overrides,
  };
}

describe('the constants', () => {
  test('are the documented bounds', () => {
    expect(SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS).toBe(7 * DAY);
    expect(SOCIAL_RECEIVE_ACTIVE_MAX).toBe(2_000);
    expect(SOCIAL_RECEIVE_CHECKS_PER_RESYNC).toBe(200);
    expect(SOCIAL_RECEIVE_RECHECK_MIN_SECONDS).toBe(DAY);
    expect(SOCIAL_RECEIVE_RECHECK_MAX_SECONDS).toBe(30 * DAY);
    expect(SOCIAL_RECEIVE_ACTIVE_FLOOR).toBe(100_000n);
    expect(SOCIAL_RECEIVE_FUNDED_MAX).toBe(1_000);
  });
});

describe('watchableRows', () => {
  test("watches this device's key whatever its encoding, keeps another key's rows out", () => {
    const mine = row(3, {
      address: addressOf(DEVICE_COMPRESSED, 3),
      identityPublicKey: DEVICE_UNCOMPRESSED,
    });
    const previous = row(4, {
      address: addressOf(PREVIOUS_KEY, 4),
      identityPublicKey: PREVIOUS_KEY,
    });
    expect(watchableRows([mine, previous], DEVICE_COMPRESSED, TESTNET)).toEqual([mine]);
  });

  test('a row with no recorded key is watched only when this key reproduces its address', () => {
    const legacyMine = row(7, {
      address: addressOf(DEVICE_COMPRESSED, 7),
      identityPublicKey: null,
    });
    const legacyOther = row(7, { address: addressOf(PREVIOUS_KEY, 7), identityPublicKey: null });
    expect(watchableRows([legacyMine, legacyOther], DEVICE_COMPRESSED, TESTNET)).toEqual([
      legacyMine,
    ]);
  });

  test('a recorded key that does not parse is not this device', () => {
    expect(
      watchableRows([row(1, { identityPublicKey: 'zz' })], DEVICE_COMPRESSED, TESTNET),
    ).toEqual([]);
  });

  // No ceiling (ADR 0021 D9, amended 2026-11-06): an address handed out at any
  // index is watched, so nothing ever has to pause `@username`.
  test('an address at index 5,000,000 is watched like index 1', () => {
    const far = row(5_000_000, {
      address: addressOf(DEVICE_COMPRESSED, 5_000_000),
      createdAt: NOW - 60,
      checkedAt: null,
      nextCheckAt: null,
    });
    const watched = watchableRows([far], DEVICE_COMPRESSED, TESTNET);
    expect(watched).toEqual([far]);
    const active = planActiveSet({ watchable: watched, holdingCoins: new Map(), now: NOW });
    expect(active.has(far.address)).toBe(true);
    const plan = planSocialReceiveChecks({
      watchable: watched,
      active,
      now: NOW,
      scanHasBegun: true,
    });
    expect(plan.due.map((due) => due.address)).toEqual([far.address]);
  });
});

describe('planActiveSet', () => {
  test('index 0, coin holders, found rows and the last week are active; the rest dormant', () => {
    const zero = row(0, { origin: 'default', createdAt: NOW - 400 * DAY });
    const holding = row(1, { createdAt: NOW - 400 * DAY });
    const found = row(2, { createdAt: NOW - 400 * DAY, foundAt: NOW - DAY });
    const foundLongAgo = row(3, { createdAt: NOW - 400 * DAY, foundAt: NOW - 30 * DAY });
    const recent = row(4, { createdAt: NOW - 6 * DAY });
    const old = row(5, { createdAt: NOW - 8 * DAY });
    const active = planActiveSet({
      watchable: [zero, holding, found, foundLongAgo, recent, old],
      holdingCoins: new Map([[holding.address, 10n ** 8n]]),
      now: NOW,
    });
    expect([...active].sort()).toEqual(['F0', 'F1', 'F2', 'F4']);
  });

  test('the newest recent rows fill the cap; index 0 and coin holders are never pushed out', () => {
    const recent = Array.from({ length: 10 }, (_, i) => row(i + 10, { createdAt: NOW - i * 60 }));
    const active = planActiveSet({
      watchable: [
        row(0, { createdAt: NOW - 400 * DAY }),
        row(1, { createdAt: NOW - 400 * DAY }),
        ...recent,
      ],
      holdingCoins: new Map([['F1', 10n ** 8n]]),
      now: NOW,
      activeMax: 5,
    });
    expect([...active].sort()).toEqual(['F0', 'F1', 'F10', 'F11', 'F12']);
  });

  test('dust does not make an address active; the funded tier is capped by value (R4-2)', () => {
    // An attacker dusts 5 000 fresh addresses (1 000 a day for five days) and
    // pays 3 000 old ones just above the floor; the owner holds real coins at
    // two old addresses and has ten addresses handed out today.
    const dusted = Array.from({ length: 5_000 }, (_, i) =>
      row(i + 10_000, { createdAt: NOW - 30 * DAY }),
    );
    const aboveFloor = Array.from({ length: 3_000 }, (_, i) =>
      row(i + 20_000, { createdAt: NOW - 30 * DAY }),
    );
    const realA = row(1, { createdAt: NOW - 400 * DAY });
    const realB = row(2, { createdAt: NOW - 400 * DAY });
    const today = Array.from({ length: 10 }, (_, i) => row(i + 100, { createdAt: NOW - i * 60 }));
    const holdingCoins = new Map<string, bigint>();
    for (const r of dusted) holdingCoins.set(r.address, SOCIAL_RECEIVE_ACTIVE_FLOOR - 1n);
    for (const r of aboveFloor) holdingCoins.set(r.address, SOCIAL_RECEIVE_ACTIVE_FLOOR);
    holdingCoins.set(realA.address, 50n * 10n ** 8n);
    holdingCoins.set(realB.address, 2n * 10n ** 8n);
    const active = planActiveSet({
      watchable: [row(0, { origin: 'default' }), realA, realB, ...today, ...dusted, ...aboveFloor],
      holdingCoins,
      now: NOW,
    });
    expect(active.size).toBeLessThanOrEqual(SOCIAL_RECEIVE_ACTIVE_MAX);
    for (const r of dusted) expect(active.has(r.address)).toBe(false);
    expect(active.has('F0')).toBe(true);
    expect(active.has(realA.address)).toBe(true);
    expect(active.has(realB.address)).toBe(true);
    for (const r of today) expect(active.has(r.address)).toBe(true);
    const funded = [...active].filter((a) => holdingCoins.has(a));
    expect(funded.length).toBe(SOCIAL_RECEIVE_FUNDED_MAX);
  });

  test('the bound holds against any attacker spend: no mix of funded, found and recent rows passes it', () => {
    const rows: WatchSetRow[] = [row(0, { origin: 'default' })];
    const holdingCoins = new Map<string, bigint>();
    for (let i = 1; i <= 6_000; i += 1) {
      const r = row(i, {
        createdAt: NOW - (i % 3) * DAY,
        foundAt: i % 2 === 0 ? NOW - DAY : null,
      });
      rows.push(r);
      if (i % 5 === 0) holdingCoins.set(r.address, BigInt(i) * 10n ** 8n);
    }
    const active = planActiveSet({ watchable: rows, holdingCoins, now: NOW });
    expect(active.size).toBe(SOCIAL_RECEIVE_ACTIVE_MAX);
    expect(active.has('F0')).toBe(true);
  });

  test('a set of a million rows stays at the cap', () => {
    const many = Array.from({ length: 1_000_000 }, (_, i) =>
      row(i + 1, { createdAt: NOW - (i % 5) * DAY }),
    );
    const active = planActiveSet({ watchable: many, holdingCoins: new Map(), now: NOW });
    expect(active.size).toBe(SOCIAL_RECEIVE_ACTIVE_MAX);
  });
});

describe('verifyGatewayRows (I-2)', () => {
  test('keeps a row its key derives at its index, drops one it does not, keeps keyless rows', () => {
    const good = row(3, { address: addressOf(DEVICE_COMPRESSED, 3) });
    const otherIndex = row(4, { address: addressOf(DEVICE_COMPRESSED, 5) });
    const otherKey = row(6, { address: addressOf(PREVIOUS_KEY, 6) });
    const badKey = row(7, { address: addressOf(DEVICE_COMPRESSED, 7), identityPublicKey: 'zz' });
    const keyless = row(8, { address: 'Tnobody', identityPublicKey: null });
    const previous = row(9, {
      address: addressOf(PREVIOUS_KEY, 9),
      identityPublicKey: PREVIOUS_KEY,
    });
    const { kept, dropped } = verifyGatewayRows(
      [good, otherIndex, otherKey, badKey, keyless, previous],
      TESTNET,
    );
    expect(kept).toEqual([good, keyless, previous]);
    expect(dropped).toEqual([otherIndex, otherKey, badKey]);
  });
});

describe('nextSocialReceiveCheckAt', () => {
  test('waits as long as the row has existed, between a day and 30 days', () => {
    expect(nextSocialReceiveCheckAt(NOW - 60, NOW)).toBe(NOW + DAY);
    expect(nextSocialReceiveCheckAt(NOW - 10 * DAY, NOW)).toBe(NOW + 10 * DAY);
    expect(nextSocialReceiveCheckAt(NOW - 3 * 365 * DAY, NOW)).toBe(NOW + 30 * DAY);
  });

  test('a dormant row is never left unread more than 30 days (the late-payment bound)', () => {
    const created = 0;
    let at = 7 * DAY;
    const reads: number[] = [];
    while (at < 3 * 365 * DAY) {
      reads.push(at);
      at = nextSocialReceiveCheckAt(created, at);
    }
    const firstYear = reads.filter((read) => read < 365 * DAY).length;
    expect(firstYear).toBeGreaterThanOrEqual(14);
    expect(firstYear).toBeLessThanOrEqual(16);
    for (let i = 1; i < reads.length; i += 1) {
      expect(must(reads[i]) - must(reads[i - 1])).toBeLessThanOrEqual(30 * DAY);
    }
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

describe('planSocialReceiveChecks', () => {
  test('a new row is read once even while active; before any scan, the first scan covers it', () => {
    const fresh = row(9, { checkedAt: null, nextCheckAt: null, createdAt: NOW - 60 });
    const active = new Set([fresh.address]);
    const afterScan = planSocialReceiveChecks({
      watchable: [fresh],
      active,
      now: NOW,
      scanHasBegun: true,
    });
    expect(afterScan.due).toEqual([fresh]);
    expect(afterScan.seen).toEqual([]);
    const beforeScan = planSocialReceiveChecks({
      watchable: [fresh],
      active,
      now: NOW,
      scanHasBegun: false,
    });
    expect(beforeScan.due).toEqual([]);
    expect(beforeScan.seen).toEqual([
      { address: fresh.address, checkedAt: NOW, nextCheckAt: NOW + DAY },
    ]);
  });

  test("an active row's turn is seen by SPV (no read); a dormant row's turn is a read", () => {
    const activeRow = row(1, { nextCheckAt: NOW - 1 });
    const dormantRow = row(2, { nextCheckAt: NOW - 1 });
    const notYet = row(3, { nextCheckAt: NOW + 1 });
    const plan = planSocialReceiveChecks({
      watchable: [activeRow, dormantRow, notYet],
      active: new Set([activeRow.address]),
      now: NOW,
      scanHasBegun: true,
    });
    expect(plan.due).toEqual([dormantRow]);
    expect(plan.seen.map((seen) => seen.address)).toEqual([activeRow.address]);
  });

  test('never-read rows first, then the most overdue, within the budget', () => {
    const plan = planSocialReceiveChecks({
      watchable: [
        row(1, { nextCheckAt: NOW - 10 }),
        row(2, { nextCheckAt: NOW - 100 }),
        row(3, { checkedAt: null, nextCheckAt: null }),
        row(4, { nextCheckAt: NOW - 1_000 }),
      ],
      active: new Set(),
      now: NOW,
      scanHasBegun: true,
      budget: 3,
    });
    expect(plan.due.map((due) => due.index)).toEqual([3, 4, 2]);
  });
});
