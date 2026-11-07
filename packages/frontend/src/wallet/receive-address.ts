/**
 * Which address the wallet offers for receiving (security review round 6,
 * R6-1; Peable ADR 0002, amended for round 6).
 *
 * An identity wallet's database outlives its key: after a rotation the same
 * `oxy-user-<id>` file opens on the NEW key, and its `addresses` table still
 * holds the replaced key's HD rows. Taking "the first unused row" showed the
 * replaced key's address on Receive and Settings — after a rotation forced by
 * a compromise, an address whoever holds the old key can spend from.
 *
 * So every row records the identity key it derives from
 * (`addresses.identity_public_key`), and an address is offered only when:
 *
 *   - it is recorded under the key the wallet opened with (`scope`; `null`
 *     for a BIP39 or watch-only wallet, whose key never changes), AND
 *   - the open tree itself derives it (`ownsAddress`) — the proof, whatever
 *     the column says.
 *
 * Rows written before keys were recorded are bound on open: a row the open
 * tree derives is recorded under the open key; any other row stays unbound
 * and is never offered (a previous key's, still read to advance that key's
 * tree when it is reached). Another key's rows never move the open tree's
 * cursor either.
 *
 * Round 7 (R7-3): which unbound rows the open key derives is judged by a
 * PROBE of the open key's tree that reaches the highest unbound index of each
 * chain, not by the open tree's own window. That window is the cursor plus
 * the gap, and the cursor is restored from rows already bound — so after the
 * upgrade, or a legacy move (which clears every row's key), a used address at
 * index 29 behind unused 0..28 lay outside it: never bound, its coin stranded
 * and new payments to it unwatched. The probe derives from the same account
 * key and never moves the open tree's cursor; the bound used rows then do,
 * through the ordinary restore.
 */
import type { NetworkConfig } from '@fairco.in/core';
import { KeyManager } from '@peable.to/pay';
import type { AddressInsert, AddressKeyScope, AddressRow } from '../storage/database';

/** The part of `Database` this needs. */
export interface ReceiveAddressStore {
  getNextUnusedIndex(isChange: boolean, scope: AddressKeyScope): Promise<number>;
  bindAddressRows(key: string, derives: (address: string) => boolean): Promise<number>;
  getHighestUnboundIndices(): Promise<{ external: number; change: number }>;
  getUnusedAddresses(isChange: boolean, scope: AddressKeyScope): Promise<AddressRow[]>;
  getAddressesOf(scope: AddressKeyScope): Promise<AddressRow[]>;
  insertAddress(row: AddressInsert): Promise<void>;
}

/** The part of the open tree (`KeyManager`) this needs. */
export interface ReceiveTree {
  ownsAddress(address: string): boolean;
  restoreCursors(externalNext: number, changeNext: number): void;
  getNextAddress(): { address: string; path: string; index: number };
}

/**
 * A tree of the open key that derives at least every index up to
 * `externalThrough` / `changeThrough` (`-1`: none of that chain), built
 * beside the open tree so its cursor never moves (R7-3). In the wallet, a
 * public-only `KeyManager` from the open tree's account xpub.
 */
export type ReceiveProbe = (
  externalThrough: number,
  changeThrough: number,
) => { ownsAddress(address: string): boolean };

/**
 * The wallet's {@link ReceiveProbe}: a public-only tree from the open tree's
 * account xpub (the same addresses, no private key), derived far enough.
 */
export function receiveProbeOf(
  tree: { accountXpub(): string },
  network: NetworkConfig,
): ReceiveProbe {
  return (externalThrough, changeThrough) => {
    const window = KeyManager.fromXpub(tree.accountXpub(), network);
    window.restoreCursors(externalThrough + 1, changeThrough + 1);
    return window;
  };
}

export interface OpenedReceive {
  /** The address the Receive sheet offers. */
  readonly receiveAddress: string;
  /** Every stored address of the open key the tree derives, for the address list. */
  readonly addresses: string[];
}

/**
 * Restore the open tree's cursors from its own rows, bind the rows written
 * before keys were recorded, and choose the receive address: the lowest
 * unused row of the open key that the tree derives, else a fresh one,
 * recorded under the open key.
 */
export async function openReceiveAddress(
  db: ReceiveAddressStore,
  tree: ReceiveTree,
  scope: AddressKeyScope,
  probe: ReceiveProbe,
): Promise<OpenedReceive> {
  const restore = async (): Promise<void> => {
    tree.restoreCursors(
      await db.getNextUnusedIndex(false, scope),
      await db.getNextUnusedIndex(true, scope),
    );
  };
  await restore();
  if (scope !== null) {
    // Every unbound row is judged, however far above the open tree's window
    // it lies (R7-3); the bound used rows then move the cursor.
    const highest = await db.getHighestUnboundIndices();
    if (highest.external >= 0 || highest.change >= 0) {
      const window = probe(highest.external, highest.change);
      const bound = await db.bindAddressRows(scope, (address) => window.ownsAddress(address));
      if (bound > 0) await restore();
    }
  }

  const candidates = await db.getUnusedAddresses(false, scope);
  let receiveAddress = candidates.find((row) => tree.ownsAddress(row.address))?.address ?? null;
  if (receiveAddress === null) {
    const derived = tree.getNextAddress();
    await db.insertAddress({
      address: derived.address,
      path: derived.path,
      index: derived.index,
      isChange: false,
      identityPublicKey: scope,
    });
    receiveAddress = derived.address;
  }

  const addresses = (await db.getAddressesOf(scope))
    .map((row) => row.address)
    .filter((address) => tree.ownsAddress(address));
  if (!addresses.includes(receiveAddress)) addresses.push(receiveAddress);
  return { receiveAddress, addresses };
}
