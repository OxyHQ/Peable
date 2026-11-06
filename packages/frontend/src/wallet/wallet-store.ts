/**
 * Zustand store for FairCoin wallet state management.
 * Central state container used by UI components.
 * Integrates KeyManager for HD key derivation, UTXOSet for coin tracking,
 * and Database for persistence.
 *
 * Supports multi-wallet: users can create, switch, and manage
 * multiple wallets, each with its own mnemonic and chain data.
 */

import { create, type StoreApi } from 'zustand';
import {
  generateMnemonic,
  validateMnemonic,
  getNetwork,
  hexToBytes,
  bytesToHex,
  decodeAddress,
  validateAddress,
  buildTransaction,
  serializeTransaction,
  hashTransaction,
  type NetworkType,
  type NetworkConfig,
  type UTXO as TxUTXO,
  type Transaction,
} from '@fairco.in/core';
import type { ParsedTransaction } from '../p2p/messages';
import { SPVClient } from '../p2p/spv-client';
import { planRescan, rewindRescanProgress, type RescanProgress } from '../p2p/rescan';
import { DatabaseHeaderStore } from '../p2p/header-store';
import { createSocketProvider } from '../p2p/socket-provider';
import { KeyManager } from '@peable.to/pay';
import { loadWatchAddressesIntoKeyManager } from './multisig';
import { resolveMoveDestinationAddress } from './move-address';
import {
  XPUB_MARKER_PREFIX,
  resolveWalletSeed,
  getOrDeriveBip39Seed,
  type ResolveWalletSeedDeps,
} from './resolve-wallet-seed';
import {
  UTXOSet,
  selectInputsForSend,
  estimateSend as computeSendEstimate,
  type UTXO,
  type SendEstimate,
} from '@peable.to/pay';
import {
  applyTransactionToWallet,
  reconstructWalletTransaction,
  reverseBytesToHex,
} from './apply-transaction';
import { useContactsStore } from './contacts-store';
import { UtxoReservation } from './utxo-reservation';
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
  isFreshlyCreatedWallet,
} from '../storage/secure-store';
import type { WalletInfo } from '../storage/secure-store';
import { Database, type PreviousKeyTreeRow, type SocialReceiveSetRow } from '../storage/database';
import {
  PERSONAL_SUBJECT,
  SEED_SECRET_PREFIX,
  buildSeedSecret,
  deriveIdentitySeed,
  derivePreviousKeySeed,
  listPreviousKeyHints,
  identitySubjectOfWalletId,
  identityWalletIdOf,
  type IdentitySubject,
} from './identity-wallet';
import { hasIdentityKeystore } from './keystore';
import {
  accountKeyFromDidDocument,
  compressedPublicKeyHex,
  getIdentityPublicKeyHex,
  deriveSocialReceiveWatchWindow,
  judgeSocialReceiveKey,
  signSocialReceiveInput,
  type SocialReceiveKeyVerdict,
} from './social-receive';
import {
  checkSocialReceiveDue,
  createResyncScheduler,
  pullSocialReceiveSet,
} from './social-receive-sync';
import {
  planActiveSet,
  planSocialReceiveChecks,
  watchableRows,
  type WatchSetCheck,
  type WatchSetRow,
} from './social-receive-watch';
import {
  partitionStrandedCoins,
  previousKeyCoins,
  signableCoins,
  sumCoinValues,
} from './spendable';
import {
  advanceTreeOverKnownAddresses,
  canonicalKey,
  discoverPreviousTree,
  groupPreviousKeys,
  planPreviousKeyMove,
  probePreviousKeys,
  signWalletInput,
  type InputSigner,
  type PreviousKeyMovePlan,
} from './previous-keys';
import {
  getSocialReceiveCursor,
  listSocialReceiveAddresses,
  type SocialReceiveCursor,
} from '../services/gateway-client';
import type { SocialReceiveAddress } from '@peable.to/shared-types';
import { fetchAddressActivity, fetchAddressUsage } from '../services/explorer-address';
import { oxyServices } from '../services/oxy-services';
import {
  getPockets,
  savePockets,
  getActivePocket,
  setActivePocket,
  clearPockets,
} from '../storage/pockets-store';
import {
  type PocketInfo,
  MAIN_POCKET_ACCOUNT,
  addPocket,
  renamePocket as renamePocketList,
  updatePocketMeta as updatePocketMetaList,
  removePocket as removePocketList,
  canDeletePocket,
} from './pockets';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeeLevel = 'low' | 'medium' | 'high';

/**
 * `superseded`: the wallet was closed or locked (an account switch, say) while
 * this init was deriving, so it opened nothing; whoever closed it opens the
 * next one.
 */
export type IdentityInitResult = 'initialized' | 'no-identity' | 'no-keystore' | 'superseded';

/**
 * Discrete P2P network states. Stored on the wallet store as a key (rather
 * than a free-form string) so the UI can localise the message and react to
 * language changes without the store re-emitting (U-2).
 */
export type NetworkStatusKey =
  | 'wallet.network.offline'
  | 'wallet.network.resolvingDns'
  | 'wallet.network.connecting'
  | 'wallet.network.waitingForPeers'
  | 'wallet.network.searchingForPeers'
  | 'wallet.network.connectedSingular'
  | 'wallet.network.connectedPlural'
  | 'wallet.network.error';

export interface WalletTransaction {
  txid: string;
  amount: bigint; // positive = received, negative = sent
  address: string;
  timestamp: number;
  confirmations: number;
  type: 'send' | 'receive' | 'stake' | 'masternode_reward';
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
   * until social receive has been set up (web, keyless account,
   * or before `initializeFromIdentity` completes).
   */
  socialReceiveDefaultAddress: string | null;
  /**
   * True when this phone's identity key is NOT the key the account publishes
   * as its DID `#key-1` (ADR 0002) — for an organization, a key that has since
   * been replaced (oxy ADR 0061 D7). Social receive is off: payers would be
   * sent to addresses this wallet can neither see nor spend. Coins already
   * received under this phone's key stay watched and spendable here.
   */
  socialReceiveKeyMismatch: boolean;
  /**
   * Coins stored by this wallet, on this network, at addresses no key this
   * device reaches owns — received under a previous identity key (a rotation,
   * a replaced organization key) that Commons does not hold here. Not in
   * `balance` and never selected for a send (F8). Shown apart, with the path
   * to spend them HERE: add the previous phrase in Commons, after which the
   * wallet reaches the key and they join `previousKeyBalance` (ADR 0002,
   * amended 2026-11-06). (Coins of the OTHER network, which shares this
   * database file, belong to that network's view.)
   */
  strandedBalance: bigint;
  /**
   * The part of `balance` held under a PREVIOUS identity key this device still
   * reaches (ADR 0002, amended 2026-11-06 "previous keys stay spendable"):
   * Commons kept the key after a rotation or replacement, so these coins are
   * signable and selectable like any other — and the wallet offers to move
   * them to the current key ({@link WalletState.movePreviousKeyFunds}),
   * because whoever else holds the previous key can spend them too.
   */
  previousKeyBalance: bigint;
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
    /**
     * The lock epoch the CALLER started under. A caller that awaited
     * something before calling (a seed derivation over IPC) passes the epoch
     * it captured first, so a lock or account switch in between makes this a
     * no-op instead of opening the previous account's wallet.
     */
    epoch?: number,
  ) => Promise<void>;
  /**
   * Bring up the Oxy-identity-derived wallet of `subject` — the person's own
   * (default) or, while they act as an organization, the ORGANIZATION's,
   * derived from its key (oxy ADR 0061). Derives the seed from the on-device
   * identity, builds the KeyManager, and runs the normal init. No mnemonic.
   * Needs the on-device keystore; returns "no-keystore" without one and
   * "no-identity" when this phone cannot reach the subject's key (a keyless
   * account, or an organization key this phone does not hold).
   *
   * `publishedPublicKey` is the organization's DID `#key-1` as Oxy answered it
   * (`accounts.identityKey.get`); social receive compares it with the key this
   * phone holds and stays off when they differ (ADR 0002).
   */
  initializeFromIdentity: (
    onReady?: () => void,
    subject?: IdentitySubject,
    publishedPublicKey?: string | null,
  ) => Promise<IdentityInitResult>;
  /**
   * Close the wallet because the person now acts as a DIFFERENT account
   * (oxy ADR 0001): their own, or an organization's. Tears it down exactly as
   * `lockWallet` does and forgets which wallet was active, so neither a PIN
   * unlock nor the entry screen can bring the previous account's wallet back
   * under the new account. The entry screen then derives the new one.
   */
  closeWallet: () => void;
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
  sendTransaction: (toAddress: string, amount: bigint, feeRate: number) => Promise<string>;
  /**
   * Pay several outputs in ONE transaction (plus change) — a Peable payment
   * request that pays every seller of an order (Peable ADR 0021 D6).
   * `sendTransaction` is its one-recipient case.
   */
  sendToRecipients: (recipients: readonly SendRecipient[], feeRate: number) => Promise<string>;
  refreshMasternodeUTXOs: () => void;
  estimateFee: (feeLevel: FeeLevel) => bigint;
  estimateSend: (amount: bigint, feeRate: number) => SendEstimate;
  /**
   * What "move to your current key" would do at `feeRate`: every confirmed
   * previous-key coin, one output to a fresh address of the current key.
   * `blocked` when this device's key is not the account's current one (the
   * move would land on a replaced key).
   */
  planPreviousKeyMove: (feeRate: number) => PreviousKeyMovePlan | { readonly kind: 'blocked' };
  /** Broadcast {@link WalletState.planPreviousKeyMove}'s move; resolves its txid. */
  movePreviousKeyFunds: (feeRate: number) => Promise<string>;
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
    image: string | undefined,
    color: string,
    goal?: number,
  ) => Promise<number>;
  renamePocket: (account: number, name: string) => Promise<void>;
  /**
   * Update a Pocket's image/color/goal. Pass `image: null` to clear a custom
   * image or `goal: null` to clear an existing goal.
   */
  updatePocketMeta: (
    account: number,
    updates: { image?: string | null; color?: string; goal?: number | null },
  ) => Promise<void>;
  deletePocket: (account: number) => Promise<void>;
  moveBetweenPockets: (toAccount: number, amount: bigint, feeRate: number) => Promise<string>;

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
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
 * The identity PUBLIC key (compressed hex) the social-receive watch set is judged
 * from (spec §4.3). Peable never holds the private key: spending a social
 * coin asks the key's holder to sign. `null` until `initializeFromIdentity`
 * sets up social receive.
 */
