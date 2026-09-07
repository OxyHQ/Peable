/**
 * Zustand store for FairCoin wallet state management.
 * Central state container used by UI components.
 * Integrates KeyManager for HD key derivation, UTXOSet for coin tracking,
 * and Database for persistence.
 *
 * Supports multi-wallet: users can create, switch, and manage
 * multiple wallets, each with its own mnemonic and chain data.
 */

import { create, type StoreApi } from "zustand";
import { Platform } from "react-native";
import {
  generateMnemonic,
  validateMnemonic,
  getNetwork,
  hexToBytes,
  bytesToHex,
  decodeAddress,
  buildTransaction,
  signInput,
  serializeTransaction,
  hashTransaction,
  type NetworkType,
  type NetworkConfig,
  type UTXO as TxUTXO,
} from "@fairco.in/core";
import type { ParsedTransaction } from "../p2p/messages";
import { SPVClient } from "../p2p/spv-client";
import { planRescan, type RescanProgress } from "../p2p/rescan";
import { DatabaseHeaderStore } from "../p2p/header-store";
import { createSocketProvider } from "../p2p/socket-provider";
import { KeyManager } from "./key-manager";
import { resolveMoveDestinationAddress } from "./move-address";
import {
  XPUB_MARKER_PREFIX,
  resolveWalletSeed,
  getOrDeriveBip39Seed,
  type ResolveWalletSeedDeps,
} from "./resolve-wallet-seed";
import { UTXOSet, type UTXO } from "./utxo-set";
import {
  selectInputsForSend,
  estimateSend as computeSendEstimate,
  type SendEstimate,
} from "./coin-selection";
import {
  applyTransactionToWallet,
  reconstructWalletTransaction,
  reverseBytesToHex,
} from "./apply-transaction";
import { useContactsStore } from "./contacts-store";
import { UtxoReservation } from "./utxo-reservation";
import {
  saveMnemonic,
  getMnemonic,
  clearAll as clearSecureStore,
  getWalletIndex,
  getActiveWalletId,
  setActiveWalletId,
  addWalletToIndex,
  removeWalletFromIndex,
  renameWallet,
  saveWalletMnemonic,
  getWalletMnemonic,
  deleteWalletMnemonic,
  saveWalletXpub,
  isWatchOnly as checkIsWatchOnly,
  setWalletBirthdayHeight,
  getWalletBirthdayHeight,
  getCachedWalletSeed,
  cacheWalletSeed,
  deleteCachedWalletSeed,
  isWalletBackedUp,
  markWalletBackedUp,
} from "../storage/secure-store";
import type { WalletInfo } from "../storage/secure-store";
import { Database } from "../storage/database";
import {
  OXY_IDENTITY_WALLET_ID,
  SEED_SECRET_PREFIX,
  buildSeedSecret,
  deriveIdentitySeed,
} from "./identity-wallet";
import {
  SOCIAL_RECEIVE_GAP_LIMIT,
  getIdentityPrivateKeyBytes,
  deriveSocialReceiveWatchWindow,
  getSocialReceiveSpendingKey,
  computeWindowExtension,
} from "./social-receive";
import { getSocialReceiveCursor } from "../services/gateway-client";
import {
  getPockets,
  savePockets,
  getActivePocket,
  setActivePocket,
  clearPockets,
} from "../storage/pockets-store";
import {
  type PocketInfo,
  MAIN_POCKET_ACCOUNT,
  addPocket,
  renamePocket as renamePocketList,
  updatePocketMeta as updatePocketMetaList,
  removePocket as removePocketList,
  canDeletePocket,
} from "./pockets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeeLevel = "low" | "medium" | "high";

export type IdentityInitResult = "initialized" | "no-identity" | "no-keystore";

/**
 * Discrete P2P network states. Stored on the wallet store as a key (rather
 * than a free-form string) so the UI can localise the message and react to
 * language changes without the store re-emitting (U-2).
 */
export type NetworkStatusKey =
  | "wallet.network.offline"
  | "wallet.network.resolvingDns"
  | "wallet.network.connecting"
  | "wallet.network.waitingForPeers"
  | "wallet.network.searchingForPeers"
  | "wallet.network.connectedSingular"
  | "wallet.network.connectedPlural"
  | "wallet.network.error";

export interface WalletTransaction {
  txid: string;
  amount: bigint; // positive = received, negative = sent
  address: string;
  timestamp: number;
  confirmations: number;
  type: "send" | "receive" | "stake" | "masternode_reward";
}

export interface MasternodeUTXO {
  txid: string;
  vout: number;
  address: string;
  confirmations: number;
}

export interface WalletState {
  // Initialization
  initialized: boolean;
  loading: boolean;
  error: string | null;
  network: NetworkType;

  // Multi-wallet
  activeWalletId: string | null;
  activeWalletName: string;
  wallets: WalletInfo[];
  isWatchOnly: boolean;
  /** Whether the active wallet's recovery phrase has been backed up. */
  hasBackedUp: boolean;
  /**
   * The recipient's stable social-receive default address (spec §4.3
   * `addr(0)`) — shown on the Receive screen alongside `@username`. `null`
   * until the social-receive window has been derived (web, keyless account,
   * or before `initializeFromIdentity` completes).
   */
  socialReceiveDefaultAddress: string | null;
  /** Active Pocket (BIP44 account index) within the current wallet. */
  activeAccount: number;
  /** Pockets (BIP44 sub-accounts) of the current wallet. */
  pockets: PocketInfo[];
  /** Per-Pocket balance (account index → confirmed+unconfirmed sats). */
  pocketBalances: Record<number, bigint>;

  // Balance
  balance: bigint;
  confirmedBalance: bigint;
  unconfirmedBalance: bigint;

  // Sync
  syncProgress: number; // 0-100
  chainHeight: number;
  connectedPeers: number;
  isSyncing: boolean;
  /**
   * Human-readable P2P status. Kept for back-compat with callers that only
   * need a string; UI components should prefer {@link networkStatusKey} +
   * {@link networkStatusData} so they can translate on render and react to
   * language changes without the store re-emitting the status (U-2).
   */
  networkStatus: string;
  /** i18n key describing the current P2P status. See `wallet.network.*`. */
  networkStatusKey: NetworkStatusKey;
  /** Optional interpolation values for the status key (e.g. `{count}`). */
  networkStatusData?: Record<string, string | number>;

  // Addresses
  currentReceiveAddress: string;
  addresses: string[];

  // Transactions
  transactions: WalletTransaction[];

  // Masternode
  masternodeUTXOs: MasternodeUTXO[];

  // Coin control
  selectedUTXOs: { txid: string; vout: number }[];

  // Actions
  /**
   * Bring a wallet up from its stored secret. Resolves only once the SPV/P2P
   * sync has been started, but invokes the optional `onReady` callback earlier
   * — the moment persisted state (balance, UTXOs, addresses, history) has been
   * hydrated into the store and `initialized` is true, BEFORE the network sync.
   * Boot/unlock pass `onReady` to render the home / lift the lock instantly
   * while sync continues in the background; internal multi-wallet callers omit
   * it and await the full promise (SPV startup stays serialised by the init
   * queue — N-1).
   */
  initialize: (
    mnemonic: string,
    walletId?: string,
    onReady?: () => void,
    account?: number,
  ) => Promise<void>;
  /**
   * Bring up the SINGLE Oxy-identity-derived wallet. Derives the seed from the
   * on-device identity, builds the KeyManager, and runs the normal init. No
   * mnemonic. Needs the on-device keystore; returns "no-keystore" without one
   * and "no-identity"
   * for a keyless account (routes onboarding to create an Oxy ID).
   */
  initializeFromIdentity: (onReady?: () => void) => Promise<IdentityInitResult>;
  /**
   * Reload the ACTIVE wallet (by `activeWalletId`, falling back to the
   * persisted active id) from its stored secret, wallet-type-aware exactly
   * like `switchWallet` — identity, BIP39, or watch-only. The reload
   * counterpart to `initialize` for a caller that already knows WHICH wallet
   * should come back up rather than switching to a different one: a PIN
   * unlock after `lockWallet` tore the module state down (M1), primarily.
   * Any resolution failure (identity unavailable, mnemonic/xpub missing) is
   * caught and surfaces through the normal `error` state, same as
   * `initialize`'s own catch — callers only need to check `initialized`
   * afterwards, not wrap this in their own try/catch.
   */
  reloadActiveWallet: (onReady?: () => void) => Promise<void>;
  createWallet: () => Promise<string>;
  restoreWallet: (mnemonic: string) => Promise<void>;
  refreshBalance: () => void;
  getNewAddress: () => string;
  getBuyDeliveryAddress: () => Promise<string>;
  sendTransaction: (
    toAddress: string,
    amount: bigint,
    feeRate: number,
  ) => Promise<string>;
  refreshMasternodeUTXOs: () => void;
  estimateFee: (feeLevel: FeeLevel) => bigint;
  estimateSend: (amount: bigint, feeRate: number) => SendEstimate;
  hasWallet: () => Promise<boolean>;
  wipeWallet: () => Promise<void>;
  lockWallet: () => void;
  rescanWallet: () => Promise<void>;

  // Multi-wallet actions
  loadWalletList: () => Promise<void>;
  switchWallet: (walletId: string) => Promise<void>;
  /** Record that the active wallet's recovery phrase has been backed up. */
  markBackedUp: () => Promise<void>;
  createNewWallet: (name: string) => Promise<string>;
  importWallet: (name: string, mnemonic: string) => Promise<void>;
  importWatchOnly: (name: string, xpub: string) => Promise<void>;
  deleteWallet: (walletId: string) => Promise<void>;
  renameActiveWallet: (name: string) => Promise<void>;

  // Pockets
  loadPockets: () => Promise<void>;
  switchPocket: (account: number) => Promise<void>;
  createPocket: (
    name: string,
    emoji: string,
    color: string,
    goal?: number,
  ) => Promise<number>;
  renamePocket: (account: number, name: string) => Promise<void>;
  /** Update a Pocket's emoji/color/goal. Pass `goal: null` to clear an existing goal. */
  updatePocketMeta: (
    account: number,
    updates: { emoji?: string; color?: string; goal?: number | null },
  ) => Promise<void>;
  deletePocket: (account: number) => Promise<void>;
  moveBetweenPockets: (
    toAccount: number,
    amount: bigint,
    feeRate: number,
  ) => Promise<string>;

  // Network switching
  switchNetwork: (network: NetworkType) => Promise<void>;

  // Backup
  exportBackup: () => Promise<string>;
  importBackup: (json: string) => Promise<void>;

  // Coin control
  setSelectedUTXOs: (utxos: { txid: string; vout: number }[]) => void;
  clearSelectedUTXOs: () => void;
}

// ---------------------------------------------------------------------------
// Wallet seed resolution — wires resolve-wallet-seed.ts's injected deps to
// the real implementations once, for switchPocket / moveBetweenPockets /
// initialize to share (see resolve-wallet-seed.ts for why this module can't
// bind its own defaults: it must stay free of the react-native-poisoned
// `../storage/secure-store` import so it loads under bun:test).
// ---------------------------------------------------------------------------

const walletSeedDeps: ResolveWalletSeedDeps = {
  deriveIdentitySeed,
  getWalletMnemonic,
  getCachedWalletSeed,
  cacheWalletSeed,
  deriveSeed: KeyManager.deriveSeed,
};

// ---------------------------------------------------------------------------
// UUID generator (no external deps)
// ---------------------------------------------------------------------------

function generateWalletId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Internal state (not exposed to Zustand consumers)
// ---------------------------------------------------------------------------

let keyManager: KeyManager | null = null;
let utxoSet: UTXOSet | null = null;
let database: Database | null = null;
let networkConfig: NetworkConfig | null = null;
let spvClient: SPVClient | null = null;
/**
 * The on-device identity's raw private key, held ONLY for deriving
 * social-receive spending keys on demand (spec §4.3) — never used for the
 * private spending tree, which goes through `deriveIdentitySeed`'s HKDF
 * instead. `null` until `initializeFromIdentity` sets up social receive.
 */
