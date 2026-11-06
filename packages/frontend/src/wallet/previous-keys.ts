/**
 * Previous identity keys stay spendable (Peable ADR 0002, amended 2026-11-06
 * "previous keys stay spendable"; mainnet gate finding F1).
 *
 * A Peable identity wallet is a function of the account's identity key: its
 * HD tree derives from `deriveScopedSeed(PEABLE_SEED_INFO)` and its
 * social-receive addresses from the key itself. A personal rotation or an
 * organization's key replacement makes a NEW wallet, and coins keep arriving
 * under the old one — payments already broadcast, late payers, `@username`
 * senders holding an old address. Commons keeps the replaced private key (oxy
 * ADR 0061 D7 as amended 2026-11-06, `@oxy.so/core` `crypto/retiredKeys.ts`),
 * and `deriveScopedSeed` / `signSocialReceive` take a `publicKey` selector that
 * reaches it, current or retired, and never another key in its place.
 *
 * This module is the wallet's half, pure over injected effects so every rule
 * is tested without Commons, SQLite, SPV or the Explorer:
 *
 * - {@link groupPreviousKeys}: WHICH keys — every key the gateway recorded on
 *   the account's social-receive set (D9's `identity_public_key` per address)
 *   that is not the current one, canonicalised, plus any extra key the device
 *   lists (Commons' ring, keys already tracked).
 * - {@link probePreviousKeys}: which of them this device can REACH.
 * - {@link discoverPreviousTree}: gap-limit discovery of a reachable key's HD
 *   tree through the Explorer, like a restored HD wallet's.
 * - {@link signWalletInput}: each input signed by the key that owns it.
 * - {@link planPreviousKeyMove}: the one-tap move to the current key.
 *
 * Security, stated once: a retained key that was compromised is also the
 * attacker's. Keeping it makes the coins spendable from Peable again; it
 * cannot make them safe, and the move to the current key races whoever else
 * holds the previous one. That is inherent, which is why the move is offered
 * prominently and at once rather than left for later.
 */

import {
  deriveSocialReceiveAddress,
  hexToBytes,
  signInput,
  type NetworkConfig,
  type Transaction,
} from '@fairco.in/core';
import { estimateFeeForInputs, type UTXO } from '@peable.to/pay';
import { compressedPublicKeyHex } from './social-receive';
import type { WatchSetRow } from './social-receive-watch';

/** A key in the one form this module compares: compressed lowercase hex, or `null` when it does not parse. */
export function canonicalKey(key: string | null | undefined): string | null {
  if (!key) return null;
  try {
    return compressedPublicKeyHex(key);
  } catch {
    return null;
  }
}

/** One previous key and the social-receive rows recorded under it. */
export interface PreviousKeyGroup {
  /** Compressed lowercase hex. */
  readonly key: string;
  readonly rows: WatchSetRow[];
}

/**
 * The account's previous keys: every key its social-receive set records that
 * is none of `currentKeys` (the key this device's wallet derives from, and the
 * account's published `#key-1` when known — a published key this device does
 * not hold is someone else's tree to watch, never a key to move FROM), plus
 * `extraKeys` with no rows. Encodings are compared canonically, so a row
 * recorded compressed and a ring entry listed uncompressed are ONE key.
 *
 * A row recorded without a key (written before keys were recorded) joins the
 * previous key that reproduces its address at its index; one no previous key
 * reproduces is left out (the current key's are D9's `watchableRows`).
 */
export function groupPreviousKeys(input: {
  readonly rows: readonly WatchSetRow[];
  readonly currentKeys: readonly (string | null | undefined)[];
  readonly extraKeys?: readonly (string | null | undefined)[];
  readonly network: NetworkConfig;
}): PreviousKeyGroup[] {
  const current = new Set<string>();
  for (const key of input.currentKeys) {
    const canonical = canonicalKey(key);
    if (canonical) current.add(canonical);
  }
  const groups = new Map<string, WatchSetRow[]>();
  const canonicalOf = new Map<string, string | null>();
  const keyless: WatchSetRow[] = [];
  for (const row of input.rows) {
    if (row.identityPublicKey === null) {
      keyless.push(row);
      continue;
    }
    let canonical = canonicalOf.get(row.identityPublicKey);
    if (canonical === undefined) {
      canonical = canonicalKey(row.identityPublicKey);
      canonicalOf.set(row.identityPublicKey, canonical);
    }
    if (canonical === null || current.has(canonical)) continue;
    const rows = groups.get(canonical);
    if (rows) rows.push(row);
    else groups.set(canonical, [row]);
  }
  for (const key of input.extraKeys ?? []) {
    const canonical = canonicalKey(key);
    if (canonical && !current.has(canonical) && !groups.has(canonical)) groups.set(canonical, []);
  }
  if (keyless.length > 0 && groups.size > 0) {
    const keys = [...groups.keys()].map((key) => ({ key, bytes: hexToBytes(key) }));
    for (const row of keyless) {
      for (const { key, bytes } of keys) {
        if (deriveSocialReceiveAddress(bytes, row.index, input.network) === row.address) {
          groups.get(key)?.push(row);
          break;
        }
      }
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, rows]) => ({ key, rows }));
}