let socialReceiveIdentityPublicKey: string | null = null;
/**
 * Whose key the social-receive watch set belongs to and who signs for
 * it: the person, or the organization they act as. Set with the window in
 * `setUpSocialReceive`; reset with it.
 */
let socialReceiveSubject: IdentitySubject = PERSONAL_SUBJECT;
/**
 * The key each organization publishes as its DID `#key-1` (compressed hex), as
 * Oxy last answered it to `initializeFromIdentity`. Public data, so it
 * deliberately survives `resetWalletInternals`: a PIN unlock re-initializes
 * through `reloadActiveWallet`, which does not ask Oxy again, and must still
 * compare this phone's key with the published one.
 */
const organizationPublishedKeys = new Map<string, string>();
/**
 * Set by `closeWallet` (the person switched account) and cleared by the next
 * `initialize`: while set, `reloadActiveWallet` has no wallet to bring back.
 * Without it a PIN unlock would fall back to the persisted active wallet id
 * and could reopen the previous account's wallet under the new account.
 */
let activeWalletForgotten = false;
/**
 * address -> derivation index, for every social-receive address of this
 * device's key in the set (active and dormant): what the wallet owns and signs
 * for (ADR 0021 D9, amended 2026-11-06).
 */
let socialReceiveAddressIndex: Map<string, number> = new Map();
/** The rows behind {@link socialReceiveAddressIndex}, with their check state. */
let socialReceiveWatched: Map<string, WatchSetRow> = new Map();
/** The active tier: the social-receive addresses in the Bloom filter (`planActiveSet`). */
let socialReceiveActive: Set<string> = new Set();
/**
 * Bumped by `resetWalletInternals`. A social-receive resync captures it before
 * its first await and writes nothing once it moved: the wallet it was reading
 * for has been locked, switched or closed.
 */
let socialReceiveGeneration = 0;
/**
 * Unspent coins in the database at addresses this wallet no longer watches
 * (see `WalletState.strandedBalance`). Kept out of `utxoSet`, so neither the
 * balance nor coin selection sees them.
 */
let strandedUtxos: UTXO[] = [];
/**
 * The HD tree of every PREVIOUS identity key this device reaches (ADR 0002,
 * amended 2026-11-06 "previous keys stay spendable"), keyed by the key
 * (compressed hex), built from a seed Commons derived and zeroed at once —
 * held in memory only while the wallet is open, wiped with the current one.
 */
let previousTrees: Map<string, KeyManager> = new Map();
/**
 * address -> previous key (compressed hex), for the social-receive rows of a
 * reachable previous key watched beside this device's own (in
 * `socialReceiveWatched` / `socialReceiveAddressIndex`). An address absent
 * here is this device's current key's.
 */
let socialReceiveAddressKey: Map<string, string> = new Map();
/** Whose keys `previousTrees` belong to: the open identity wallet's subject, or `null`. */
let previousKeySubject: IdentitySubject | null = null;
// Handle of the recurring poll that mirrors peer / sync state from the SPV
// client into the store (peer count, height, status text, periodic rescan).
// Held at module scope so we can clear it from `resetWalletInternals` — without
// that, every wallet switch / network change layered a fresh interval on top
// of the previous one, all racing to mutate the same state (C-1).
let peerUpdateInterval: ReturnType<typeof setInterval> | null = null;
// Guards the historical-rescan driver so the periodic trigger never starts a
// second concurrent scan.
let rescanDriverRunning = false;
/** One output of a send: an address and the base units it receives. */
export interface SendRecipient {
  readonly address: string;
  readonly amount: bigint;
}

/** The most outputs one send carries (Peable's `MAX_PAYMENT_RECIPIENTS`). */
const MAX_SEND_RECIPIENTS = 50;

/** Why a recipient list is not one payment, or `null` when it is. */
function invalidRecipients(recipients: readonly SendRecipient[]): string | null {
  if (recipients.length === 0) return 'A payment needs at least one recipient';
  if (recipients.length > MAX_SEND_RECIPIENTS) {
    return `A payment carries at most ${MAX_SEND_RECIPIENTS} recipients`;
  }
  const seen = new Set<string>();
  for (const recipient of recipients) {
    if (recipient.amount <= 0n) return 'Every recipient amount must be positive';
    if (seen.has(recipient.address)) return `${recipient.address} is named twice`;
    seen.add(recipient.address);
  }
  return null;
}

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
 * the ACTIVE tier of the social-receive set (spec §4.3; ADR 0021 D9, amended
 * 2026-11-06). `setBloomFilter` replaces the filter wholesale, so every call
 * site that rebuilds it must include BOTH sets or the other silently drops out
 * of coverage until the next refresh. The dormant tier is never in the filter:
 * it is read through the Explorer instead (`checkWatchedSocialAddresses`).
 */
function buildCombinedBloomFilterHashes(km: KeyManager): Uint8Array[] {
  // A reachable previous key's HD tree is watched like the current one (its
  // gap window, extended as payments land): late payers still use it.
  const previous: string[] = [];
  for (const tree of previousTrees.values()) previous.push(...tree.getAllAddresses());
  return [...km.getAllAddresses(), ...previous, ...socialReceiveActive].map(
    (addr) => decodeAddress(addr).hash,
  );
}

/** Now, in the Unix seconds the watch set keeps. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toWatchSetRow(row: SocialReceiveSetRow): WatchSetRow {
  return {
    address: row.address,
    index: row.index_num,
    identityPublicKey: row.identity_public_key,
    createdAt: row.created_at,
    used: row.used === 1,
    checkedAt: row.checked_at,
    nextCheckAt: row.next_check_at,
    foundAt: row.found_at,
    origin: row.origin,
  };
}

/** Watch `rows` (already judged this device's): ownership, signing, tiers. */
function addWatchedSocialRows(rows: readonly WatchSetRow[]): void {
  for (const row of rows) {
    socialReceiveWatched.set(row.address, row);
    socialReceiveAddressIndex.set(row.address, row.index);
  }
}

/** Fold persisted checks into the in-memory rows. */
function applySocialReceiveChecks(checks: readonly WatchSetCheck[]): void {
  for (const check of checks) {
    const row = socialReceiveWatched.get(check.address);
    if (!row) continue;
    socialReceiveWatched.set(check.address, {
      ...row,
      checkedAt: check.checkedAt,
      nextCheckAt: check.nextCheckAt,
      foundAt: check.foundAt ?? row.foundAt,
      used: row.used || check.foundAt !== undefined,
    });
  }
}

/**
 * Recompute the active tier (`planActiveSet`) from what the rows and the UTXO
 * set say now. Returns whether it changed — the caller rebuilds the filter.
 */
async function refreshSocialReceiveActive(db: Database): Promise<boolean> {
  const holdingCoins = new Set(await db.getSocialReceiveAddressesHoldingCoins());
  const next = planActiveSet({
    watchable: Array.from(socialReceiveWatched.values()),
    holdingCoins,
    now: nowSeconds(),
  });
  let changed = next.size !== socialReceiveActive.size;
  if (!changed) {
    for (const address of next) {
      if (!socialReceiveActive.has(address)) {
        changed = true;
        break;
      }
    }
  }
  socialReceiveActive = next;
  return changed;
}

/**
 * Bring up the social-receive branch (spec §4.3) for the identity wallet:
 * make sure index 0 (the stable default address) is in the set, load the
 * set's rows this device's key owns, choose the active tier, publish the
 * default address to the store, and resync the set with the gateway.
 *
 * Called from INSIDE `initialize()` itself (gated on `activeId ===
 * an identity wallet` — the person's or an organization's — AND the active
 * Pocket being the main one,
 * mirroring the `hasBackedUp` gate right above its call site) — not just
 * once from `initializeFromIdentity` — so every caller that re-runs
 * `initialize()` after `resetWalletInternals()` cleared this module's state
 * (a PIN unlock, a Pocket switch, a wallet switch) reliably re-establishes
 * social-receive watching. It runs BEFORE `initialize()` builds its Bloom
 * filter (which folds in the active tier via
 * {@link buildCombinedBloomFilterHashes}), so the very first filter a peer
 * ever sees already covers the social branch — no separate post-hoc
 * `setBloomFilter` call needed here.
 */
async function setUpSocialReceive(
  db: Database,
  network: NetworkConfig,
  networkType: NetworkType,
  set: WalletSet,
  subject: IdentitySubject,
): Promise<void> {
  const identityPublicKey = await getIdentityPublicKeyHex(subject);
  if (!identityPublicKey) {
    // Web, Commons absent on Android, or a race where identity was removed
    // between initialize() and here — initializeFromIdentity() already
    // returned "no-identity" in the normal case, so this is a defensive
    // no-op, not the expected path.
    return;
  }
  socialReceiveIdentityPublicKey = identityPublicKey;
  socialReceiveSubject = subject;

  // Index 0 of THIS key: never handed out by the gateway, always watched. A
  // previous key's rows stay in the set, with their key, and are simply not
  // this device's to watch (ADR 0002): nothing is deleted on a key change.
  const [defaultAddress] = deriveSocialReceiveWatchWindow(identityPublicKey, 0, 1, network);
  if (!defaultAddress) return;
  await db.insertSocialReceiveSet([
    {
      address: defaultAddress.address,
      index: 0,
      identityPublicKey,
      createdAt: nowSeconds(),
      origin: 'default',
    },
  ]);
  const persisted = await db.getSocialReceiveSet();
  socialReceiveWatched = new Map();
  socialReceiveAddressIndex = new Map();
  addWatchedSocialRows(watchableRows(persisted.map(toWatchSetRow), identityPublicKey, network));
  await refreshSocialReceiveActive(db);
  set({
    socialReceiveDefaultAddress: defaultAddress.address,
    socialReceiveKeyMismatch: false,
  });

  // An organization publishes its key as its DID `#key-1` (oxy ADR 0061), and
  // Oxy told the entry screen which one that is. A phone holding a key the
  // organization has since REPLACED keeps watching (and can spend) what that
  // key received, but must not offer it as the organization's way to be paid:
  // the gateway derives new payments from the published key. ADR 0002: stop,
  // and say so.
  const publishedKey =
    subject.kind === 'organization' ? organizationPublishedKeys.get(subject.accountId) : undefined;
  if (publishedKey !== undefined && publishedKey !== identityPublicKey) {
    console.warn(
      '[social-receive] this organization publishes a different key than this phone holds; social receive is off',
    );
    set({ socialReceiveDefaultAddress: null, socialReceiveKeyMismatch: true });
    return;
  }

  // The gateway hands out a fresh address on every FairCoin payment and every
  // `@username` request, and this device only learns of it by asking. Ask
  // now, before `@username` is offered, and again while the wallet runs
  // (`socialResync`): foreground, a bounded interval, a push, a payment.
  await syncSocialReceiveSet(db, network, networkType, set, socialReceiveGeneration);
  await refreshSocialReceiveActive(db);
}

