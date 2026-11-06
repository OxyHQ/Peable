/**
 * What a Peable wallet watches of its social-receive set, and how (ADR 0021
 * D9, amended 2026-11-06).
 *
 * The SET is exactly what the gateway reports it handed out
 * (`GET /v1/social/me/receive_addresses`: every payment and `@username`
 * address, under every key the account has had), plus index 0 — the stable
 * default address this device derives itself — plus, on a device upgraded from
 * the contiguous window, the indices that window already watched. Addresses are
 * never reused and the set has no ceiling, so it only grows; a wallet that put
 * all of it in its Bloom filter would freeze as the filter saturated (finding
 * F4). So it is watched in two tiers:
 *
 * - **Active** — in the Bloom filter, seen by SPV block by block: index 0, every
 *   address holding coins (or that the Explorer just showed coins at), and the
 *   newest addresses handed out in the last {@link SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS},
 *   at most {@link SOCIAL_RECEIVE_ACTIVE_MAX} in all. A payment is paid within
 *   its quote's life (24 h at most), and an `@username` sender pays at once.
 * - **Dormant** — everything else, read through the Explorer on a doubling
 *   schedule ({@link nextSocialReceiveCheckAt}): a late payment to ANY address
 *   ever handed out is found, at the latest a year after the previous look, and
 *   credited through the same SPV rescan as every other coin.
 *
 * Only addresses of the key THIS device holds are watched and signed for
 * ({@link watchableRows}); the others are kept with their key, for a wallet
 * that can sign for a previous one. Pure: no SQLite, no network, no clock.
 */
import { deriveSocialReceiveAddress, hexToBytes } from '@fairco.in/core';
import type { NetworkConfig } from '@fairco.in/core';
import { compressedPublicKeyHex } from './social-receive';

const DAY_SECONDS = 24 * 60 * 60;

/** How long a newly handed-out address stays in the Bloom filter: a week. */
export const SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS = 7 * DAY_SECONDS;

/**
 * The most social-receive addresses in the Bloom filter at once. The contiguous
 * window this replaces watched 2,000 — the size the review proved a wallet
 * carries (finding F4: the filter caps at 36,000 bytes, ~15,000 entries at its
 * false-positive rate, beside the HD tree's own addresses).
 */
export const SOCIAL_RECEIVE_ACTIVE_MAX = 2_000;

/** Explorer reads of dormant (or never looked-at) addresses per resync. */
export const SOCIAL_RECEIVE_CHECKS_PER_RESYNC = 200;

/** The shortest wait before a dormant address is read again: a day. */
export const SOCIAL_RECEIVE_RECHECK_MIN_SECONDS = DAY_SECONDS;

/** The longest wait: a year — so every address is looked at, for ever, at least yearly. */
export const SOCIAL_RECEIVE_RECHECK_MAX_SECONDS = 365 * DAY_SECONDS;

/** Where a row of the set came from. */
export type SocialReceiveOrigin = 'gateway' | 'default' | 'legacy';

/** One address of the set, as the wallet keeps it. Times are Unix seconds. */
export interface WatchSetRow {
  readonly address: string;
  readonly index: number;
  /** The key it derives from, as the gateway records keys; `null`: not recorded. */
  readonly identityPublicKey: string | null;
  readonly createdAt: number;
  readonly used: boolean;
  /** When it was last looked at (an Explorer read, or SPV watching it); `null`: never. */
  readonly checkedAt: number | null;
  /** When a dormant row is next read through the Explorer. */
  readonly nextCheckAt: number | null;
  /** When the Explorer last showed coins at it; such a row joins the filter. */
  readonly foundAt: number | null;
  readonly origin: SocialReceiveOrigin;
}

/**
 * The rows this device can watch and sign for: those recorded under its key
 * (compared compressed — the DID publishes the key in its own encoding), and
 * those with no recorded key that its key reproduces at their index. A row of
 * another key is someone else's tree as far as this device is concerned.
 *
 * Each distinct key is compressed once, not once per row, and only keyless
 * rows cost a derivation.
 */
export function watchableRows(
  rows: readonly WatchSetRow[],
  deviceKey: string,
  network: NetworkConfig,
): WatchSetRow[] {
  const device = compressedPublicKeyHex(deviceKey);
  const deviceBytes = hexToBytes(device);
  const verdicts = new Map<string, boolean>();
  const isDeviceKey = (key: string): boolean => {
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      try {
        verdict = compressedPublicKeyHex(key) === device;
      } catch {
        verdict = false;
      }
      verdicts.set(key, verdict);
    }
    return verdict;
  };
  const watchable: WatchSetRow[] = [];
  for (const row of rows) {
    if (row.identityPublicKey !== null) {
      if (isDeviceKey(row.identityPublicKey)) watchable.push(row);
      continue;
    }
    if (deriveSocialReceiveAddress(deviceBytes, row.index, network) === row.address) {
      watchable.push(row);
    }
  }
  return watchable;
}

