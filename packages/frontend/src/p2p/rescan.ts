/**
 * Historical rescan for the FairCoin SPV wallet (SPV_AUDIT.md §6.3).
 *
 * A Bloom filter only causes peers to relay *future* matching transactions.
 * A restored wallet (or one whose filter was widened to a higher-index address)
 * therefore never sees payments that were already confirmed before the filter
 * loaded — e.g. funds already sitting at one of the wallet's addresses.
 *
 * The rescan walks the already-synced header chain from a start height up to
 * the tip and re-requests each block as a *filtered* (merkle) block via
 * `getdata`. Peers reply with a `merkleblock` (the partial Merkle tree of the
 * matches) followed by the matching `tx` messages, which flow through the SAME
 * receive path as live transactions — so discovered outputs are credited
 * exactly once. The receive path is idempotent (UTXOs are keyed by
 * `txid:vout`), so re-scanning a block that was already processed never
 * double-counts.
 *
 * Progress is persisted after every window so the scan resumes from where it
 * left off across app restarts.
 *
 * This module contains only the (pure, dependency-injected) scheduling logic;
 * the actual `getdata` send and merkleblock/tx handling live in the SPV client.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RescanProgress {
  /** Height the scan started from. */
  readonly startHeight: number;
  /** Next height that still needs scanning. */
  readonly nextHeight: number;
  /** Height the scan runs up to (inclusive). */
  readonly targetHeight: number;
  /** Whether the scan has reached the target. */
  readonly completed: boolean;
}

export interface RescanCallbacks {
  /**
   * Return the block hashes (internal byte order) for the given inclusive
   * height range, in ascending height order. Heights without a stored header
   * are skipped (the returned array may be shorter than the range).
   */
  getBlockHashesInRange(fromHeight: number, toHeight: number): Promise<Uint8Array[]>;
  /** Request the given block hashes as filtered (merkle) blocks from a peer. */
  requestMerkleBlocks(hashes: Uint8Array[]): Promise<boolean>;
  /** Persist progress so the scan can resume after a restart. */
  persist(progress: RescanProgress): Promise<void>;
  /** Wait for peers to answer the just-requested window before the next one. */
  waitForWindow(): Promise<void>;
  /** Whether the scan should keep running (false stops it cleanly). */
  isRunning(): boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Blocks requested per window. Keeps `getdata` messages and peer load bounded. */
export const DEFAULT_RESCAN_WINDOW = 200;

// ---------------------------------------------------------------------------
// Rescanner
// ---------------------------------------------------------------------------

export class Rescanner {
  private readonly callbacks: RescanCallbacks;
  private readonly windowSize: number;
  private running = false;

  constructor(callbacks: RescanCallbacks, windowSize = DEFAULT_RESCAN_WINDOW) {
    this.callbacks = callbacks;
    this.windowSize = Math.max(1, windowSize);
  }

  /** Whether a rescan is currently in progress. */
  get isActive(): boolean {
    return this.running;
  }

  /**
   * Run (or resume) a rescan over `[startHeight, targetHeight]`.
   *
   * @param startHeight  First height to scan (resume point if `resumeFrom` set).
   * @param targetHeight Last height to scan (usually the current chain tip).
   * @param resumeFrom   Optional next-height to resume from (from persisted state).
   * @returns The final progress (completed unless stopped or no peers).
   */
  async run(
    startHeight: number,
    targetHeight: number,
    resumeFrom?: number,
  ): Promise<RescanProgress> {
    if (this.running) {
      throw new Error('Rescan already in progress');
    }
    this.running = true;

    let next = resumeFrom !== undefined ? Math.max(resumeFrom, startHeight) : startHeight;

    try {
      if (targetHeight < startHeight) {
        const progress: RescanProgress = {
          startHeight,
          nextHeight: startHeight,
          targetHeight,
          completed: true,
        };
        await this.callbacks.persist(progress);
        return progress;
      }

      while (next <= targetHeight && this.callbacks.isRunning()) {
        const windowEnd = Math.min(next + this.windowSize - 1, targetHeight);
        const hashes = await this.callbacks.getBlockHashesInRange(next, windowEnd);

        if (hashes.length > 0) {
          const sent = await this.callbacks.requestMerkleBlocks(hashes);
          if (!sent) {
            // No peer available right now. Persist progress at the current
            // window so we resume here, and stop without marking complete.
            const progress: RescanProgress = {
              startHeight,
              nextHeight: next,
              targetHeight,
              completed: false,
            };
            await this.callbacks.persist(progress);
            return progress;
          }
          await this.callbacks.waitForWindow();
        }

        next = windowEnd + 1;

        const progress: RescanProgress = {
          startHeight,
          nextHeight: next,
          targetHeight,
          completed: next > targetHeight,
        };
        await this.callbacks.persist(progress);
      }

      return {
        startHeight,
        nextHeight: next,
        targetHeight,
        completed: next > targetHeight,
      };
    } finally {
      this.running = false;
    }
  }
}

/**
 * Pick the height a rescan should start from.
 *
 * Resumes from persisted progress when an incomplete scan exists for the same
 * target window; otherwise starts from the wallet birthday (or genesis when no
 * birthday is known). Never restarts a completed scan unless the tip advanced
 * past where it finished.
 *
 * @param persisted   Persisted progress, if any.
 * @param birthday    Wallet birthday height (0 / genesis if unknown).
 * @param chainTip    Current chain tip height.
 * @returns The start and resume heights, or null when nothing needs scanning.
 */
export function planRescan(
  persisted: RescanProgress | null,
  birthday: number,
  chainTip: number,
): { startHeight: number; resumeFrom: number; targetHeight: number } | null {
  const start = Math.max(0, birthday);
  if (chainTip < start) {
    return null;
  }

  if (persisted) {
    if (!persisted.completed && persisted.nextHeight <= chainTip) {
      // Resume the in-flight scan, extending the target to the latest tip.
      return {
        startHeight: persisted.startHeight,
        resumeFrom: persisted.nextHeight,
        targetHeight: chainTip,
      };
    }
    if (persisted.completed && persisted.targetHeight >= chainTip) {
      // Already fully scanned up to (or past) the tip — nothing to do.
      return null;
    }
    if (persisted.completed && persisted.targetHeight < chainTip) {
      // Catch up only the newly-synced range since the last completed scan.
      return {
        startHeight: persisted.targetHeight + 1,
        resumeFrom: persisted.targetHeight + 1,
        targetHeight: chainTip,
      };
    }
  }

  return { startHeight: start, resumeFrom: start, targetHeight: chainTip };
}
