/**
 * SPV (Simplified Payment Verification) client for FairCoin.
 *
 * Orchestrates header-chain sync, Bloom filter management for address
 * monitoring, Merkle proof validation, and transaction broadcasting.
 */

import { sha256 } from "@noble/hashes/sha256";
import type { NetworkConfig, BlockHeader } from "@fairco.in/core";
import { bytesEqual, hashBlockHeader as quarkHashBlockHeader, getCheckpointHash, hexToBytes } from "@fairco.in/core";
import { BloomFilter } from "./bloom-filter";
import { validateMerkleProof } from "./merkle-proof";
import {
  validateHeaderChain,
  planChainUpdate,
  proofOfWorkLimit,
  lastPowBlock,
  HeaderValidationError,
  type HeaderChainAnchor,
  type ValidatedHeader,
} from "./header-validation";
import {
  Rescanner,
  DEFAULT_RESCAN_WINDOW,
  type RescanProgress,
} from "./rescan";
import {
  type BlockHeaderMsg,
  type InvItem,
  type MerkleBlockMsg,
  type ParsedTransaction,
  INV_TX,
  INV_BLOCK,
  INV_FILTERED_BLOCK,
  parseAddr,
  parseHeaders,
  parseInv,
  parseMerkleBlock,
  parseTx,
  serializeFilterLoad,
  serializeGetData,
  serializeGetBlocks,
} from "./messages";
import type { Peer, SocketProvider } from "./peer";
import {
  PeerManager,
  type PeerManagerConfig,
  type PeerEventSink,
} from "./peer-manager";
import type { NativeDnsResolver } from "./dns-seeds";
import { getSyncAnchor } from "./sync-anchor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredBlockHeader {
  hash: Uint8Array; // 32 bytes
  height: number;
  version: number;
  prevBlock: Uint8Array;
  merkleRoot: Uint8Array;
  timestamp: number;
  bits: number;
  nonce: number;
}

export interface HeaderStore {
  getLatestHeader(): Promise<StoredBlockHeader | undefined>;
  getHeaderByHash(hash: Uint8Array): Promise<StoredBlockHeader | undefined>;
  getHeaderByHeight(height: number): Promise<StoredBlockHeader | undefined>;
  saveHeaders(headers: StoredBlockHeader[]): Promise<void>;
  getChainHeight(): Promise<number>;
  /**
   * Delete every stored header strictly above `height`. Used when a longer
   * competing branch replaces the tip during a reorg.
   */
  deleteHeadersAboveHeight(height: number): Promise<void>;
}

export interface SPVClientConfig {
  network: NetworkConfig;
  socketProvider: SocketProvider;
  headerStore: HeaderStore;
  nativeDnsResolver?: NativeDnsResolver;
  /**
   * Optional telemetry sink for peer connectivity events (errors, disconnects).
   * Forwarded to the underlying {@link PeerManager}; defaults to a no-op so
   * connectivity is observable only when a consumer opts in (review finding L6).
   */
  onPeerEvent?: PeerEventSink;
  /**
   * Optional list of `host` addresses to seed the peer manager with before
   * the first DNS resolution round (N-5). Use it for the persisted
   * "good peers" cache and for addresses the user added manually via the
   * "Add Peer" UI — those rows in the `peers` table were previously dead
   * writes because the peer manager only learned addresses from DNS / on-wire
   * `addr` messages.
   */
  initialKnownAddresses?: readonly string[];
  /**
   * Start the header chain at the network's verified checkpoint anchor instead
   * of genesis, skipping tens of thousands of headers on first sync.
   *
   * ONLY safe for a wallet whose mnemonic this app generated: it cannot have
   * received coins before it existed. A restored or imported wallet must leave
   * this false, or payments below the anchor are invisible and the balance is
   * silently wrong. Ignored once the store already holds headers.
   */
  startFromCheckpoint?: boolean;
}