/**
 * The key the account PUBLISHES as its DID `#key-1` — what the gateway derives
 * the next reservation from — or `undefined` when it cannot be read here. The
 * cursor carries it (`account_identity_public_key`); a gateway too old to send
 * it leaves us to read it ourselves: the organization's from what Oxy told the
 * entry screen, the person's from their DID document.
 */
async function readPublishedAccountKey(
  cursor: SocialReceiveCursor,
  subject: IdentitySubject,
): Promise<string | null | undefined> {
  if (cursor.account_identity_public_key !== undefined) return cursor.account_identity_public_key;
  if (subject.kind === 'organization') return organizationPublishedKeys.get(subject.accountId);
  const userId = oxyServices.session.userId;
  if (!userId) return undefined;
  try {
    return accountKeyFromDidDocument(await oxyServices.identity.resolveDid(userId));
  } catch {
    return undefined;
  }
}

/** addr(0) of this device's key, the stable default address. */
function socialReceiveDefaultFromIndex(): string | null {
  for (const [address, index] of socialReceiveAddressIndex) {
    // A previous key's index 0 is watched too, but is never the default.
    if (index === 0 && !socialReceiveAddressKey.has(address)) return address;
  }
  return null;
}

/**
 * Re-read the cursor and the account's published key; stop offering
 * `@username` when the key is not this device's (ADR 0002); then pull the
 * addresses the gateway handed out since the stored sync cursor
 * (`pullSocialReceiveSet`) and watch those of this device's key. Returns
 * whether new addresses joined. An offline gateway leaves the set as it is;
 * the next resync tries again.
 */
