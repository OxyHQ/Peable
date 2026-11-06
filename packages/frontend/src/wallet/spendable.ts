/**
 * Which stored coins this wallet can actually spend.
 *
 * A coin is stored because an address the wallet watched was paid. Whether the
 * wallet can still SIGN for it is a different question, and the answer can
 * change after the coin arrived: the social-receive window is re-derived when
 * the identity key changes (a rotation, an organization key replaced in
 * Commons — Peable ADR 0002, oxy ADR 0061 D7) and when the network changes,
 * and the addresses of the previous window stop being anyone's this device can
 * reach. Those coins were sitting in the balance and in coin selection; largest
 * first, a send picked one and `signInputForAddress` threw on it, so EVERY send
 * failed while the balance said the money was there.
 *
 * Pure: ownership is injected, so the rule is tested without a KeyManager.
 */

export interface AddressedCoin {
  readonly address: string;
}

/**
 * Split `coins` into those an address this wallet watches holds (`held`: the
 * HD tree, its registered multisig watch addresses, the current social window),
 * those stored for the OTHER network (`otherNetwork`: the database file is
 * shared by mainnet and testnet, and a testnet view must neither count nor
 * offer a mainnet coin — it reappears when the wallet switches back), and the
 * rest (`stranded`: received on this network under a key this device no longer
 * derives). Stranded coins are NOT dropped — the caller shows them apart,
 * because they are still the person's, spendable with the previous key's
 * recovery phrase.
 */
export function partitionStrandedCoins<T extends AddressedCoin>(
  coins: readonly T[],
  isWatched: (address: string) => boolean,
  isOnThisNetwork: (address: string) => boolean,
): { held: T[]; stranded: T[]; otherNetwork: T[] } {
  const held: T[] = [];
  const stranded: T[] = [];
  const otherNetwork: T[] = [];
  for (const coin of coins) {
    if (isWatched(coin.address)) held.push(coin);
    else if (isOnThisNetwork(coin.address)) stranded.push(coin);
    else otherNetwork.push(coin);
  }
  return { held, stranded, otherNetwork };
}

/**
 * The coins a send may select: only those this wallet can sign for. A watched
 * multisig address is held (it counts in the balance) but is spent through
 * the multisig flow, never by a plain send's signer.
 */
export function signableCoins<T extends AddressedCoin>(
  coins: readonly T[],
  canSign: (address: string) => boolean,
): T[] {
  return coins.filter((coin) => canSign(coin.address));
}

/** The total value of `coins`. */
export function sumCoinValues(coins: readonly { readonly value: bigint }[]): bigint {
  let total = 0n;
  for (const coin of coins) total += coin.value;
  return total;
}