export interface SPVClientEvents {
  /**
   * Fired for every transaction delivered by a peer that matches the Bloom
   * filter (and for transactions inside matched merkle blocks).
   *
   * @param tx       Parsed transaction (inputs, outputs, raw bytes).
   * @param txid     Transaction id in display byte order (reversed double-SHA256).
   * @param blockHash Hash of the block that contains the tx, in the same byte
   *                  order the header store uses (internal/quark-hash order, as
   *                  produced by `hashBlockHeader`), or `undefined` for an
   *                  unconfirmed (mempool) transaction.
   */
  onTransaction?: (
    tx: ParsedTransaction,
    txid: string,
    blockHash: Uint8Array | undefined,
  ) => void;
  onBlockHeader?: (header: StoredBlockHeader) => void;
  onSyncProgress?: (progress: number) => void;
  /**
   * Fired when a longer competing chain orphans blocks above `forkHeight`,
   * BEFORE the new branch's headers are stored. The consumer must roll the
   * wallet (UTXO set, transactions) back to `forkHeight` so it never spends or
   * displays outputs that no longer exist on the winning chain.
   *
   * @param forkHeight Height of the last header common to both chains.
   * @param oldTipHeight Height of the tip that is being discarded.
   */
  onReorg?: (forkHeight: number, oldTipHeight: number) => Promise<void> | void;
  /**
   * Fired once per peer that completes the version handshake AND passes the
   * NODE_BLOOM service gate — i.e. an address that is genuinely usable for SPV
   * right now. The consumer persists these so the next cold start can dial
   * known-good nodes immediately instead of waiting on DNS seed resolution.
   */
  onPeerReady?: (peer: ReadyPeerInfo) => void;
}

/** Connection details of a peer that reached the ready state. */
export interface ReadyPeerInfo {
  readonly host: string;
  readonly port: number;
  /** Advertised service bitmask from the peer's `version` message. */
  readonly services: bigint;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCATOR_STEP_MULTIPLIER = 2;
const BLOOM_FALSE_POSITIVE_RATE = 0.0001;
/** Time to wait for peers to answer one rescan window of merkle-block requests. */
const RESCAN_WINDOW_DELAY_MS = 8000;
/** Delay before retrying `getblocks` when no peer is ready yet. */
const NO_PEER_RETRY_MS = 5000;
/** Extra window granted once before concluding a locator round made no progress. */
const SYNC_STALL_RETRY_MS = 15000;
/** How often {@link SPVClient.waitForBatch} samples the chain height. */
const BATCH_POLL_MS = 400;
/** Consecutive idle samples (no new block) that mark a merkle-block batch drained (~2s). */
const BATCH_IDLE_TICKS = 5;
/** Hard cap on how long one batch is awaited (~60s) before re-issuing `getblocks`. */
const BATCH_MAX_TICKS = 150;

// ---------------------------------------------------------------------------
// Utility: Quark hash of an 80-byte block header (FairCoin uses Quark, not SHA256d)
// ---------------------------------------------------------------------------

function hashBlockHeader(header: BlockHeaderMsg): Uint8Array {
  const coreHeader: BlockHeader = {
    version: header.version,
    prevHash: header.prevBlock,
    merkleRoot: header.merkleRoot,
    timestamp: header.timestamp,
    bits: header.bits,
    nonce: header.nonce,
  };
  return quarkHashBlockHeader(coreHeader);
}

/**
 * Build a block-locator hash list for `getheaders`.
 * Starts from tip and goes back with exponentially increasing steps.
 */
async function buildLocator(store: HeaderStore): Promise<Uint8Array[]> {
  const tip = await store.getChainHeight();
  if (tip <= 0) {
    return [];
  }

  const locator: Uint8Array[] = [];
  let step = 1;
  let height = tip;

  while (height > 0) {
    const header = await store.getHeaderByHeight(height);
    if (header) {
      locator.push(header.hash);
    }

    if (height === 0) {
      break;
    }

    height -= step;
    if (height < 0) {
      height = 0;
    }

    if (locator.length >= 10) {
      step *= LOCATOR_STEP_MULTIPLIER;
    }
  }

  // Always include genesis (height 0)
  const genesis = await store.getHeaderByHeight(0);
  if (genesis) {
    // Only add if not already the last entry
    const last = locator[locator.length - 1];
    if (!last || !bytesEqual(last, genesis.hash)) {
      locator.push(genesis.hash);
    }
  }

  return locator;
}

// ---------------------------------------------------------------------------
// SPVClient
// ---------------------------------------------------------------------------

export class SPVClient {
  private readonly headerStore: HeaderStore;
  private readonly peerManager: PeerManager;
  private readonly network: NetworkConfig;
  private readonly powLimit: bigint;
  private readonly startFromCheckpoint: boolean;

