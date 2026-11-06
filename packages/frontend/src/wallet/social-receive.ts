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
 * dependency. Also owns the window math and the key comparison as pure
 * functions, kept here (not in `wallet-store.ts`) so they stay directly
 * unit-testable without any SQLite or SPV setup.
 */
import {
  SIGHASH_ALL,
  bytesToHex,
  hexToBytes,
  computeMultisigSigHash,
  createP2PKHScriptSig,
  deriveSocialReceiveAddress,
  publicKeyToAddress,
} from '@fairco.in/core';
import type { NetworkConfig, Transaction } from '@fairco.in/core';
import { Point } from '@noble/secp256k1';
import { KeyManager as IdentityKeyManager, getOrganizationPublicKey } from '@oxy.so/core/crypto';
// One module, not the vocabulary barrel: Metro ships every module it reaches.
import {
  SOCIAL_RECEIVE_GAP_LIMIT,
  SOCIAL_RECEIVE_INDEX_LIMIT,
  SOCIAL_RECEIVE_MAX_WATCHED,
} from '@peable.to/contracts/vocabulary/receiveTree';
import { PERSONAL_SUBJECT, identityKeyOptions, type IdentitySubject } from './identity-wallet';

/**
 * How many unused social-receive addresses stay watched beyond the highest
 * USED or RESERVED index — the FairCoin BIP44 external-chain gap limit
 * (`EXTERNAL_GAP_LIMIT` in `key-manager.ts`). The gateway's ceiling is derived
 * from it, so it is the contract's constant, not this wallet's.
 *
 * {@link SOCIAL_RECEIVE_MAX_WATCHED}: the most indices this device watches,
 * `0 .. MAX - 1`. Every index the gateway hands out is watched forever (a paid
 * address can be paid again), so the window only grows. It has to stop
 * somewhere: each index is an elliptic-curve derivation, a row, a Bloom-filter
 * entry (the filter caps at 36,000 bytes, ~15,000 entries at its
 * false-positive rate, and saturates beyond) and, the first time, an Explorer
 * read. The gateway never hands out an index at or above
 * {@link SOCIAL_RECEIVE_INDEX_LIMIT} (`MAX - GAP`), so with the plan below
 * every address it reserves is inside this window; past the bound the wallet
 * says so ({@link SocialReceiveWindowPlan.capped}) rather than pretend it still
 * watches what payers are sent to.
 */
export { SOCIAL_RECEIVE_GAP_LIMIT, SOCIAL_RECEIVE_INDEX_LIMIT, SOCIAL_RECEIVE_MAX_WATCHED };

/**
 * The compressed, lowercase hex form of a secp256k1 public key, whatever
 * encoding it arrived in. The identity key is published uncompressed (`04…`)
 * while the social-receive scheme works on the compressed point; comparing two
 * encodings of one key as strings would call them different keys.
 */
