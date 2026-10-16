import { getNetwork } from '@fairco.in/core';
import { getDb } from '../db/postgres';
import { reserveNextAccountDerivationIndex } from '../db/accounts/accountDerivationIndex';
import { reserveNextDerivationIndex } from '../db/merchants/derivationIndex';
import { deriveIntentAddress } from './derivation';

/**
 * Atomically claim the merchant's next derivation index and derive its
 * watch-only receive address.
 *
 * The reservation is `UPDATE … SET x = x + 1 … RETURNING x - 1`, which takes
 * the row lock and returns the PRE-increment value — exactly the index this
 * call owns, so concurrent callers each get a distinct index with no
 * read-modify-write race; see `db/merchants/derivationIndex.ts` for what a
 * wrong index costs.
 *
 * The key material comes back in the SAME statement as the index, so the xpub
 * used to derive the address is the one the reservation was taken against.
 */
export async function reserveNextAddress(
  merchantId: string,
): Promise<{ index: number; address: string }> {
  const reserved = await reserveNextDerivationIndex(getDb(), merchantId);

  if (!reserved) {
    throw new Error(`merchant not found: ${merchantId}`);
  }

  const address = deriveIntentAddress(
    reserved.xpub,
    0,
    reserved.index,
    getNetwork(reserved.network),
  );

  return { index: reserved.index, address };
}

/**
 * The on-behalf twin of {@link reserveNextAddress} (ADR 0012 D5): claim the
 * SELLER's next index and derive the receive address from THEIR key, so the
 * coins go straight to their wallet.
 *
 * Same single-statement reservation, on `connected_accounts`; see
 * `db/accounts/accountDerivationIndex.ts`.
 */
export async function reserveNextAccountAddress(
  merchantId: string,
  accountId: string,
): Promise<{ index: number; address: string }> {
  const reserved = await reserveNextAccountDerivationIndex(getDb(), merchantId, accountId);
  if (!reserved) {
    throw new Error(`connected account has no registered key: ${accountId}`);
  }
  const address = deriveIntentAddress(
    reserved.xpub,
    0,
    reserved.index,
    getNetwork(reserved.network),
  );
  return { index: reserved.index, address };
}