  private events: SPVClientEvents = {};
  private bloomFilter: BloomFilter | undefined;
  private syncing = false;
  private running = false;
  private chainHeight = 0;
  private syncTargetHeight = 0;
  // Serialises header-batch processing so a reorg rewind can never interleave
  // with another batch being applied (which would corrupt heights/balance).
  private headerProcessing: Promise<void> = Promise.resolve();

  // Track which block each expected transaction belongs to. Keyed by the tx
  // hash (internal byte order, hex). A `merkleblock` populates these
  // associations and the following `tx` messages consume them. Using a map
  // (rather than a single pending block) keeps associations correct when many
  // merkle blocks are requested at once — e.g. during a historical rescan —
  // and the per-block `tx` messages interleave.
  private pendingTxBlock: Map<string, Uint8Array> = new Map();

  // Historical rescan (SPV_AUDIT.md §6.3)
  private rescanner: Rescanner | undefined;

  constructor(config: SPVClientConfig) {
    this.headerStore = config.headerStore;
    this.network = config.network;
    this.powLimit = proofOfWorkLimit();
    this.startFromCheckpoint = config.startFromCheckpoint ?? false;

    const peerManagerConfig: PeerManagerConfig = {
      network: config.network,
      socketProvider: config.socketProvider,
      nativeDnsResolver: config.nativeDnsResolver,
      targetPeers: 8,
      onEvent: config.onPeerEvent,
      initialKnownAddresses: config.initialKnownAddresses,
    };

    this.peerManager = new PeerManager(peerManagerConfig);
    this.peerManager.onMessage(this.handlePeerMessage.bind(this));
    this.peerManager.onPeerReady(this.handlePeerReady.bind(this));
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start the SPV client: connect to peers and begin syncing.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    // Seed the genesis header (height 0) before anything else. The chain is
    // built from merkle blocks whose first entry links to genesis via
    // `prevBlock`; without genesis in the store there is no anchor and header
    // validation rejects block 1, so sync (and therefore receiving) never
    // starts.
    // One read of the tip serves all three startup steps: the corruption check,
    // the genesis/anchor seed, and the initial height. Each used to issue its
    // own `SELECT ... ORDER BY height DESC LIMIT 1` on the wallet-start path.
    const tip = await this.discardCorruptHeaderStore();
    const seeded = await this.ensureStartHeader(tip);
    this.chainHeight = seeded?.height ?? 0;

    await this.peerManager.start();
  }

  /**
   * Drop the whole header store if its tip does not re-hash to the id recorded
   * alongside it.
   *
   * `@fairco.in/core` 0.2.0–0.3.1 shipped a regressed Quark implementation that
   * computed the wrong id for every block. A wallet that synced against one of
   * those builds holds headers keyed by bogus hashes: once the correct hash is
   * restored, no incoming header's `prevBlock` can ever match the stored tip,
   * so `processHeadersResponse` rejects every batch as unconnected and sync
   * stalls silently and permanently.
   *
   * One hash of the tip is enough to detect it, and re-syncing headers is
   * cheap next to a wallet that never confirms another payment. Wallet data
   * (UTXOs, transactions, notes) is untouched: the rescan that follows the
   * re-sync re-derives confirmations from the rebuilt chain.
   */
  private async discardCorruptHeaderStore(): Promise<
    StoredBlockHeader | undefined
  > {
    const tip = await this.headerStore.getLatestHeader();
    // Genesis is seeded from network config rather than hashed, so it proves
    // nothing either way.
    if (!tip || tip.height === 0) return tip;

    const recomputed = hashBlockHeader({
      version: tip.version,
      prevBlock: tip.prevBlock,
      merkleRoot: tip.merkleRoot,
      timestamp: tip.timestamp,
      bits: tip.bits,
      nonce: tip.nonce,
      // Not part of the hashed 80 bytes; only the `headers` wire message
      // carries it.
      txCount: 0,
    });
    if (bytesEqual(recomputed, tip.hash)) return tip;

    await this.headerStore.deleteHeadersAboveHeight(-1);
    this.chainHeight = 0;
    return undefined;
  }