let socialReceiveIdentityPrivateKey: Uint8Array | null = null;
/** address -> derivation index, for every currently-watched social-receive address (used + unused window). */
let socialReceiveAddressIndex: Map<string, number> = new Map();
// Handle of the recurring poll that mirrors peer / sync state from the SPV
// client into the store (peer count, height, status text, periodic rescan).
// Held at module scope so we can clear it from `resetWalletInternals` — without
// that, every wallet switch / network change layered a fresh interval on top
// of the previous one, all racing to mutate the same state (C-1).
let peerUpdateInterval: ReturnType<typeof setInterval> | null = null;
// Guards the historical-rescan driver so the periodic trigger never starts a
// second concurrent scan.
let rescanDriverRunning = false;
// True while `sendTransaction` is executing. Used by `lockWallet` /
// `resetWalletInternals` callers (N-2) to defer the teardown until the send
// finishes, so we never wipe the KeyManager mid-signing (would produce a
// zero-padded ECDSA signature) or null the database between broadcast and
// markUTXOSpent (would broadcast a tx and forget to record the spend → local
// double-spend).
let sendInFlight = false;
/**
 * When `lockWallet` (or any teardown caller) fires while `sendInFlight` is
 * true, we set this flag instead of running the reset, and the send's
 * `finally` runs the deferred reset on its way out. Carries the snapshot of
 * post-lock state to apply to the store.
 */
let pendingLockTeardown: null | (() => void) = null;

/**
 * Bumped by `lockWallet` the instant it fires (before anything else runs —
 * see `lockWallet` below). A queued `initialize()` task captures the value
 * in effect when IT started; if a checkpoint later finds the value has
 * moved, a lock landed while this task was mid-flight (e.g. the user
 * backgrounds the app again during an unlock's `reloadActiveWallet`). The
 * task then abandons its own now-unwanted work via `resetWalletInternals()`
 * instead of resurrecting `database`/`keyManager`/`spvClient`/wallet state
 * out from under the lock — mirrors the generation-counter guard in
 * `SendSheet.tsx`'s `reservationRequestIdRef`, applied to module state
 * instead of component state.
 */
let lockEpoch = 0;

/**
 * Serialises `initialize` / `switchWallet` / `restoreWallet` / `switchNetwork`
 * calls (N-1). Any call enters this single `Promise<void>` queue; the next
 * call awaits the previous one before starting, so we can never have two
 * concurrent inits racing to overwrite `database`, `spvClient`, `keyManager`,
 * `utxoSet`, `networkConfig`, and `peerUpdateInterval` — which would
 * cross-contaminate two wallets at once and leak the loser's SPV client.
 *
 * Re-entrancy guard: a task running inside the queue can call helpers (e.g.
 * `switchWallet` invokes `initialize`) without enqueuing again, otherwise the
 * inner call would await the outer task that is awaiting IT (deadlock).
 */
let walletInitQueue: Promise<void> = Promise.resolve();
let walletInitDepth = 0;
function queueWalletInit(task: () => Promise<void>): Promise<void> {
  if (walletInitDepth > 0) {
    // Re-entrant call from another queued task: run inline so we don't
    // deadlock waiting for the outer task we're already inside.
    walletInitDepth++;
    return task().finally(() => {
      walletInitDepth--;
    });
  }
  const next = walletInitQueue.then(
    async () => {
      walletInitDepth++;
      try {
        await task();
      } finally {
        walletInitDepth--;
      }
    },
    async () => {
      walletInitDepth++;
      try {
        await task();
      } finally {
        walletInitDepth--;
      }
    },
  );
  // Swallow rejections on the queue so a failed init doesn't poison the
  // chain — the caller still receives the rejected promise via `next`.
  walletInitQueue = next.catch(() => undefined);
  return next;
}

/**
 * Outpoints reserved by an in-flight send (review finding M4). Guards concurrent
 * send flows from selecting the same coins and double-spending. See
 * {@link UtxoReservation}.
 */
const utxoReservation = new UtxoReservation();

/**
 * Get the current Database instance. Returns null if the wallet is not initialized.
 * Used by other stores (contacts, tx notes) that need database access.
 */
export function getDatabase(): Database | null {
  return database;
}

/**
 * The account-level watch-only xpub (m/44'/coinType'/0') of the active wallet,
 * or null when no wallet is initialized (e.g. while PIN-locked). Read by the
 * push-registration lifecycle to register for background notifications; it is a
 * PUBLIC key, so this never exposes spend capability. Returns null rather than
 * throwing so callers can treat "no wallet up yet" as "nothing to register".
 */
export function getActiveAccountXpub(): string | null {
  if (!keyManager) return null;
  try {
    return keyManager.accountXpub();
  } catch {
    return null;
  }
}

/**
 * Every address the active wallet watches (external + change + lookahead), or an
 * empty array when no wallet is initialized (e.g. while PIN-locked). Used by the
 * silent-push handler to decide whether a pushed txid actually pays this wallet
 * before composing the on-device notification.
 */
export function getActiveWalletAddresses(): string[] {
  return keyManager?.getAllAddresses() ?? [];
}

/**
 * Every address hash the wallet should watch: the private spending tree PLUS
 * the social-receive branch (spec §4.3). `setBloomFilter` replaces the
 * filter wholesale, so every call site that rebuilds it must include BOTH
 * sets or the other silently drops out of coverage until the next refresh.
 */
function buildCombinedBloomFilterHashes(km: KeyManager): Uint8Array[] {
  return [...km.getAllAddresses(), ...socialReceiveAddressIndex.keys()].map(
    (addr) => decodeAddress(addr).hash,
  );
}

/**
 * Bring up the social-receive branch (spec §4.3) for the identity wallet:
 * derive (or load the persisted) watch window, populate the in-memory index
 * map, publish the stable default address (`addr(0)`) to the store, and
 * resync the window against the backend's reservation cursor.
 *
 * Called from INSIDE `initialize()` itself (gated on `activeId ===
 * OXY_IDENTITY_WALLET_ID` AND the active Pocket being the main one,
 * mirroring the `hasBackedUp` gate right above its call site) — not just
 * once from `initializeFromIdentity` — so every caller that re-runs
 * `initialize()` after `resetWalletInternals()` cleared this module's state
 * (a PIN unlock, a Pocket switch, a wallet switch) reliably re-establishes
 * social-receive watching. It runs BEFORE `initialize()` builds its Bloom
 * filter (which folds in `socialReceiveAddressIndex` via
 * {@link buildCombinedBloomFilterHashes}), so the very first filter a peer
 * ever sees already covers the social branch — no separate post-hoc
 * `setBloomFilter` call needed here.
 */
async function setUpSocialReceive(
  db: Database,
  network: NetworkConfig,
  networkType: NetworkType,
  set: WalletSet,
): Promise<void> {
  const identityPrivateKey = await getIdentityPrivateKeyBytes();
  if (!identityPrivateKey) {
    // Web, or a race where identity was removed between initialize() and
    // here — initializeFromIdentity() already returned "no-identity" in the
    // normal case, so this is a defensive no-op, not the expected path.
    return;
  }
  socialReceiveIdentityPrivateKey = identityPrivateKey;

  let persisted = await db.getSocialReceiveAddresses();
  if (persisted.length === 0) {
    const initial = deriveSocialReceiveWatchWindow(
      identityPrivateKey,
      0,
      SOCIAL_RECEIVE_GAP_LIMIT,
      network,
    );
    await db.insertSocialReceiveAddresses(initial);
    persisted = await db.getSocialReceiveAddresses();
  }

  socialReceiveAddressIndex = new Map(persisted.map((row) => [row.address, row.index_num]));
  const defaultRow = persisted.find((row) => row.index_num === 0);
  set({ socialReceiveDefaultAddress: defaultRow?.address ?? null });

  // Cursor-sync (finding: HIGH). `reserveNextSocialAddress` on the backend
  // advances this user's cursor on EVERY sender's `next_address` call,
  // whether or not the reserved address is ever paid — but this device only
  // widens its own watch window when a payment lands on an index it already
  // watches. A burst of reservations with no payment in between (a payer
  // browsing/re-picking a recipient, or griefing) can therefore outrun the
  // window derived above and leave a later real payment on an unwatched
  // index — silent non-receipt. Resync against the backend's reservation
  // cursor so the device watches every index it has EVER handed out, not
  // just the ones a payment has already landed on.
  const highestUsed = await db.getHighestUsedSocialReceiveIndex();
  let reservedThrough = 0;
  try {
    ({ reservedThrough } = await getSocialReceiveCursor(networkType));
  } catch (error) {
    // Offline / Gateway error: degrade to the local-only window derived
    // above rather than blocking wallet bring-up on a network round-trip.
    // The next successful call to setUpSocialReceive (next unlock/init)
    // retries the resync.
    console.warn(
      "[social-receive] cursor resync failed, using local-only watch window:",
      error,
    );
  }
  // `reservedThrough === 0` is the endpoint's explicit "no cursor exists
  // yet" sentinel (index 0 is the stable default address and is never
  // reserved through the next_address flow — see
  // SocialReceiveCursorResponse), so it must NOT be treated as index 0
  // having been reserved — that would spuriously widen every fresh
  // recipient's window by one address on every call. Feed it into
  // `computeWindowExtension` (which already uses -1 as its "nothing yet"
  // sentinel) as the equivalent "nothing reserved" value.
  const highestReserved = reservedThrough > 0 ? reservedThrough : -1;
  const highestWatched = Math.max(-1, ...socialReceiveAddressIndex.values());
  const cursorExtension = computeWindowExtension(
    highestWatched,
    Math.max(highestUsed, highestReserved),
    SOCIAL_RECEIVE_GAP_LIMIT,
  );
  if (cursorExtension) {
    const fresh = deriveSocialReceiveWatchWindow(
      identityPrivateKey,
      cursorExtension.start,
      cursorExtension.count,
      network,
    );
    await db.insertSocialReceiveAddresses(fresh);
    for (const { index, address } of fresh) {
      socialReceiveAddressIndex.set(address, index);
    }
  }
}

/**
 * Extend the persisted + in-memory social-receive watch window if the
 * highest USED index has moved close enough to its edge (spec §4.3 — mirrors
 * the private tree's `markAddressUsed`-driven lookahead extension). Returns
 * true if new addresses were derived (caller should refresh the Bloom
 * filter), false otherwise.
 */
async function extendSocialReceiveWindowIfNeeded(
  db: Database,
  network: NetworkConfig,
): Promise<boolean> {
  if (!socialReceiveIdentityPrivateKey) {
    return false;
  }
  const highestWatched = Math.max(-1, ...socialReceiveAddressIndex.values());
  const highestUsed = await db.getHighestUsedSocialReceiveIndex();
  const extension = computeWindowExtension(highestWatched, highestUsed, SOCIAL_RECEIVE_GAP_LIMIT);
  if (!extension) {
    return false;
  }
  const fresh = deriveSocialReceiveWatchWindow(
    socialReceiveIdentityPrivateKey,
    extension.start,
    extension.count,
    network,
  );
  await db.insertSocialReceiveAddresses(fresh);
  for (const { index, address } of fresh) {
    socialReceiveAddressIndex.set(address, index);
  }
  return true;
}

/**
 * Resolve the signing private key for `address`: the private spending tree
 * first, then the social-receive branch (spec §4.3) if the address isn't in
 * the tree. Throws if neither knows the address, or if a social address is
 * matched but the on-device identity key is unavailable (should not happen —
 * a social address can only be watched while the identity key was present).
 */
async function getSigningKeyForAddress(
  km: KeyManager,
  address: string,
): Promise<Uint8Array> {
  if (km.ownsAddress(address)) {
    return km.getPrivateKeyForAddress(address);
  }
  const socialIndex = socialReceiveAddressIndex.get(address);
  if (socialIndex !== undefined) {
    const identityPrivateKey =
      socialReceiveIdentityPrivateKey ?? (await getIdentityPrivateKeyBytes());
    if (!identityPrivateKey) {
      throw new Error(
        "Cannot sign for a social-receive address without the on-device identity key",
      );
    }
    return getSocialReceiveSpendingKey(identityPrivateKey, socialIndex);
  }
  throw new Error(`Address not found in key manager: ${address}`);
}