export function compressedPublicKeyHex(publicKey: string | Uint8Array): string {
  const hex = typeof publicKey === 'string' ? publicKey.toLowerCase() : bytesToHex(publicKey);
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
export async function getIdentityPublicKeyHex(
  subject: IdentitySubject = PERSONAL_SUBJECT,
): Promise<string | null> {
  // An organization's key as THIS phone can reach it (oxy ADR 0061 D6): the
  // iOS keychain group, or Commons' identity host on Android. `null` when this
  // phone has no copy — never the person's own key in its place.
  const publicKey =
    subject.kind === 'organization'
      ? await getOrganizationPublicKey(subject.accountId)
      : await IdentityKeyManager.getSharedPublicKey();
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
export function p2pkhSigHash(
  tx: Transaction,
  inputIndex: number,
  scriptPubKey: Uint8Array,
): Uint8Array {
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
  subject: IdentitySubject = PERSONAL_SUBJECT,
): Promise<Uint8Array> {
  const sighash = bytesToHex(p2pkhSigHash(tx, inputIndex, scriptPubKey));
  // The holder of the SUBJECT's key signs: an organization's coins are signed
  // by the organization's key (`{ accountId }`), never by the person's.
  const options = identityKeyOptions(subject);
  const signed = options
    ? await IdentityKeyManager.signSocialReceive(index, sighash, options)
    : await IdentityKeyManager.signSocialReceive(index, sighash);
  if (!signed) {
    throw new Error('Cannot sign for a social-receive address without the Oxy identity');
  }
  const childPublicKey = hexToBytes(signed.publicKey);
  if (publicKeyToAddress(childPublicKey, network) !== address) {
    throw new Error(
      'The Oxy identity signed with a key that does not own this social-receive address',
    );
  }
  const der = hexToBytes(signed.signature);
  const signature = new Uint8Array(der.length + 1);
  signature.set(der, 0);
  signature[der.length] = SIGHASH_ALL;
  return createP2PKHScriptSig(signature, childPublicKey);
}

/**
 * The highest of `values`, or -1 when there is none. A loop, never
 * `Math.max(...values)`: spreading a large collection into arguments throws
 * `RangeError: Maximum call stack size exceeded` (V8 between 100k and 200k
 * entries, JSC near 1M, Hermes lower), and a large cursor must never be what
 * stops a wallet from opening.
 */
export function highestIndex(values: Iterable<number>): number {
  let highest = -1;
  for (const value of values) {
    if (value > highest) highest = value;
  }
  return highest;
}

export interface SocialReceiveWindowPlan {
  /** The indices to derive and watch next, or `null` when none. */
  readonly extension: { start: number; count: number } | null;
  /**
   * True when the gateway has handed out (or is within the gap of handing
   * out) indices beyond {@link SOCIAL_RECEIVE_MAX_WATCHED}: a payment to one
   * of them would not reach this wallet, so `@username` must not be offered.
   */
  readonly capped: boolean;
}

/**
 * How far the watch window should reach — `SOCIAL_RECEIVE_GAP_LIMIT` past the
 * highest index either PAID (seen on chain) or RESERVED (the gateway's cursor)
 * — bounded by `maxWatched`. Pure.
 *
 * @param highestReserved The cursor's `reserved_through`, or -1 when nothing
 *   was reserved (the endpoint's `0` sentinel: index 0 is the stable default
 *   address and is never handed out by `next_address`).
 */
export function planSocialReceiveWindow(input: {
  readonly highestWatched: number;
  readonly highestUsed: number;
  readonly highestReserved: number;
  readonly gapLimit?: number;
  readonly maxWatched?: number;
}): SocialReceiveWindowPlan {
  const gapLimit = input.gapLimit ?? SOCIAL_RECEIVE_GAP_LIMIT;
  const maxWatched = input.maxWatched ?? SOCIAL_RECEIVE_MAX_WATCHED;
  const ceiling = maxWatched - 1;
  const wanted = Math.max(input.highestUsed, input.highestReserved) + gapLimit;
  const target = Math.min(wanted, ceiling);
  const extension =
    target > input.highestWatched
      ? { start: input.highestWatched + 1, count: target - input.highestWatched }
      : null;
  return { extension, capped: wanted > ceiling };
}

/**
 * Whether this device's key is the one payers are sent to:
 *
 *   match       the account publishes this device's key as its `#key-1`
 *   mismatch    it publishes another key, or none: every address the gateway
 *               hands out belongs to a tree this wallet cannot see (ADR 0002)
 *   unverified  the published key could not be read; the cursor's last
 *               recorded key did not contradict this device
 */
export type SocialReceiveKeyVerdict = 'match' | 'mismatch' | 'unverified';

/**
 * Judge the device's key against the account's PUBLISHED key — the one the
 * gateway derives the NEXT reservation from — and only when that cannot be
 * read, against the key the cursor's LAST reservation used. The last-recorded
 * key is history: after a rotation done on another device it still names the
 * old key, and a phone holding that old key would keep offering `@username`
 * while every new payment derives from the new one.
 *
 * @param accountKey The account's `#key-1` (any encoding), `null` when it
 *   publishes none, `undefined` when it could not be read.
 * @param lastReservedKey The cursor's `identity_public_key`.
 */
export function judgeSocialReceiveKey(input: {
  readonly deviceKey: string;
  readonly accountKey: string | null | undefined;
  readonly lastReservedKey: string | null;
}): SocialReceiveKeyVerdict {
  const device = compressedPublicKeyHex(input.deviceKey);
  if (input.accountKey !== undefined) {
    if (input.accountKey === null) return 'mismatch';
    return sameKey(input.accountKey, device) ? 'match' : 'mismatch';
  }
  if (input.lastReservedKey !== null && !sameKey(input.lastReservedKey, device)) {
    return 'mismatch';
  }
  return 'unverified';
}

/** A key that does not parse is not this device's key. */
function sameKey(candidate: string, deviceCompressed: string): boolean {
  try {
    return compressedPublicKeyHex(candidate) === deviceCompressed;
  } catch {
    return false;
  }
}

const SECP256K1_VERIFICATION_METHOD_TYPE = 'EcdsaSecp256k1VerificationKey2019';
const ACCOUNT_KEY_FRAGMENT = '#key-1';

/**
 * The account's own key from its DID document: the secp256k1 method named
 * `#key-1`, exactly as the gateway's `resolveIdentityPublicKey` takes it (by
 * NAME, never the first one listed). `null` when the document lists none.
 */
export function accountKeyFromDidDocument(document: {
  readonly verificationMethod?: readonly unknown[];
}): string | null {
  for (const entry of document.verificationMethod ?? []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const method = entry as { id?: unknown; type?: unknown; publicKeyHex?: unknown };
    if (
      method.type === SECP256K1_VERIFICATION_METHOD_TYPE &&
      typeof method.id === 'string' &&
      method.id.endsWith(ACCOUNT_KEY_FRAGMENT) &&
      typeof method.publicKeyHex === 'string'
    ) {
      return method.publicKeyHex;
    }
  }
  return null;
}