async function syncSocialReceiveSet(
  db: Database,
  network: NetworkConfig,
  networkType: NetworkType,
  set: WalletSet,
  generation: number,
): Promise<boolean> {
  const deviceKey = socialReceiveIdentityPublicKey;
  const subject = socialReceiveSubject;
  if (!deviceKey) return false;
  const current = (): boolean => generation === socialReceiveGeneration && database === db;
  // `/v1/social/me/*` answers for whoever the session acts as. For an
  // organization's wallet that must BE the organization: a session that has
  // since switched account would hand back someone else's cursor and set.
  const actsAsSubject = (): boolean =>
    subject.kind !== 'organization' || oxyServices.session.userId === subject.accountId;

  let verdict: SocialReceiveKeyVerdict | null = null;
  try {
    if (!actsAsSubject()) throw new Error('the Oxy session no longer acts as this organization');
    const cursor = await getSocialReceiveCursor(networkType);
    if (!actsAsSubject())
      throw new Error('the Oxy session switched account during the cursor read');
    const accountKey = await readPublishedAccountKey(cursor, subject);
    if (accountKey) publishedAccountKey = canonicalKey(accountKey);
    // The gateway derives every NEW address from the key the account
    // publishes. If that is not the key this device holds, each address it
    // hands out belongs to a tree this wallet cannot see or spend from.
    verdict = judgeSocialReceiveKey({
      deviceKey,
      accountKey,
      lastReservedKey: cursor.identity_public_key,
    });
  } catch (error) {
    console.warn('[social-receive] cursor resync failed, using the stored watch set:', error);
  }
  if (!current()) return false;

  if (verdict === 'mismatch') {
    console.warn(
      '[social-receive] this account publishes a different identity key than this device holds; social receive is off',
    );
    set({ socialReceiveDefaultAddress: null, socialReceiveKeyMismatch: true });
  } else if (verdict === 'match' && useWalletStore.getState().socialReceiveKeyMismatch) {
    // The account publishes this device's key again (Commons caught up with a
    // rotation, or an owner added the organization's current key here).
    set({
      socialReceiveDefaultAddress: socialReceiveDefaultFromIndex(),
      socialReceiveKeyMismatch: false,
    });
  }
  // Pulled whatever the verdict, once the cursor answered for the right
  // account: a mismatch still leaves this key's earlier addresses to watch,
  // and every row is stored with its key (another key's is kept, not watched).
  if (verdict === null) return false;

  const fresh: WatchSetRow[] = [];
  try {
    const state = await db.getSocialReceiveSyncState();
    await pullSocialReceiveSet<SocialReceiveAddress>({
      state,
      now: nowSeconds,
      list: async (after) => {
        if (!actsAsSubject())
          throw new Error('the Oxy session no longer acts as this organization');
        const page = await listSocialReceiveAddresses(networkType, after);
        if (!actsAsSubject()) throw new Error('the Oxy session switched account during the read');
        return page;
      },
      store: async (items) => {
        const rows: WatchSetRow[] = [];
        for (const item of items) {
          if (item.network !== networkType) continue;
          rows.push({
            address: item.address,
            index: item.derivation_index,
            identityPublicKey: item.identity_public_key,
            createdAt: item.created,
            used: false,
            checkedAt: null,
            nextCheckAt: null,
            foundAt: null,
            origin: 'gateway',
          });
        }
        await db.insertSocialReceiveSet(rows);
        for (const row of rows) if (!socialReceiveWatched.has(row.address)) fresh.push(row);
        // Yield between pages: a large set is many derivation-free inserts,
        // but the JS thread still has a UI to draw.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      saveState: (next) => db.setSocialReceiveSyncState(next),
      isCurrent: current,
    });
  } catch (error) {
    console.warn(
      '[social-receive] reading the watch set failed; the rest is read next time:',
      error,
    );
  }
  if (!current() || fresh.length === 0) return false;
  const mine = watchableRows(fresh, deviceKey, network);
  addWatchedSocialRows(mine);
  return mine.length > 0;
}

/**
 * Look, through the Explorer, at every social-receive address whose turn came
 * (`planSocialReceiveChecks`): a new one the Bloom filter has only watched
 * from now on, and a dormant one, which the filter does not hold at all. A
 * coin found there sends the SPV rescan back to its block and puts the
 * address in the filter, so the payment is credited through the same
 * merkle-checked path as every other. Returns whether anything was found.
 */
async function checkWatchedSocialAddresses(
  db: Database,
  networkType: NetworkType,
  generation: number,
): Promise<boolean> {
  const current = (): boolean => generation === socialReceiveGeneration && database === db;
  const scanHasBegun = (await db.getRescanState()) !== null;
  if (!current()) return false;
  const plan = planSocialReceiveChecks({
    watchable: Array.from(socialReceiveWatched.values()),
    active: socialReceiveActive,
    now: nowSeconds(),
    scanHasBegun,
  });
  await db.recordSocialReceiveChecks(plan.seen);
  if (!current()) return false;
  applySocialReceiveChecks(plan.seen);
  const result = await checkSocialReceiveDue({
    due: plan.due,
    now: nowSeconds,
    fetchActivity: (addresses) => fetchAddressActivity(addresses, networkType),
    requestRescanFrom: (height) => db.requestRescanFrom(height),
    record: async (checks) => {
      await db.recordSocialReceiveChecks(checks);
      applySocialReceiveChecks(checks);
    },
    isCurrent: current,
  });
  if (result.rescanFrom !== null) {
    console.warn(
      `[social-receive] coins found at addresses not watched by SPV; rescanning from block ${String(result.rescanFrom)}`,
    );
  }
  return result.found.length > 0;
}

/**
 * One full social-receive resync for the open wallet: the cursor, the key,
 * the set, the active tier and the Bloom filter, the check of every address
 * whose turn came, then the historical rescan. A no-op for a wallet without
 * social receive (not an identity wallet, not its main Pocket, no key on this
 * device).
 */
async function resyncSocialReceive(): Promise<void> {
  const db = database;
  const network = networkConfig;
  const generation = socialReceiveGeneration;
  if (!db || !network || !socialReceiveIdentityPublicKey) return;
  const set = useWalletStore.setState;
  const get = useWalletStore.getState;
  const networkType = get().network;
  const grew = await syncSocialReceiveSet(db, network, networkType, set, generation);
  if (generation !== socialReceiveGeneration) return;
  const refilter = async (): Promise<void> => {
    const changed = await refreshSocialReceiveActive(db);
    if (generation !== socialReceiveGeneration) return;
    if (changed && spvClient && keyManager) {
      spvClient.setBloomFilter(buildCombinedBloomFilterHashes(keyManager));
    }
  };
  await refilter();
  if (generation !== socialReceiveGeneration) return;
  if (grew) {
    // Coins stranded at an address now watched again rejoin the balance.
    reclaimStrandedCoins();
    publishBalance(set);
  }
  // Errors (an Explorer outage) propagate to the scheduler's log; progress
  // already recorded stays, and the rest is read on the next resync.
  const found = await checkWatchedSocialAddresses(db, networkType, generation);
  if (generation !== socialReceiveGeneration) return;
  if (found) await refilter();
  if (generation !== socialReceiveGeneration) return;
  // A rescan requested above is folded in by the driver; start it now rather
  // than on the next peer tick.
  void runHistoricalRescan(set, get).catch(() => {
    // Best-effort; the peer tick retries.
  });
}

/**
 * When the open wallet resyncs its social-receive set: on request and on
 * the peer tick's bounded interval, never two at once, and once more when an
 * event arrives mid-run. Reset with the wallet.
 */
const socialResync = createResyncScheduler({
  run: resyncSocialReceive,
  now: () => Date.now(),
  onError: (error) => {
    console.warn('[social-receive] resync failed; retrying on the next one:', error);
  },
});

/**
 * Ask the open wallet to resync its social-receive set now: the app came
 * to the foreground, a push arrived, the Receive sheet opened — anything after
 * which a payer may have been handed a new address. Cheap and safe to call
 * any time; a no-op without an open identity wallet.
 */
export function requestSocialReceiveResync(): void {
  // The same moments (the app back from Commons, say) are when a previous key
  // may have become reachable.
  if (previousKeySubject) void previousKeyRefresh.request();
  if (!socialReceiveIdentityPublicKey) return;
  void socialResync.request();
}

// ---------------------------------------------------------------------------
// Previous identity keys (ADR 0002, amended 2026-11-06 "previous keys stay
// spendable"; mainnet gate F1). Pure rules in `previous-keys.ts`.
// ---------------------------------------------------------------------------

/**
 * The account's published `#key-1` (compressed hex) as the last cursor read
 * answered it, `null` when unknown. A previous key is any recorded key that is
 * neither this device's nor this one.
 */
let publishedAccountKey: string | null = null;

/** The keys that are never "previous": this device's, and the account's published one. */
function currentKeysOf(subject: IdentitySubject, deviceKey: string | null): Set<string> {
  const published =
    subject.kind === 'organization'
      ? (organizationPublishedKeys.get(subject.accountId) ?? null)
      : publishedAccountKey;
  const keys = new Set<string>();
  for (const key of [deviceKey, published]) {
    const canonical = canonicalKey(key);
    if (canonical) keys.add(canonical);
  }
  return keys;
}

/** A previous key's HD tree, for the open Pocket, from a seed the caller zeroes. */
function buildPreviousTree(network: NetworkConfig, account: number) {
  return (_key: string, seed: Uint8Array): KeyManager =>
    KeyManager.fromSeed(seed, network, account);
}

/**
 * Watch the social-receive rows of `keys` (reachable previous keys) beside
 * this device's own, in D9's tiers: index 0 and funded rows in the filter,
 * the rest read through the Explorer on its schedule. Main Pocket only, like
 * the rest of social receive.
 */
async function watchPreviousSocialRows(
  db: Database,
  network: NetworkConfig,
  subject: IdentitySubject,
  keys: readonly string[],
): Promise<void> {
  const deviceKey = socialReceiveIdentityPublicKey;
  if (!deviceKey || keys.length === 0) return;
  const wanted = new Set(keys);
  const stored = (await db.getSocialReceiveSetKeys()).filter((key) => {
    const canonical = canonicalKey(key);
    return canonical !== null && wanted.has(canonical);
  });
  const rows = (await db.getSocialReceiveSetRowsForKeys(stored, true)).map(toWatchSetRow);
  const groups = groupPreviousKeys({
    rows,
    currentKeys: [...currentKeysOf(subject, deviceKey)],
    extraKeys: keys,
    network,
  });
  for (const group of groups) {
    if (!wanted.has(group.key)) continue;
    addWatchedSocialRows(group.rows);
    for (const row of group.rows) socialReceiveAddressKey.set(row.address, group.key);
  }
  await refreshSocialReceiveActive(db);
}

/**
 * Bring up the previous keys this wallet already tracks, inside `initialize`
 * (before the UTXO set loads, so their coins are held rather than stranded):
 * every recorded tree whose discovery ran is re-derived through Commons and
 * restored to its cursors. Cheap — no Explorer read; a new key is found by
 * {@link refreshPreviousKeys} in the background.
 */
async function loadPreviousKeys(
  db: Database,
  network: NetworkConfig,
  networkType: NetworkType,
  subject: IdentitySubject,
  account: number,
): Promise<void> {
  previousKeySubject = subject;
  const deviceKey = socialReceiveIdentityPublicKey ?? (await getIdentityPublicKeyHex(subject));
  const excluded = currentKeysOf(subject, deviceKey);
  const rows = (await db.getPreviousKeyTrees(networkType)).filter(
    (row) => row.discovered_at !== null && !excluded.has(row.public_key),
  );
  // A key this device cannot reach leaves its coins stranded;
  // `refreshPreviousKeys` asks again on its interval.
  const { reachable } = await probePreviousKeys(
    rows.map((row) => row.public_key),
    (key) => derivePreviousKeySeed(subject, key),
    buildPreviousTree(network, account),
  );
  for (const row of rows)
    reachable.get(row.public_key)?.restoreCursors(row.external_next, row.change_next);
  previousTrees = reachable;
  if (account === MAIN_POCKET_ACCOUNT) {
    await watchPreviousSocialRows(db, network, subject, [...reachable.keys()]);
  }
}

/**
 * Find previous keys and the ones that became reachable: the keys the
 * gateway recorded on the account's addresses (D9's `identity_public_key`),
 * Commons' list as a hint, and the trees already recorded, less those already
 * open. A newly reachable key's tree is advanced over what this device
 * already stored, then discovered through the Explorer (gap limit, as a
 * restored HD wallet) — or, when the Explorer cannot tell (testnet), rescanned
 * from the wallet's birthday over its window — and recorded; its coins leave
 * the stranded line for the balance, and the move prompt appears.
 */
async function refreshPreviousKeys(): Promise<void> {
  const db = database;
  const network = networkConfig;
  const km = keyManager;
  const subject = previousKeySubject;
  const generation = socialReceiveGeneration;
  if (!db || !network || !km || !subject || km.isWatchOnly()) return;
  const current = (): boolean => generation === socialReceiveGeneration && database === db;
  const set = useWalletStore.setState;
  const get = useWalletStore.getState;
  const { network: networkType, activeAccount: account, activeWalletId } = get();

  const deviceKey = socialReceiveIdentityPublicKey ?? (await getIdentityPublicKeyHex(subject));
  const excluded = currentKeysOf(subject, deviceKey);
  const recorded =
    account === MAIN_POCKET_ACCOUNT && socialReceiveIdentityPublicKey
      ? await db.getSocialReceiveSetKeys()
      : [];
  const hints = await listPreviousKeyHints(subject);
  const trees = await db.getPreviousKeyTrees(networkType);
  if (!current()) return;
  const candidates = new Set<string>();
  for (const key of [...recorded, ...hints, ...trees.map((row) => row.public_key)]) {
    const canonical = canonicalKey(key);
    if (canonical && !excluded.has(canonical) && !previousTrees.has(canonical)) {
      candidates.add(canonical);
    }
  }
  if (candidates.size === 0) return;
  // Every key not open yet is asked again each time: one the person has just
  // added in Commons is reached on the next refresh.
  const { reachable } = await probePreviousKeys(
    [...candidates],
    (key) => derivePreviousKeySeed(subject, key),
    buildPreviousTree(network, account),
  );
  const discard = (): void => {
    for (const tree of reachable.values()) tree.wipe();
  };
  if (!current()) return discard();
  if (reachable.size === 0) return;

  const known = new Set<string>();
  for (const row of await db.getAllUTXOs()) known.add(row.address);
  for (const row of await db.getAddresses()) known.add(row.address);
  let birthday = 0;
  if (activeWalletId) {
    try {
      birthday = await getWalletBirthdayHeight(activeWalletId);
    } catch {
      // No recorded birthday: from genesis, never risk missing a coin.
    }
  }
  let rescanFrom: number | null = null;
  const opened: string[] = [];
  for (const [key, tree] of reachable) {
    const row: PreviousKeyTreeRow | undefined = trees.find(
      (candidate) => canonicalKey(candidate.public_key) === key,
    );
    if (row) tree.restoreCursors(row.external_next, row.change_next);
    advanceTreeOverKnownAddresses(tree, known);
    // Discovered every time a key is reached here, not only the first: while
    // it was unreachable its tree was in no Bloom filter, so a payment that
    // landed meanwhile is found only by reading the chain again.
    try {
      const found = await discoverPreviousTree(tree, (addresses) =>
        fetchAddressUsage(addresses, networkType),
      );
      const from = found.conclusive ? found.rescanFrom : birthday;
      if (from !== null) rescanFrom = rescanFrom === null ? from : Math.min(rescanFrom, from);
    } catch (error) {
      // The Explorer failed: nothing recorded, so the next refresh asks again.
      console.warn('[previous-keys] discovery failed; retrying on the next refresh:', error);
      tree.wipe();
      continue;
    }
    if (!current()) return discard();
    await db.savePreviousKeyTree({
      public_key: key,
      network: networkType,
      external_next: tree.getNextExternalIndex(),
      change_next: tree.getNextChangeIndex(),
      discovered_at: nowSeconds(),
    });
    opened.push(key);
  }
  if (!current()) return discard();
  for (const key of opened) {
    const tree = reachable.get(key);
    if (tree) previousTrees.set(key, tree);
  }
  if (opened.length === 0) return;
  if (account === MAIN_POCKET_ACCOUNT) {
    await watchPreviousSocialRows(db, network, subject, opened);
  }
  if (!current()) return;
  // Coins stored while the key was stranded are held again.
  reclaimStrandedCoins();
  publishBalance(set);
  if (spvClient) spvClient.setBloomFilter(buildCombinedBloomFilterHashes(km));
  if (rescanFrom !== null) await db.requestRescanFrom(rescanFrom);
  // The previous key's social rows are read through the Explorer on D9's
  // schedule (never-read rows first), and any coin found rewinds the scan.
  if (socialReceiveIdentityPublicKey) void socialResync.request();
  void runHistoricalRescan(set, get).catch(() => {
    // Best-effort; the peer tick retries.
  });
}

/**
 * When the open identity wallet looks for previous keys: on open, on the same
 * moments as the social resync, and on the peer tick's interval (a key the
 * person adds in Commons is found within it). Reset with the wallet.
 */
const previousKeyRefresh = createResyncScheduler({
  run: refreshPreviousKeys,
  now: () => Date.now(),
  onError: (error) => {
    console.warn('[previous-keys] refresh failed; retrying on the next one:', error);
  },
});

/**
 * Whether a coin at `address` belongs to what this wallet watches now: its HD
 * tree (with registered multisig watch addresses) or the current social
 * window. A coin elsewhere is stranded (`WalletState.strandedBalance`).
 */
function isWatchedAddress(address: string): boolean {
  return (
    (keyManager?.ownsAddress(address) ?? false) ||
    socialReceiveAddressIndex.has(address) ||
    previousTreeOwning(address) !== null
  );
}

/** The reachable previous key whose HD tree owns `address`, or `null`. */
function previousTreeOwning(address: string): string | null {
  for (const [key, tree] of previousTrees) {
    if (tree.ownsAddress(address)) return key;
  }
  return null;
}

/**
 * The PREVIOUS key a held coin at `address` is under (its HD tree or its
 * social-receive address), or `null` for the current key's (ADR 0002,
 * amended 2026-11-06).
 */
function previousKeyOf(address: string): string | null {
  if (keyManager?.ownsAddress(address)) return null;
  return socialReceiveAddressKey.get(address) ?? previousTreeOwning(address);
}

/**
 * Whether {@link signInputForAddress} can sign a coin at an address, for `km`:
 * an HD key it holds, or a social-receive index whose key's holder signs. A
 * multisig watch address is owned but signed through the multisig flow; a
 * watch-only manager signs nothing.
 */
function signerFor(km: KeyManager): (address: string) => boolean {
  const multisig = new Set(km.getWatchAddresses());
  const watchOnly = km.isWatchOnly();
  return (address) =>
    socialReceiveAddressIndex.has(address) ||
    (!watchOnly && km.ownsAddress(address) && !multisig.has(address)) ||
    (!watchOnly && previousTreeOwning(address) !== null);
}

/**
 * Move every stranded coin whose address is watched again (the window grew
 * back over it) into the UTXO set. The caller publishes the balance.
 */
function reclaimStrandedCoins(): void {
  if (!utxoSet || strandedUtxos.length === 0) return;
  const { held, stranded } = partitionStrandedCoins(strandedUtxos, isWatchedAddress, () => true);
  for (const utxo of held) utxoSet.add(utxo);
  strandedUtxos = stranded;
}

/**
 * The scriptSig for input `inputIndex`, which spends `utxo`: the private
 * spending tree signs locally; a social-receive address (spec §4.3) is signed
 * by the identity key's holder, since Peable never has that key. Throws if
 * neither knows the address.
 */
async function signInputForAddress(
  km: KeyManager,
  tx: Transaction,
  inputIndex: number,
  utxo: { address: string; scriptPubKey: Uint8Array },
  network: NetworkConfig,
): Promise<Uint8Array> {
  // Captured now: a send may mix the current key's coins with a previous
  // key's, and each input is signed by the key that owns it (ADR 0002,
  // amended 2026-11-06) — `signWalletInput` is the one dispatch, tested with
  // a transaction mixing current-HD, previous-HD and previous-social inputs.
  const subject = socialReceiveSubject;
  const trees = previousTrees;
  const socialKeys = socialReceiveAddressKey;
  const socialIndices = socialReceiveAddressIndex;
  const signer = (address: string): InputSigner | null => {
    if (km.ownsAddress(address)) {
      return { kind: 'hd', privateKey: km.getPrivateKeyForAddress(address) };
    }
    const socialIndex = socialIndices.get(address);
    if (socialIndex !== undefined) {
      return { kind: 'social', index: socialIndex, publicKey: socialKeys.get(address) ?? null };
    }
    for (const tree of trees.values()) {
      if (tree.ownsAddress(address)) {
        return { kind: 'hd', privateKey: tree.getPrivateKeyForAddress(address) };
      }
    }
    return null;
  };
  return signWalletInput(tx, inputIndex, utxo, {
    signerFor: signer,
    signSocial: (unsigned, index, scriptPubKey, childIndex, address, publicKey) =>
      signSocialReceiveInput(
        unsigned,
        index,
        scriptPubKey,
        childIndex,
        address,
        network,
        subject,
        publicKey === null ? {} : { publicKey },
      ),
  });
}

/**
 * Sum the confirmed+unconfirmed unspent value persisted for a Pocket by reading
 * its isolated database directly. Used to show balances for Pockets that are not
 * the active one (their UTXO set is not loaded into memory). Opens read-only and
 * always closes.
 */
async function readPocketUnspentTotal(walletId: string, account: number): Promise<bigint> {
  const db = await Database.open(walletId, account);
  try {
    const rows = await db.getUnspentUTXOs();
    return rows.reduce((sum, row) => sum + BigInt(row.value), 0n);
  } finally {
    await db.close();
  }
}

/**
 * Broadcast a fully signed `tx` and record the spend: REQUIRES at least one
 * peer to have received it (H-1) — otherwise nothing is marked spent — then
 * marks its inputs spent (height -1 until it confirms, so a reorg can undo
 * it) and persists the row with the REAL fee. Shared by every send, the move
 * to the current key included, so they cannot drift. Returns the txid.
 */
async function broadcastAndRecord(
  tx: Transaction,
  fee: bigint,
  client: SPVClient | null,
  db: Database,
  coins: UTXOSet | null,
): Promise<{ txid: string; timestamp: number }> {
  // `hashTransaction` is the single source of truth for the txid across the
  // wallet (history, UI, reorg) — what the user sees is what hit the network (H-2).
  const rawTx = serializeTransaction(tx);
  const txid = hashTransaction(tx);
  if (!client) {
    throw new Error('Wallet is offline. Connect to peers before sending a transaction.');
  }
  const broadcast = client.broadcastTransaction(rawTx);
  if (broadcast.peerCount === 0) {
    throw new Error(
      'No peers available to relay the transaction. Try again once the wallet is connected.',
    );
  }
  for (const input of tx.inputs) {
    await db.markUTXOSpent(input.txid, input.vout, txid, -1);
    coins?.spend(input.txid, input.vout);
  }
  const timestamp = Math.floor(Date.now() / 1000);
  await db.insertTransaction({
    txid,
    raw_hex: bytesToHex(rawTx),
    block_height: -1,
    block_hash: '',
    timestamp,
    fee: Number(fee),
    confirmed: 0,
  });
  return { txid, timestamp };
}

// ---------------------------------------------------------------------------
// Incoming transaction processing (SPV receive path)
// ---------------------------------------------------------------------------

type WalletSet = StoreApi<WalletState>['setState'];
type WalletGet = StoreApi<WalletState>['getState'];

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
    strandedBalance: sumCoinValues(strandedUtxos),
    previousKeyBalance: currentPreviousKeyBalance(),
  });
}

