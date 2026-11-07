/**
 * Peable's on-device half of the social-receive scheme (design spec §4.3).
 *
 * Peable never holds the identity private key. Every watched address derives from
 * the identity PUBLIC key the wallet opened with (`identity-key.ts` decides it
 * from what the account vouches for, never from a store another app can
 * write — R5-1), exactly as a payer or the backend derives the same addresses, and spending a
 * social-receive coin asks the key's holder to sign the input's sighash
 * (`KeyManager.signSocialReceive(index, sighash)`): Commons over
 * signature-protected IPC on Android, the keychain-group key on iOS. What comes
 * back is a DER signature and the child's compressed public key, never a key.
 *
 * The address derivation is `@fairco.in/core`'s published primitive
 * (`deriveSocialReceiveAddress`) — generic secp256k1 crypto with no Oxy
 * dependency. Also owns the key comparison as a pure function, kept here (not
 * in `wallet-store.ts`) so it stays directly unit-testable without any SQLite
 * or SPV setup. WHICH addresses are watched is `social-receive-watch.ts`: the
 * set the gateway reports it handed out (ADR 0021 D9, amended 2026-11-06), not
 * a contiguous window.
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
import { KeyManager as IdentityKeyManager } from '@oxy.so/core/crypto';
import { asWalletKeyError } from './identity-unavailable';
import { identityKeyOptions, type IdentitySubject } from './identity-wallet';

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
 * The key this device holds for the subject, compressed hex:
 * `KeyManager.getIdentityPublicKeyForMoney` (core 7.33.0, R5-1), the public
 * half of exactly the private key `deriveScopedSeed` / `signSocialReceive`
 * use — on iOS derived from the private key in the restricted keychain groups,
 * never the shared group's public item every Oxy app can write; on Android
 * Commons' own key. Still only a candidate: `identity-key.ts` opens it only
 * when the account's key history names it and a derivation selecting it
 * succeeds. `null` on web, for a keyless account, when nothing answers, or for
 * an answer that does not parse. A read that THROWS (core's
 * `IdentityUnavailableError`) is passed on: it is "cannot tell now", never
 * "no key here" (`identity-key.ts` stops as `unavailable`).
 */
export async function readDeviceKeyHint(subject: IdentitySubject): Promise<string | null> {
  const publicKey = await IdentityKeyManager.getIdentityPublicKeyForMoney(
    subject.kind === 'organization' ? { accountId: subject.accountId } : undefined,
  );
  if (!publicKey) return null;
  try {
    return compressedPublicKeyHex(publicKey);
  } catch {
    return null;
  }
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

/** `KeyManager.signSocialReceive`'s shape, injectable so signing is tested without a holder. */
export type SocialReceiveSign = (
  index: number,
  digest: string,
  opts?: { accountId?: string; ownerAccountId?: string; publicKey?: string },
) => Promise<{ signature: string; publicKey: string } | null>;

/**
 * Which of the subject's keys signs (Peable ADR 0002, amended 2026-11-06
 * "previous keys stay spendable"): `publicKey` names a PREVIOUS key the
 * holder kept after a rotation or replacement; absent, the current key.
 */
export interface SocialReceiveKeySelector {
  readonly publicKey?: string;
  readonly sign?: SocialReceiveSign;
}

/**
 * The scriptSig spending social-receive child `index` at `address`, signed by
 * the identity key's holder. Throws when no holder answers (Commons absent,
 * keyless, web) or when the key that signed is not the one `address` belongs
 * to — broadcasting that would be rejected by every node after the bytes left.
 * A key that cannot be read NOW (core's `IdentityUnavailableError`: a locked
 * keychain, a busy Commons) throws `WalletKeyUnavailableError` — "try
 * again", never "this coin is not yours"; nothing is signed or sent.
 */
export async function signSocialReceiveInput(
  tx: Transaction,
  inputIndex: number,
  scriptPubKey: Uint8Array,
  index: number,
  address: string,
  network: NetworkConfig,
  subject: IdentitySubject,
  selector: SocialReceiveKeySelector = {},
): Promise<Uint8Array> {
  const sighash = bytesToHex(p2pkhSigHash(tx, inputIndex, scriptPubKey));
  // The holder of the SUBJECT's key signs: an organization's coins are signed
  // by the organization's key (`{ accountId }`), never by the person's. A
  // previous key is named by its public key, and never falls back to another.
  const sign: SocialReceiveSign =
    selector.sign ?? ((i, digest, opts) => IdentityKeyManager.signSocialReceive(i, digest, opts));
  const options = {
    ...identityKeyOptions(subject),
    ...(selector.publicKey !== undefined ? { publicKey: selector.publicKey } : {}),
  };
  let signed: Awaited<ReturnType<SocialReceiveSign>>;
  try {
    signed = await sign(index, sighash, options);
  } catch (error) {
    throw asWalletKeyError(error);
  }
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