/**
 * The active tier: the addresses the Bloom filter holds. Index 0, every row
 * holding coins (`holdingCoins`, from the local UTXO set) and every row the
 * Explorer showed coins at within the active age are always in; the newest
 * rows handed out within {@link SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS} fill the
 * rest, up to `activeMax` in all.
 */
export function planActiveSet(input: {
  readonly watchable: readonly WatchSetRow[];
  readonly holdingCoins: ReadonlySet<string>;
  readonly now: number;
  readonly activeAgeSeconds?: number;
  readonly activeMax?: number;
}): Set<string> {
  const activeAge = input.activeAgeSeconds ?? SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS;
  const activeMax = input.activeMax ?? SOCIAL_RECEIVE_ACTIVE_MAX;
  const since = input.now - activeAge;
  const active = new Set<string>();
  const recent: WatchSetRow[] = [];
  for (const row of input.watchable) {
    if (
      row.index === 0 ||
      input.holdingCoins.has(row.address) ||
      (row.foundAt !== null && row.foundAt >= since)
    ) {
      active.add(row.address);
    } else if (row.createdAt >= since) {
      recent.push(row);
    }
  }
  recent.sort((a, b) => b.createdAt - a.createdAt || b.index - a.index);
  for (const row of recent) {
    if (active.size >= activeMax) break;
    active.add(row.address);
  }
  return active;
}

/**
 * When a row that was just looked at (at `checkedAt`) is read again: as long
 * again as it has existed, between a day and a year. A doubling schedule —
 * about six reads in a row's first year, then one a year for ever.
 */
export function nextSocialReceiveCheckAt(createdAt: number, checkedAt: number): number {
  const age = checkedAt - createdAt;
  const wait = Math.min(
    SOCIAL_RECEIVE_RECHECK_MAX_SECONDS,
    Math.max(SOCIAL_RECEIVE_RECHECK_MIN_SECONDS, age),
  );
  return checkedAt + wait;
}

/** A row's new check state, to persist. */
export interface WatchSetCheck {
  readonly address: string;
  readonly checkedAt: number;
  readonly nextCheckAt: number;
  /** Set when the read showed coins there. */
  readonly foundAt?: number;
}

export interface SocialReceiveCheckPlan {
  /** Rows to read through the Explorer now, most overdue first. */
  readonly due: WatchSetRow[];
  /**
   * Rows looked at without a read: active ones SPV watches whose turn came,
   * and — before any historical rescan began — new active ones the first scan
   * covers. Persist them as checked now.
   */
  readonly seen: WatchSetCheck[];
}

/**
 * Which rows to look at now. A row never looked at is due at once — even an
 * active one, because the Bloom filter only shows what is paid from now on —
 * unless no historical rescan has begun, whose first pass scans from the
 * wallet's birthday with the filter as it is. An active row whose turn came is
 * SEEN (SPV watches it); a dormant row whose turn came is due. At most
 * `budget` reads, never-looked-at rows first, then by how overdue they are.
 */
export function planSocialReceiveChecks(input: {
  readonly watchable: readonly WatchSetRow[];
  readonly active: ReadonlySet<string>;
  readonly now: number;
  readonly scanHasBegun: boolean;
  readonly budget?: number;
}): SocialReceiveCheckPlan {
  const budget = input.budget ?? SOCIAL_RECEIVE_CHECKS_PER_RESYNC;
  const due: WatchSetRow[] = [];
  const seen: WatchSetCheck[] = [];
  const looked = (row: WatchSetRow): WatchSetCheck => ({
    address: row.address,
    checkedAt: input.now,
    nextCheckAt: nextSocialReceiveCheckAt(row.createdAt, input.now),
  });
  for (const row of input.watchable) {
    const isActive = input.active.has(row.address);
    if (row.checkedAt === null) {
      if (isActive && !input.scanHasBegun) seen.push(looked(row));
      else due.push(row);
      continue;
    }
    if (row.nextCheckAt !== null && row.nextCheckAt > input.now) continue;
    if (isActive) seen.push(looked(row));
    else due.push(row);
  }
  due.sort((a, b) => {
    if (a.checkedAt === null || b.checkedAt === null) {
      if (a.checkedAt === b.checkedAt) return a.index - b.index;
      return a.checkedAt === null ? -1 : 1;
    }
    return (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0) || a.index - b.index;
  });
  return { due: due.slice(0, budget), seen };
}
