/**
 * Address balances read straight from the FairCoin Explorer's HTTP API.
 *
 * WHY THE WALLET AND NOT THE GATEWAY. Reading the chain is the wallet's job,
 * and this app already talks to the Explorer directly (`explorer-socket.ts`,
 * `price.ts`, `market.ts`). The gateway reads the chain only to settle intents;
 * routing balances through it would make it a chain proxy for wallets. The
 * Explorer echoes the request Origin in `access-control-allow-origin`, so a
 * browser reaches it with no proxy at all (verified 2026-09-06).
 *
 * WHY THIS EXISTS ALONGSIDE SPV. On native, balance comes from the local UTXO
 * set that `p2p/` builds over a real TCP socket. A browser has no such socket —
 * `p2p/peer.ts` needs react-native-tcp-socket or Electron's `net` — so the web
 * build has no SPV and this HTTP read is the only way it can show a balance.
 * It is NOT a replacement for the UTXO set: it cannot select coins or build a
 * transaction, only report what an address holds.
 *
 * ONLY `balanceSat` is read. `addressInfo` also carries cumulative
 * `totalReceivedSat` / `totalSentSat`, which grow without bound — one live
 * address already reports 6_969_626_939_280_430, within 1.3x of
 * `Number.MAX_SAFE_INTEGER`, so `JSON.parse` would silently round them before
 * any code here could widen them to a bigint. A balance is bounded by the money
 * supply (6.4e14 base units today), which leaves ~14x of headroom.
 */

import { EXPLORER_BASE_URL, type NetworkType } from '@fairco.in/core';

export interface AddressBalances {
  readonly byAddress: ReadonlyMap<string, bigint>;
  readonly totalSat: bigint;
}

/** The Explorer's answer for an address it has no record of. */
const UNKNOWN_ADDRESS = 404;

/**
 * What each address holds right now, and their total, in base units.
 *
 * ## Zero means zero, and only the Explorer may say so
 *
 * An address the Explorer has never seen answers `0n` rather than throwing: a
 * freshly derived receive address is exactly that until someone pays it, and a
 * wallet whose newest address is unused must still show the balance of the
 * rest.
 *
 * That reason justifies ONE response and this function used to apply it to
 * every failure — a 429, a 502, a truncated body, all rendered as `0n`. A
 * wallet showing zero during an Explorer outage tells someone their money is
 * gone, which is the worst thing this screen can say and the one thing it must
 * never say by accident. So every other failure THROWS, and the caller's query
 * reports the balance as unavailable while whatever it had stays on screen.
 *
 * This is also what makes `ReadOnlyWalletView`'s split real rather than aspirational:
 * balances are a separate query precisely "so a history that already loaded must
 * not disappear because the chain read failed" — which needs the chain read to
 * actually fail.
 */
export async function fetchBalancesSat(
  addresses: readonly string[],
  network: NetworkType,
): Promise<AddressBalances> {
  const byAddress = new Map<string, bigint>();
  if (addresses.length === 0) return { byAddress, totalSat: 0n };

  const unique = [...new Set(addresses)];
  const balances = await Promise.all(
    unique.map(async (address) => {
      const url = `${EXPLORER_BASE_URL}/api/address/${encodeURIComponent(address)}?network=${network}`;
      const response = await fetch(url);
      if (response.status === UNKNOWN_ADDRESS) return [address, 0n] as const;
      if (!response.ok) {
        throw new Error(
          `Explorer balance request for ${address} failed: ${String(response.status)} ${response.statusText}`,
        );
      }

      // A body this cannot read is NOT a zero balance. It is an answer we do
      // not understand, and guessing the most alarming possible number from it
      // is not a safe default.
      const body: unknown = await response.json();
      const balanceSat = (body as { addressInfo?: { balanceSat?: unknown } })?.addressInfo
        ?.balanceSat;
      if (typeof balanceSat !== 'number' || !Number.isSafeInteger(balanceSat)) {
        throw new Error(`Explorer balance response for ${address} carried no usable balanceSat`);
      }
      return [address, BigInt(balanceSat)] as const;
    }),
  );

  let totalSat = 0n;
  for (const [address, balance] of balances) {
    byAddress.set(address, balance);
    totalSat += balance;
  }
  return { byAddress, totalSat };
}

/**
 * Where on the chain an address holds coins, as far as the Explorer knows:
 * the block heights of its unspent outputs. It is a POINTER, never a credit:
 * the wallet rescans those blocks through its own SPV path, which checks the
 * merkle proof and records the transaction, rather than taking the Explorer's
 * word for a coin it would then sign for.
 */
export interface AddressActivity {
  /** Heights of the address's confirmed unspent outputs, ascending. */
  readonly confirmedHeights: readonly number[];
  /** Whether it has an unspent output still in the mempool (height 0). */
  readonly hasUnconfirmed: boolean;
}

/** At most this many Explorer requests in flight at once. */
const ACTIVITY_CONCURRENCY = 8;