/** The part of the in-memory balance under a reachable previous key. */
function currentPreviousKeyBalance(): bigint {
  if (!utxoSet || (previousTrees.size === 0 && socialReceiveAddressKey.size === 0)) return 0n;
  return sumCoinValues(previousKeyCoins(utxoSet.getAllUTXOs(), previousKeyOf));
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
    return { blockHeight: -1, blockHash: '', confirmations: 0 };
  }

  const blockHashHex = bytesToHex(blockHash);
  const header = await database.getHeaderByHash(blockHash);
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
    // A previous key's tree and social rows count too (ADR 0002, amended
    // 2026-11-06): late payers still pay them, and they are spendable here.
    isWatchedAddress,
    networkConfig,
    confirmation,
  );

  // A stranded coin spent from elsewhere (the device that still holds the
  // previous key): it is no longer the person's to be told about.
  if (strandedUtxos.length > 0) {
    const spent = new Set(
      tx.inputs.map((input) => `${reverseBytesToHex(input.prevTxHash)}:${input.prevTxIndex}`),
    );
    const stillStranded = strandedUtxos.filter((utxo) => !spent.has(`${utxo.txid}:${utxo.vout}`));
    if (stillStranded.length !== strandedUtxos.length) {
      for (const utxo of strandedUtxos) {
        if (spent.has(`${utxo.txid}:${utxo.vout}`)) {
          await database.markUTXOSpent(utxo.txid, utxo.vout, txid, confirmation.blockHeight);
        }
      }
      strandedUtxos = stillStranded;
      publishBalance(set);
    }
  }

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
  let socialReceivePaid = false;
  for (const address of result.receiveAddresses) {
    await database.markAddressUsed(address);
    if (keyManager.markAddressUsed(address)) {
      bloomNeedsRefresh = true;
    }
    const previousKey = previousTreeOwning(address);
    const previousTree = previousKey !== null ? previousTrees.get(previousKey) : undefined;
    if (previousKey !== null && previousTree) {
      // The previous tree's cursor moved: watch the gap past it, and
      // remember where it stands so the next open restores it.
      if (previousTree.markAddressUsed(address)) bloomNeedsRefresh = true;
      await database.savePreviousKeyTree({
        public_key: previousKey,
        network: get().network,
        external_next: previousTree.getNextExternalIndex(),
        change_next: previousTree.getNextChangeIndex(),
        discovered_at: null,
      });
    }
    const watched = socialReceiveWatched.get(address);
    if (watched) {
      await database.markSocialReceiveAddressUsed(address);
      socialReceiveWatched.set(address, { ...watched, used: true });
      // Someone was handed this address, so others may have been handed later
      // ones: resync the set rather than wait for the interval.
      socialReceivePaid = true;
    }
  }

  // ---- Mirror spent inputs to SQLite -------------------------------------
  // Record which tx spent the UTXO and at what height so a reorg can un-spend
  // it precisely if the spending block is later orphaned.
  for (const debit of result.debited) {
    await database.markUTXOSpent(debit.txid, debit.vout, txid, confirmation.blockHeight);
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
        await database.updateUTXOSpentHeight(prevTxid, input.prevTxIndex, confirmation.blockHeight);
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
    const spentAddress = result.debited[0]?.address ?? '';
    upsertWalletTransaction(set, {
      txid,
      amount: net,
      address: net > 0n ? (result.receiveAddresses[0] ?? '') : spentAddress,
      timestamp: now,
      confirmations: confirmation.confirmations,
      type: net > 0n ? 'receive' : 'send',
    });
  }

  publishBalance(set);

  if (bloomNeedsRefresh && spvClient && keyManager) {
    spvClient.setBloomFilter(buildCombinedBloomFilterHashes(keyManager));
  }
  if (socialReceivePaid) {
    requestSocialReceiveResync();
  }
}