/**
 * Sum the confirmed+unconfirmed unspent value persisted for a Pocket by reading
 * its isolated database directly. Used to show balances for Pockets that are not
 * the active one (their UTXO set is not loaded into memory). Opens read-only and
 * always closes.
 */
async function readPocketUnspentTotal(
  walletId: string,
  account: number,
): Promise<bigint> {
  const db = await Database.open(walletId, account);
  try {
    const rows = await db.getUnspentUTXOs();
    return rows.reduce((sum, row) => sum + BigInt(row.value), 0n);
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// Incoming transaction processing (SPV receive path)
// ---------------------------------------------------------------------------

type WalletSet = StoreApi<WalletState>["setState"];
type WalletGet = StoreApi<WalletState>["getState"];

/**
 * Push the current in-memory balance and transaction list into the store and
 * persist nothing (callers are responsible for DB writes). Centralises the
 * derived-state update so every receive/spend path stays consistent.
 */
function publishBalance(set: WalletSet): void {
  if (!utxoSet) {
    return;
  }
  set({
    balance: utxoSet.getBalance(),
    confirmedBalance: utxoSet.getConfirmedBalance(),
    unconfirmedBalance: utxoSet.getUnconfirmedBalance(),
  });
}

/**
 * Merge a transaction into the in-memory `transactions` list, replacing any
 * existing entry with the same txid (so a mempool receive is upgraded in place
 * once it confirms, rather than duplicated).
 */
function upsertWalletTransaction(set: WalletSet, tx: WalletTransaction): void {
  set((state) => {
    const filtered = state.transactions.filter((t) => t.txid !== tx.txid);
    return { transactions: [tx, ...filtered] };
  });
}

/**
 * Resolve the block height and confirmation count for a transaction given the
 * hash of the block that contains it. `blockHash` is in the header store's
 * internal byte order (as produced by the SPV client). Returns height -1 and
 * zero confirmations for unconfirmed (mempool) transactions.
 */
async function resolveConfirmation(
  blockHash: Uint8Array | undefined,
  chainTip: number,
): Promise<{ blockHeight: number; blockHash: string; confirmations: number }> {
  if (!blockHash || !database) {
    return { blockHeight: -1, blockHash: "", confirmations: 0 };
  }

  const blockHashHex = bytesToHex(blockHash);
  const header = await database.getHeaderByHash(blockHashHex);
  if (!header) {
    // The containing block header has not been stored yet (the tx arrived
    // ahead of its merkle block during sync). Treat as unconfirmed for now;
    // `reconcileConfirmations` will upgrade it once the header lands.
    return { blockHeight: -1, blockHash: blockHashHex, confirmations: 0 };
  }

  const tip = chainTip > 0 ? chainTip : header.height;
  const confirmations = Math.max(0, tip - header.height + 1);
  return { blockHeight: header.height, blockHash: blockHashHex, confirmations };
}

/**
 * Process a transaction delivered by the SPV client.
 *
 * Credits every output that pays one of our addresses (adding a UTXO and
 * recording a "receive"), and debits every input that spends one of our
 * existing UTXOs (marking it spent and recording a "send"). All changes are
 * mirrored to SQLite so balances and history survive an app restart.
 *
 * Idempotent: replaying the same transaction (e.g. on reconnect, or when the
 * same tx arrives loose and again inside a merkle block) does not double-count.
 */
async function processIncomingTransaction(
  tx: ParsedTransaction,
  txid: string,
  blockHash: Uint8Array | undefined,
  set: WalletSet,
  get: WalletGet,
): Promise<void> {
  if (!keyManager || !utxoSet || !database || !networkConfig) {
    return;
  }

  const chainTip = get().chainHeight;
  const confirmation = await resolveConfirmation(blockHash, chainTip);
  const confirmed = confirmation.blockHeight >= 0;
  const now = Math.floor(Date.now() / 1000);

  // Apply the receive/spend logic against the in-memory UTXO set. This is the
  // single source of truth for "which outputs are ours / which inputs spend
  // ours" — shared with the unit tests so the tested path is the real path.
  const result = applyTransactionToWallet(
    utxoSet,
    tx,
    txid,
    (address) =>
      (keyManager?.ownsAddress(address) ?? false) || socialReceiveAddressIndex.has(address),
    networkConfig,
    confirmation,
  );

  if (!result.changed) {
    // Bloom-filter false positive: the tx matched the filter but touches none
    // of our outputs or UTXOs. Nothing to record.
    return;
  }

  // ---- Mirror credited outputs to SQLite ---------------------------------
  for (const { utxo } of result.credited) {
    await database.insertUTXO({
      txid: utxo.txid,
      vout: utxo.vout,
      address: utxo.address,
      value: utxo.value,
      script_pub_key: bytesToHex(utxo.scriptPubKey),
      spent: 0,
      block_height: utxo.blockHeight,
    });
  }

  // Mark matched receive addresses as used and extend the derivation /
  // Bloom-filter window so payments to higher-index addresses still arrive.
  let bloomNeedsRefresh = false;
  for (const address of result.receiveAddresses) {
    await database.markAddressUsed(address);
    if (keyManager.markAddressUsed(address)) {
      bloomNeedsRefresh = true;
    }
    if (socialReceiveAddressIndex.has(address)) {
      await database.markSocialReceiveAddressUsed(address);
      if (await extendSocialReceiveWindowIfNeeded(database, networkConfig)) {
        bloomNeedsRefresh = true;
      }
    }
  }

  // ---- Mirror spent inputs to SQLite -------------------------------------
  // Record which tx spent the UTXO and at what height so a reorg can un-spend
  // it precisely if the spending block is later orphaned.
  for (const debit of result.debited) {
    await database.markUTXOSpent(
      debit.txid,
      debit.vout,
      txid,
      confirmation.blockHeight,
    );
  }

  // H-4: when our OWN outgoing transaction confirms, the inputs it claims to
  // spend were already removed from the in-memory UTXO set at broadcast time
  // (with spent_height = -1). They will NOT appear in `result.debited`, so the
  // loop above would never update their spent_height — leaving them at -1 and
  // making a future reorg unable to restore them (the rewind query keys off
  // `spent_height > forkHeight`).
  //
  // Walk every raw input of this transaction and, if the persisted row is
  // present and already marked spent at -1 (i.e. ours, broadcast before this
  // confirmation), promote its `spent_height` to the real block height. This
  // is a no-op for received transactions (none of those rows exist locally)
  // and for already-confirmed spends (spent_height > -1).
  if (confirmation.blockHeight >= 0) {
    for (const input of tx.inputs) {
      const prevTxid = reverseBytesToHex(input.prevTxHash);
      try {
        await database.updateUTXOSpentHeight(
          prevTxid,
          input.prevTxIndex,
          confirmation.blockHeight,
        );
      } catch {
        // Best-effort: a missing row here is normal for inputs we never owned.
      }
    }
  }

  // ---- Persist the transaction row and update derived state --------------
  await database.insertTransaction({
    txid,
    raw_hex: bytesToHex(tx.raw),
    block_height: confirmation.blockHeight,
    block_hash: confirmation.blockHash,
    timestamp: now,
    fee: 0,
    confirmed: confirmed ? 1 : 0,
  });

  // Net effect on this wallet: received outputs minus our spent inputs.
  // A pure receive is positive; spending our own coins (with change back to
  // us) nets negative by the amount that left the wallet.
  const net = result.receivedTotal - result.spentTotal;
  if (net !== 0n) {
    const spentAddress = result.debited[0]?.address ?? "";
    upsertWalletTransaction(set, {
      txid,
      amount: net,
      address: net > 0n ? (result.receiveAddresses[0] ?? "") : spentAddress,
      timestamp: now,
      confirmations: confirmation.confirmations,
      type: net > 0n ? "receive" : "send",
    });
  }

  publishBalance(set);

  if (bloomNeedsRefresh && spvClient && keyManager) {
    spvClient.setBloomFilter(buildCombinedBloomFilterHashes(keyManager));
  }
}

/**
 * Replace the in-memory UTXO set with the unspent UTXOs currently in SQLite.
 * Used at init, and after a reorg rewind, to keep the in-memory set the single
 * source of truth for balance in lock-step with the persisted state.
 */
async function reloadUtxoSetFromDatabase(): Promise<void> {
  if (!utxoSet || !database) {
    return;
  }
  const fresh = new UTXOSet();
  const dbUtxos = await database.getUnspentUTXOs();
  for (const row of dbUtxos) {
    fresh.add({
      txid: row.txid,
      vout: row.vout,
      address: row.address,
      value: BigInt(row.value),
      scriptPubKey: hexToBytes(row.script_pub_key),
      blockHeight: row.block_height,
      confirmed: row.block_height >= 0,
    });
  }
  utxoSet = fresh;
}

/**
 * Roll the wallet back to `forkHeight` after the SPV client detects that a
 * longer chain has orphaned the blocks above it. The database rewind deletes
 * UTXOs created in orphaned blocks and restores UTXOs spent by orphaned
 * transactions; we then rebuild the in-memory set and balance from the
 * post-rewind database so nothing reflects the discarded chain.
 */
async function rewindWalletToHeight(
  forkHeight: number,
  set: WalletSet,
): Promise<void> {
  if (!database || !utxoSet) {
    return;
  }
  // The DB rewind prunes UTXOs and the `transactions` rows for orphaned blocks.
  await database.rewindToHeight(forkHeight);
  await reloadUtxoSetFromDatabase();

  // Reconcile the displayed transaction list with what survived in the
  // database: any tx whose row was pruned (confirmed only in an orphaned block)
  // is dropped. Unconfirmed sends/receives (still present in the DB) are kept
  // and will re-confirm via the receive path once the new chain includes them.
  const surviving = new Set<string>();
  for (const row of await database.getTransactions(10_000, 0)) {
    surviving.add(row.txid);
  }
  set((state) => ({
    transactions: state.transactions.filter((t) => surviving.has(t.txid)),
    chainHeight: forkHeight,
  }));
  publishBalance(set);
}

/**
 * Drive a historical rescan (SPV_AUDIT.md §6.3): find and credit transactions
 * that confirmed BEFORE the Bloom filter loaded (e.g. funds already sitting at
 * one of the wallet's addresses on a restored wallet).
 *
 * Reads persisted progress, plans the scan with {@link planRescan} (resuming an
 * incomplete scan or catching up newly-synced blocks), and asks the SPV client
 * to re-request each block as a filtered merkle block. Discovered matches flow
 * through the same idempotent `onTransaction` receive path, so nothing is
 * double-counted. Progress is persisted after every window for resumability.
 *
 * Best-effort and re-entrancy-guarded: the periodic trigger calls this whenever
 * headers advance, but only one scan runs at a time.
 */
async function runHistoricalRescan(set: WalletSet, get: WalletGet): Promise<void> {
  if (rescanDriverRunning || !database || !spvClient) {
    return;
  }
  // A rescan only makes sense once we have some chain and at least one peer to
  // serve the merkle blocks.
  const chainTip = get().chainHeight;
  if (chainTip <= 0) {
    return;
  }
  if (spvClient.getPeerManager().getReadyPeers().length === 0) {
    return;
  }

  const persistedRow = await database.getRescanState();
  const persisted: RescanProgress | null = persistedRow
    ? {
        startHeight: persistedRow.start_height,
        nextHeight: persistedRow.next_height,
        targetHeight: persistedRow.target_height,
        completed: persistedRow.completed === 1,
      }
    : null;

  // N-14: use the persisted wallet birthday (chain height at creation) so
  // newly-created wallets skip the genesis–to-birthday range. Restored
  // wallets and legacy wallets without a recorded birthday fall back to 0
  // (full rescan from genesis) — a safe default even if slower.
  const activeWalletId = get().activeWalletId;
  let birthday = 0;
  if (activeWalletId) {
    try {
      birthday = await getWalletBirthdayHeight(activeWalletId);
    } catch {
      // best-effort — missing birthday just means genesis scan.
    }
  }
  const plan = planRescan(persisted, birthday, chainTip);
  if (!plan) {
    return;
  }

  rescanDriverRunning = true;
  try {
    await spvClient.rescan({
      fromHeight: plan.startHeight,
      toHeight: plan.targetHeight,
      resumeFrom: plan.resumeFrom,
      onProgress: async (progress) => {
        if (!database) {
          return;
        }
        await database.saveRescanState({
          start_height: progress.startHeight,
          next_height: progress.nextHeight,
          target_height: progress.targetHeight,
          completed: progress.completed ? 1 : 0,
        });
      },
    });
  } finally {
    rescanDriverRunning = false;
  }
}

/**
 * Re-derive confirmation counts for stored UTXOs and transactions when the
 * chain tip advances. Promotes any UTXO whose containing block is now known
 * from unconfirmed to confirmed, and refreshes the displayed balance.
 */
async function reconcileConfirmations(
  set: WalletSet,
  get: WalletGet,
): Promise<void> {
  if (!utxoSet || !database) {
    return;
  }

  const tip = get().chainHeight;
  if (tip <= 0) {
    return;
  }

  let changed = false;

  // H-3: a UTXO can be stored with block_height = -1 when its transaction
  // arrived ahead of its merkle block during sync (the header was not yet in
  // the DB at receive time). Once the header lands, look up the real height
  // by the tx's recorded block_hash and promote both the in-memory set and
  // the persisted row. Without this, such UTXOs stay "unconfirmed" forever.
  try {
    const pendingUtxos = await database.getPendingHeightUTXOs();
    for (const pending of pendingUtxos) {
      const header = await database.getHeaderByHash(pending.block_hash);
      if (!header) continue;
      await database.updateUTXOBlockHeight(
        pending.txid,
        pending.vout,
        header.height,
      );
      const inMemory = utxoSet.get(pending.txid, pending.vout);
      if (inMemory) {
        utxoSet.add({
          ...inMemory,
          blockHeight: header.height,
          confirmed: header.height <= tip,
        });
        changed = true;
      }
    }

    // Same pattern for the history rows (Tx list).
    const pendingTxs = await database.getPendingHeightTransactions();
    for (const pending of pendingTxs) {
      const header = await database.getHeaderByHash(pending.block_hash);
      if (!header) continue;
      const confirmed = header.height <= tip ? 1 : 0;
      await database.updateTransactionConfirmation(
        pending.txid,
        header.height,
        pending.block_hash,
        confirmed,
      );
    }
  } catch {
    // Best-effort reconciliation; never let a DB hiccup stall sync.
  }

  for (const utxo of utxoSet.getAllUTXOs()) {
    if (utxo.confirmed || utxo.blockHeight < 0) {
      continue;
    }
    // A previously-unconfirmed UTXO now sits at or below the tip: confirm it.
    if (utxo.blockHeight <= tip) {
      utxoSet.add({ ...utxo, confirmed: true });
      changed = true;
    }
  }

  if (changed) {
    publishBalance(set);
  }
}

// ---------------------------------------------------------------------------
// Fee estimation constants (satoshis per byte)
// ---------------------------------------------------------------------------

/**
 * Per-byte fee rate (base units/byte) for each user-selectable fee level.
 * Exported so the Send screen renders the SAME number it would actually
 * pass to {@link sendTransaction}, instead of duplicating the values
 * inline and risking drift between display and on-chain fee.
 */
export const FEE_RATES: Record<FeeLevel, number> = {
  low: 1,
  medium: 5,
  high: 10,
};

// Average P2PKH transaction ~226 bytes
const AVERAGE_TX_SIZE = 226;

/**
 * Upper bound on `transactions` rows reconstructed into the display history at
 * init. The home Activity feed shows the 10 most recent and HomeOverview sums
 * every reward row, so we load the full history (newest-first) rather than a
 * page. Matches the bound `rewindWalletToHeight` uses when reconciling history.
 */
const MAX_HISTORY_ROWS = 10_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Reset all in-memory wallet state to defaults. */
function resetWalletInternals(): void {
  if (peerUpdateInterval) {
    clearInterval(peerUpdateInterval);
    peerUpdateInterval = null;
  }
  if (spvClient) {
    spvClient.stop();
    spvClient = null;
  }
  // Zeroize cached private keys before dropping the reference so key material
  // never lingers in the heap after a lock/reset/switch (review finding M1).
  if (keyManager) {
    keyManager.wipe();
  }
  keyManager = null;
  socialReceiveIdentityPrivateKey = null;
  socialReceiveAddressIndex = new Map();
  utxoSet = null;
  database = null;
  networkConfig = null;
  rescanDriverRunning = false;
  utxoReservation.clear();
  // N-11: clear the per-wallet contact cache so we don't leak names /
  // addresses from wallet A into wallet B's contact picker.
  try {
    useContactsStore.getState().reset();
  } catch {
    // best-effort; store may not be initialised yet during early boot.
  }
}

const DEFAULT_WALLET_STATE = {
  initialized: false,
  loading: false,
  error: null,
  balance: 0n,
  confirmedBalance: 0n,
  unconfirmedBalance: 0n,
  syncProgress: 0,
  chainHeight: 0,
  connectedPeers: 0,
  isSyncing: false,
  networkStatus: "Offline",
  networkStatusKey: "wallet.network.offline" as NetworkStatusKey,
  networkStatusData: undefined as Record<string, string | number> | undefined,
  currentReceiveAddress: "",
  addresses: [] as string[],
  transactions: [] as WalletTransaction[],
  masternodeUTXOs: [] as MasternodeUTXO[],
  isWatchOnly: false,
  hasBackedUp: false,
  socialReceiveDefaultAddress: null as string | null,
  activeAccount: 0,
  pockets: [] as PocketInfo[],
  pocketBalances: {} as Record<number, bigint>,
  selectedUTXOs: [] as { txid: string; vout: number }[],
} as const;

/**
 * Default English fallback text for each P2P status key. Lives in the store
 * (alongside the key) so any non-UI consumer that reads `networkStatus` still
 * gets a sensible string; the UI should translate via `networkStatusKey`.
 */
const NETWORK_STATUS_FALLBACK: Record<NetworkStatusKey, string> = {
  "wallet.network.offline": "Offline",
  "wallet.network.resolvingDns": "Resolving DNS seeds...",
  "wallet.network.connecting": "Connecting to peers...",
  "wallet.network.waitingForPeers": "Waiting for peers...",
  "wallet.network.searchingForPeers": "Searching for peers...",
  "wallet.network.connectedSingular": "Connected to 1 peer",
  "wallet.network.connectedPlural": "Connected to {count} peers",
  "wallet.network.error": "P2P error: {message}",
};

/**
 * Format the fallback string by interpolating `{name}` placeholders. The UI
 * uses the proper i18n module on `networkStatusKey`; this is only used by the
 * back-compat `networkStatus` string.
 */
function formatNetworkStatusFallback(
  key: NetworkStatusKey,
  data?: Record<string, string | number>,
): string {
  let out = NETWORK_STATUS_FALLBACK[key];
  if (data) {
    for (const [name, value] of Object.entries(data)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}

/**
 * Write a P2P status update to the store. Always populates both the i18n key
 * and the back-compat `networkStatus` string in one `set` so consumers can't
 * observe an inconsistent pair (U-2).
 */
function setNetworkStatus(
  set: WalletSet,
  key: NetworkStatusKey,
  data?: Record<string, string | number>,
): void {
  set({
    networkStatus: formatNetworkStatusFallback(key, data),
    networkStatusKey: key,
    networkStatusData: data,
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWalletStore = create<WalletState>((set, get) => ({
  // Initial state
  initialized: false,
  loading: false,
  error: null,
  network: "mainnet",

  // Multi-wallet initial state
  activeWalletId: null,
  activeWalletName: "",
  wallets: [],
  isWatchOnly: false,
  hasBackedUp: false,
  socialReceiveDefaultAddress: null,
  activeAccount: 0,
  pockets: [],
  pocketBalances: {},

  balance: 0n,
  confirmedBalance: 0n,
  unconfirmedBalance: 0n,

  syncProgress: 0,
  chainHeight: 0,
  connectedPeers: 0,
  isSyncing: false,
  networkStatus: NETWORK_STATUS_FALLBACK["wallet.network.offline"],
  networkStatusKey: "wallet.network.offline" as NetworkStatusKey,
  networkStatusData: undefined,

  currentReceiveAddress: "",
  addresses: [],

  transactions: [],

  masternodeUTXOs: [],

  selectedUTXOs: [],

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

  initialize: async (
    mnemonic: string,
    walletId?: string,
    onReady?: () => void,
    account?: number,
  ): Promise<void> => {
    // N-1: serialise wallet initialisation. If two callers race (deep-link +
    // boot, double-tap wallet switch, restore + network switch, …) we must
    // not run two `initialize` bodies in parallel — they would both observe
    // `initialized === false` (cleared between each `await`), both open a
    // Database, both spawn an SPVClient, both setInterval, all racing to
    // overwrite the same module-level globals. The losing client would never
    // be stopped (open socket leak) and its callbacks would write rows into
    // the winning wallet's DB (cross-contamination).
    return queueWalletInit(async () => {
      // Lock-race guard (see `lockEpoch`): captured before the first await
      // below, so every checkpoint compares against the epoch that was
      // current when THIS task started.
      const myEpoch = lockEpoch;
      const state = get();
      if (state.initialized) {
        // Already up (e.g. a concurrent caller won the race). Signal the
        // UI-ready checkpoint immediately so a boot/unlock caller renders /
        // lifts the lock instead of waiting on a no-op.
        onReady?.();
        return;
      }

      set({ loading: true, error: null });

      try {
      networkConfig = getNetwork(state.network);

      // Resolve the wallet + active Pocket once, up front. When `account` is
      // omitted (boot / unlock / wallet switch) restore the persisted active
      // Pocket; explicit callers (switchPocket) pass it. Account 0 keeps the
      // legacy DB file, so pre-Pockets wallets open exactly where they always did.
      const activeId = walletId ?? (await getActiveWalletId());
      const resolvedAccount =
        account ?? (activeId ? await getActivePocket(activeId) : 0);

      database = await Database.open(activeId ?? undefined, resolvedAccount);
      if (myEpoch !== lockEpoch) {
        // Locked while we were opening the database: abandon this task
        // rather than build wallet state on top of a wallet the user just
        // locked. `resetWalletInternals` tears down exactly what we've
        // assigned so far (this database handle) and is a no-op for
        // anything we haven't reached yet.
        resetWalletInternals();
        return;
      }
      // A wallet's stored secret is either a BIP39 mnemonic or the watch-only
      // marker `xpub:<extended public key>`. The marker MUST route to the
      // public-only KeyManager: feeding it into mnemonicToSeedSync would
      // silently derive a random spendable keypair (BIP39 doesn't validate),
      // producing a dangerous fake wallet (review finding C2). Watch-only
      // wallets have no Pockets, so they always open at account 0.
      if (mnemonic.startsWith(SEED_SECRET_PREFIX)) {
        // Identity-derived wallet: the "secret" carries the 32-byte HKDF seed
        // directly (never persisted, re-derived from the Oxy identity each
        // boot). Build straight from the seed — no BIP39 detour. Still
        // account-aware so the identity wallet supports Pockets like any
        // other wallet.
        const seed = hexToBytes(mnemonic.slice(SEED_SECRET_PREFIX.length));
        keyManager = KeyManager.fromSeed(seed, networkConfig, resolvedAccount);
      } else if (mnemonic.startsWith(XPUB_MARKER_PREFIX)) {
        const xpub = mnemonic.slice(XPUB_MARKER_PREFIX.length);
        keyManager = KeyManager.fromXpub(xpub, networkConfig);
      } else {
        // Reuse the cached BIP39 seed when present so unlock skips the
        // multi-second PBKDF2 mnemonic→seed derivation; derive + cache it on the
        // first run. The seed is shared by every Pocket of this wallet, so it is
        // keyed by the wallet identity, and the account selects the subtree.
        const seedCacheId = activeId ?? "default";
        const seed = await getOrDeriveBip39Seed(seedCacheId, mnemonic, walletSeedDeps);
        keyManager = KeyManager.fromSeed(seed, networkConfig, resolvedAccount);
      }
      if (myEpoch !== lockEpoch) {
        // Locked while we were deriving keys (the BIP39 branch awaits a
        // PBKDF2 derivation above). Wipe/close what this task built instead
        // of leaving key material or a database handle dangling in module
        // scope behind the lock screen.
        resetWalletInternals();
        return;
      }
      utxoSet = new UTXOSet();

      // Load persisted UTXOs from database. A UTXO is confirmed iff it was
      // stored with a real block height (>= 0); mempool receives are stored
      // with height -1 and remain unconfirmed until their block is seen.
      await reloadUtxoSetFromDatabase();

      // Restore the BIP44 derivation cursors from persisted state so used
      // addresses are never re-issued across restarts and the lookahead window
      // (hence the Bloom filter) keeps watching the right addresses
      // (SPV_AUDIT.md §4.5). KeyManager.fromMnemonic resets the cursors to 0.
      const nextExternal = await database.getNextUnusedIndex(false);
      const nextChange = await database.getNextUnusedIndex(true);
      keyManager.restoreCursors(nextExternal, nextChange);

      // Load persisted addresses from database
      const dbAddresses = await database.getAddresses();
      const addressList = dbAddresses.map((a) => a.address);

      // Get receive address
      const unused = await database.getUnusedAddress(false);
      let receiveAddress: string;
      if (unused) {
        receiveAddress = unused.address;
      } else {
        const derived = keyManager.getNextAddress();
        await database.insertAddress(
          derived.address,
          derived.path,
          derived.index,
          false,
        );
        receiveAddress = derived.address;
        addressList.push(derived.address);
      }

      // Load wallet info. `activeId` was already resolved above (alongside
      // the active Pocket) so the DB-open path and this lookup agree.
      const wallets = await getWalletIndex();
      const activeWallet = activeId
        ? wallets.find((w) => w.id === activeId)
        : undefined;

      // Check if this is a watch-only wallet
      const watchOnly = activeId ? await checkIsWatchOnly(activeId) : false;
      // Has the user backed up this wallet's recovery phrase? Drives the home
      // "back up your wallet" reminder. Watch-only wallets have no phrase to
      // back up, so they never prompt.
      const backedUp =
        activeId === OXY_IDENTITY_WALLET_ID
          ? true
          : activeId && !watchOnly
            ? await isWalletBackedUp(activeId)
            : true;

      // Bring up the social-receive branch (spec §4.3) for the identity
      // wallet's MAIN Pocket only (account 0) on EVERY initialize() call, not
      // just the first boot — a PIN unlock, a Pocket switch, or a wallet
      // switch all tear this module's state down via `resetWalletInternals`
      // and re-run `initialize()` directly, bypassing `initializeFromIdentity`.
      // Runs before the Bloom filter is built below so the first filter a peer
      // sees already covers the social branch. Gating on `resolvedAccount ===
      // 0` (finding: MEDIUM/LOW) keeps the social-receive window a single set
      // of addresses established once, on the main Pocket, instead of
      // re-deriving and persisting the SAME window redundantly into every
      // other Pocket's own (otherwise-unrelated) DB file. Non-identity
      // wallets and non-main Pockets skip it; `resetWalletInternals` already
      // cleared `socialReceiveIdentityPrivateKey` / `socialReceiveAddressIndex`
      // to their empty defaults for them.
      if (activeId === OXY_IDENTITY_WALLET_ID && resolvedAccount === MAIN_POCKET_ACCOUNT) {
        await setUpSocialReceive(database, networkConfig, state.network, set);
      }

      // Reconstruct the persisted transaction history into the display list.
      // The `transactions` table stores raw_hex + block metadata but not the
      // derived amount/address/type, so re-derive them the SAME way the SPV
      // receive path does. Without this, a wallet that received (or sent) FAIR
      // in a previous session shows an empty Activity list after unlock even
      // though the balance — restored from the persisted UTXOs above — is
      // correct. Spent inputs are priced from the full UTXO set (spent rows
      // survive with their value/address); confirmations use the persisted tip.
      const historyRows = await database.getTransactions(MAX_HISTORY_ROWS, 0);
      const prevoutByOutpoint = new Map<
        string,
        { value: bigint; address: string }
      >();
      for (const row of await database.getAllUTXOs()) {
        prevoutByOutpoint.set(`${row.txid}:${row.vout}`, {
          value: BigInt(row.value),
          address: row.address,
        });
      }
      const persistedTip = (await database.getLatestHeader())?.height ?? 0;
      const restoredTransactions: WalletTransaction[] = [];
      for (const row of historyRows) {
        const reconstructed = reconstructWalletTransaction(
          row,
          (address) => keyManager?.ownsAddress(address) ?? false,
          (prevTxid, vout) => prevoutByOutpoint.get(`${prevTxid}:${vout}`),
          networkConfig,
          persistedTip,
        );
        if (reconstructed) {
          restoredTransactions.push(reconstructed);
        }
      }

      if (myEpoch !== lockEpoch) {
        // Locked while we were hydrating from disk (persisted UTXOs,
        // addresses, social-receive window, transaction history — all pure
        // reads/derivations up to this point). This is the mandatory gate:
        // never publish `initialized: true` or fire `onReady` (which would
        // lift the lock screen) for a task that started before the lock.
        // There is no `await` between this check and the SPV start-up block
        // below, so passing here also guarantees we won't create a live
        // SPVClient / peer-update interval behind a locked screen.
        resetWalletInternals();
        return;
      }
      set({
        initialized: true,
        loading: false,
        currentReceiveAddress: receiveAddress,
        addresses: addressList,
        balance: utxoSet.getBalance(),
        confirmedBalance: utxoSet.getConfirmedBalance(),
        unconfirmedBalance: utxoSet.getUnconfirmedBalance(),
        transactions: restoredTransactions,
        activeWalletId: activeId,
        activeWalletName: activeWallet?.name ?? "",
        hasBackedUp: backedUp,
        wallets,
        isWatchOnly: watchOnly,
        activeAccount: resolvedAccount,
      });

      // The wallet is now fully hydrated from persisted SQLite state (cached
      // balance, UTXOs, addresses, transaction history) with NO network access.
      // Signal the UI-ready checkpoint HERE so the home renders / the lock
      // lifts immediately — BEFORE the SPV/P2P startup below. That startup
      // resolves DNS, connects to peers and syncs headers in the background,
      // streaming live updates into the store (isSyncing / connectedPeers /
      // chainHeight / balance) via the existing setters. This is what decouples
      // "wallet usable" from "fully synced" without changing what sync computes.
      // It stays INSIDE the serialised init task (N-1): the returned promise
      // still only resolves after SPV startup, so switch/network/create/import
      // callers that await it keep their exclusive critical section.
      onReady?.();

      // Start SPV client for P2P connectivity
      try {
        setNetworkStatus(set, "wallet.network.resolvingDns");
        const socketProvider = createSocketProvider();
        const headerStore = new DatabaseHeaderStore(database);

        // N-5: load the persisted peer cache so the first connection round
        // doesn't wait on DNS resolution. This also honours user-added peers
        // from the "Add Peer" screen, which were previously written to DB
        // but never read by the peer manager.
        let initialPeers: string[] = [];
        try {
          const peerRows = await database.getKnownPeers(50);
          initialPeers = peerRows.map((row) => row.host);
        } catch {
          // best-effort; DNS seeds are the fallback.
        }

        spvClient = new SPVClient({
          network: networkConfig,
          socketProvider,
          headerStore,
          initialKnownAddresses: initialPeers,
        });

        spvClient.setEvents({
          onTransaction: (tx, txid, blockHash) => {
            // A peer delivered a transaction matching our Bloom filter.
            // Process it: credit received outputs, debit spent inputs, and
            // persist everything so balances survive restarts. The SPV client
            // calls this synchronously, so fire the async processor and route
            // any failure into the store's error state (never swallow it).
            void processIncomingTransaction(tx, txid, blockHash, set, get).catch(
              (err: unknown) => {
                const message =
                  err instanceof Error ? err.message : "Unknown error";
                set({ error: `Failed to process transaction: ${message}` });
              },
            );
          },
          onBlockHeader: (header) => {
            set({ chainHeight: header.height });
            // A new tip means previously-received UTXOs gained a confirmation.
            void reconcileConfirmations(set, get).catch(() => {
              // Confirmation reconciliation is best-effort; a transient failure
              // here is retried on the next block. Do not surface it as a
              // wallet error or interrupt sync.
            });
          },
          onReorg: async (forkHeight) => {
            // A longer chain orphaned the blocks above forkHeight. Roll the
            // wallet (UTXO set, balance, tx list) back so it never spends or
            // displays outputs that no longer exist on the winning chain. This
            // runs before the SPV client stores the new branch.
            await rewindWalletToHeight(forkHeight, set);
          },
          onSyncProgress: (progress) => {
            set({
              syncProgress: Math.round(progress * 100),
              isSyncing: progress < 1,
            });
            // Once headers are (nearly) caught up, kick the historical rescan
            // so funds received before the filter loaded are discovered. The
            // driver is guarded and resumable, so calling it repeatedly is safe.
            if (progress >= 1) {
              void runHistoricalRescan(set, get).catch(() => {
                // Rescan is best-effort; failures are retried on the next tip
                // advance and do not surface as wallet errors.
              });
            }
          },
        });

        // Load Bloom filter with all wallet addresses. `setUpSocialReceive`
        // above (identity wallets only) has already populated
        // `socialReceiveAddressIndex` by this point, so the combined helper
        // folds the social branch into the FIRST filter a peer ever sees —
        // no separate post-hoc refresh needed.
        if (keyManager) {
          spvClient.setBloomFilter(buildCombinedBloomFilterHashes(keyManager));
        }

        setNetworkStatus(set, "wallet.network.connecting");
        await spvClient.start();

        set({ chainHeight: spvClient.getChainHeight() });
        setNetworkStatus(set, "wallet.network.waitingForPeers");

        // Periodic peer count updater. Persist the handle at module scope so
        // `resetWalletInternals` (lock / switch wallet / change network) can
        // unconditionally clear it; otherwise a stale interval keeps writing
        // peer-count and triggering rescans on top of the new wallet (C-1).
        if (peerUpdateInterval) {
          clearInterval(peerUpdateInterval);
          peerUpdateInterval = null;
        }
        peerUpdateInterval = setInterval(() => {
          if (!spvClient) {
            if (peerUpdateInterval) {
              clearInterval(peerUpdateInterval);
              peerUpdateInterval = null;
            }
            return;
          }
          const count = spvClient.getPeerManager().getReadyPeers().length;
          set({ connectedPeers: count });
          if (count === 0) {
            setNetworkStatus(set, "wallet.network.searchingForPeers");
          } else if (count === 1) {
            setNetworkStatus(set, "wallet.network.connectedSingular");
          } else {
            setNetworkStatus(set, "wallet.network.connectedPlural", {
              count,
            });
          }

          // Drive the historical rescan once peers and a chain exist. This
          // covers the already-synced case (a restored wallet whose headers are
          // current so `onSyncProgress` never fires). Guarded + resumable, so
          // the repeated call is a cheap no-op while a scan is in flight or done.
          if (count > 0) {
            void runHistoricalRescan(set, get).catch(() => {
              // Best-effort; retried on the next interval tick.
            });
          }
        }, 5000);
      } catch (spvError: unknown) {
        const spvMsg =
          spvError instanceof Error ? spvError.message : "Unknown P2P error";
        setNetworkStatus(set, "wallet.network.error", { message: spvMsg });
      }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Unknown initialization error";
        set({ loading: false, error: message });
      }
    });
  },

  initializeFromIdentity: async (onReady?: () => void): Promise<IdentityInitResult> => {
    // The IDENTITY-derived wallet needs the on-device keystore the identity key
    // lives in (`@oxyhq/core` keyManager -> expo-secure-store). `Platform.OS`
    // is the current proxy for "is that keystore here": a browser has none.
    //
    // This is narrower than "the wallet does not work on web". The BIP39 and
    // watch-only paths below (`createNewWallet`, `importWallet`,
    // `importWatchOnly`) carry no platform gate and write through
    // `storage/kv-store.ts`, which has a real web branch — Peable's fork of
    // FAIRWallet deleted the create/restore SCREENS, not the capability. What a
    // browser genuinely cannot do is derive THIS seed, and therefore sign.
    if (Platform.OS === "web") {
      return "no-keystore";
    }
    const seed = await deriveIdentitySeed();
    if (!seed) {
      return "no-identity";
    }
    // `initialize()` itself brings up social receive (gated on
    // `activeId === OXY_IDENTITY_WALLET_ID`, which is always true here) —
    // no separate step needed.
    await get().initialize(buildSeedSecret(seed), OXY_IDENTITY_WALLET_ID, onReady);
    return "initialized";
  },

  reloadActiveWallet: async (onReady?: () => void): Promise<void> => {
    try {
      const activeId = get().activeWalletId ?? (await getActiveWalletId());
      if (!activeId) {
        onReady?.();
        return;
      }
      // Watch-only wallets carry an `xpub:` marker, not a spending seed, so
      // they route through `getWalletMnemonic` directly (same as
      // `switchNetwork`'s watch-only branch) rather than `resolveWalletSeed`,
      // which throws for them by design.
      if (await checkIsWatchOnly(activeId)) {
        const marker = await getWalletMnemonic(activeId);
        if (!marker) {
          throw new Error("Wallet xpub not found");
        }
        await get().initialize(marker, activeId, onReady);
        return;
      }
      // Identity-wallet-aware, mirroring switchPocket/switchNetwork: the
      // identity wallet's seed is re-derived from the Oxy identity (never
      // persisted) and can't be fetched via `getWalletMnemonic` like a BIP39
      // wallet's, so route through `resolveWalletSeed` instead of assuming a
      // stored mnemonic exists.
      const seed = await resolveWalletSeed(activeId, walletSeedDeps);
      await get().initialize(buildSeedSecret(seed), activeId, onReady);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to reload wallet";
      set({ loading: false, error: message });
    }
  },

  createWallet: async (): Promise<string> => {
    set({ loading: true, error: null });

    try {
      const mnemonic = await get().createNewWallet("Wallet 1");
      return mnemonic;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to create wallet";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  restoreWallet: async (mnemonic: string): Promise<void> => {
    // N-1: serialise restore so a concurrent boot / switch can't interleave.
    return queueWalletInit(async () => {
      set({ loading: true, error: null });

      try {
        const trimmed = mnemonic.trim().toLowerCase();
        if (!validateMnemonic(trimmed)) {
          throw new Error("Invalid mnemonic phrase");
        }

        const walletId = generateWalletId();
        const wallets = await getWalletIndex();
        const walletName = `Wallet ${wallets.length + 1}`;

        await saveWalletMnemonic(walletId, trimmed);
        await addWalletToIndex(walletId, walletName);
        await setActiveWalletId(walletId);
        // A restored wallet came from a phrase the user already holds, so it
        // counts as backed up — don't nag them to re-back-it-up.
        await markWalletBackedUp(walletId);

        await get().initialize(trimmed, walletId);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to restore wallet";
        set({ loading: false, error: message });
        throw new Error(message);
      }
    });
  },

  rescanWallet: async (): Promise<void> => {
    if (!database || !spvClient) {
      return;
    }
    // Force a full rescan from genesis by clearing any persisted progress, then
    // drive it. Discovered transactions are credited idempotently, so this is
    // safe to invoke even if the wallet is already up to date.
    const tip = get().chainHeight;
    await database.saveRescanState({
      start_height: 0,
      next_height: 0,
      target_height: tip > 0 ? tip : 0,
      completed: 0,
    });
    await runHistoricalRescan(set, get);
  },

  refreshBalance: (): void => {
    if (!utxoSet) {
      return;
    }
    set({
      balance: utxoSet.getBalance(),
      confirmedBalance: utxoSet.getConfirmedBalance(),
      unconfirmedBalance: utxoSet.getUnconfirmedBalance(),
    });
  },

  getNewAddress: (): string => {
    if (!keyManager) {
      throw new Error("Wallet not initialized");
    }

    const derived = keyManager.getNextAddress();

    // Persist to database asynchronously
    if (database) {
      database
        .insertAddress(derived.address, derived.path, derived.index, false)
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Unknown database error";
          set({ error: `Failed to persist address: ${message}` });
        });
    }

    const current = get().addresses;
    set({
      currentReceiveAddress: derived.address,
      addresses: [...current, derived.address],
    });

    return derived.address;
  },

  getBuyDeliveryAddress: async (): Promise<string> => {
    if (!keyManager) {
      throw new Error("Wallet not initialized");
    }
    if (keyManager.isWatchOnly()) {
      throw new Error("Watch-only wallet cannot receive bought FAIR");
    }

    // Bought FAIR is delivered to a NORMAL chain-0 receive address, so it flows
    // through the wallet's existing watched-address path: it is in the Bloom
    // filter and accepted by ownsAddress, which a dedicated chain-2 "buy" chain
    // was NOT (review finding C5 — deposits to chain 2 never matched and were
    // rejected). We derive a fresh address per order to keep orders unlinkable.
    const derived = keyManager.getNextAddress();

    if (database) {
      await database.insertAddress(
        derived.address,
        derived.path,
        derived.index,
        false,
      );
    }

    const current = get().addresses;
    set({ addresses: [...current, derived.address] });

    // Make sure the new address is watched before the deposit can arrive.
    // getNextAddress extends the lookahead window; refresh the Bloom filter so
    // a peer relays the incoming transaction that pays this address.
    if (spvClient) {
      spvClient.setBloomFilter(buildCombinedBloomFilterHashes(keyManager));
    }

    return derived.address;
  },

  sendTransaction: async (
    toAddress: string,
    amount: bigint,
    feeRate: number,
  ): Promise<string> => {
    set({ loading: true, error: null });

    // N-2: capture local references to every module-level dependency the
    // send touches. If `lockWallet` (auto-lock, manual lock, switch wallet)
    // fires during one of our `await`s, it will null these globals and
    // wipe the KeyManager. Without local snapshots:
    //   - signInput would read a zeroed `privateKey` and produce an invalid
    //     signature ALREADY broadcasted (signed) → on-chain reject only after
    //     the bytes left;
    //   - `database.markUTXOSpent` would throw on a null DB AFTER broadcast,
    //     leaving the network with a tx that spends our coins while our
    //     local UTXO set still shows them spendable → local double-spend.
    //
    // `lockWallet` is aware of this and defers its teardown via
    // `pendingLockTeardown` when `sendInFlight` is true; we run that
    // deferred teardown in `finally`.
    const localKeyManager = keyManager;
    const localDatabase = database;
    const localNetworkConfig = networkConfig;
    const localSpvClient = spvClient;
    const localUtxoSet = utxoSet;
    const localReservation = utxoReservation;

    // Outpoints this send reserves; released in `finally` on any exit so a
    // failed or completed send never leaves coins permanently locked (M4).
    let reservedHere: { txid: string; vout: number }[] = [];
    let sendStarted = false;

    try {
      if (!localKeyManager || !localDatabase || !localNetworkConfig) {
        throw new Error("Wallet not initialized");
      }
      if (get().isWatchOnly) {
        throw new Error("Watch-only wallets cannot send transactions");
      }

      // From here on we hold critical refs; mark in-flight so lockWallet
      // defers its teardown until our finally block runs.
      sendInFlight = true;
      sendStarted = true;

      // Build the pool of spendable coins from CONFIRMED unspent rows only.
      // Unconfirmed (block_height < 0, mempool) outputs are excluded so a send
      // never spends funds that could still be reorged away. Coins already
      // reserved by another in-flight send are excluded too, so automatic
      // selection cannot pick a UTXO a concurrent send is about to spend (M4).
      const utxoRows = await localDatabase.getUnspentUTXOs();
      const candidates: UTXO[] = utxoRows
        .filter((row) => !localReservation.has(row.txid, row.vout))
        .map((row) => ({
          txid: row.txid,
          vout: row.vout,
          address: row.address,
          value: BigInt(row.value),
          scriptPubKey: hexToBytes(row.script_pub_key),
          blockHeight: row.block_height,
          confirmed: row.block_height >= 0,
        }));

      // Decide which coins to spend: honour an explicit coin-control selection
      // when present, otherwise pick the minimum set largest-first. This is the
      // single source of truth for spent inputs and the real fee.
      const coinControl = get().selectedUTXOs;
      const selection = selectInputsForSend({
        candidates,
        targetValue: amount,
        feePerByte: feeRate,
        coinControl,
        dustThreshold: localNetworkConfig.minRelayFee,
      });

      // Reserve the selected outpoints synchronously, before the first `await`
      // below can yield to another send (M4). A coin-control selection bypasses
      // the candidate filter above, so reserve() re-checks each outpoint: if any
      // is already held by an overlapping send, refuse rather than double-spend.
      const outpoints = selection.selected.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
      }));
      const conflict = localReservation.reserve(outpoints);
      if (conflict !== null) {
        throw new Error(
          "Selected coins are being spent by another transaction in progress",
        );
      }
      reservedHere = outpoints;

      const inputs: TxUTXO[] = selection.selected.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        scriptPubKey: utxo.scriptPubKey,
      }));

      // Build unsigned transaction from EXACTLY the selected inputs. The core
      // builder spends every input it is given, which is why selection (not the
      // builder) is responsible for choosing the right coins.
      const changeAddress = localKeyManager.getNextChangeAddress().address;
      const tx = buildTransaction({
        utxos: inputs,
        recipients: [{ address: toAddress, value: amount }],
        changeAddress,
        feePerByte: BigInt(feeRate),
        network: localNetworkConfig,
      });

      // Sign each input with the corresponding private key
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        const utxo = selection.selected.find(
          (u) => u.txid === input.txid && u.vout === input.vout,
        );
        if (!utxo) {
          throw new Error(`UTXO not found for input ${input.txid}:${input.vout}`);
        }

        const privateKey = await getSigningKeyForAddress(localKeyManager, utxo.address);
        tx.inputs[i] = {
          ...tx.inputs[i],
          scriptSig: signInput(tx, i, utxo.scriptPubKey, privateKey),
        };
      }

      // Serialize and compute txid. `hashTransaction` is the single source of
      // truth used across the wallet (history, UI, reorg) — pass the same
      // txid into broadcast so what the user sees matches what hit the network
      // (H-2). The SPV client computes the txid from the raw bytes too but we
      // ignore that value to avoid divergence between two code paths.
      const rawTx = serializeTransaction(tx);
      const txid = hashTransaction(tx);

      // Broadcast via SPV client (P2P). REQUIRES at least one peer received the
      // `tx` message; otherwise the transaction never reached the network and
      // we MUST NOT mark inputs as spent or pretend the send succeeded (H-1).
      // Without this gate the wallet would silently desync from the network:
      // UTXOs locally spent but still spendable by anyone else on chain.
      if (!localSpvClient) {
        throw new Error(
          "Wallet is offline. Connect to peers before sending a transaction.",
        );
      }
      const broadcast = localSpvClient.broadcastTransaction(rawTx);
      if (broadcast.peerCount === 0) {
        throw new Error(
          "No peers available to relay the transaction. Try again once the wallet is connected.",
        );
      }

      // Mark UTXOs as spent locally. The spend is unconfirmed (height -1) until
      // it lands in a block; recording the spending txid lets a reorg undo it.
      for (const input of tx.inputs) {
        await localDatabase.markUTXOSpent(input.txid, input.vout, txid, -1);
        if (localUtxoSet) {
          localUtxoSet.spend(input.txid, input.vout);
        }
      }

      // Persist the transaction record. Persist the REAL fee derived from
      // inputs - outputs (selection.fee), not a re-estimate against the
      // serialized size — selection already computed exactly what the
      // transaction pays, so the history row matches the on-chain fee (M-1).
      const now = Math.floor(Date.now() / 1000);
      await localDatabase.insertTransaction({
        txid,
        raw_hex: bytesToHex(rawTx),
        block_height: -1,
        block_hash: "",
        timestamp: now,
        fee: Number(selection.fee),
        confirmed: 0,
      });

      // Update UI state
      const newTx: WalletTransaction = {
        txid,
        amount: -amount,
        address: toAddress,
        timestamp: now,
        confirmations: 0,
        type: "send",
      };

      set((state) => ({
        transactions: [newTx, ...state.transactions],
        loading: false,
        // A coin-control selection is a one-shot instruction for THIS send.
        // Clear it so the next transaction defaults back to automatic
        // selection instead of silently reusing the same (now-spent) coins.
        selectedUTXOs: [],
      }));

      // Refresh balance from UTXO set
      get().refreshBalance();

      return txid;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      set({ loading: false, error: msg });
      throw new Error(msg);
    } finally {
      // Release this send's UTXO reservations whether it succeeded or failed.
      // On success the inputs are already marked spent in the DB so they won't
      // be reselected; on failure they return to the available pool (M4).
      localReservation.release(reservedHere);
      if (sendStarted) {
        sendInFlight = false;
        // Run any teardown that was deferred while we were sending (N-2). The
        // user pressed lock during a send; the lock UI showed immediately,
        // but the actual KeyManager wipe + spvClient.stop waited for us so
        // we never zeroed the keys mid-signing.
        if (pendingLockTeardown) {
          const teardown = pendingLockTeardown;
          pendingLockTeardown = null;
          teardown();
        }
      }
    }
  },

  refreshMasternodeUTXOs: (): void => {
    if (!utxoSet) {
      return;
    }

    const state = get();
    const mnUtxos = utxoSet.getMasternodeUTXOs();
    const masternodeList: MasternodeUTXO[] = mnUtxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      address: u.address,
      confirmations:
        state.chainHeight > 0 && u.blockHeight > 0
          ? state.chainHeight - u.blockHeight + 1
          : 0,
    }));

    set({ masternodeUTXOs: masternodeList });
  },

  estimateFee: (feeLevel: FeeLevel): bigint => {
    const rate = FEE_RATES[feeLevel];
    return BigInt(rate * AVERAGE_TX_SIZE);
  },

  estimateSend: (amount: bigint, feeRate: number): SendEstimate => {
    // Reason over the same confirmed coins (and coin-control selection) that
    // sendTransaction will spend, so the confirmation screen, the Max button,
    // and the insufficient-funds gate all reflect the REAL fee and balance.
    const candidates: UTXO[] = utxoSet
      ? utxoSet.getAllUTXOs().filter((u) => u.confirmed)
      : [];
    return computeSendEstimate({
      candidates,
      targetValue: amount,
      feePerByte: feeRate,
      coinControl: get().selectedUTXOs,
      dustThreshold: networkConfig?.minRelayFee,
    });
  },

  hasWallet: async (): Promise<boolean> => {
    try {
      const stored = await getMnemonic();
      return stored !== null && stored.length > 0;
    } catch {
      // Secure store may be unavailable (e.g. app just installed,
      // keychain locked). Treat as no wallet present.
      return false;
    }
  },

  wipeWallet: async (): Promise<void> => {
    set({ loading: true, error: null });
    try {
      await clearSecureStore();

      if (database) {
        await database.close();
      }

      resetWalletInternals();

      set({
        ...DEFAULT_WALLET_STATE,
        network: "mainnet",
        activeWalletId: null,
        activeWalletName: "",
        wallets: [],
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to wipe wallet";
      set({ loading: false, error: message });
    }
  },

  lockWallet: (): void => {
    // Tear the wallet down when the app auto-locks (review finding M1): stop the
    // SPV client and zeroize cached private keys (via resetWalletInternals ->
    // KeyManager.wipe) so no key material survives in memory behind the lock.
    // `initialized` is cleared so the lock overlay's unlock path re-initializes
    // the wallet from the stored secret — the same deferred-init flow used when
    // a PIN-protected wallet boots (review finding C1). Multi-wallet identity
    // (activeWalletId / wallets / network) is preserved so the right wallet is
    // brought back up. Persisted secrets and chain data are untouched, so this
    // is non-destructive and fully reversible by unlocking.
    //
    // Bump the lock epoch FIRST, synchronously, unconditionally — even in the
    // sendInFlight-deferred branch below. This is what makes locking safe
    // against a queued `initialize()` task that's mid-flight (e.g. a PIN
    // unlock's `reloadActiveWallet` still hydrating when the app backgrounds
    // again): the epoch bump itself is instant, so the in-flight task will
    // see it at its very next checkpoint and abandon its own work, regardless
    // of whether ITS teardown (this function's, for a concurrent send) runs
    // immediately or is deferred.
    lockEpoch++;
    const state = get();
    const applyLockState = (): void => {
      set({
        ...DEFAULT_WALLET_STATE,
        network: state.network,
        activeWalletId: state.activeWalletId,
        activeWalletName: state.activeWalletName,
        wallets: state.wallets,
        isWatchOnly: state.isWatchOnly,
      });
    };

    // N-2: if a send is currently between broadcast and its DB markUTXOSpent,
    // running the teardown now would either (a) zero the KeyManager's private
    // keys mid-signing and produce an invalid (zeroed) ECDSA signature, or
    // (b) null `database` between broadcast and the spend-record write —
    // leaving the wallet thinking those coins are still spendable while the
    // network already accepted the tx that spends them. Defer the teardown
    // until `sendTransaction`'s `finally` runs it; the UI still sees the
    // lock immediately because the unlock screen only checks `hasPin()`.
    if (sendInFlight) {
      pendingLockTeardown = (): void => {
        resetWalletInternals();
        applyLockState();
      };
      return;
    }

    resetWalletInternals();
    applyLockState();
  },

  // -------------------------------------------------------------------
  // Multi-wallet actions
  // -------------------------------------------------------------------

  loadWalletList: async (): Promise<void> => {
    try {
      const wallets = await getWalletIndex();
      const activeId = await getActiveWalletId();
      const activeWallet = activeId
        ? wallets.find((w) => w.id === activeId)
        : undefined;

      set({
        wallets,
        activeWalletId: activeId,
        activeWalletName: activeWallet?.name ?? "",
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to load wallet list";
      set({ error: message });
    }
  },

  markBackedUp: async (): Promise<void> => {
    const walletId = get().activeWalletId;
    if (!walletId) return;
    await markWalletBackedUp(walletId);
    set({ hasBackedUp: true });
  },

  switchWallet: async (walletId: string): Promise<void> => {
    const state = get();
    if (state.activeWalletId === walletId) return;

    // N-1: serialise the whole switch. A second switchWallet press while the
    // first is mid-flight would race to close the same DB, null the same
    // globals, and call `initialize` twice. The init queue serialises the
    // inner initialize, but the tear-down before it also has to be exclusive
    // — otherwise both call sites reset state and the second one starts
    // initialising before the first one finished its setActiveWalletId.
    return queueWalletInit(async () => {
      set({ loading: true, error: null });

      try {
        // Close current database
        if (database) {
          await database.close();
        }

        // Reset in-memory state
        resetWalletInternals();

        set({
          ...DEFAULT_WALLET_STATE,
          network: state.network,
          activeWalletId: walletId,
          wallets: state.wallets,
          loading: true,
        });

        // Set the new active wallet
        await setActiveWalletId(walletId);

        // Load the new wallet's mnemonic
        const mnemonic = await getWalletMnemonic(walletId);
        if (!mnemonic) {
          throw new Error("Wallet mnemonic not found");
        }

        // Re-initialize with the new wallet. `initialize` itself queues, but
        // since we're already inside the queue here, calling it would await
        // forever. Inline the same effect by calling the action with an
        // already-queued flag — simplest is to await it; the queue is
        // re-entrant safe because we awaited and the chain resolves in
        // order. (The inner queueWalletInit returns the same promise the
        // outer task is awaiting; deadlock would occur only if we awaited
        // a NEW task posted while we still hold the queue.)
        await get().initialize(mnemonic, walletId);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to switch wallet";
        set({ loading: false, error: message });
      }
    });
  },

  loadPockets: async (): Promise<void> => {
    const walletId = get().activeWalletId;
    if (!walletId) return;
    const list = await getPockets(walletId);
    const activeAccount = get().activeAccount;
    const balances: Record<number, bigint> = {};
    for (const pocket of list) {
      balances[pocket.account] =
        pocket.account === activeAccount
          ? get().balance
          : await readPocketUnspentTotal(walletId, pocket.account);
    }
    set({ pockets: list, pocketBalances: balances });
  },

  switchPocket: async (account: number): Promise<void> => {
    const state = get();
    if (state.activeAccount === account) return;
    const walletId = state.activeWalletId;
    if (!walletId) return;

    // Serialise the whole switch, exactly like switchWallet: tear the current
    // Pocket down (close its DB, wipe the KeyManager, clear intervals) and
    // re-init the module globals for the new account.
    return queueWalletInit(async () => {
      set({ loading: true, error: null });
      try {
        if (database) {
          await database.close();
        }
        resetWalletInternals();
        set({
          ...DEFAULT_WALLET_STATE,
          network: state.network,
          activeWalletId: walletId,
          activeWalletName: state.activeWalletName,
          wallets: state.wallets,
          pockets: state.pockets,
          activeAccount: account,
          loading: true,
        });
        await setActivePocket(walletId, account);
        // Identity-wallet-aware: the identity wallet's seed is re-derived from
        // the Oxy identity (never persisted), so it can't be fetched via
        // `getWalletMnemonic` like a BIP39 wallet's. `resolveWalletSeed`
        // handles both, plus watch-only (which never reaches this screen —
        // Pockets is gated off for watch-only wallets in the UI).
        const seed = await resolveWalletSeed(walletId, walletSeedDeps);
        await get().initialize(buildSeedSecret(seed), walletId, undefined, account);
        await get().loadPockets();
      } catch (err: unknown) {
        set({
          loading: false,
          error: err instanceof Error ? err.message : "Failed to switch pocket",
        });
      }
    });
  },

  createPocket: async (
    name: string,
    emoji: string,
    color: string,
    goal?: number,
  ): Promise<number> => {
    const walletId = get().activeWalletId;
    if (!walletId) {
      throw new Error("No active wallet");
    }
    const list = await getPockets(walletId);
    const updated = addPocket(list, name.trim(), emoji, color, goal, Date.now());
    await savePockets(walletId, updated);
    await get().loadPockets();
    return updated[updated.length - 1].account;
  },

  renamePocket: async (account: number, name: string): Promise<void> => {
    const walletId = get().activeWalletId;
    if (!walletId) return;
    const list = await getPockets(walletId);
    await savePockets(walletId, renamePocketList(list, account, name.trim()));
    await get().loadPockets();
  },

  updatePocketMeta: async (
    account: number,
    updates: { emoji?: string; color?: string; goal?: number | null },
  ): Promise<void> => {
    const walletId = get().activeWalletId;
    if (!walletId) return;
    const list = await getPockets(walletId);
    await savePockets(walletId, updatePocketMetaList(list, account, updates));
    await get().loadPockets();
  },

  deletePocket: async (account: number): Promise<void> => {
    const walletId = get().activeWalletId;
    if (!walletId) return;
    const list = await getPockets(walletId);
    if (!canDeletePocket(list, account)) {
      throw new Error("This pocket cannot be deleted");
    }
    const total = await readPocketUnspentTotal(walletId, account);
    if (total > 0n) {
      throw new Error("Move funds out of this pocket before deleting it");
    }
    await savePockets(walletId, removePocketList(list, account));
    if (get().activeAccount === account) {
      await get().switchPocket(MAIN_POCKET_ACCOUNT);
    } else {
      await get().loadPockets();
    }
  },

  moveBetweenPockets: async (
    toAccount: number,
    amount: bigint,
    feeRate: number,
  ): Promise<string> => {
    const state = get();
    const walletId = state.activeWalletId;
    if (!walletId) {
      throw new Error("No active wallet");
    }
    if (state.isWatchOnly) {
      throw new Error("Watch-only wallets cannot move funds");
    }
    if (toAccount === state.activeAccount) {
      throw new Error("Choose a different destination pocket");
    }
    if (!networkConfig) {
      throw new Error("Wallet not initialized");
    }

    // Identity-wallet-aware: the identity wallet's seed is re-derived from the
    // Oxy identity (never persisted); a BIP39 wallet's is cached during
    // initialize, falling back to deriving it from the mnemonic if the cache
    // was cleared. Watch-only wallets have no seed (already excluded above).
    const seed = await resolveWalletSeed(walletId, walletSeedDeps);

    // Resolve + persist the destination Pocket's next receive address in ITS own
    // isolated database so that Pocket watches it once it next syncs.
    const destDb = await Database.open(walletId, toAccount);
    let destAddress: string;
    try {
      const nextIndex = await destDb.getNextUnusedIndex(false);
      const dest = resolveMoveDestinationAddress(
        seed,
        networkConfig,
        toAccount,
        nextIndex,
      );
      await destDb.insertAddress(dest.address, dest.path, dest.index, false);
      // Mark it used immediately: this address is about to receive the move, so
      // treating it as unused until the destination Pocket next syncs would let
      // a second move (before that sync) derive and reuse the SAME address —
      // this advances getNextUnusedIndex so back-to-back moves never collide.
      await destDb.markAddressUsed(dest.address);
      destAddress = dest.address;
    } finally {
      await destDb.close();
    }

    // Reuse the existing send path: an ordinary on-chain self-transfer spending
    // from the active (source) Pocket to the destination Pocket's address.
    const txid = await get().sendTransaction(destAddress, amount, feeRate);
    await get().loadPockets();
    return txid;
  },

  createNewWallet: async (name: string): Promise<string> => {
    set({ loading: true, error: null });

    try {
      const walletId = generateWalletId();
      const mnemonic = generateMnemonic();

      // Save wallet mnemonic with wallet-specific key
      await saveWalletMnemonic(walletId, mnemonic);
      await addWalletToIndex(walletId, name);
      await setActiveWalletId(walletId);

      // Close current database if open
      if (database) {
        await database.close();
      }

      // Reset in-memory state
      resetWalletInternals();

      const state = get();
      set({
        ...DEFAULT_WALLET_STATE,
        network: state.network,
        activeWalletId: walletId,
        activeWalletName: name,
        wallets: state.wallets,
        loading: true,
      });

      // Mark wallet as created in secure store
      await saveMnemonic(mnemonic);

      // Initialize with the new wallet
      await get().initialize(mnemonic, walletId);

      // N-14: record the chain tip at creation time so future rescans can
      // skip blocks that existed before this wallet was born.
      const tip = get().chainHeight;
      await setWalletBirthdayHeight(walletId, tip).catch(() => {
        // Best-effort. Not being able to record a birthday just means
        // rescans start from 0 (same as today's behaviour).
      });

      // Reload wallet list
      await get().loadWalletList();

      return mnemonic;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to create new wallet";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  importWallet: async (name: string, mnemonic: string): Promise<void> => {
    set({ loading: true, error: null });

    try {
      const trimmed = mnemonic.trim().toLowerCase();
      if (!validateMnemonic(trimmed)) {
        throw new Error("Invalid mnemonic phrase");
      }

      const walletId = generateWalletId();

      await saveWalletMnemonic(walletId, trimmed);
      await addWalletToIndex(walletId, name);
      await setActiveWalletId(walletId);

      // Close current database if open
      if (database) {
        await database.close();
      }

      resetWalletInternals();

      const state = get();
      set({
        ...DEFAULT_WALLET_STATE,
        network: state.network,
        activeWalletId: walletId,
        activeWalletName: name,
        wallets: state.wallets,
        loading: true,
      });

      await get().initialize(trimmed, walletId);
      await get().loadWalletList();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to import wallet";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  deleteWallet: async (walletId: string): Promise<void> => {
    set({ loading: true, error: null });

    try {
      const state = get();
      const isActive = state.activeWalletId === walletId;

      // Remove from index and delete mnemonic + its cached seed
      await removeWalletFromIndex(walletId);
      await deleteWalletMnemonic(walletId);
      await deleteCachedWalletSeed(walletId);
      await clearPockets(walletId);

      // Reload wallet list
      const remainingWallets = await getWalletIndex();

      if (isActive) {
        // Close current database
        if (database) {
          await database.close();
        }
        resetWalletInternals();

        if (remainingWallets.length > 0) {
          // Switch to the first remaining wallet
          const nextWallet = remainingWallets[0];

          set({
            ...DEFAULT_WALLET_STATE,
            network: state.network,
            activeWalletId: nextWallet.id,
            activeWalletName: nextWallet.name,
            wallets: remainingWallets,
            loading: true,
          });

          await setActiveWalletId(nextWallet.id);
          const mnemonic = await getWalletMnemonic(nextWallet.id);
          if (mnemonic) {
            await get().initialize(mnemonic, nextWallet.id);
          }
        } else {
          // No wallets left - go to onboarding state
          set({
            ...DEFAULT_WALLET_STATE,
            network: state.network,
            activeWalletId: null,
            activeWalletName: "",
            wallets: [],
          });
        }
      } else {
        // Not the active wallet, just update the list
        set({
          wallets: remainingWallets,
          loading: false,
        });
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to delete wallet";
      set({ loading: false, error: message });
    }
  },

  renameActiveWallet: async (name: string): Promise<void> => {
    const state = get();
    if (!state.activeWalletId) return;

    try {
      await renameWallet(state.activeWalletId, name);
      const wallets = await getWalletIndex();
      set({
        activeWalletName: name,
        wallets,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to rename wallet";
      set({ error: message });
    }
  },

  // -------------------------------------------------------------------
  // Watch-only wallet import
  // -------------------------------------------------------------------

  importWatchOnly: async (name: string, xpub: string): Promise<void> => {
    set({ loading: true, error: null });

    try {
      const trimmedXpub = xpub.trim();

      // Validate the extended public key BEFORE persisting anything. This both
      // gives the user a clear error on a bad key and guarantees we never store
      // a non-mnemonic that could later be (mis)fed into seed derivation.
      // KeyManager.fromXpub throws on anything that isn't a valid xpub for this
      // network (or that carries private material).
      const network = getNetwork(get().network);
      KeyManager.fromXpub(trimmedXpub, network);

      const walletId = generateWalletId();

      // Persist the xpub both as the watch-only flag (saveWalletXpub) and as the
      // wallet "secret" using the xpub: marker. `initialize` routes the marker
      // to the public-only KeyManager (no private keys).
      await saveWalletXpub(walletId, trimmedXpub);
      await addWalletToIndex(walletId, name);
      await saveWalletMnemonic(walletId, `${XPUB_MARKER_PREFIX}${trimmedXpub}`);
      await setActiveWalletId(walletId);

      // Close current database if open
      if (database) {
        await database.close();
      }

      resetWalletInternals();

      const state = get();
      set({
        ...DEFAULT_WALLET_STATE,
        network: state.network,
        activeWalletId: walletId,
        activeWalletName: name,
        wallets: state.wallets,
        isWatchOnly: true,
        loading: true,
      });

      // Initialize like any other wallet: derive watch addresses, persist them,
      // load the Bloom filter, and start SPV so balances actually appear.
      await get().initialize(`${XPUB_MARKER_PREFIX}${trimmedXpub}`, walletId);
      await get().loadWalletList();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to import watch-only wallet";
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  // -------------------------------------------------------------------
  // Network switching
  // -------------------------------------------------------------------

  switchNetwork: async (newNetwork: NetworkType): Promise<void> => {
    const state = get();
    if (state.network === newNetwork) return;

    // N-1: serialise so a concurrent switchWallet/restore can't race the
    // teardown→re-init we're about to perform.
    return queueWalletInit(async () => {
      set({ loading: true, error: null });

      try {
        // Network-scope the social-receive window (finding: MEDIUM).
        // `databaseFileName` has no network component, so this DB file is
        // shared across mainnet/testnet for the active wallet+Pocket — a
        // window derived for the OLD network is a stale, wrong-network
        // address set for the new one (FairCoin mainnet/testnet addresses
        // encode different version bytes for the same underlying key). Clear
        // it here, BEFORE `resetWalletInternals()` nulls the module-level
        // `database` reference, so `setUpSocialReceive` re-derives a fresh
        // window for `newNetwork` from inside the `initialize()` call further
        // down. Also moves the DB close to precede `resetWalletInternals()`
        // (matching switchWallet/switchPocket) — closing it AFTER, as this
        // used to, checked `database` once `resetWalletInternals()` had
        // already nulled it, so the close silently never ran.
        if (database) {
          await database.clearSocialReceiveAddresses();
          await database.close();
        }

        // Stop SPV client + wipe in-memory wallet state, including the
        // in-memory social-receive index/key (`resetWalletInternals` also
        // resets `socialReceiveDefaultAddress` via the `DEFAULT_WALLET_STATE`
        // spread just below).
        resetWalletInternals();

        // Reset to uninitialized state with new network
        set({
          ...DEFAULT_WALLET_STATE,
          network: newNetwork,
          activeWalletId: state.activeWalletId,
          activeWalletName: state.activeWalletName,
          wallets: state.wallets,
          initialized: false,
          loading: true,
        });

        // Re-initialize with the current wallet's secret on the new network.
        // Identity-wallet-aware, mirroring switchPocket: the identity
        // wallet's seed is re-derived from the Oxy identity and can't be
        // fetched via `getWalletMnemonic` like a BIP39 wallet's, so route
        // through `resolveWalletSeed` instead. Unlike Pockets (gated off for
        // watch-only wallets in the UI), network switching IS reachable for
        // watch-only wallets from Settings — they carry an `xpub:` marker,
        // not a spending seed, so they stay on the plain marker path via
        // `getWalletMnemonic`. Any resolution failure throws into the catch
        // below instead of silently leaving the wallet torn down.
        if (state.activeWalletId) {
          if (state.isWatchOnly) {
            const marker = await getWalletMnemonic(state.activeWalletId);
            if (!marker) {
              throw new Error("Wallet xpub not found");
            }
            await get().initialize(marker, state.activeWalletId);
          } else {
            const seed = await resolveWalletSeed(
              state.activeWalletId,
              walletSeedDeps,
            );
            await get().initialize(buildSeedSecret(seed), state.activeWalletId);
          }
        } else {
          set({ loading: false });
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to switch network";
        set({ loading: false, error: message });
      }
    });
  },

  // -------------------------------------------------------------------
  // Backup export/import
  // -------------------------------------------------------------------

  exportBackup: async (): Promise<string> => {
    if (!database) {
      throw new Error("Wallet not initialized");
    }

    try {
      const contacts = await database.getContacts();
      const addresses = await database.getAddresses();

      // Collect address labels and tx notes
      const addressLabels: { address: string; label: string }[] = [];
      for (const addr of addresses) {
        const label = await database.getAddressLabel(addr.address);
        if (label) {
          addressLabels.push({ address: addr.address, label });
        }
      }

      const backup = {
        version: 1,
        exportedAt: Date.now(),
        contacts: contacts.map((c) => ({
          name: c.name,
          address: c.address,
          notes: c.notes,
        })),
        addressLabels,
      };

      return JSON.stringify(backup, null, 2);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to export backup";
      throw new Error(message);
    }
  },

  importBackup: async (json: string): Promise<void> => {
    if (!database) {
      throw new Error("Wallet not initialized");
    }

    try {
      const backup = JSON.parse(json) as {
        version?: number;
        contacts?: {
          name: string;
          address: string;
          notes: string;
        }[];
        addressLabels?: { address: string; label: string }[];
      };

      if (typeof backup.version !== "number") {
        throw new Error("Invalid backup format: missing version");
      }

      // Import contacts
      if (Array.isArray(backup.contacts)) {
        for (const contact of backup.contacts) {
          const id = generateWalletId(); // reuse UUID generator
          await database.insertContact(
            id,
            contact.name,
            contact.address,
            contact.notes,
          );
        }
      }

      // Import address labels
      if (Array.isArray(backup.addressLabels)) {
        for (const label of backup.addressLabels) {
          await database.setAddressLabel(label.address, label.label);
        }
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to import backup";
      throw new Error(message);
    }
  },

  // -------------------------------------------------------------------
  // Coin control
  // -------------------------------------------------------------------

  setSelectedUTXOs: (utxos: { txid: string; vout: number }[]): void => {
    set({ selectedUTXOs: utxos });
  },

  clearSelectedUTXOs: (): void => {
    set({ selectedUTXOs: [] });
  },
}));
