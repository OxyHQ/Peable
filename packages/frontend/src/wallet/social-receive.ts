/**
 * Peable's on-device half of the social-receive scheme (design spec §4.3).
 *
 * Peable never holds the identity private key. The watch window derives from
 * the identity PUBLIC key (`KeyManager.getSharedPublicKey()`), exactly as a
 * payer or the backend derives the same addresses, and spending a
 * social-receive coin asks the key's holder to sign the input's sighash
 * (`KeyManager.signSocialReceive(index, sighash)`): Commons over
 * signature-protected IPC on Android, the keychain-group key on iOS. What comes
 * back is a DER signature and the child's compressed public key, never a key.
 *
 * The address derivation is `@fairco.in/core`'s published primitive
 * (`deriveSocialReceiveAddress`) — generic secp256k1 crypto with no Oxy
 * dependency. Also owns the gap-limit-extension math as a pure function, kept
 * here (not in `wallet-store.ts`) so it stays directly unit-testable without
 * any SQLite or SPV setup.
 */
import {
  SIGHASH_ALL,
  bytesToHex,
  hexToBytes,
  computeMultisigSigHash,
  createP2PKHScriptSig,
  deriveSocialReceiveAddress,
  publicKeyToAddress,
} from "@fairco.in/core";
import type { NetworkConfig, Transaction } from "@fairco.in/core";
import { Point } from "@noble/secp256k1";
import { KeyManager as IdentityKeyManager } from "@oxy.so/core/crypto";

/**
 * How many unused social-receive addresses stay watched beyond the highest
 * USED index — mirrors the FairCoin BIP44 external-chain gap limit
 * (`EXTERNAL_GAP_LIMIT` in `key-manager.ts`).
 */
export const SOCIAL_RECEIVE_GAP_LIMIT = 20;

/**
 * The compressed, lowercase hex form of a secp256k1 public key, whatever
 * encoding it arrived in. The identity key is published uncompressed (`04…`)
 * while the social-receive scheme works on the compressed point; comparing two
 * encodings of one key as strings would call them different keys.
 */
export function compressedPublicKeyHex(publicKey: string | Uint8Array): string {
  const hex = typeof publicKey === "string" ? publicKey.toLowerCase() : bytesToHex(publicKey);
  return Point.fromHex(hex).toHex(true);
}

/**
 * The identity public key, compressed hex — the name under which this device's
 * social-receive addresses exist. `null` on web, for a keyless account, or on
 * Android when Commons is absent: only the key's holder can sign for these
 * addresses, so without it there is nothing to watch.
 *
 * Both sides of social receive derive from it: this device computes its watch
 * window from it, and the backend derives what payers are sent to from the key
 * the account publishes. Comparing the two is the only way to notice they have
 * stopped being the same key.
 */
export async function getIdentityPublicKeyHex(): Promise<string | null> {
  const publicKey = await IdentityKeyManager.getSharedPublicKey();
  return publicKey ? compressedPublicKeyHex(publicKey) : null;
}

/**
 * Compute `count` consecutive social-receive addresses starting at `start`,
 * from the identity PUBLIC key. Address 0 is always the caller's stable
 * default/favourite address.
 */
export function deriveSocialReceiveWatchWindow(
  identityPublicKeyHex: string,
  start: number,
  count: number,
  network: NetworkConfig,
): { index: number; address: string }[] {
  const identityPublicKey = hexToBytes(compressedPublicKeyHex(identityPublicKeyHex));
  const window: { index: number; address: string }[] = [];
  for (let i = start; i < start + count; i++) {
    window.push({
      index: i,
      address: deriveSocialReceiveAddress(identityPublicKey, i, network),
    });
  }
  return window;
}

/**
 * The legacy (pre-segwit) SIGHASH_ALL digest of input `inputIndex` with
 * `scriptCode` substituted in. `@fairco.in/core` exports this algorithm as
 * `computeMultisigSigHash`, whose scriptCode is a P2SH redeem script; for a
 * P2PKH input the scriptCode is the previous output's scriptPubKey, and the
 * digest is byte-identical to what `signInput` signs.
 */
export function p2pkhSigHash(tx: Transaction, inputIndex: number, scriptPubKey: Uint8Array): Uint8Array {
  return computeMultisigSigHash(tx, inputIndex, scriptPubKey, SIGHASH_ALL);
}

/**
 * The scriptSig spending social-receive child `index` at `address`, signed by
 * the identity key's holder. Throws when no holder answers (Commons absent,
 * keyless, web) or when the key that signed is not the one `address` belongs
 * to — broadcasting that would be rejected by every node after the bytes left.
 */
export async function signSocialReceiveInput(
  tx: Transaction,
  inputIndex: number,
  scriptPubKey: Uint8Array,
  index: number,
  address: string,
  network: NetworkConfig,
): Promise<Uint8Array> {
  const sighash = bytesToHex(p2pkhSigHash(tx, inputIndex, scriptPubKey));
  const signed = await IdentityKeyManager.signSocialReceive(index, sighash);
  if (!signed) {
    throw new Error("Cannot sign for a social-receive address without the Oxy identity");
  }
  const childPublicKey = hexToBytes(signed.publicKey);
  if (publicKeyToAddress(childPublicKey, network) !== address) {
    throw new Error("The Oxy identity signed with a key that does not own this social-receive address");
  }
  const der = hexToBytes(signed.signature);
  const signature = new Uint8Array(der.length + 1);
  signature.set(der, 0);
  signature[der.length] = SIGHASH_ALL;
  return createP2PKHScriptSig(signature, childPublicKey);
}

/**
 * Decide whether the persisted, watched social-receive window needs to grow,
 * and if so, which NEW indices to derive — pure, no I/O. Called after
 * persisting a newly-used address; the caller derives + persists whatever
 * this returns and refreshes the Bloom filter if it returns non-null.
 *
 * @param highestWatchedIndex The highest index currently derived+persisted,
 *   or -1 if none yet.
 * @param highestUsedIndex The highest index a real payment has landed on, or
 *   -1 if none yet.
 * @param gapLimit {@link SOCIAL_RECEIVE_GAP_LIMIT} in production; injectable
 *   for tests.
 */
export function computeWindowExtension(
  highestWatchedIndex: number,
  highestUsedIndex: number,
  gapLimit: number,
): { start: number; count: number } | null {
  const target = highestUsedIndex + gapLimit;
  if (target <= highestWatchedIndex) {
    return null;
  }
  return { start: highestWatchedIndex + 1, count: target - highestWatchedIndex };
}
