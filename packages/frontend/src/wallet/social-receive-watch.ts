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
 * - **Active** — in the Bloom filter, seen by SPV block by block: index 0, the
 *   {@link SOCIAL_RECEIVE_FUNDED_MAX} best-funded addresses holding at least
 *   {@link SOCIAL_RECEIVE_ACTIVE_FLOOR} (or that the Explorer just showed that
 *   much at), and the newest addresses handed out in the last
 *   {@link SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS}, at most
 *   {@link SOCIAL_RECEIVE_ACTIVE_MAX} in all — whatever anyone pays anywhere
 *   (review round 4, R4-2: dust sent to fresh addresses used to make each one
 *   active for good). A payment is paid within its quote's life (24 h at most),
 *   and an `@username` sender pays at once.
 * - **Dormant** — everything else, read through the Explorer on a doubling
 *   schedule ({@link nextSocialReceiveCheckAt}): a late payment to ANY address
 *   ever handed out is found, at the latest {@link SOCIAL_RECEIVE_RECHECK_MAX_SECONDS}
 *   after the previous look, and credited through the same SPV rescan as every
 *   other coin.
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

/**
 * The longest wait: 30 days — so every address is looked at, for ever, at
 * least monthly (a year until review round 4). At D9's worst sustained abuse
 * bound that is the read budget's affordable floor; see ADR 0021 D9.
 */
export const SOCIAL_RECEIVE_RECHECK_MAX_SECONDS = 30 * DAY_SECONDS;

/**
 * Below this many base units (0.001 FAIR, ten times the relay fee floor) coins
 * at an address do not make it active: dusting addresses cannot fill the
 * Bloom filter. Coins below it still count once SPV sees them; a dormant
 * address holding only that little is not rescanned for.
 */
export const SOCIAL_RECEIVE_ACTIVE_FLOOR = 100_000n;

/**
 * The most funded addresses in the Bloom filter (by value, highest first);
 * the rest of the active tier stays for the newest addresses. Funded
 * addresses past it are dormant: read through the Explorer on their schedule,
 * their coins still held and spendable.
 */
export const SOCIAL_RECEIVE_FUNDED_MAX = 1_000;

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
 * The active tier: the addresses the Bloom filter holds. Index 0 is always
 * in. Then the funded rows — holding at least {@link SOCIAL_RECEIVE_ACTIVE_FLOOR}
 * in the local UTXO set (`holdingCoins`: address to the value held), or shown
 * coins by the Explorer within the active age (`foundAt`, which a read only
 * sets for at least the floor) — highest value first, at most
 * {@link SOCIAL_RECEIVE_FUNDED_MAX}. The newest rows handed out within
 * {@link SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS} fill the rest, up to `activeMax`
 * in all. So the tier is never larger than `activeMax` (or the number of
 * index-0 rows, one per key), however many addresses anyone pays.
 */
export function planActiveSet(input: {
  readonly watchable: readonly WatchSetRow[];
  readonly holdingCoins: ReadonlyMap<string, bigint>;
  readonly now: number;
  readonly activeAgeSeconds?: number;
  readonly activeMax?: number;
  readonly fundedMax?: number;
  readonly floor?: bigint;
}): Set<string> {
  const activeAge = input.activeAgeSeconds ?? SOCIAL_RECEIVE_ACTIVE_AGE_SECONDS;
  const activeMax = input.activeMax ?? SOCIAL_RECEIVE_ACTIVE_MAX;
  const fundedMax = input.fundedMax ?? SOCIAL_RECEIVE_FUNDED_MAX;
  const floor = input.floor ?? SOCIAL_RECEIVE_ACTIVE_FLOOR;
  const since = input.now - activeAge;
  const active = new Set<string>();
  const funded: { row: WatchSetRow; value: bigint }[] = [];
  const recent: WatchSetRow[] = [];
  for (const row of input.watchable) {
    if (row.index === 0) {
      active.add(row.address);
      continue;
    }
    const held = input.holdingCoins.get(row.address) ?? 0n;
    const found = row.foundAt !== null && row.foundAt >= since;
    if (held >= floor || found) {
      funded.push({ row, value: held >= floor ? held : floor });
    } else if (row.createdAt >= since) {
      recent.push(row);
    }
  }
  const newestFirst = (a: WatchSetRow, b: WatchSetRow): number =>
    b.createdAt - a.createdAt || b.index - a.index;
  funded.sort((a, b) =>
    a.value === b.value ? newestFirst(a.row, b.row) : a.value > b.value ? -1 : 1,
  );
  let fundedTaken = 0;
  for (const { row } of funded) {
    if (fundedTaken >= fundedMax || active.size >= activeMax) {
      // Not watched block by block: read on its schedule, like any dormant
      // row. A recent one still competes for the recent slots below.
      if (row.createdAt >= since) recent.push(row);
      continue;
    }
    active.add(row.address);
    fundedTaken += 1;
  }
  recent.sort(newestFirst);
  for (const row of recent) {
    if (active.size >= activeMax) break;
    active.add(row.address);
  }
  return active;
}

/**
 * When a row that was just looked at (at `checkedAt`) is read again: as long
 * again as it has existed, between a day and 30 days. A doubling schedule —
 * reads at about 1, 2, 4, 8, 16 and 32 days of age, then every 30 days for
 * ever.
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

/**
 * The gateway's rows this wallet can take at their word: each row recorded
 * under a key is derived again from that key at its index, and kept only when
 * it reproduces the address (security review round 4, I-2). A row that does
 * not is a gateway answer this wallet will neither watch nor sign for; it is
 * dropped (and logged by the caller), never stored. A row recorded without a
 * key is kept: {@link watchableRows} derives it before watching it. Each
 * distinct key is decoded once.
 */
export function verifyGatewayRows(
  rows: readonly WatchSetRow[],
  network: NetworkConfig,
): { readonly kept: WatchSetRow[]; readonly dropped: WatchSetRow[] } {
  const kept: WatchSetRow[] = [];
  const dropped: WatchSetRow[] = [];
  const keyBytes = new Map<string, Uint8Array | null>();
  for (const row of rows) {
    if (row.identityPublicKey === null) {
      kept.push(row);
      continue;
    }
    let bytes = keyBytes.get(row.identityPublicKey);
    if (bytes === undefined) {
      try {
        bytes = hexToBytes(compressedPublicKeyHex(row.identityPublicKey));
      } catch {
        bytes = null;
      }
      keyBytes.set(row.identityPublicKey, bytes);
    }
    let derived: string | null = null;
    if (bytes !== null && Number.isSafeInteger(row.index) && row.index >= 0) {
      try {
        derived = deriveSocialReceiveAddress(bytes, row.index, network);
      } catch {
        derived = null;
      }
    }
    if (derived === row.address) kept.push(row);
    else dropped.push(row);
  }
  return { kept, dropped };
}