/**
 * Which `keys` this device can reach: `derive(key)` is
 * `deriveScopedSeed(PEABLE_SEED_INFO, { ...subject, publicKey: key })`, which
 * answers `null` for a key this device does not hold. A reachable key's seed
 * is handed to `build` (the HD KeyManager) and ZEROED right after — a seed is
 * never kept, here or anywhere (identity-wallet.ts). A key whose derivation
 * throws is unreachable this time, and asked again next time.
 */
export async function probePreviousKeys<T>(
  keys: readonly string[],
  derive: (key: string) => Promise<Uint8Array | null>,
  build: (key: string, seed: Uint8Array) => T,
): Promise<{ reachable: Map<string, T>; unreachable: string[] }> {
  const reachable = new Map<string, T>();
  const unreachable: string[] = [];
  for (const key of keys) {
    let seed: Uint8Array | null = null;
    try {
      seed = await derive(key);
    } catch {
      seed = null;
    }
    if (!seed) {
      unreachable.push(key);
      continue;
    }
    try {
      reachable.set(key, build(key, seed));
    } finally {
      seed.fill(0);
    }
  }
  return { reachable, unreachable };
}

/** What the Explorer says of one address, for discovery. */
export interface DiscoveryUsage {
  readonly usage: 'used' | 'unused' | 'unknown';
  /** Heights of its confirmed unspent outputs, ascending. */
  readonly confirmedHeights: readonly number[];
  readonly hasUnconfirmed: boolean;
}

/** The HD tree being discovered: the public face of `@peable.to/pay`'s KeyManager. */
export interface DiscoverableTree {
  getExternalAddresses(): string[];
  getChangeAddresses(): string[];
  getNextExternalIndex(): number;
  getNextChangeIndex(): number;
  /** Move the cursors forward (and derive the gap beyond them). */
  restoreCursors(externalNext: number, changeNext: number): void;
}

export interface TreeDiscoveryResult {
  /**
   * `false` when any read could not tell (testnet's index-less node, or an
   * address the Explorer answered without a verdict): the caller falls back
   * to a rescan from the wallet's birthday over the tree's window, which is
   * how a restored HD wallet discovers.
   */
  readonly conclusive: boolean;
  readonly externalNext: number;
  readonly changeNext: number;
  /** The lowest height an unspent output of the tree confirmed at, or `null`. */
  readonly rescanFrom: number | null;
  /** Whether any address of the tree holds coins now (confirmed or in the mempool). */
  readonly holdsCoins: boolean;
}

/** Safety bound per chain, far past any real tree: discovery never loops for ever. */
const DISCOVERY_MAX_ADDRESSES = 20_000;

/**
 * Gap-limit discovery of a previous key's HD tree: read each derived address
 * of the external then the change chain; a used one moves the cursor past it,
 * which derives the gap limit beyond (`restoreCursors`); stop once a whole gap
 * reads unused. An Explorer failure THROWS (nothing is recorded, the caller
 * tries again later); an `unknown` answer ends discovery inconclusive.
 */
export async function discoverPreviousTree(
  tree: DiscoverableTree,
  usage: (addresses: readonly string[]) => Promise<ReadonlyMap<string, DiscoveryUsage>>,
): Promise<TreeDiscoveryResult> {
  let rescanFrom: number | null = null;
  let holdsCoins = false;
  for (const chain of ['external', 'change'] as const) {
    const addresses = (): string[] =>
      chain === 'external' ? tree.getExternalAddresses() : tree.getChangeAddresses();
    let checked = 0;
    while (checked < DISCOVERY_MAX_ADDRESSES) {
      const batch = addresses().slice(checked);
      if (batch.length === 0) break;
      const answers = await usage(batch);
      let highestUsed = -1;
      for (let i = 0; i < batch.length; i++) {
        const answer = answers.get(batch[i] as string);
        if (!answer || answer.usage === 'unknown') {
          return {
            conclusive: false,
            externalNext: tree.getNextExternalIndex(),
            changeNext: tree.getNextChangeIndex(),
            rescanFrom: null,
            holdsCoins,
          };
        }
        if (answer.usage === 'used') highestUsed = checked + i;
        const lowest = answer.confirmedHeights[0];
        if (lowest !== undefined && (rescanFrom === null || lowest < rescanFrom)) {
          rescanFrom = lowest;
        }
        if (lowest !== undefined || answer.hasUnconfirmed) holdsCoins = true;
      }
      checked += batch.length;
      if (highestUsed >= 0) {
        if (chain === 'external') tree.restoreCursors(highestUsed + 1, 0);
        else tree.restoreCursors(0, highestUsed + 1);
      }
    }
  }
  return {
    conclusive: true,
    externalNext: tree.getNextExternalIndex(),
    changeNext: tree.getNextChangeIndex(),
    rescanFrom,
    holdsCoins,
  };
}

