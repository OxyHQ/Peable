/**
 * HD key derivation and address management for FairCoin wallet.
 * Uses BIP44 derivation path: m/44'/119'/0'/change/index
 * Manages address gap limits for external (20) and internal/change (10) addresses.
 */

import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { encodeAddress, type NetworkConfig } from "@fairco.in/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DerivedAddress {
  address: string;
  path: string;
  index: number;
}

interface DerivedKeyEntry {
  address: string;
  path: string;
  index: number;
  isChange: boolean;
  /** Private key bytes, or null for watch-only (xpub) wallets. */
  privateKey: Uint8Array | null;
  publicKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXTERNAL_GAP_LIMIT = 20;
const CHANGE_GAP_LIMIT = 10;

// ---------------------------------------------------------------------------
// Key Manager
// ---------------------------------------------------------------------------

export class KeyManager {
  private readonly accountKey: HDKey;
  private readonly network: NetworkConfig;
  private readonly account: number;
  private readonly externalKeys: Map<string, DerivedKeyEntry> = new Map();
  private readonly changeKeys: Map<string, DerivedKeyEntry> = new Map();
  /**
   * Addresses this wallet is watching but that are NOT derived from its HD
   * tree -- e.g. a multisig P2SH address one of this wallet's own keys is a
   * cosigner for. No private key is derivable for one of these here; a
   * multisig spend goes through `@fairco.in/core`'s multisig primitives
   * directly, keyed by whichever leg address's private key the caller
   * already obtained via `getPrivateKeyForAddress`.
   */
  private readonly watchAddresses: Set<string> = new Set();
  private nextExternalIndex = 0;
  private nextChangeIndex = 0;
  /** True when built from an xpub (no private keys; cannot sign/spend). */
  private readonly watchOnly: boolean;

  private constructor(
    accountKey: HDKey,
    network: NetworkConfig,
    watchOnly: boolean,
    account: number,
  ) {
    this.accountKey = accountKey;
    this.network = network;
    this.watchOnly = watchOnly;
    this.account = account;
  }

  /**
   * Derive the raw BIP39 seed from a mnemonic. Exposed separately from
   * {@link fromSeed} because this is the single expensive step (PBKDF2, 2048
   * rounds — several seconds on Hermes): callers that persist the seed (so
   * unlock can skip re-deriving it) run this once, then build every subsequent
   * KeyManager from the cached bytes via {@link fromSeed}.
   */
  static deriveSeed(mnemonic: string): Uint8Array {
    return mnemonicToSeedSync(mnemonic);
  }

  /**
   * Create a KeyManager from a raw BIP39 seed. Derives the BIP44 account key
   * (m/44'/coinType'/account') and the initial address batch. This is the cheap part
   * of {@link fromMnemonic} — it does NOT run the PBKDF2 mnemonic→seed step, so
   * it's used on unlock with a cached seed.
   */
  static fromSeed(
    seed: Uint8Array,
    network: NetworkConfig,
    account = 0,
  ): KeyManager {
    const root = HDKey.fromMasterSeed(seed, {
      public: network.bip32.public,
      private: network.bip32.private,
    });
    const accountPath = `m/44'/${network.bip44CoinType}'/${account}'`;
    const accountKey = root.derive(accountPath);
    const manager = new KeyManager(accountKey, network, false, account);

    // Pre-generate initial batch of addresses up to the gap limit
    for (let i = 0; i < EXTERNAL_GAP_LIMIT; i++) {
      manager.deriveExternal(i);
    }
    for (let i = 0; i < CHANGE_GAP_LIMIT; i++) {
      manager.deriveChange(i);
    }

    return manager;
  }

  /**
   * Create a KeyManager from a BIP39 mnemonic. Derives the seed then the BIP44
   * account key: m/44'/coinType'/account'.
   */
  static fromMnemonic(
    mnemonic: string,
    network: NetworkConfig,
    account = 0,
  ): KeyManager {
    return KeyManager.fromSeed(KeyManager.deriveSeed(mnemonic), network, account);
  }