/**
 * {@link AddressActivity} for each of `addresses`. Same failure rule as
 * {@link fetchBalancesSat}: only a 404 means "nothing here"; any other failure
 * THROWS, because the caller records an address as checked once this answers,
 * and a 502 recorded as "never paid" would be a payment nobody looks for again.
 */
export async function fetchAddressActivity(
  addresses: readonly string[],
  network: NetworkType,
): Promise<Map<string, AddressActivity>> {
  const result = new Map<string, AddressActivity>();
  const queue = [...new Set(addresses)];
  const worker = async (): Promise<void> => {
    for (let address = queue.shift(); address !== undefined; address = queue.shift()) {
      result.set(address, await readAddressActivity(address, network));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ACTIVITY_CONCURRENCY, queue.length) }, () => worker()),
  );
  return result;
}

async function readAddressActivity(
  address: string,
  network: NetworkType,
): Promise<AddressActivity> {
  const url = `${EXPLORER_BASE_URL}/api/address/${encodeURIComponent(address)}?network=${network}`;
  const response = await fetch(url);
  if (response.status === UNKNOWN_ADDRESS) return { confirmedHeights: [], hasUnconfirmed: false };
  if (!response.ok) {
    throw new Error(
      `Explorer address request for ${address} failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const utxos = (body as { addressInfo?: { utxos?: unknown } })?.addressInfo?.utxos;
  if (!Array.isArray(utxos)) {
    throw new Error(`Explorer address response for ${address} carried no utxo list`);
  }
  const confirmedHeights: number[] = [];
  let hasUnconfirmed = false;
  for (const entry of utxos) {
    const height = (entry as { height?: unknown } | null)?.height;
    if (typeof height === 'number' && Number.isSafeInteger(height) && height > 0) {
      confirmedHeights.push(height);
    } else {
      // Height 0 (or absent) is what the Explorer reports for the mempool.
      hasUnconfirmed = true;
    }
  }
  confirmedHeights.sort((a, b) => a - b);
  return { confirmedHeights, hasUnconfirmed };
}

/**
 * Whether an address was EVER used, as far as the Explorer can say, and where
 * it holds coins now. `unknown` when the Explorer cannot tell — testnet's node
 * has no address index and answers `txCount: 0` beside `isValid: false` or a
 * `note` for every address (measured 2026-11-06; the gateway's
 * `getAddressUsage` reads that shape the same way). A spent-out address is
 * `used`: gap-limit discovery must not stop at an address whose coins moved.
 */
export interface AddressUsage extends AddressActivity {
  readonly usage: 'used' | 'unused' | 'unknown';
}

/**
 * {@link AddressUsage} for each of `addresses`, for gap-limit discovery of a
 * previous key's HD tree (Peable ADR 0002, amended 2026-11-06). Same failure
 * rule as {@link fetchAddressActivity}: only a 404 means "nothing here"; any
 * other failure THROWS, so an outage is never read as an empty tree.
 */
export async function fetchAddressUsage(
  addresses: readonly string[],
  network: NetworkType,
): Promise<Map<string, AddressUsage>> {
  const result = new Map<string, AddressUsage>();
  const queue = [...new Set(addresses)];
  const worker = async (): Promise<void> => {
    for (let address = queue.shift(); address !== undefined; address = queue.shift()) {
      result.set(address, await readAddressUsage(address, network));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ACTIVITY_CONCURRENCY, queue.length) }, () => worker()),
  );
  return result;
}

async function readAddressUsage(address: string, network: NetworkType): Promise<AddressUsage> {
  const url = `${EXPLORER_BASE_URL}/api/address/${encodeURIComponent(address)}?network=${network}`;
  const response = await fetch(url);
  if (response.status === UNKNOWN_ADDRESS) {
    return { usage: 'unused', confirmedHeights: [], hasUnconfirmed: false };
  }
  if (!response.ok) {
    throw new Error(
      `Explorer address request for ${address} failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const info = (body as { addressInfo?: Record<string, unknown> } | null)?.addressInfo;
  const utxos = info?.utxos;
  if (!info || !Array.isArray(utxos)) {
    throw new Error(`Explorer address response for ${address} carried no utxo list`);
  }
  const confirmedHeights: number[] = [];
  let hasUnconfirmed = false;
  for (const entry of utxos) {
    const height = (entry as { height?: unknown } | null)?.height;
    if (typeof height === 'number' && Number.isSafeInteger(height) && height > 0) {
      confirmedHeights.push(height);
    } else {
      hasUnconfirmed = true;
    }
  }
  confirmedHeights.sort((a, b) => a - b);
  const txCount = typeof info.txCount === 'number' ? info.txCount : 0;
  const received = typeof info.totalReceivedSat === 'number' ? info.totalReceivedSat : 0;
  let usage: AddressUsage['usage'];
  if (txCount !== 0 || received !== 0 || utxos.length !== 0) usage = 'used';
  else if (info.isValid === false || info.note !== undefined) usage = 'unknown';
  else usage = 'unused';
  return { usage, confirmedHeights, hasUnconfirmed };
}
