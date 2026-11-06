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
 * Since ADR 0002's amendment "previous keys stay spendable" (2026-11-06), a
 * previous key Commons kept is reachable again (`previous-keys.ts`): its coins
 * are held and signable, counted in the balance and named apart
 * ({@link previousKeyCoins}) so the wallet can offer to move them. F8's rule
 * is unchanged: the balance never includes a coin this wallet cannot sign for.
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
 * rest (`stranded`: received on this network under a key this device cannot
 * reach). Stranded coins are NOT dropped — the caller shows them apart,
 * because they are still the person's: once the previous key is added in
 * Commons, the wallet reaches it and the coins rejoin the balance (ADR 0002,
 * amended 2026-11-06 "previous keys stay spendable").
 *
 * `isWatched` includes every PREVIOUS key this device still reaches: its HD
 * tree and its social-receive addresses are signable, so their coins are held.
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

/**
 * Of the coins this wallet holds, those under a PREVIOUS key it still reaches
 * (`previousKeyOf` names the key, `null` for the current key's coins). They
 * are in the balance — a send can sign for them — and are what the "move to
 * your current key" prompt moves.
 */
export function previousKeyCoins<T extends AddressedCoin>(
  held: readonly T[],
  previousKeyOf: (address: string) => string | null,
): T[] {
  return held.filter((coin) => previousKeyOf(coin.address) !== null);
}