  /**
   * Persist the genesis header at height 0 if the store is empty. Its hash and
   * fields come straight from the network config; the stored hash is in the
   * internal (wire) byte order the header store and `prevBlock` linkage use —
   * i.e. the reverse of the display genesis hash.
   */
  private async ensureStartHeader(
    existing: StoredBlockHeader | undefined,
  ): Promise<StoredBlockHeader | undefined> {
    if (existing) {
      return existing;
    }

    // A wallet with no possible history starts at the verified checkpoint
    // anchor instead, skipping every header below it.
    if (this.startFromCheckpoint) {
      const anchor = getSyncAnchor(this.network.name);
      if (anchor) {
        await this.headerStore.saveHeaders([anchor]);
        return anchor;
      }
    }

    const genesis: StoredBlockHeader = {
      hash: hexToBytes(this.network.genesisHash).reverse(),
      height: 0,
      version: 1,
      prevBlock: new Uint8Array(32),
      merkleRoot: hexToBytes(this.network.genesisMerkle).reverse(),
      timestamp: this.network.genesisTime,
      bits: this.network.genesisBits,
      nonce: this.network.genesisNonce,
    };
    await this.headerStore.saveHeaders([genesis]);
    return genesis;
  }

  /**
   * Stop the SPV client and disconnect from all peers.
   */
  stop(): void {
    this.running = false;
    this.syncing = false;
    this.peerManager.stop();
  }

  /**
   * Called when a peer completes the version/verack handshake.
   * Sends our Bloom filter and begins header sync if not already syncing.
   */
  private handlePeerReady(peer: Peer): void {
    // Report the address so it can be cached for the next cold start. Emitted
    // before the filter/sync work so a throwing consumer can't stall the sync.
    if (this.events.onPeerReady) {
      this.events.onPeerReady({
        host: peer.host,
        port: peer.port,
        services: peer.services,
      });
    }

    // Send Bloom filter to the newly connected peer
    if (this.bloomFilter) {
      const filterPayload = serializeFilterLoad(
        this.bloomFilter.toBytes(),
        this.bloomFilter.numHashFuncs,
        this.bloomFilter.tweak,
        1, // BLOOM_UPDATE_ALL
      );
      peer.sendMessage("filterload", filterPayload);
    }

    // Begin chain sync on first ready peer
    if (this.running && !this.syncing) {
      void this.syncChain();
    }
  }

  /**
   * Register event handlers.
   */
  setEvents(events: SPVClientEvents): void {
    this.events = events;
  }

