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
 */
import type { AddressInsert, AddressKeyScope, AddressRow } from '../storage/database';

/** The part of `Database` this needs. */
export interface ReceiveAddressStore {
  getNextUnusedIndex(isChange: boolean, scope: AddressKeyScope): Promise<number>;
  bindAddressRows(key: string, derives: (address: string) => boolean): Promise<number>;
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

export interface OpenedReceive {
  /** The address the Receive sheet offers. */
  readonly receiveAddress: string;
  /** Every stored address of the open key the tree derives, for the address list. */
  readonly addresses: string[];
}

/** A bound used row can widen the window, which may derive more rows: at most this many passes. */
const MAX_BIND_PASSES = 16;

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
): Promise<OpenedReceive> {
  const restore = async (): Promise<void> => {
    tree.restoreCursors(
      await db.getNextUnusedIndex(false, scope),
      await db.getNextUnusedIndex(true, scope),
    );
  };
  await restore();
  if (scope !== null) {
    for (let pass = 0; pass < MAX_BIND_PASSES; pass++) {
      const bound = await db.bindAddressRows(scope, (address) => tree.ownsAddress(address));
      if (bound === 0) break;
      await restore();
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
