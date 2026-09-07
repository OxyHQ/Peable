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

/**
 * What each address holds right now, and their total, in base units.
 *
 * An address the Explorer has never seen answers 0n rather than throwing: a
 * freshly derived receive address is exactly that until someone pays it, and a
 * wallet whose newest address is unused must still show the balance of the
 * rest.
 */
export async function fetchBalancesSat(
  addresses: readonly string[],
  network: NetworkType
): Promise<AddressBalances> {
  const byAddress = new Map<string, bigint>();
  if (addresses.length === 0) return { byAddress, totalSat: 0n };

  const unique = [...new Set(addresses)];
  const balances = await Promise.all(
    unique.map(async (address) => {
      const url = `${EXPLORER_BASE_URL}/api/address/${encodeURIComponent(address)}?network=${network}`;
      const response = await fetch(url);
      if (!response.ok) return [address, 0n] as const;

      const body: unknown = await response.json();
      const balanceSat = (body as { addressInfo?: { balanceSat?: unknown } })?.addressInfo
        ?.balanceSat;
      if (typeof balanceSat !== 'number' || !Number.isSafeInteger(balanceSat)) {
        return [address, 0n] as const;
      }
      return [address, BigInt(balanceSat)] as const;
    })
  );

  let totalSat = 0n;
  for (const [address, balance] of balances) {
    byAddress.set(address, balance);
    totalSat += balance;
  }
  return { byAddress, totalSat };
}
