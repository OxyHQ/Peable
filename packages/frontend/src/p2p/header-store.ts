/**
 * Bridges the SPV client's HeaderStore interface to our SQLite Database class.
 *
 * Both sides now speak raw bytes — the database stores 32-byte BLOBs — so this
 * is a straight field rename with no hex encoding on the sync hot path.
 */

import type { HeaderStore, StoredBlockHeader } from "./spv-client";
import type { Database, BlockHeaderRow } from "../storage/database";

// ---------------------------------------------------------------------------
// DatabaseHeaderStore
// ---------------------------------------------------------------------------

export class DatabaseHeaderStore implements HeaderStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getLatestHeader(): Promise<StoredBlockHeader | undefined> {
    const row = await this.db.getLatestHeader();
    if (!row) return undefined;
    return rowToStoredHeader(row);
  }

  async getHeaderByHash(hash: Uint8Array): Promise<StoredBlockHeader | undefined> {
    const row = await this.db.getHeaderByHash(hash);
    if (!row) return undefined;
    return rowToStoredHeader(row);
  }

  async getHeaderByHeight(height: number): Promise<StoredBlockHeader | undefined> {
    const row = await this.db.getHeaderByHeight(height);
    if (!row) return undefined;
    return rowToStoredHeader(row);
  }

  /**
   * Save headers using batch insert for performance.
   * During SPV sync, headers arrive in batches of 2,000.
   * Using a prepared statement inside a transaction is ~100x faster
   * than individual INSERT calls.
   */
  async saveHeaders(headers: StoredBlockHeader[]): Promise<void> {
    const rows: BlockHeaderRow[] = headers.map((h) => ({
      height: h.height,
      hash: h.hash,
      prev_hash: h.prevBlock,
      merkle_root: h.merkleRoot,
      timestamp: h.timestamp,
      bits: h.bits,
      nonce: h.nonce,
      version: h.version,
    }));
    await this.db.insertHeadersBatch(rows);
  }

  async getChainHeight(): Promise<number> {
    const latest = await this.db.getLatestHeader();
    if (!latest) return 0;
    return latest.height;
  }

  async deleteHeadersAboveHeight(height: number): Promise<void> {
    await this.db.deleteHeadersAboveHeight(height);
  }
}

// ---------------------------------------------------------------------------
// Conversion helper
// ---------------------------------------------------------------------------

function rowToStoredHeader(row: BlockHeaderRow): StoredBlockHeader {
  return {
    height: row.height,
    hash: row.hash,
    prevBlock: row.prev_hash,
    merkleRoot: row.merkle_root,
    timestamp: row.timestamp,
    bits: row.bits,
    nonce: row.nonce,
    version: row.version,
  };
}