/**
 * Replace the in-memory UTXO set with the unspent UTXOs currently in SQLite.
 * Used at init, and after a reorg rewind, to keep the in-memory set the single
 * source of truth for balance in lock-step with the persisted state.
 *
 * Only coins at addresses this wallet watches NOW enter the set; the rest are
 * kept apart as stranded (`strandedUtxos`) — counted on their own line, never
 * in the balance or in coin selection, where the first send that picked one
 * failed to sign. Call it once the key manager's cursors and the social window
 * are in place, or their coins read as stranded.
 */
async function reloadUtxoSetFromDatabase(): Promise<void> {
  if (!utxoSet || !database) {
    return;
  }
  const fresh = new UTXOSet();
  const dbUtxos = await database.getUnspentUTXOs();
  const rows: UTXO[] = dbUtxos.map((row) => ({
    txid: row.txid,
    vout: row.vout,
    address: row.address,
    value: BigInt(row.value),
    scriptPubKey: hexToBytes(row.script_pub_key),
    blockHeight: row.block_height,
    confirmed: row.block_height >= 0,
  }));
  const network = networkConfig;
  const { held, stranded } = partitionStrandedCoins(rows, isWatchedAddress, (address) =>
    network ? validateAddress(address, network) : true,
  );
  for (const utxo of held) fresh.add(utxo);
  utxoSet = fresh;
  strandedUtxos = stranded;
}

/**
 * Roll the wallet back to `forkHeight` after the SPV client detects that a
 * longer chain has orphaned the blocks above it. The database rewind deletes
 * UTXOs created in orphaned blocks and restores UTXOs spent by orphaned
 * transactions; we then rebuild the in-memory set and balance from the
 * post-rewind database so nothing reflects the discarded chain.
 */