  /**
   * Sync the chain from peers using the legacy block-announcement protocol.
   *
   * FairCoin Core does not implement `getheaders`/`headers`. Instead we send
   * `getblocks` (a block locator); the peer replies with an `inv` of up to 500
   * block hashes. {@link processInv} requests each as a *filtered* (merkle)
   * block, and {@link processMerkleBlock} validates the proof, stores the block
   * header (advancing the chain), and tags the matching transactions with their
   * block. We then advance the locator and repeat until caught up.
   */
  async syncChain(): Promise<void> {
    if (this.syncing) {
      return;
    }
    this.syncing = true;

    try {
      this.syncTargetHeight = this.peerManager.getBestHeight();

      while (this.syncing && this.running) {
        const locator = await buildLocator(this.headerStore);
        const stopHash = new Uint8Array(32); // all zeros = to the tip

        // Only ask a peer that actually has blocks above our tip: a node that
        // is itself behind answers with nothing, which the loop below reads as
        // "caught up".
        const sent = this.peerManager.sendToOne(
          "getblocks",
          serializeGetBlocks(locator, stopHash),
          { minBestHeight: this.chainHeight + 1 },
        );
        if (!sent) {
          // No ready peers, wait and retry
          await delay(NO_PEER_RETRY_MS);
          continue;
        }

        // Wait for the inv'd merkle blocks to stream back and advance the chain.
        const heightBefore = this.chainHeight;
        await this.waitForBatch();

        // Update target from peers (they may have advanced)
        this.syncTargetHeight = Math.max(
          this.syncTargetHeight,
          this.peerManager.getBestHeight(),
        );

        if (this.chainHeight >= this.syncTargetHeight) {
          // Caught up
          break;
        }

        if (this.chainHeight === heightBefore) {
          // No progress this round — give the peer one more window, then stop.
          // A live `inv` for a freshly mined block will resume us via
          // processInv, so we do not need to spin here.
          await delay(SYNC_STALL_RETRY_MS);
          if (this.chainHeight === heightBefore) {
            break;
          }
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Wait for the current batch of merkle blocks to drain: poll the chain height
   * until it stops advancing for a short idle window, or a hard cap elapses.
   * Merkle blocks stream in and advance `chainHeight` asynchronously, so this
   * paces the locator loop without a fixed, wasteful sleep.
   */
  private async waitForBatch(): Promise<void> {
    let last = this.chainHeight;
    let idleTicks = 0;
    for (
      let tick = 0;
      tick < BATCH_MAX_TICKS && this.syncing && this.running;
      tick++
    ) {
      await delay(BATCH_POLL_MS);
      if (this.chainHeight > last) {
        last = this.chainHeight;
        idleTicks = 0;
      } else if (++idleTicks >= BATCH_IDLE_TICKS) {
        return;
      }
    }
  }

  /**
   * Create and send a Bloom filter for the given addresses to all peers.
   * Addresses should be pubkey hashes (20 bytes) or script hashes.
   */
  setBloomFilter(addresses: Uint8Array[]): void {
    this.bloomFilter = BloomFilter.forAddresses(addresses, BLOOM_FALSE_POSITIVE_RATE);

    const filterPayload = serializeFilterLoad(
      this.bloomFilter.toBytes(),
      this.bloomFilter.getNumHashFuncs(),
      this.bloomFilter.getTweak(),
      this.bloomFilter.getFlags(),
    );

    this.peerManager.broadcast("filterload", filterPayload);
  }

  /**
   * Broadcast a signed transaction to all connected peers.
   * Returns the txid (double-SHA256, hex, reversed for display) together with
   * the number of peers the `tx` message was actually delivered to. The
   * caller MUST check `peerCount`: if zero, the transaction was not handed off
   * to the network and should NOT be treated as sent (H-1).
   */
  broadcastTransaction(rawTx: Uint8Array): { txid: string; peerCount: number } {
    return broadcastTransactionToPeers(rawTx, this.peerManager.getReadyPeers());
  }

  /**
   * Get the current chain height.
   */
  getChainHeight(): number {
    return this.chainHeight;
  }

  /**
   * Get sync progress as a value between 0 and 1.
   */
  getSyncProgress(): number {
    if (this.syncTargetHeight <= 0) {
      return 0;
    }
    return Math.min(this.chainHeight / this.syncTargetHeight, 1);
  }

  /**
   * Get the underlying peer manager for advanced use.
   */
  getPeerManager(): PeerManager {
    return this.peerManager;
  }

  /** Whether a historical rescan is currently running. */
  isRescanning(): boolean {
    return this.rescanner?.isActive ?? false;
  }

  /**
   * Run (or resume) a historical rescan over `[fromHeight, toHeight]`,
   * re-requesting each stored block as a filtered (merkle) block so payments
   * confirmed before the Bloom filter loaded are discovered and credited
   * (SPV_AUDIT.md §6.3).
   *
   * The Bloom filter must already be set (peers filter the merkle blocks
   * against it). Matches flow through the normal `onTransaction` receive path,
   * which is idempotent, so a re-scan never double-counts.
   *
   * @param params.fromHeight  First height to scan.
   * @param params.toHeight    Last height to scan (inclusive).
   * @param params.resumeFrom  Optional resume point from persisted progress.
   * @param params.onProgress  Called after each window so the caller can persist.
   * @returns The final rescan progress.
   */
  async rescan(params: {
    fromHeight: number;
    toHeight: number;
    resumeFrom?: number;
    onProgress?: (progress: RescanProgress) => Promise<void> | void;
  }): Promise<RescanProgress> {
    if (this.rescanner?.isActive) {
      throw new Error("Rescan already in progress");
    }

    this.rescanner = new Rescanner(
      {
        getBlockHashesInRange: async (fromHeight, toHeight) => {
          const hashes: Uint8Array[] = [];
          for (let h = fromHeight; h <= toHeight; h++) {
            const header = await this.headerStore.getHeaderByHeight(h);
            if (header) {
              hashes.push(header.hash);
            }
          }
          return hashes;
        },
        requestMerkleBlocks: async (hashes) => {
          const items: InvItem[] = hashes.map((hash) => ({
            type: INV_FILTERED_BLOCK,
            hash,
          }));
          return this.peerManager.sendToOne("getdata", serializeGetData(items));
        },
        persist: async (progress) => {
          if (params.onProgress) {
            await params.onProgress(progress);
          }
        },
        waitForWindow: () => delay(RESCAN_WINDOW_DELAY_MS),
        isRunning: () => this.running,
      },
      DEFAULT_RESCAN_WINDOW,
    );

    return this.rescanner.run(
      params.fromHeight,
      params.toHeight,
      params.resumeFrom,
    );
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  private handlePeerMessage(peer: Peer, command: string, payload: Uint8Array): void {
    switch (command) {
      case "headers":
        // Serialise header batches: each batch (and any reorg rewind it
        // triggers) must fully apply before the next one starts, otherwise two
        // concurrent batches could assign overlapping heights or rewind a chain
        // mid-write and corrupt the balance.
        this.headerProcessing = this.headerProcessing
          .then(() => this.processHeadersResponse(payload))
          .catch(() => {
            // A batch failure is non-fatal: the sync loop re-requests from the
            // current (unchanged) tip. Swallow so the serial chain continues.
          });
        break;
      case "inv":
        this.processInv(peer, payload);
        break;
      case "merkleblock":
        this.processMerkleBlock(payload);
        break;
      case "tx":
        this.processTransaction(payload);
        break;
      case "addr":
        this.processAddr(payload);
        break;
      default:
        break;
    }
  }

  private async processHeadersResponse(payload: Uint8Array): Promise<void> {
    let headers: BlockHeaderMsg[];
    try {
      headers = parseHeaders(payload);
    } catch {
      // Malformed headers payload from peer — skip this batch and
      // allow the sync loop to request again from a different peer.
      return;
    }
    await this.applyHeaderBatch(headers);
  }

  /**
   * Validate and store a batch of block headers, advancing the tip (or
   * rewinding on a reorg). Shared by the legacy `headers` message path and the
   * merkle-block sync path (each merkle block carries its 80-byte header, fed
   * here as a one-element batch). Must be run serialised via `headerProcessing`
   * so batches never interleave.
   */
  private async applyHeaderBatch(headers: BlockHeaderMsg[]): Promise<void> {
    if (headers.length === 0) {
      return;
    }

    // -------------------------------------------------------------------
    // 1. Find where this batch connects to the chain we already have. The
    //    first header links to the tip (a simple extension) or to an earlier
    //    block we know (a competing branch / reorg).
    // -------------------------------------------------------------------
    const firstPrev = headers[0].prevBlock;
    const tip = await this.headerStore.getLatestHeader();

    let anchor: HeaderChainAnchor | undefined;
    if (!tip) {
      // Empty store: the batch must begin at genesis (validateHeaderChain
      // enforces the genesis hash). `anchor` stays undefined.
      anchor = undefined;
    } else if (bytesEqual(firstPrev, tip.hash)) {
      anchor = { hash: tip.hash, height: tip.height };
    } else {
      const connect = await this.headerStore.getHeaderByHash(firstPrev);
      if (!connect) {
        // The batch does not build on any header we know. This is an
        // unconnected chain from a misbehaving or out-of-sync peer; drop it.
        return;
      }
      anchor = { hash: connect.hash, height: connect.height };
    }

    // -------------------------------------------------------------------
    // 2. Validate the chain: prev-hash linkage, nBits sanity, checkpoints.
    //    Any failure rejects the WHOLE batch (we never store a partial or
    //    unverified chain).
    // -------------------------------------------------------------------
    let validated: ValidatedHeader[];
    try {
      validated = validateHeaderChain({
        headers,
        anchor,
        powLimit: this.powLimit,
        checkpointHashHex: (height) =>
          getCheckpointHash(height, this.network.name),
        genesisHashHex: this.network.genesisHash,
        lastPowBlockHeight: lastPowBlock(this.network.name),
      });
    } catch (err) {
      if (err instanceof HeaderValidationError) {
        // Invalid header chain from a peer — reject and let the sync loop
        // retry against another peer.
        return;
      }
      throw err;
    }

    // -------------------------------------------------------------------
    // 3. Decide extend vs reorg vs ignore. SPV cannot recompute Quark PoW
    //    reliably (SPV_AUDIT.md §4.1), so chain length is the work proxy: a
    //    competing branch must be strictly longer (and within maxReorgDepth)
    //    to win; ties keep the active chain.
    // -------------------------------------------------------------------
    const oldTipHeight = tip ? tip.height : -1;
    const newTipHeight = validated[validated.length - 1].height;
    const plan = planChainUpdate({
      anchorHeight: anchor ? anchor.height : -1,
      batchTipHeight: newTipHeight,
      currentTipHeight: oldTipHeight,
      maxReorgDepth: this.network.maxReorgDepth,
    });

    if (plan.action === "ignore") {
      return;
    }

    if (plan.action === "reorg") {
      // Roll the wallet back to the fork point BEFORE storing the new branch,
      // so balance/UTXOs never reflect orphaned blocks. The wallet's rewind is
      // atomic and also prunes orphaned headers; the explicit delete below is a
      // defensive no-op in that case and the authoritative prune when no
      // `onReorg` consumer is registered.
      if (this.events.onReorg) {
        await this.events.onReorg(plan.forkHeight, oldTipHeight);
      }
      await this.headerStore.deleteHeadersAboveHeight(plan.forkHeight);
    }

    // -------------------------------------------------------------------
    // 4. Persist the validated headers and advance the tip.
    // -------------------------------------------------------------------
    const toStore: StoredBlockHeader[] = validated.map((v) => ({
      hash: v.hash,
      height: v.height,
      version: v.header.version,
      prevBlock: v.header.prevBlock,
      merkleRoot: v.header.merkleRoot,
      timestamp: v.header.timestamp,
      bits: v.header.bits,
      nonce: v.header.nonce,
    }));

    await this.headerStore.saveHeaders(toStore);
    this.chainHeight = newTipHeight;

    const lastHeader = toStore[toStore.length - 1];
    if (lastHeader && this.events.onBlockHeader) {
      this.events.onBlockHeader(lastHeader);
    }
    if (this.events.onSyncProgress) {
      this.events.onSyncProgress(this.getSyncProgress());
    }
  }

  private processInv(peer: Peer, payload: Uint8Array): void {
    let items: InvItem[];
    try {
      items = parseInv(payload);
    } catch {
      // Malformed inv payload from peer — ignore this message.
      return;
    }

    // Request data for interesting items.
    const wanted: InvItem[] = [];

    for (const item of items) {
      if (item.type === INV_TX) {
        // A loose (mempool) transaction matching our filter — fetch it for
        // zero-conf display.
        wanted.push(item);
      } else if (item.type === INV_BLOCK || item.type === INV_FILTERED_BLOCK) {
        // Blocks are announced as `inv` MSG_BLOCK — both during `getblocks`
        // sync and when a new block is mined. Always fetch them as a *filtered*
        // (merkle) block so the peer returns just our matching transactions plus
        // the header and a proof. This single path drives both historical sync
        // and instant confirmation of a freshly mined block.
        wanted.push({ type: INV_FILTERED_BLOCK, hash: item.hash });
      }
    }

    if (wanted.length > 0) {
      const getDataPayload = serializeGetData(wanted);
      peer.sendMessage("getdata", getDataPayload);
    }
  }

  private processMerkleBlock(payload: Uint8Array): void {
    let merkleBlock: MerkleBlockMsg;
    try {
      merkleBlock = parseMerkleBlock(payload);
    } catch {
      // Malformed merkleblock from peer — skip this block.
      return;
    }

    // Validate Merkle proof and extract matched transaction hashes. A failure
    // here means the partial tree did not reconstruct the header's merkle root
    // (a misbehaving peer or corrupt data) — drop the whole block.
    let matchedHashes: Uint8Array[];
    try {
      matchedHashes = validateMerkleProof(merkleBlock);
    } catch {
      return;
    }

    // Every merkle block carries its full 80-byte header. Feed it through the
    // shared, serialised header pipeline so the chain advances (and heights are
    // assigned) even for blocks that contain none of our transactions — which
    // is the vast majority. Without this the chain would never move and no
    // payment could ever confirm.
    const header: BlockHeaderMsg = {
      version: merkleBlock.version,
      prevBlock: merkleBlock.prevBlock,
      merkleRoot: merkleBlock.merkleRoot,
      timestamp: merkleBlock.timestamp,
      bits: merkleBlock.bits,
      nonce: merkleBlock.nonce,
      txCount: 0,
    };
    this.headerProcessing = this.headerProcessing
      .then(() => this.applyHeaderBatch([header]))
      .catch(() => {
        // A single block failing to link is non-fatal: the sync loop re-issues
        // `getblocks` from the current tip. Swallow so the serial chain lives on.
      });

    if (matchedHashes.length === 0) {
      return;
    }

    // Record the block hash for each matched tx so the following `tx` messages
    // can be tagged with their containing block (drives confirmation).
    const blockHash = hashBlockHeader(header);
    for (const hash of matchedHashes) {
      this.pendingTxBlock.set(bytesToHex(hash), blockHash);
    }
  }

  private processTransaction(payload: Uint8Array): void {
    let tx: ParsedTransaction;
    try {
      tx = parseTx(payload);
    } catch {
      // Malformed transaction payload from peer — ignore.
      return;
    }

    // Compute txid. The internal (non-reversed) hash is used to match against
    // the pending merkle block associations; the reversed form is the canonical
    // display txid handed to listeners (same convention as `hashTransaction` in
    // @fairco.in/core and the block explorer).
    const txHash = sha256(sha256(tx.raw));
    const txHashHex = bytesToHex(txHash);
    const displayTxid = bytesToHexReversed(txHash);

    // A confirmed tx was announced by a merkle block: pop its block hash.
    // Absent association → an unconfirmed (mempool) tx.
    const blockHash = this.pendingTxBlock.get(txHashHex);
    if (blockHash !== undefined) {
      this.pendingTxBlock.delete(txHashHex);
    }

    if (this.events.onTransaction) {
      this.events.onTransaction(tx, displayTxid, blockHash);
    }
  }

  private processAddr(payload: Uint8Array): void {
    try {
      const addresses = parseAddr(payload);
      for (const addr of addresses) {
        const ipStr = extractIPv4FromMapped(addr.ip);
        if (ipStr) {
          this.peerManager.addKnownAddress(ipStr);
        }
      }
    } catch {
      // Malformed addr message from peer — ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function bytesToHexReversed(bytes: Uint8Array): string {
  let hex = "";
  for (let i = bytes.length - 1; i >= 0; i--) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Minimal peer surface that {@link broadcastTransactionToPeers} needs. Lets
 * tests drive the broadcast helper without spinning up a full {@link SPVClient}
 * / socket / peer-manager stack.
 */
export interface BroadcastTarget {
  sendMessage(command: string, payload: Uint8Array): void;
}

/**
 * Pure helper extracted from {@link SPVClient.broadcastTransaction} so the
 * "did this actually leave the wallet?" contract is unit-testable. Sends the
 * raw `tx` message to every peer and returns:
 *
 *   - `txid`     — the double-SHA256 hash in display order (reversed hex);
 *   - `peerCount` — how many peers actually accepted the message.
 *
 * Critically, a peer that throws while sending is NOT counted: the caller
 * (sendTransaction) must be able to trust `peerCount > 0` to mean "at least
 * one peer received the bytes", or it will mark UTXOs as spent for a
 * transaction that never reached the network (H-1).
 */
export function broadcastTransactionToPeers(
  rawTx: Uint8Array,
  readyPeers: readonly BroadcastTarget[],
): { txid: string; peerCount: number } {
  const txHash = sha256(sha256(rawTx));

  let delivered = 0;
  for (const peer of readyPeers) {
    try {
      peer.sendMessage("tx", rawTx);
      delivered++;
    } catch {
      // Skip peers that error mid-send; other peers can still relay.
    }
  }

  return {
    txid: bytesToHexReversed(txHash),
    peerCount: delivered,
  };
}

function extractIPv4FromMapped(ip: Uint8Array): string | undefined {
  // Check for IPv4-mapped IPv6: first 10 bytes 0x00, bytes 10-11 0xff
  if (ip.length !== 16) return undefined;

  let isV4Mapped = true;
  for (let i = 0; i < 10; i++) {
    if (ip[i] !== 0) {
      isV4Mapped = false;
      break;
    }
  }
  if (isV4Mapped && ip[10] === 0xff && ip[11] === 0xff) {
    return `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
  }

  return undefined;
}
