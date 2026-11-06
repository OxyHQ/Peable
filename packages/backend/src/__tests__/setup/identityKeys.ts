/**
 * Tests never read a DID from Oxy for a FairCoin recipient (ADR 0021 D5): every
 * account has a deterministic identity key — the secp256k1 public key of
 * sha256(account id) — except an id starting with `keyless_`, which has none
 * (a custodial account, or an organization without its wallet). A suite about
 * the DID read itself restores it with `useIdentityKeyResolver(null)`.
 *
 * Nor do they ask the Explorer whether an address was ever paid: the answer
 * is `unknown`, so no `@username` address is handed back to its sender and no
 * payment is retired on the chain's word unless a suite says the chain shows
 * an address unused (`useAddressUsageReader`).
 */
import { getPublicKey } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { useIdentityKeyResolver } from '../../services/socialReceive';
import { useAddressUsageReader } from '../../services/faircoin/addressPool';

export function testIdentityPrivateKey(accountId: string): Uint8Array {
  return sha256(new TextEncoder().encode(`peable-test-identity:${accountId}`));
}

export function testIdentityPublicKey(accountId: string): Uint8Array {
  return getPublicKey(testIdentityPrivateKey(accountId), true);
}

useIdentityKeyResolver(async (accountId) =>
  accountId.startsWith('keyless_') ? null : testIdentityPublicKey(accountId),
);

useAddressUsageReader(async () => 'unknown');