  /**
   * Create a watch-only KeyManager from an account-level extended public key
   * (the xpub at m/44'/coinType'/account'). Derives receive/change addresses from the
   * neutered public key — NO private keys are ever produced, so the wallet can
   * track balances but cannot sign or spend.
   *
   * Security: this exists so watch-only import never feeds a non-mnemonic into
   * `mnemonicToSeedSync` (BIP39 does not validate its input, so that path
   * silently derives a random *spendable* keypair — a dangerous fake wallet).
   *
   * @throws If the string is not a valid extended public key for this network,
   *         or if it carries private material (an xprv was supplied).
   */
  static fromXpub(xpub: string, network: NetworkConfig, account = 0): KeyManager {
    const trimmed = xpub.trim();
    let accountKey: HDKey;
    try {
      accountKey = HDKey.fromExtendedKey(trimmed, {
        public: network.bip32.public,
        private: network.bip32.private,
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "unknown error";
      throw new Error(`Invalid extended public key for this network: ${detail}`);
    }

    // A watch-only manager must hold no private material. If an xprv slipped
    // through, refuse it rather than silently retaining spend capability.
    if (accountKey.privateKey) {
      throw new Error(
        "Expected an extended PUBLIC key (xpub) but got a private key",
      );
    }
    if (!accountKey.publicKey) {
      throw new Error("Extended key has no public key");
    }

    const manager = new KeyManager(accountKey, network, true, account);

    for (let i = 0; i < EXTERNAL_GAP_LIMIT; i++) {
      manager.deriveExternal(i);
    }
    for (let i = 0; i < CHANGE_GAP_LIMIT; i++) {
      manager.deriveChange(i);
    }

    return manager;
  }

  /** Whether this manager is watch-only (xpub) and therefore cannot sign. */
  isWatchOnly(): boolean {
    return this.watchOnly;
  }

  /** The BIP44 account index (Pocket) this manager derives under. */
  getAccount(): number {
    return this.account;
  }

  /**
   * The account-level extended PUBLIC key (the xpub at m/44'/coinType'/0').
   *
   * This is the watch-only key the wallet registers with a notification server:
   * it lets the server derive our receive/change addresses (BIP32 public
   * derivation) but carries NO private material, so it can never sign or spend.
   * Exposing it here means push registration needs no private key and works even
   * while the wallet is PIN-locked.
   *
   * @throws If the underlying account key has no extended public key (should
   *         never happen — every manager is built from a public-capable key).
   */
  accountXpub(): string {
    const xpub = this.accountKey.publicExtendedKey;
    if (!xpub) {
      throw new Error("Account key has no extended public key");
    }
    return xpub;
  }

  /**
   * Zeroize all cached private-key material and clear the derived-key maps.
   *
   * The manager keeps every derived private key in memory for the session so
   * signing is instant. On lock, wallet reset, switch, or network change those
   * keys must not linger in the heap where a memory dump could recover them.
   * This overwrites each private-key buffer with zeros in place (so the
   * underlying bytes are destroyed even if another reference still points at the
   * buffer) and drops the maps.
   *
   * The manager is single-use afterwards: a wiped manager has no addresses and
   * cannot sign. Callers replace it (e.g. via `KeyManager.fromMnemonic`) when
   * the wallet is brought back up, so there is no `unwipe`.
   */
  wipe(): void {
    for (const entry of this.externalKeys.values()) {
      entry.privateKey?.fill(0);
    }
    for (const entry of this.changeKeys.values()) {
      entry.privateKey?.fill(0);
    }
    this.externalKeys.clear();
    this.changeKeys.clear();
    this.watchAddresses.clear();
    this.nextExternalIndex = 0;
    this.nextChangeIndex = 0;
    // Also zeroize the account-level extended key the children derive from, so
    // no signing-capable material survives (no-op for a watch-only manager,
    // whose account key holds no private data). `wipePrivateData` overwrites the
    // private-key bytes in place, matching the in-place wipe of the cached keys.
    this.accountKey.wipePrivateData();
  }

  /**
   * Restore the derivation cursors from persisted state (SPV_AUDIT.md §4.5).
   *
   * `KeyManager.fromMnemonic` always resets `nextExternalIndex` /
   * `nextChangeIndex` to 0, so without this the wallet forgets which addresses
   * it had already handed out and re-issues the same "next receive address" on
   * every launch (and can miss funds beyond the initial gap window). The store
   * computes the cursors from the database on init and calls this to advance
   * them, pre-deriving the lookahead window so the Bloom filter keeps watching
   * the right addresses.
   *
   * Cursors only ever move forward: a smaller value than the current cursor is
   * ignored, so this is safe to call repeatedly.
   *
   * @param externalNext Next unused external index (one past the highest used).
   * @param changeNext   Next unused change index (one past the highest used).
   */
  restoreCursors(externalNext: number, changeNext: number): void {
    if (externalNext > this.nextExternalIndex) {
      this.nextExternalIndex = externalNext;
      const targetEnd = this.nextExternalIndex + EXTERNAL_GAP_LIMIT;
      for (let i = this.externalKeys.size; i < targetEnd; i++) {
        this.deriveExternal(i);
      }
    }
    if (changeNext > this.nextChangeIndex) {
      this.nextChangeIndex = changeNext;
      const targetEnd = this.nextChangeIndex + CHANGE_GAP_LIMIT;
      for (let i = this.changeKeys.size; i < targetEnd; i++) {
        this.deriveChange(i);
      }
    }
  }

  /** Current next-unused external derivation index (for persistence). */
  getNextExternalIndex(): number {
    return this.nextExternalIndex;
  }

  /** Current next-unused change derivation index (for persistence). */
  getNextChangeIndex(): number {
    return this.nextChangeIndex;
  }

  /**
   * Get the next unused external (receive) address.
   */
  getNextAddress(): DerivedAddress {
    const index = this.nextExternalIndex;
    const entry = this.deriveExternal(index);
    this.nextExternalIndex = index + 1;

    // Extend the lookahead window if needed
    const targetEnd = this.nextExternalIndex + EXTERNAL_GAP_LIMIT;
    for (let i = this.externalKeys.size; i < targetEnd; i++) {
      this.deriveExternal(i);
    }

    return {
      address: entry.address,
      path: entry.path,
      index: entry.index,
    };
  }

  /**
   * Get the next unused change address.
   */
  getNextChangeAddress(): DerivedAddress {
    const index = this.nextChangeIndex;
    const entry = this.deriveChange(index);
    this.nextChangeIndex = index + 1;

    // Extend the lookahead window if needed
    const targetEnd = this.nextChangeIndex + CHANGE_GAP_LIMIT;
    for (let i = this.changeKeys.size; i < targetEnd; i++) {
      this.deriveChange(i);
    }

    return {
      address: entry.address,
      path: entry.path,
      index: entry.index,
    };
  }

  /**
   * Whether the given address belongs to this wallet (external, change, or
   * an explicitly registered watch address -- see {@link registerWatchAddress}).
   */
  ownsAddress(address: string): boolean {
    return (
      this.externalKeys.has(address) ||
      this.changeKeys.has(address) ||
      this.watchAddresses.has(address)
    );
  }

  /**
   * Register an explicit watch address that is NOT derived from this
   * wallet's HD tree -- e.g. a multisig P2SH address one of this wallet's
   * own keys is a cosigner for. Once registered, `ownsAddress` recognises it
   * and `getAllAddresses` includes it in the Bloom-filter watch set.
   */
  registerWatchAddress(address: string): void {
    this.watchAddresses.add(address);
  }

  /** Every explicitly registered watch address (see {@link registerWatchAddress}). */
  getWatchAddresses(): string[] {
    return Array.from(this.watchAddresses);
  }

  /**
   * Mark an address as used and extend the derivation window so that at least
   * `gapLimit` unused addresses always exist beyond the highest used index.
   *
   * This is the sync-level equivalent of the BIP44 gap-limit walk: when a
   * payment lands on one of our addresses we advance the cursor past it and
   * pre-derive the next batch so future receives to higher indexes are still
   * watched by the Bloom filter.
   *
   * @returns `true` if new addresses were derived (the caller should refresh
   *          its address watch set / Bloom filter), `false` otherwise.
   */
  markAddressUsed(address: string): boolean {
    const changeEntry = this.changeKeys.get(address);
    if (changeEntry) {
      return this.advanceCursor(true, changeEntry.index);
    }
    const externalEntry = this.externalKeys.get(address);
    if (externalEntry) {
      return this.advanceCursor(false, externalEntry.index);
    }
    return false;
  }

  /**
   * Get the private key bytes for a derived address.
   * Throws if the wallet is watch-only or the address is not managed here.
   */
  getPrivateKeyForAddress(address: string): Uint8Array {
    if (this.watchOnly) {
      throw new Error(
        "Watch-only wallet has no private keys; cannot sign or spend",
      );
    }

    const externalEntry = this.externalKeys.get(address);
    if (externalEntry?.privateKey) {
      return externalEntry.privateKey;
    }

    const changeEntry = this.changeKeys.get(address);
    if (changeEntry?.privateKey) {
      return changeEntry.privateKey;
    }

    throw new Error(
      `Address not found in key manager: ${address}`,
    );
  }

  /**
   * Get all derived addresses (external + change) plus any registered
   * watch addresses.
   */
  getAllAddresses(): string[] {
    return [
      ...this.getExternalAddresses(),
      ...this.getChangeAddresses(),
      ...this.getWatchAddresses(),
    ];
  }

  /**
   * Get all external (receive) addresses.
   */
  getExternalAddresses(): string[] {
    return Array.from(this.externalKeys.values())
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.address);
  }

  /**
   * Get all change addresses.
   */
  getChangeAddresses(): string[] {
    return Array.from(this.changeKeys.values())
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.address);
  }