/**
 * Move a previous key's tree past every address this device already knows it
 * used — the coins and derived addresses stored while that key was the
 * current one — so a phone that rotated finds its own history without asking
 * the Explorer. A used address extends the window, which may own more of
 * `addresses`, so it repeats until nothing moves. Returns how many it marked.
 */
export function advanceTreeOverKnownAddresses(
  tree: { ownsAddress(address: string): boolean; markAddressUsed(address: string): boolean },
  addresses: Iterable<string>,
): number {
  let pending = [...new Set(addresses)];
  let marked = 0;
  for (let moved = true; moved && pending.length > 0; ) {
    moved = false;
    const rest: string[] = [];
    for (const address of pending) {
      if (tree.ownsAddress(address)) {
        tree.markAddressUsed(address);
        marked += 1;
        moved = true;
      } else {
        rest.push(address);
      }
    }
    pending = rest;
  }
  return marked;
}

/**
 * Who signs one input, by the address it spends:
 *
 *   hd      a key of an HD tree this wallet holds — the current key's or a
 *           previous key's — signed here
 *   social  social-receive child `index`, signed by the identity key's holder;
 *           `publicKey` names a PREVIOUS key, `null` the current one
 */
export type InputSigner =
  | { readonly kind: 'hd'; readonly privateKey: Uint8Array }
  | { readonly kind: 'social'; readonly index: number; readonly publicKey: string | null };

export interface WalletInputSigners {
  /** The signer of a coin at `address`, or `null` when this wallet cannot sign for it. */
  readonly signerFor: (address: string) => InputSigner | null;
  /** `signSocialReceiveInput` with the key selector `publicKey` names. */
  readonly signSocial: (
    tx: Transaction,
    inputIndex: number,
    scriptPubKey: Uint8Array,
    index: number,
    address: string,
    publicKey: string | null,
  ) => Promise<Uint8Array>;
}

/**
 * The scriptSig of input `inputIndex`, signed by the key that owns `utxo`'s
 * address. ONE dispatch for every send, so a transaction mixing the current
 * key's coins with a previous key's signs each input with its own key — the
 * mixed-key test proves it input by input. Throws for an address no key of
 * this wallet owns.
 */
export async function signWalletInput(
  tx: Transaction,
  inputIndex: number,
  utxo: { readonly address: string; readonly scriptPubKey: Uint8Array },
  signers: WalletInputSigners,
): Promise<Uint8Array> {
  const signer = signers.signerFor(utxo.address);
  if (!signer) throw new Error(`Address not found in key manager: ${utxo.address}`);
  if (signer.kind === 'hd') {
    return signInput(tx, inputIndex, utxo.scriptPubKey, signer.privateKey);
  }
  return signers.signSocial(
    tx,
    inputIndex,
    utxo.scriptPubKey,
    signer.index,
    utxo.address,
    signer.publicKey,
  );
}

/** The move of every previous-key coin to the current key, or why there is none. */
export type PreviousKeyMovePlan =
  | {
      readonly kind: 'ready';
      readonly inputs: UTXO[];
      /** What reaches the current key: the inputs less the fee. */
      readonly amount: bigint;
      readonly fee: bigint;
    }
  /** No confirmed previous-key coin to move (coins still confirming move later). */
  | { readonly kind: 'nothing' }
  /** What is there would not cover the fee and leave more than dust. */
  | { readonly kind: 'dust'; readonly total: bigint; readonly fee: bigint };

/**
 * Plan the one-tap move: EVERY confirmed previous-key coin in, ONE output to
 * the current key, no change — a sweep. The fee is `buildTransaction`'s own
 * no-change sizing for that many inputs and one output, so the fee shown is
 * the fee built. Refused as `dust` when what would arrive is at or below the
 * network's dust threshold: a move that costs (nearly) all it moves is not
 * one to offer.
 */
export function planPreviousKeyMove(input: {
  readonly coins: readonly UTXO[];
  readonly feePerByte: number;
  readonly dustThreshold: bigint;
}): PreviousKeyMovePlan {
  const inputs = input.coins.filter((coin) => coin.confirmed);
  if (inputs.length === 0) return { kind: 'nothing' };
  let total = 0n;
  for (const coin of inputs) total += coin.value;
  const fee = estimateFeeForInputs(inputs.length, input.feePerByte, 1);
  const amount = total - fee;
  if (amount <= input.dustThreshold) return { kind: 'dust', total, fee };
  return { kind: 'ready', inputs, amount, fee };
}

/**
 * The translation keys the previous-key notices use, by whose wallet it is.
 * The stranded line names the path to spend it HERE — the previous phrase
 * added in Commons — never "outside Peable": Commons keeps a key added that
 * way, and the wallet reaches it on its next refresh.
 */
export function previousKeyCopy(subjectKind: 'personal' | 'organization'): {
  readonly body: string;
  readonly stranded: string;
} {
  return {
    body: `wallet.previousKey.body.${subjectKind}`,
    stranded: `wallet.previousKey.stranded.${subjectKind}`,
  };
}