async function rewindWalletToHeight(forkHeight: number, set: WalletSet): Promise<void> {
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
async function runHistoricalRescan(_set: WalletSet, get: WalletGet): Promise<void> {
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
  // Claimed before the first await: the peer tick, a sync-progress event and
  // a social-receive resync all call this, and two that both passed the guard
  // would each plan (and fold the pending height into) the same scan.
  rescanDriverRunning = true;
  const db = database;
  const client = spvClient;
  try {
    const persistedRow = await db.getRescanState();
    let persisted: RescanProgress | null = persistedRow
      ? {
          startHeight: persistedRow.start_height,
          nextHeight: persistedRow.next_height,
          targetHeight: persistedRow.target_height,
          completed: persistedRow.completed === 1,
        }
      : null;

    // An address joined the filter after the scan passed a block that pays it
    // (a social-receive index watched late, found through the Explorer). Send
    // the scan back there; only now, with no scan running to overwrite it.
    const pendingFrom = await db.getPendingRescanFrom();
    if (pendingFrom !== null) {
      const rewound = rewindRescanProgress(persisted, pendingFrom, chainTip);
      if (rewound && rewound !== persisted) {
        await db.saveRescanState({
          start_height: rewound.startHeight,
          next_height: rewound.nextHeight,
          target_height: rewound.targetHeight,
          completed: rewound.completed ? 1 : 0,
        });
        persisted = rewound;
      }
      await db.clearPendingRescanFrom();
    }

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

    await client.rescan({
      fromHeight: plan.startHeight,
      toHeight: plan.targetHeight,
      resumeFrom: plan.resumeFrom,
      onProgress: async (progress) => {
        if (database !== db) {
          return;
        }
        await db.saveRescanState({
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
async function reconcileConfirmations(set: WalletSet, get: WalletGet): Promise<void> {
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
      const header = await database.getHeaderByHash(hexToBytes(pending.block_hash));
      if (!header) continue;
      await database.updateUTXOBlockHeight(pending.txid, pending.vout, header.height);
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
      const header = await database.getHeaderByHash(hexToBytes(pending.block_hash));
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
  socialReceiveIdentityPublicKey = null;
  socialReceiveSubject = PERSONAL_SUBJECT;
  socialReceiveAddressIndex = new Map();
  socialReceiveWatched = new Map();
  socialReceiveActive = new Set();
  socialReceiveGeneration += 1;
  socialResync.reset();
  // A previous key's HD keys are wiped exactly like the current key's.
  for (const tree of previousTrees.values()) tree.wipe();
  previousTrees = new Map();
  socialReceiveAddressKey = new Map();
  previousKeySubject = null;
  previousKeyRefresh.reset();
  strandedUtxos = [];
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
  networkStatus: 'Offline',
  networkStatusKey: 'wallet.network.offline' as NetworkStatusKey,
  networkStatusData: undefined as Record<string, string | number> | undefined,
  currentReceiveAddress: '',
  addresses: [] as string[],
  transactions: [] as WalletTransaction[],
  masternodeUTXOs: [] as MasternodeUTXO[],
  isWatchOnly: false,
  hasBackedUp: false,
  socialReceiveDefaultAddress: null as string | null,
  socialReceiveKeyMismatch: false,
  strandedBalance: 0n,
  previousKeyBalance: 0n,
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
  'wallet.network.offline': 'Offline',
  'wallet.network.resolvingDns': 'Resolving DNS seeds...',
  'wallet.network.connecting': 'Connecting to peers...',
  'wallet.network.waitingForPeers': 'Waiting for peers...',
  'wallet.network.searchingForPeers': 'Searching for peers...',
  'wallet.network.connectedSingular': 'Connected to 1 peer',
  'wallet.network.connectedPlural': 'Connected to {count} peers',
  'wallet.network.error': 'P2P error: {message}',
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
  network: 'mainnet',

  // Multi-wallet initial state
  activeWalletId: null,
  activeWalletName: '',
  wallets: [],
  isWatchOnly: false,
  hasBackedUp: false,
  socialReceiveDefaultAddress: null,
  socialReceiveKeyMismatch: false,
  strandedBalance: 0n,
  previousKeyBalance: 0n,
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
  networkStatus: NETWORK_STATUS_FALLBACK['wallet.network.offline'],
  networkStatusKey: 'wallet.network.offline' as NetworkStatusKey,
  networkStatusData: undefined,

  currentReceiveAddress: '',
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
    epoch?: number,
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
      // A caller that started earlier (and awaited before queueing) passes the
      // epoch it started under: a close or lock since then abandons this init.
      const myEpoch = epoch ?? lockEpoch;
      if (myEpoch !== lockEpoch) return;
      const state = get();
      if (state.initialized) {
        // Another wallet is up: never treat it as this one. The account
        // switch that asked for this wallet closes that one first.
        if (walletId !== undefined && state.activeWalletId !== walletId) return;
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
        activeWalletForgotten = false;
        const resolvedAccount = account ?? (activeId ? await getActivePocket(activeId) : 0);

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
          const seedCacheId = activeId ?? 'default';
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

        // Restore the BIP44 derivation cursors from persisted state so used
        // addresses are never re-issued across restarts and the lookahead window
        // (hence the Bloom filter) keeps watching the right addresses
        // (SPV_AUDIT.md §4.5). KeyManager.fromMnemonic resets the cursors to 0.
        const nextExternal = await database.getNextUnusedIndex(false);
        const nextChange = await database.getNextUnusedIndex(true);
        keyManager.restoreCursors(nextExternal, nextChange);

        // Restore any multisig watch addresses registered in a previous
        // session (Layer 1 multisig -- see src/wallet/multisig.ts) so they are
        // owned and Bloom-filter-watched again immediately, same as the HD
        // cursor restore just above.
        await loadWatchAddressesIntoKeyManager(database, keyManager);

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
          await database.insertAddress(derived.address, derived.path, derived.index, false);
          receiveAddress = derived.address;
          addressList.push(derived.address);
        }

        // Load wallet info. `activeId` was already resolved above (alongside
        // the active Pocket) so the DB-open path and this lookup agree.
        const wallets = await getWalletIndex();
        const activeWallet = activeId ? wallets.find((w) => w.id === activeId) : undefined;

        // Check if this is a watch-only wallet
        const watchOnly = activeId ? await checkIsWatchOnly(activeId) : false;
        // Has the user backed up this wallet's recovery phrase? Drives the home
        // "back up your wallet" reminder. Watch-only wallets have no phrase to
        // back up, so they never prompt.
        const identitySubject = activeId ? identitySubjectOfWalletId(activeId) : null;
        const backedUp =
          identitySubject !== null
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
        // cleared `socialReceiveIdentityPublicKey` / `socialReceiveAddressIndex`
        // to their empty defaults for them.
        if (identitySubject !== null && resolvedAccount === MAIN_POCKET_ACCOUNT) {
          try {
            await setUpSocialReceive(database, networkConfig, state.network, set, identitySubject);
          } catch (socialError: unknown) {
            // Social receive is one branch of this wallet, never a reason for
            // the rest not to open: the HD coins stay spendable whatever the
            // cursor or the identity holder answered. Whatever part of the
            // window loaded stays watched (its coins stay spendable); only
            // `@username` is withdrawn until the next unlock sets it up again.
            console.warn('[social-receive] could not be set up; @username is off:', socialError);
            set({ socialReceiveDefaultAddress: null });
          }
        }

        // Previous identity keys this wallet already tracks (ADR 0002, amended
        // 2026-11-06): re-derived through Commons before the UTXO set loads,
        // so their coins are held — in the balance, signable — rather than
        // stranded. New ones are found in the background (`previousKeyRefresh`).
        if (identitySubject !== null && !watchOnly) {
          try {
            await loadPreviousKeys(
              database,
              networkConfig,
              state.network,
              identitySubject,
              resolvedAccount,
            );
          } catch (previousError: unknown) {
            // Never a reason for the wallet not to open: those coins read as
            // stranded until the next refresh reaches their key.
            console.warn('[previous-keys] could not be loaded:', previousError);
          }
        }

        // Load persisted UTXOs from database — AFTER the HD cursors, the
        // multisig watch addresses and the social window are in place, because
        // a coin at an address none of them watches is stranded (kept apart,
        // never selected). A UTXO is confirmed iff it was stored with a real
        // block height (>= 0); mempool receives are stored with height -1 and
        // remain unconfirmed until their block is seen.
        await reloadUtxoSetFromDatabase();

        // Reconstruct the persisted transaction history into the display list.
        // The `transactions` table stores raw_hex + block metadata but not the
        // derived amount/address/type, so re-derive them the SAME way the SPV
        // receive path does. Without this, a wallet that received (or sent) FAIR
        // in a previous session shows an empty Activity list after unlock even
        // though the balance — restored from the persisted UTXOs above — is
        // correct. Spent inputs are priced from the full UTXO set (spent rows
        // survive with their value/address); confirmations use the persisted tip.
        const historyRows = await database.getTransactions(MAX_HISTORY_ROWS, 0);
        const prevoutByOutpoint = new Map<string, { value: bigint; address: string }>();
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
          strandedBalance: sumCoinValues(strandedUtxos),
          previousKeyBalance: currentPreviousKeyBalance(),
          transactions: restoredTransactions,
          activeWalletId: activeId,
          activeWalletName: activeWallet?.name ?? '',
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
          setNetworkStatus(set, 'wallet.network.resolvingDns');
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

          // Only a wallet this app generated can safely skip the chain below the
          // checkpoint anchor — a restored phrase may have received coins at any
          // height (see `sync-anchor.ts`).
          let startFromCheckpoint = false;
          if (activeId) {
            try {
              startFromCheckpoint = await isFreshlyCreatedWallet(activeId);
            } catch {
              // Unknown provenance: sync from genesis, never risk hiding funds.
            }
          }

          spvClient = new SPVClient({
            network: networkConfig,
            socketProvider,
            headerStore,
            initialKnownAddresses: initialPeers,
            startFromCheckpoint,
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
                  const message = err instanceof Error ? err.message : 'Unknown error';
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
            onPeerReady: (peer) => {
              // Cache every node that actually completed a handshake. Without
              // this the `peers` table only ever held manually-added entries and
              // each cold start had to re-resolve the DNS seeds before it could
              // dial anything.
              void database?.insertPeer(peer.host, peer.port, Number(peer.services)).catch(() => {
                // The cache is an optimisation: DNS seeds remain the fallback.
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

          setNetworkStatus(set, 'wallet.network.connecting');
          await spvClient.start();

          set({ chainHeight: spvClient.getChainHeight() });
          setNetworkStatus(set, 'wallet.network.waitingForPeers');

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
              setNetworkStatus(set, 'wallet.network.searchingForPeers');
            } else if (count === 1) {
              setNetworkStatus(set, 'wallet.network.connectedSingular');
            } else {
              setNetworkStatus(set, 'wallet.network.connectedPlural', {
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

            // Re-read the social-receive cursor on a bounded interval while
            // the wallet runs; the scheduler skips it until one is due.
            if (socialReceiveIdentityPublicKey) {
              socialResync.tick();
            }
            if (previousKeySubject) {
              previousKeyRefresh.tick();
            }
          }, 5000);
        } catch (spvError: unknown) {
          const spvMsg = spvError instanceof Error ? spvError.message : 'Unknown P2P error';
          setNetworkStatus(set, 'wallet.network.error', { message: spvMsg });
        }

        // Look at every watched social-receive index once the filter is up
        // (or P2P failed: the Explorer read does not need it), and re-read the
        // cursor the same way every later resync does.
        requestSocialReceiveResync();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown initialization error';
        set({ loading: false, error: message });
      }
    });
  },

  initializeFromIdentity: async (
    onReady?: () => void,
    subject: IdentitySubject = PERSONAL_SUBJECT,
    publishedPublicKey?: string | null,
  ): Promise<IdentityInitResult> => {
    // The IDENTITY-derived wallet needs the on-device keystore the identity key
    // lives in (`@oxy.so/core` keyManager -> expo-secure-store), and a browser
    // has none. `hasIdentityKeystore` answers that for the shell's capability
    // gate too, so the two cannot disagree.
    //
    // This is narrower than "the wallet does not work on web". The BIP39 and
    // watch-only paths below (`createNewWallet`, `importWallet`,
    // `importWatchOnly`) carry no platform gate and write through
    // `storage/kv-store.ts`, which has a real web branch — Peable's fork of
    // FAIRWallet deleted the create/restore SCREENS, not the capability. What a
    // browser genuinely cannot do is derive THIS seed, and therefore sign.
    if (!hasIdentityKeystore()) {
      return 'no-keystore';
    }
    // Captured BEFORE the derivation, which can wait on Commons over IPC: a
    // close (account switch) or lock meanwhile must not open this wallet.
    const epoch = lockEpoch;
    if (subject.kind === 'organization' && publishedPublicKey) {
      organizationPublishedKeys.set(subject.accountId, compressedPublicKeyHex(publishedPublicKey));
    }
    // An organization's seed derives from ITS key; `null` when this phone
    // cannot reach it, and never the person's key in its place (ADR 0061 D6).
    const seed = await deriveIdentitySeed(subject);
    if (!seed) {
      return 'no-identity';
    }
    let secret: string;
    try {
      secret = buildSeedSecret(seed);
    } finally {
      // The bytes are needed only to build the secret; do not keep them.
      seed.fill(0);
    }
    if (epoch !== lockEpoch) return 'superseded';
    const walletId = identityWalletIdOf(subject);
    // `initialize()` itself brings up social receive (gated on the wallet id
    // naming an identity wallet, which it always does here) — no separate
    // step needed.
    await get().initialize(secret, walletId, onReady, undefined, epoch);
    const after = get();
    if (epoch !== lockEpoch || (after.initialized && after.activeWalletId !== walletId)) {
      return 'superseded';
    }
    return 'initialized';
  },

  closeWallet: (): void => {
    activeWalletForgotten = true;
    set({ activeWalletId: null, activeWalletName: '' });
    get().lockWallet();
  },

  reloadActiveWallet: async (onReady?: () => void): Promise<void> => {
    // As in `initializeFromIdentity`: the seed derivation below can wait, and
    // a close (account switch) meanwhile must not bring this wallet back.
    const epoch = lockEpoch;
    try {
      const activeId =
        get().activeWalletId ?? (activeWalletForgotten ? null : await getActiveWalletId());
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
          throw new Error('Wallet xpub not found');
        }
        await get().initialize(marker, activeId, onReady, undefined, epoch);
        return;
      }
      // Identity-wallet-aware, mirroring switchPocket/switchNetwork: the
      // identity wallet's seed is re-derived from the Oxy identity (never
      // persisted) and can't be fetched via `getWalletMnemonic` like a BIP39
      // wallet's, so route through `resolveWalletSeed` instead of assuming a
      // stored mnemonic exists.
      const seed = await resolveWalletSeed(activeId, walletSeedDeps);
      await get().initialize(buildSeedSecret(seed), activeId, onReady, undefined, epoch);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to reload wallet';
      set({ loading: false, error: message });
    }
  },

  createWallet: async (): Promise<string> => {
    set({ loading: true, error: null });

    try {
      const mnemonic = await get().createNewWallet('Wallet 1');
      return mnemonic;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create wallet';
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
          throw new Error('Invalid mnemonic phrase');
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
        const message = err instanceof Error ? err.message : 'Failed to restore wallet';
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
    // The previous-key and stranded lines move with the balance.
    publishBalance(set);
  },

  getNewAddress: (): string => {
    if (!keyManager) {
      throw new Error('Wallet not initialized');
    }

    const derived = keyManager.getNextAddress();

    // Persist to database asynchronously
    if (database) {
      database
        .insertAddress(derived.address, derived.path, derived.index, false)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Unknown database error';
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

  sendTransaction: (toAddress: string, amount: bigint, feeRate: number): Promise<string> =>
    get().sendToRecipients([{ address: toAddress, amount }], feeRate),

  sendToRecipients: async (
    recipients: readonly SendRecipient[],
    feeRate: number,
  ): Promise<string> => {
    // Refused before anything is selected, reserved or signed.
    const invalid = invalidRecipients(recipients);
    if (invalid !== null) {
      set({ error: invalid });
      throw new Error(invalid);
    }
    const amount = recipients.reduce((sum, recipient) => sum + recipient.amount, 0n);
    const toAddress = recipients[0]?.address ?? '';
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
        throw new Error('Wallet not initialized');
      }
      if (get().isWatchOnly) {
        throw new Error('Watch-only wallets cannot send transactions');
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
      // And only coins this wallet can SIGN for: a coin under a previous
      // identity key this device cannot reach (stranded) or at a multisig
      // watch address would be selected largest-first and fail the whole send
      // at signing. A previous key it DOES reach signs its own inputs.
      const utxoRows = await localDatabase.getUnspentUTXOs();
      const candidates: UTXO[] = signableCoins(
        utxoRows
          .filter((row) => !localReservation.has(row.txid, row.vout))
          .map((row) => ({
            txid: row.txid,
            vout: row.vout,
            address: row.address,
            value: BigInt(row.value),
            scriptPubKey: hexToBytes(row.script_pub_key),
            blockHeight: row.block_height,
            confirmed: row.block_height >= 0,
          })),
        signerFor(localKeyManager),
      );

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
        recipientCount: recipients.length,
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
        throw new Error('Selected coins are being spent by another transaction in progress');
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
        recipients: recipients.map((recipient) => ({
          address: recipient.address,
          value: recipient.amount,
        })),
        changeAddress,
        feePerByte: BigInt(feeRate),
        network: localNetworkConfig,
      });

      // Sign each input with the corresponding private key
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        const utxo = selection.selected.find((u) => u.txid === input.txid && u.vout === input.vout);
        if (!utxo) {
          throw new Error(`UTXO not found for input ${input.txid}:${input.vout}`);
        }

        tx.inputs[i] = {
          ...tx.inputs[i],
          scriptSig: await signInputForAddress(localKeyManager, tx, i, utxo, localNetworkConfig),
        };
      }

      // Broadcast (P2P, at least one peer — H-1), mark the inputs spent and
      // persist the row with the REAL fee selection computed (M-1).
      const { txid, timestamp: now } = await broadcastAndRecord(
        tx,
        selection.fee,
        localSpvClient,
        localDatabase,
        localUtxoSet,
      );

      // Update UI state. A multi-recipient send is ONE history row for its
      // total, shown against its first recipient; the SPV history replaces it
      // with the chain's own view once the transaction is seen.
      const newTx: WalletTransaction = {
        txid,
        amount: -amount,
        address: toAddress,
        timestamp: now,
        confirmations: 0,
        type: 'send',
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
      const msg = err instanceof Error ? err.message : 'Transaction failed';
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
        state.chainHeight > 0 && u.blockHeight > 0 ? state.chainHeight - u.blockHeight + 1 : 0,
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
    const candidates: UTXO[] =
      utxoSet && keyManager
        ? signableCoins(
            utxoSet.getAllUTXOs().filter((u) => u.confirmed),
            signerFor(keyManager),
          )
        : [];
    return computeSendEstimate({
      candidates,
      targetValue: amount,
      feePerByte: feeRate,
      coinControl: get().selectedUTXOs,
      dustThreshold: networkConfig?.minRelayFee,
    });
  },

  planPreviousKeyMove: (feeRate: number) => {
    // A device whose key is not the account's current one would move the
    // coins onto a replaced key: add the current key in Commons first.
    if (get().socialReceiveKeyMismatch) return { kind: 'blocked' } as const;
    const candidates =
      utxoSet && keyManager && !keyManager.isWatchOnly()
        ? previousKeyCoins(
            utxoSet.getAllUTXOs().filter((u) => !utxoReservation.has(u.txid, u.vout)),
            previousKeyOf,
          )
        : [];
    return planPreviousKeyMove({
      coins: candidates,
      feePerByte: feeRate,
      dustThreshold: networkConfig?.minRelayFee ?? 0n,
    });
  },

  movePreviousKeyFunds: async (feeRate: number): Promise<string> => {
    // An explicit, prominent prompt, never automatic (ADR 0002, amended
    // 2026-11-06): a move spends a fee and the person should see it happen;
    // after a rotation forced by a compromise it must happen AT ONCE, because
    // whoever else holds the previous key can spend these coins too — the
    // move races them, and the prompt says so.
    const plan = get().planPreviousKeyMove(feeRate);
    if (plan.kind !== 'ready') {
      const message =
        plan.kind === 'blocked'
          ? 'Add your current key in Commons before moving these funds'
          : plan.kind === 'dust'
            ? 'These funds would not cover the network fee'
            : 'Nothing to move yet: funds under a previous key move once confirmed';
      set({ error: message });
      throw new Error(message);
    }
    set({ loading: true, error: null });
    // Local snapshots, as `sendToRecipients`: a lock mid-send defers its
    // teardown until `finally`, so keys are never wiped mid-signing (N-2).
    const localKeyManager = keyManager;
    const localDatabase = database;
    const localNetworkConfig = networkConfig;
    const localSpvClient = spvClient;
    const localUtxoSet = utxoSet;
    const localReservation = utxoReservation;
    let reservedHere: { txid: string; vout: number }[] = [];
    let sendStarted = false;
    try {
      if (!localKeyManager || !localDatabase || !localNetworkConfig) {
        throw new Error('Wallet not initialized');
      }
      sendInFlight = true;
      sendStarted = true;
      const outpoints = plan.inputs.map((utxo) => ({ txid: utxo.txid, vout: utxo.vout }));
      if (localReservation.reserve(outpoints) !== null) {
        throw new Error('Selected coins are being spent by another transaction in progress');
      }
      reservedHere = outpoints;

      // A FRESH address of the current key's wallet, persisted like any
      // receive address so the next open still watches it.
      const destination = localKeyManager.getNextAddress();
      await localDatabase.insertAddress(
        destination.address,
        destination.path,
        destination.index,
        false,
      );
      if (localSpvClient) {
        localSpvClient.setBloomFilter(buildCombinedBloomFilterHashes(localKeyManager));
      }
      // One output, no change: the builder's no-change fee is the plan's.
      const tx = buildTransaction({
        utxos: plan.inputs.map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value,
          scriptPubKey: utxo.scriptPubKey,
        })),
        recipients: [{ address: destination.address, value: plan.amount }],
        changeAddress: destination.address,
        feePerByte: BigInt(feeRate),
        network: localNetworkConfig,
      });
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        const utxo = plan.inputs.find((u) => u.txid === input?.txid && u.vout === input?.vout);
        if (!input || !utxo) throw new Error(`UTXO not found for input ${String(i)}`);
        tx.inputs[i] = {
          ...input,
          scriptSig: await signInputForAddress(localKeyManager, tx, i, utxo, localNetworkConfig),
        };
      }
      const { txid, timestamp } = await broadcastAndRecord(
        tx,
        plan.fee,
        localSpvClient,
        localDatabase,
        localUtxoSet,
      );
      set((state) => ({
        transactions: [
          {
            txid,
            amount: -plan.fee,
            address: destination.address,
            timestamp,
            confirmations: 0,
            type: 'send' as const,
          },
          ...state.transactions,
        ],
        loading: false,
        addresses: [...state.addresses, destination.address],
      }));
      publishBalance(set);
      return txid;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      set({ loading: false, error: msg });
      throw new Error(msg);
    } finally {
      localReservation.release(reservedHere);
      if (sendStarted) {
        sendInFlight = false;
        if (pendingLockTeardown) {
          const teardown = pendingLockTeardown;
          pendingLockTeardown = null;
          teardown();
        }
      }
    }
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
        network: 'mainnet',
        activeWalletId: null,
        activeWalletName: '',
        wallets: [],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to wipe wallet';
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
        // Read at APPLY time: a teardown deferred behind a send must not
        // resurrect a wallet `closeWallet` forgot in the meantime.
        activeWalletId: get().activeWalletId,
        activeWalletName: get().activeWalletName,
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
      const activeWallet = activeId ? wallets.find((w) => w.id === activeId) : undefined;

      set({
        wallets,
        activeWalletId: activeId,
        activeWalletName: activeWallet?.name ?? '',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load wallet list';
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
          throw new Error('Wallet mnemonic not found');
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
        const message = err instanceof Error ? err.message : 'Failed to switch wallet';
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
          error: err instanceof Error ? err.message : 'Failed to switch pocket',
        });
      }
    });
  },

  createPocket: async (
    name: string,
    image: string | undefined,
    color: string,
    goal?: number,
  ): Promise<number> => {
    const walletId = get().activeWalletId;
    if (!walletId) {
      throw new Error('No active wallet');
    }
    const list = await getPockets(walletId);
    const updated = addPocket(list, name.trim(), image, color, goal, Date.now());
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
    updates: { image?: string | null; color?: string; goal?: number | null },
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
      throw new Error('This pocket cannot be deleted');
    }
    const total = await readPocketUnspentTotal(walletId, account);
    if (total > 0n) {
      throw new Error('Move funds out of this pocket before deleting it');
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
      throw new Error('No active wallet');
    }
    if (state.isWatchOnly) {
      throw new Error('Watch-only wallets cannot move funds');
    }
    if (toAccount === state.activeAccount) {
      throw new Error('Choose a different destination pocket');
    }
    if (!networkConfig) {
      throw new Error('Wallet not initialized');
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
      const dest = resolveMoveDestinationAddress(seed, networkConfig, toAccount, nextIndex);
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

      // Save wallet mnemonic with wallet-specific key. `createdFresh` records
      // that WE generated this phrase, which is what lets the header sync start
      // at the checkpoint anchor instead of genesis.
      await saveWalletMnemonic(walletId, mnemonic);
      await addWalletToIndex(walletId, name, { createdFresh: true });
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
      const message = err instanceof Error ? err.message : 'Failed to create new wallet';
      set({ loading: false, error: message });
      throw new Error(message);
    }
  },

  importWallet: async (name: string, mnemonic: string): Promise<void> => {
    set({ loading: true, error: null });

    try {
      const trimmed = mnemonic.trim().toLowerCase();
      if (!validateMnemonic(trimmed)) {
        throw new Error('Invalid mnemonic phrase');
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
      const message = err instanceof Error ? err.message : 'Failed to import wallet';
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
            activeWalletName: '',
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
      const message = err instanceof Error ? err.message : 'Failed to delete wallet';
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
      const message = err instanceof Error ? err.message : 'Failed to rename wallet';
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
      const message = err instanceof Error ? err.message : 'Failed to import watch-only wallet';
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
        // Network-scope the social-receive watch set (finding: MEDIUM).
        // `databaseFileName` has no network component, so this DB file is
        // shared across mainnet/testnet for the active wallet+Pocket — a
        // set synced for the OLD network is a stale, wrong-network
        // address set for the new one (FairCoin mainnet/testnet addresses
        // encode different version bytes for the same underlying key). Clear
        // it here, BEFORE `resetWalletInternals()` nulls the module-level
        // `database` reference, so `setUpSocialReceive` pulls a fresh
        // set for `newNetwork` from inside the `initialize()` call further
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
              throw new Error('Wallet xpub not found');
            }
            await get().initialize(marker, state.activeWalletId);
          } else {
            const seed = await resolveWalletSeed(state.activeWalletId, walletSeedDeps);
            await get().initialize(buildSeedSecret(seed), state.activeWalletId);
          }
        } else {
          set({ loading: false });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to switch network';
        set({ loading: false, error: message });
      }
    });
  },

  // -------------------------------------------------------------------
  // Backup export/import
  // -------------------------------------------------------------------

  exportBackup: async (): Promise<string> => {
    if (!database) {
      throw new Error('Wallet not initialized');
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
      const message = err instanceof Error ? err.message : 'Failed to export backup';
      throw new Error(message);
    }
  },

  importBackup: async (json: string): Promise<void> => {
    if (!database) {
      throw new Error('Wallet not initialized');
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

      if (typeof backup.version !== 'number') {
        throw new Error('Invalid backup format: missing version');
      }

      // Import contacts
      if (Array.isArray(backup.contacts)) {
        for (const contact of backup.contacts) {
          const id = generateWalletId(); // reuse UUID generator
          await database.insertContact(id, contact.name, contact.address, contact.notes);
        }
      }

      // Import address labels
      if (Array.isArray(backup.addressLabels)) {
        for (const label of backup.addressLabels) {
          await database.setAddressLabel(label.address, label.label);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to import backup';
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