  /**
   * Scan for used addresses by checking each one with the provided callback.
   * Extends derivation beyond the gap limit when used addresses are found.
   *
   * @param checkFn - Returns true if the address has been used (has history).
   */
  async scanForUsedAddresses(
    checkFn: (address: string) => Promise<boolean>,
  ): Promise<void> {
    await this.scanChain(false, checkFn);
    await this.scanChain(true, checkFn);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async scanChain(
    isChange: boolean,
    checkFn: (address: string) => Promise<boolean>,
  ): Promise<void> {
    const gapLimit = isChange ? CHANGE_GAP_LIMIT : EXTERNAL_GAP_LIMIT;
    let consecutiveUnused = 0;
    let index = 0;

    while (consecutiveUnused < gapLimit) {
      const entry = isChange
        ? this.deriveChange(index)
        : this.deriveExternal(index);

      const used = await checkFn(entry.address);

      if (used) {
        consecutiveUnused = 0;
        // Advance the next index past all used addresses
        if (isChange) {
          if (index >= this.nextChangeIndex) {
            this.nextChangeIndex = index + 1;
          }
        } else {
          if (index >= this.nextExternalIndex) {
            this.nextExternalIndex = index + 1;
          }
        }
      } else {
        consecutiveUnused += 1;
      }

      index += 1;
    }
  }

  /**
   * Advance the next-index cursor for a chain past a used index and pre-derive
   * addresses so that `gapLimit` unused addresses always exist beyond it.
   * Returns true if any new address was derived.
   */
  private advanceCursor(isChange: boolean, usedIndex: number): boolean {
    const gapLimit = isChange ? CHANGE_GAP_LIMIT : EXTERNAL_GAP_LIMIT;
    const keys = isChange ? this.changeKeys : this.externalKeys;

    if (isChange) {
      if (usedIndex >= this.nextChangeIndex) {
        this.nextChangeIndex = usedIndex + 1;
      }
    } else {
      if (usedIndex >= this.nextExternalIndex) {
        this.nextExternalIndex = usedIndex + 1;
      }
    }

    const nextIndex = isChange ? this.nextChangeIndex : this.nextExternalIndex;
    const targetEnd = nextIndex + gapLimit;

    let derivedNew = false;
    for (let i = keys.size; i < targetEnd; i++) {
      if (isChange) {
        this.deriveChange(i);
      } else {
        this.deriveExternal(i);
      }
      derivedNew = true;
    }

    return derivedNew;
  }

  private deriveExternal(index: number): DerivedKeyEntry {
    // Return cached entry if it exists
    for (const entry of this.externalKeys.values()) {
      if (entry.index === index && !entry.isChange) {
        return entry;
      }
    }
    return this.deriveAndStore(0, index);
  }

  private deriveChange(index: number): DerivedKeyEntry {
    // Return cached entry if it exists
    for (const entry of this.changeKeys.values()) {
      if (entry.index === index && entry.isChange) {
        return entry;
      }
    }
    return this.deriveAndStore(1, index);
  }

  private deriveAndStore(
    chain: 0 | 1,
    index: number,
  ): DerivedKeyEntry {
    const childKey = this.accountKey.deriveChild(chain).deriveChild(index);
    const privateKey = childKey.privateKey;
    const publicKey = childKey.publicKey;

    // The public key is always required (it yields the address). The private
    // key is absent for watch-only (xpub) wallets, which is expected; only a
    // signing wallet must have one.
    if (!publicKey) {
      throw new Error(
        `Failed to derive public key at chain=${chain} index=${index}`,
      );
    }
    if (!this.watchOnly && !privateKey) {
      throw new Error(
        `Failed to derive private key at chain=${chain} index=${index}`,
      );
    }

    const hash = hash160(publicKey);
    const address = encodeAddress(hash, this.network.pubKeyHash);
    const isChange = chain === 1;
    const path = `m/44'/${this.network.bip44CoinType}'/${this.account}'/${chain}/${index}`;

    const entry: DerivedKeyEntry = {
      address,
      path,
      index,
      isChange,
      privateKey: privateKey ? new Uint8Array(privateKey) : null,
      publicKey: new Uint8Array(publicKey),
    };

    if (isChange) {
      this.changeKeys.set(address, entry);
    } else {
      this.externalKeys.set(address, entry);
    }

    return entry;
  }
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}
