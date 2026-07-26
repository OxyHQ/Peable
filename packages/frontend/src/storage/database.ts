/**
 * SQLite database layer for FairCoin wallet persistent storage.
 * Uses expo-sqlite for cross-platform database access.
 *
 * Design decisions:
 * - WAL journal mode + NORMAL synchronous for optimal write performance
 * - All schema created in a single execAsync batch (one round-trip)
 * - UTXO values stored as TEXT to preserve bigint precision (avoids JS number overflow)
 * - Batch header insertion wrapped in transactions for SPV sync performance
 * - Compound indexes for common multi-column query patterns
 */

import * as SQLite from "expo-sqlite";
import { databaseFileName } from "./db-name";
import {
  HEADER_BLOB_MIGRATION_SQL,
  needsHeaderBlobMigration,
} from "./header-blob-migration";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface BlockHeaderRow {
  height: number;
  /**
   * 32 raw bytes, NOT hex. A block header is 80 bytes on the wire; storing its
   * three hashes as 64-character hex made each row ~400 bytes — roughly 5x the
   * data it represents, and ~27 MB for a synced mainnet chain. BLOB columns
   * hold the bytes the SPV client already works in, so nothing has to be
   * encoded or decoded on the hot sync path either.
   */
  hash: Uint8Array;
  prev_hash: Uint8Array;
  merkle_root: Uint8Array;
  timestamp: number;
  bits: number;
  nonce: number;
  version: number;
}

export interface TransactionRow {
  txid: string;
  raw_hex: string;
  block_height: number;
  block_hash: string;
  timestamp: number;
  fee: number;
  confirmed: number;
}

/**
 * UTXO row from the database.
 * `value` is stored as TEXT in SQLite and returned as string here
 * to preserve precision for amounts that exceed Number.MAX_SAFE_INTEGER.
 * Callers should convert to bigint: `BigInt(row.value)`.
 *
 * `spent_height` / `spent_txid` record *where* a UTXO was spent so a chain
 * reorg can precisely un-spend outputs whose spending transaction was orphaned.
 * `spent_height` is -1 when the spend is unconfirmed (mempool) and 0 when
 * unknown (legacy rows written before reorg tracking existed).
 */
export interface UTXORow {
  txid: string;
  vout: number;
  address: string;
  value: string;
  script_pub_key: string;
  spent: number;
  block_height: number;
  spent_height: number;
  spent_txid: string;
}

export interface AddressRow {
  address: string;
  path: string;
  index_num: number;
  is_change: number;
  used: number;
}

export interface SocialReceiveAddressRow {
  index_num: number;
  address: string;
  used: number;
}

export interface WatchAddressRow {
  address: string;
  redeem_script: string;
  label: string;
  created_at: number;
}

export interface PeerRow {
  host: string;
  port: number;
  last_seen: number;
  last_success: number;
  services: number;
}

export interface ContactRow {
  id: string;
  name: string;
  address: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface TxNoteRow {
  txid: string;
  note: string;
  updated_at: number;
}

export interface AddressLabelRow {
  address: string;
  label: string;
  updated_at: number;
}

export interface RecentRecipientRow {
  address: string;
  last_used: number;
  use_count: number;
}

/**
 * Persisted progress of a historical rescan. `next_height` is the next block
 * height to request; the scan is resumable from there across app restarts.
 */
export interface RescanStateRow {
  id: number;
  start_height: number;
  next_height: number;
  target_height: number;
  completed: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Schema (single SQL batch for initialization)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS block_headers (
    height INTEGER PRIMARY KEY,
    hash BLOB UNIQUE NOT NULL,
    prev_hash BLOB NOT NULL,
    merkle_root BLOB NOT NULL,
    timestamp INTEGER NOT NULL,
    bits INTEGER NOT NULL,
    nonce INTEGER NOT NULL,
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    txid TEXT PRIMARY KEY,
    raw_hex TEXT NOT NULL,
    block_height INTEGER NOT NULL,
    block_hash TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    fee INTEGER NOT NULL,
    confirmed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS utxos (
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    address TEXT NOT NULL,
    value TEXT NOT NULL,
    script_pub_key TEXT NOT NULL,
    spent INTEGER DEFAULT 0,
    block_height INTEGER NOT NULL,
    spent_height INTEGER NOT NULL DEFAULT 0,
    spent_txid TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (txid, vout)
  );

  CREATE TABLE IF NOT EXISTS addresses (
    address TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    index_num INTEGER NOT NULL,
    is_change INTEGER DEFAULT 0,
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS social_receive_addresses (
    index_num INTEGER PRIMARY KEY,
    address TEXT UNIQUE NOT NULL,
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS watch_addresses (
    address TEXT PRIMARY KEY,
    redeem_script TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS peers (
    host TEXT PRIMARY KEY,
    port INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    last_success INTEGER NOT NULL,
    services INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    notes TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tx_notes (
    txid TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS address_labels (
    address TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recent_recipients (
    address TEXT PRIMARY KEY,
    last_used INTEGER NOT NULL,
    use_count INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS rescan_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start_height INTEGER NOT NULL,
    next_height INTEGER NOT NULL,
    target_height INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  -- No explicit index on block_headers(hash): the UNIQUE constraint already
  -- creates one, and a second copy doubled the index cost on the largest
  -- table in the database for no lookup benefit.
  DROP INDEX IF EXISTS idx_block_headers_hash;
  CREATE INDEX IF NOT EXISTS idx_utxos_address ON utxos(address);
  CREATE INDEX IF NOT EXISTS idx_utxos_unspent ON utxos(spent, address);
  CREATE INDEX IF NOT EXISTS idx_utxos_block_height ON utxos(block_height);
  CREATE INDEX IF NOT EXISTS idx_transactions_block_height ON transactions(block_height);
  CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_addresses_change_used ON addresses(is_change, used);
  CREATE INDEX IF NOT EXISTS idx_social_receive_used ON social_receive_addresses(used);
  CREATE INDEX IF NOT EXISTS idx_contacts_address ON contacts(address);
  CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
`;

/**
 * Columns added after the initial release. `CREATE TABLE IF NOT EXISTS` never
 * alters an existing table, so for wallets created before reorg tracking we add
 * the columns idempotently. SQLite has no "ADD COLUMN IF NOT EXISTS", so each
 * statement is run individually and a duplicate-column error is ignored.
 */
const UTXO_MIGRATION_COLUMNS: readonly { name: string; ddl: string }[] = [
  {
    name: "spent_height",
    ddl: "ALTER TABLE utxos ADD COLUMN spent_height INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "spent_txid",
    ddl: "ALTER TABLE utxos ADD COLUMN spent_txid TEXT NOT NULL DEFAULT ''",
  },
];

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class Database {
  private readonly db: SQLite.SQLiteDatabase;

  private constructor(db: SQLite.SQLiteDatabase) {
    this.db = db;
  }

  /**
   * Open a database for a wallet + Pocket. `account` (BIP44 account index)
   * partitions each Pocket into its own file; account 0 keeps the legacy name.
   */
  static async open(walletId?: string, account = 0): Promise<Database> {
    const dbName = databaseFileName(walletId, account);
    const db = await SQLite.openDatabaseAsync(dbName);
    const instance = new Database(db);
    await instance.initialize();
    return instance;
  }

  /**
   * Create all tables and indexes in a single batch.
   * Using execAsync with the full schema string is a single native call,
   * much faster than 16+ individual calls.
   */
  private async initialize(): Promise<void> {
    // Header storage must be converted BEFORE the schema batch: on a legacy
    // wallet the `block_headers` table already exists with TEXT columns, and
    // `CREATE TABLE IF NOT EXISTS` would leave it that way.
    await this.migrateHeaderHashesToBlob();
    await this.db.execAsync(SCHEMA_SQL);
    await this.migrateUtxoColumns();
  }

  /**
   * Convert a legacy `block_headers` table from 64-character hex TEXT to raw
   * 32-byte BLOBs.
   *
   * Hex tripled the cost of the only table that grows without bound: ~400 bytes
   * per row for an 80-byte header, ~27 MB for a synced mainnet chain. The
   * conversion is a single `unhex()` pass inside one transaction (SQLite 3.41+;
   * expo-sqlite ships 3.49+), so it is atomic — a failure mid-way rolls back
   * and leaves the old table intact.
   *
   * No-op when the table is absent (fresh wallet) or already BLOB.
   */
  private async migrateHeaderHashesToBlob(): Promise<void> {
    const columns = await this.db.getAllAsync<{ name: string; type: string }>(
      "SELECT name, type FROM pragma_table_info('block_headers')",
    );
    // Absent table → nothing to migrate; already BLOB → nothing to do.
    const hashColumn = columns.find((c) => c.name === "hash");
    if (!needsHeaderBlobMigration(hashColumn?.type)) return;

    await this.db.withTransactionAsync(async () => {
      await this.db.execAsync(HEADER_BLOB_MIGRATION_SQL);
    });

    // DROP TABLE only frees pages for reuse; without this the file keeps the
    // old size on disk and the user sees none of the ~15 MB back. VACUUM
    // cannot run inside a transaction, hence its position here. Best-effort:
    // the data is already correct, reclaiming space is not worth failing boot.
    try {
      await this.db.execAsync("VACUUM");
    } catch {
      // Left for the next VACUUM opportunity.
    }
  }

  /**
   * Add reorg-tracking columns to the `utxos` table for databases created
   * before they existed. Idempotent: an "duplicate column" error means the
   * column is already present and is safely ignored; any other error is
   * surfaced.
   */
  private async migrateUtxoColumns(): Promise<void> {
    const existing = await this.db.getAllAsync<{ name: string }>(
      "SELECT name FROM pragma_table_info('utxos')",
    );
    const present = new Set(existing.map((c) => c.name));
    for (const column of UTXO_MIGRATION_COLUMNS) {
      if (present.has(column.name)) {
        continue;
      }
      await this.db.execAsync(column.ddl);
    }

    // The `spent_height` index lives here, NOT in SCHEMA_SQL, because it depends
    // on the migrated `spent_height` column. On a wallet created before reorg
    // tracking, the column is added just above; creating the index inside the
    // schema batch (which runs before this migration) would fail the whole batch
    // with "no such column: spent_height" and abort wallet initialization.
    await this.db.execAsync(
      "CREATE INDEX IF NOT EXISTS idx_utxos_spent_height ON utxos(spent_height)",
    );
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }

  /**
   * Run multiple writes atomically. If any statement fails,
   * all changes are rolled back.
   */
  async withTransaction(fn: () => Promise<void>): Promise<void> {
    await this.db.withTransactionAsync(fn);
  }

  // -----------------------------------------------------------------------
  // Block headers
  // -----------------------------------------------------------------------

  async insertHeader(header: BlockHeaderRow): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO block_headers
        (height, hash, prev_hash, merkle_root, timestamp, bits, nonce, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      header.height,
      header.hash,
      header.prev_hash,
      header.merkle_root,
      header.timestamp,
      header.bits,
      header.nonce,
      header.version,
    );
  }

  /**
   * Insert multiple headers in a single transaction.
   * Critical for SPV sync performance where thousands of headers
   * arrive in rapid succession.
   */
  async insertHeadersBatch(headers: BlockHeaderRow[]): Promise<void> {
    if (headers.length === 0) return;
    await this.db.withTransactionAsync(async () => {
      const stmt = await this.db.prepareAsync(
        `INSERT OR REPLACE INTO block_headers
          (height, hash, prev_hash, merkle_root, timestamp, bits, nonce, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const h of headers) {
          await stmt.executeAsync(
            h.height,
            h.hash,
            h.prev_hash,
            h.merkle_root,
            h.timestamp,
            h.bits,
            h.nonce,
            h.version,
          );
        }
      } finally {
        await stmt.finalizeAsync();
      }
    });
  }

  async getLatestHeader(): Promise<BlockHeaderRow | null> {
    const row = await this.db.getFirstAsync<BlockHeaderRow>(
      "SELECT * FROM block_headers ORDER BY height DESC LIMIT 1",
    );
    return row ?? null;
  }

  async getHeaderByHeight(height: number): Promise<BlockHeaderRow | null> {
    const row = await this.db.getFirstAsync<BlockHeaderRow>(
      "SELECT * FROM block_headers WHERE height = ?",
      height,
    );
    return row ?? null;
  }

  async getHeaderByHash(hash: Uint8Array): Promise<BlockHeaderRow | null> {
    const row = await this.db.getFirstAsync<BlockHeaderRow>(
      "SELECT * FROM block_headers WHERE hash = ?",
      hash,
    );
    return row ?? null;
  }

  async getHeaderCount(): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) as count FROM block_headers",
    );
    return row?.count ?? 0;
  }

  // -----------------------------------------------------------------------
  // Transactions
  // -----------------------------------------------------------------------

  async insertTransaction(tx: TransactionRow): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO transactions
        (txid, raw_hex, block_height, block_hash, timestamp, fee, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      tx.txid,
      tx.raw_hex,
      tx.block_height,
      tx.block_hash,
      tx.timestamp,
      tx.fee,
      tx.confirmed,
    );
  }

  async getTransaction(txid: string): Promise<TransactionRow | null> {
    const row = await this.db.getFirstAsync<TransactionRow>(
      "SELECT * FROM transactions WHERE txid = ?",
      txid,
    );
    return row ?? null;
  }

  async getTransactions(
    limit: number,
    offset: number,
  ): Promise<TransactionRow[]> {
    return this.db.getAllAsync<TransactionRow>(
      "SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ? OFFSET ?",
      limit,
      offset,
    );
  }

  /**
   * Find transactions related to an address (both sends and receives).
   * Checks both UTXO outputs (received) and inputs (spent from this address).
   */
  async getTransactionsForAddress(address: string): Promise<TransactionRow[]> {
    return this.db.getAllAsync<TransactionRow>(
      `SELECT DISTINCT t.* FROM transactions t
       WHERE t.txid IN (
         SELECT txid FROM utxos WHERE address = ?
       )
       ORDER BY t.timestamp DESC`,
      address,
    );
  }

  async updateTransactionConfirmation(
    txid: string,
    blockHeight: number,
    blockHash: string,
    confirmed: number,
  ): Promise<void> {
    await this.db.runAsync(
      `UPDATE transactions SET block_height = ?, block_hash = ?, confirmed = ?
       WHERE txid = ?`,
      blockHeight,
      blockHash,
      confirmed,
      txid,
    );
  }

  // -----------------------------------------------------------------------
  // UTXOs
  // -----------------------------------------------------------------------

  async insertUTXO(utxo: {
    txid: string;
    vout: number;
    address: string;
    value: bigint | string;
    script_pub_key: string;
    spent?: number;
    block_height: number;
    spent_height?: number;
    spent_txid?: string;
  }): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO utxos
        (txid, vout, address, value, script_pub_key, spent, block_height, spent_height, spent_txid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      utxo.txid,
      utxo.vout,
      utxo.address,
      String(utxo.value),
      utxo.script_pub_key,
      utxo.spent ?? 0,
      utxo.block_height,
      utxo.spent_height ?? 0,
      utxo.spent_txid ?? "",
    );
  }

  /**
   * Mark a UTXO as spent, recording the spending transaction and the height it
   * was spent at (-1 if unconfirmed) so a later reorg can un-spend it precisely.
   */
  async markUTXOSpent(
    txid: string,
    vout: number,
    spendingTxid = "",
    spentHeight = -1,
  ): Promise<void> {
    await this.db.runAsync(
      "UPDATE utxos SET spent = 1, spent_txid = ?, spent_height = ? WHERE txid = ? AND vout = ?",
      spendingTxid,
      spentHeight,
      txid,
      vout,
    );
  }

  async getUnspentUTXOs(): Promise<UTXORow[]> {
    return this.db.getAllAsync<UTXORow>(
      "SELECT * FROM utxos WHERE spent = 0",
    );
  }

  /**
   * Every stored UTXO, spent AND unspent. Used at init to price the inputs of
   * historical send transactions when reconstructing the display history: a
   * spent input's value/address is only known from the (now-spent) row it
   * consumed. `getUnspentUTXOs` alone cannot value those, so history
   * reconstruction reads the full set through this method.
   */
  async getAllUTXOs(): Promise<UTXORow[]> {
    return this.db.getAllAsync<UTXORow>("SELECT * FROM utxos");
  }

  /**
   * Update the recorded block height of a stored UTXO. Used by the
   * confirmation-reconciler when a transaction was received before its
   * containing header was known (block_height was persisted as -1) and we
   * later learn the real height (H-3).
   */
  async updateUTXOBlockHeight(
    txid: string,
    vout: number,
    blockHeight: number,
  ): Promise<void> {
    await this.db.runAsync(
      "UPDATE utxos SET block_height = ? WHERE txid = ? AND vout = ?",
      blockHeight,
      txid,
      vout,
    );
  }

  /**
   * Update the spent_height of an already-spent UTXO whose spend height was
   * still unknown (< 0). Used when our own outgoing transaction confirms: at
   * broadcast time we marked the input as spent with height -1 (mempool);
   * once the spend lands in a block we must persist the real height so a
   * future reorg above that block can correctly un-spend the UTXO (H-4).
   *
   * Deliberately scoped to `spent = 1 AND spent_height < 0` so it can never
   * touch unspent rows or overwrite an already-resolved spend height.
   */
  async updateUTXOSpentHeight(
    txid: string,
    vout: number,
    spentHeight: number,
  ): Promise<void> {
    await this.db.runAsync(
      `UPDATE utxos SET spent_height = ?
        WHERE txid = ? AND vout = ? AND spent = 1 AND spent_height < 0`,
      spentHeight,
      txid,
      vout,
    );
  }

  /**
   * Return every UTXO row whose stored block_height is < 0 (the tx was
   * received ahead of its merkle block during sync) together with the
   * block_hash recorded for that tx in the `transactions` table, so the caller
   * can attempt to resolve the real height once the header lands.
   */
  async getPendingHeightUTXOs(): Promise<
    { txid: string; vout: number; block_hash: string }[]
  > {
    return this.db.getAllAsync<{
      txid: string;
      vout: number;
      block_hash: string;
    }>(
      `SELECT u.txid AS txid, u.vout AS vout, t.block_hash AS block_hash
         FROM utxos u
         JOIN transactions t ON t.txid = u.txid
        WHERE u.block_height < 0
          AND t.block_hash IS NOT NULL
          AND t.block_hash <> ''`,
    );
  }

  /**
   * Return every tx row whose stored block_height is < 0 (received ahead of
   * its header during sync) together with the recorded block_hash. Used by
   * the confirmation-reconciler to promote unconfirmed history rows once the
   * header lands.
   */
  async getPendingHeightTransactions(): Promise<
    { txid: string; block_hash: string }[]
  > {
    return this.db.getAllAsync<{ txid: string; block_hash: string }>(
      `SELECT txid, block_hash FROM transactions
        WHERE block_height < 0
          AND block_hash IS NOT NULL
          AND block_hash <> ''`,
    );
  }

  async getUnspentUTXOsForAddress(address: string): Promise<UTXORow[]> {
    return this.db.getAllAsync<UTXORow>(
      "SELECT * FROM utxos WHERE spent = 0 AND address = ?",
      address,
    );
  }

  async getUTXOCount(): Promise<{ total: number; unspent: number }> {
    const total = await this.db.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) as count FROM utxos",
    );
    const unspent = await this.db.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) as count FROM utxos WHERE spent = 0",
    );
    return {
      total: total?.count ?? 0,
      unspent: unspent?.count ?? 0,
    };
  }

  // -----------------------------------------------------------------------
  // Reorg rewind
  //
  // When a better chain orphans blocks above `forkHeight`, every wallet effect
  // that those blocks caused must be undone atomically:
  //   1. UTXOs *created* in an orphaned block are deleted (they no longer
  //      exist; if the same output reappears in the new chain the receive path
  //      re-adds it).
  //   2. UTXOs *spent* by a transaction in an orphaned block are restored to
  //      unspent (the spend no longer happened on the winning chain).
  //   3. Orphaned headers are deleted so the new branch can take their heights.
  // -----------------------------------------------------------------------

  /**
   * Roll the wallet back to `forkHeight`, undoing all UTXO and header effects of
   * orphaned blocks above it. Runs in a single transaction so the balance can
   * never be observed half-rewound.
   *
   * The UTXO rules here are the exact SQL translation of `computeReorgRewind`
   * in `src/wallet/reorg-rewind.ts` (the unit-tested specification): delete
   * outputs created above the fork, restore outputs whose spend was orphaned.
   *
   * @returns Counts of the changes applied (for logging / event payloads).
   */
  async rewindToHeight(
    forkHeight: number,
  ): Promise<{ deletedUtxos: number; restoredUtxos: number; deletedHeaders: number }> {
    let deletedUtxos = 0;
    let restoredUtxos = 0;
    let deletedHeaders = 0;

    await this.db.withTransactionAsync(async () => {
      const createdAbove = await this.db.getFirstAsync<{ count: number }>(
        "SELECT COUNT(*) as count FROM utxos WHERE block_height > ?",
        forkHeight,
      );
      deletedUtxos = createdAbove?.count ?? 0;

      const spentAbove = await this.db.getFirstAsync<{ count: number }>(
        "SELECT COUNT(*) as count FROM utxos WHERE spent = 1 AND spent_height > ?",
        forkHeight,
      );
      restoredUtxos = spentAbove?.count ?? 0;

      // 2. Un-spend outputs whose spending tx was orphaned. Do this BEFORE the
      //    delete so we don't resurrect an output that was itself created above
      //    the fork (those are removed in step 1).
      await this.db.runAsync(
        "UPDATE utxos SET spent = 0, spent_txid = '', spent_height = 0 WHERE spent = 1 AND spent_height > ?",
        forkHeight,
      );

      // 1. Delete outputs created in orphaned blocks.
      await this.db.runAsync(
        "DELETE FROM utxos WHERE block_height > ?",
        forkHeight,
      );

      // Orphaned transactions: drop them. If they re-confirm on the new chain
      // the merkle-block receive path re-inserts them.
      await this.db.runAsync(
        "DELETE FROM transactions WHERE block_height > ?",
        forkHeight,
      );

      const headerCount = await this.db.getFirstAsync<{ count: number }>(
        "SELECT COUNT(*) as count FROM block_headers WHERE height > ?",
        forkHeight,
      );
      deletedHeaders = headerCount?.count ?? 0;

      // 3. Delete orphaned headers.
      await this.db.runAsync(
        "DELETE FROM block_headers WHERE height > ?",
        forkHeight,
      );
    });

    return { deletedUtxos, restoredUtxos, deletedHeaders };
  }

  /**
   * Delete all stored headers strictly above `height` (without touching UTXOs).
   * Used by the SPV client when accepting a longer competing branch.
   */
  async deleteHeadersAboveHeight(height: number): Promise<void> {
    await this.db.runAsync(
      "DELETE FROM block_headers WHERE height > ?",
      height,
    );
  }

  // -----------------------------------------------------------------------
  // Rescan state (resumable historical scan)
  // -----------------------------------------------------------------------

  async getRescanState(): Promise<RescanStateRow | null> {
    const row = await this.db.getFirstAsync<RescanStateRow>(
      "SELECT * FROM rescan_state WHERE id = 1",
    );
    return row ?? null;
  }

  async saveRescanState(state: {
    start_height: number;
    next_height: number;
    target_height: number;
    completed: number;
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `INSERT OR REPLACE INTO rescan_state
        (id, start_height, next_height, target_height, completed, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      state.start_height,
      state.next_height,
      state.target_height,
      state.completed,
      now,
    );
  }

  // -----------------------------------------------------------------------
  // Addresses
  // -----------------------------------------------------------------------

  async insertAddress(
    address: string,
    path: string,
    index: number,
    isChange: boolean,
  ): Promise<void> {
    await this.db.runAsync(
      `INSERT OR IGNORE INTO addresses
        (address, path, index_num, is_change, used)
       VALUES (?, ?, ?, ?, 0)`,
      address,
      path,
      index,
      isChange ? 1 : 0,
    );
  }

  async getAddresses(): Promise<AddressRow[]> {
    return this.db.getAllAsync<AddressRow>(
      "SELECT * FROM addresses ORDER BY is_change, index_num",
    );
  }

  async getUnusedAddress(isChange: boolean): Promise<AddressRow | null> {
    const row = await this.db.getFirstAsync<AddressRow>(
      "SELECT * FROM addresses WHERE is_change = ? AND used = 0 ORDER BY index_num ASC LIMIT 1",
      isChange ? 1 : 0,
    );
    return row ?? null;
  }

  async markAddressUsed(address: string): Promise<void> {
    await this.db.runAsync(
      "UPDATE addresses SET used = 1 WHERE address = ?",
      address,
    );
  }

  // -----------------------------------------------------------------------
  // Watch addresses (non-HD, e.g. multisig)
  // -----------------------------------------------------------------------

  async insertWatchAddress(
    address: string,
    redeemScript: string,
    label: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `INSERT OR IGNORE INTO watch_addresses (address, redeem_script, label, created_at)
       VALUES (?, ?, ?, ?)`,
      address,
      redeemScript,
      label,
      now,
    );
  }

  async getWatchAddresses(): Promise<WatchAddressRow[]> {
    return this.db.getAllAsync<WatchAddressRow>(
      "SELECT * FROM watch_addresses ORDER BY created_at",
    );
  }

  /**
   * The next unused derivation index for a chain: one past the highest *used*
   * index in the database (0 if none are used). Used to restore the BIP44
   * cursor on startup so used addresses are never re-issued (SPV_AUDIT.md §4.5).
   */
  async getNextUnusedIndex(isChange: boolean): Promise<number> {
    const row = await this.db.getFirstAsync<{ max_used: number | null }>(
      "SELECT MAX(index_num) as max_used FROM addresses WHERE is_change = ? AND used = 1",
      isChange ? 1 : 0,
    );
    if (row?.max_used == null) {
      return 0;
    }
    return row.max_used + 1;
  }

  // -----------------------------------------------------------------------
  // Social-receive addresses (spec §4.3 — Oxy-identity-derived branch,
  // parallel to the private BIP44 spending tree above)
  // -----------------------------------------------------------------------

  /**
   * Persist a batch of derived social-receive addresses. `INSERT OR IGNORE`
   * makes this idempotent: re-deriving and re-inserting an already-persisted
   * index is a safe no-op, so callers never need to check existence first.
   */
  async insertSocialReceiveAddresses(
    rows: { index: number; address: string }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db.withTransactionAsync(async () => {
      const stmt = await this.db.prepareAsync(
        `INSERT OR IGNORE INTO social_receive_addresses (index_num, address, used)
         VALUES (?, ?, 0)`,
      );
      try {
        for (const row of rows) {
          await stmt.executeAsync(row.index, row.address);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    });
  }

  async getSocialReceiveAddresses(): Promise<SocialReceiveAddressRow[]> {
    return this.db.getAllAsync<SocialReceiveAddressRow>(
      "SELECT * FROM social_receive_addresses ORDER BY index_num ASC",
    );
  }

  async markSocialReceiveAddressUsed(address: string): Promise<void> {
    await this.db.runAsync(
      "UPDATE social_receive_addresses SET used = 1 WHERE address = ?",
      address,
    );
  }

  /**
   * The highest social-receive index marked used, or -1 if none are used yet.
   * Mirrors `getNextUnusedIndex`'s role for the private spending tree: the
   * caller extends the watched window to stay `SOCIAL_RECEIVE_GAP_LIMIT`
   * ahead of this value.
   */
  async getHighestUsedSocialReceiveIndex(): Promise<number> {
    const row = await this.db.getFirstAsync<{ max_used: number | null }>(
      "SELECT MAX(index_num) as max_used FROM social_receive_addresses WHERE used = 1",
    );
    return row?.max_used ?? -1;
  }

  /**
   * Drop every persisted social-receive address. `databaseFileName` has no
   * network component, so this DB file is shared across mainnet/testnet for
   * a given wallet+Pocket — a window derived on one network is a stale,
   * wrong-network address set on the other. Called on `switchNetwork` so the
   * next `setUpSocialReceive` re-derives a fresh window for the new network
   * (finding: network-scope the social-receive window, MEDIUM).
   */
  async clearSocialReceiveAddresses(): Promise<void> {
    await this.db.runAsync("DELETE FROM social_receive_addresses");
  }

  // -----------------------------------------------------------------------
  // Peers
  // -----------------------------------------------------------------------

  async insertPeer(
    host: string,
    port: number,
    services: number,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `INSERT OR REPLACE INTO peers
        (host, port, last_seen, last_success, services)
       VALUES (?, ?, ?, ?, ?)`,
      host,
      port,
      now,
      now,
      services,
    );
  }

  async getKnownPeers(limit: number): Promise<PeerRow[]> {
    return this.db.getAllAsync<PeerRow>(
      "SELECT * FROM peers ORDER BY last_success DESC LIMIT ?",
      limit,
    );
  }

  // -----------------------------------------------------------------------
  // Contacts
  // -----------------------------------------------------------------------

  async insertContact(
    id: string,
    name: string,
    address: string,
    notes: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `INSERT INTO contacts (id, name, address, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      name,
      address,
      notes,
      now,
      now,
    );
  }

  async updateContact(
    id: string,
    name: string,
    address: string,
    notes: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `UPDATE contacts SET name = ?, address = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      name,
      address,
      notes,
      now,
      id,
    );
  }

  async deleteContact(id: string): Promise<void> {
    await this.db.runAsync("DELETE FROM contacts WHERE id = ?", id);
  }

  async getContacts(): Promise<ContactRow[]> {
    return this.db.getAllAsync<ContactRow>(
      "SELECT * FROM contacts ORDER BY name ASC",
    );
  }

  async getContactByAddress(address: string): Promise<ContactRow | null> {
    const row = await this.db.getFirstAsync<ContactRow>(
      "SELECT * FROM contacts WHERE address = ? LIMIT 1",
      address,
    );
    return row ?? null;
  }

  /**
   * Search contacts by name or address.
   * Escapes LIKE wildcards in user input to prevent unintended matches.
   */
  async searchContacts(query: string): Promise<ContactRow[]> {
    const escaped = query.replace(/[%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    return this.db.getAllAsync<ContactRow>(
      "SELECT * FROM contacts WHERE name LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' ORDER BY name ASC",
      pattern,
      pattern,
    );
  }

  // -----------------------------------------------------------------------
  // Transaction notes
  // -----------------------------------------------------------------------

  async setTxNote(txid: string, note: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `INSERT OR REPLACE INTO tx_notes (txid, note, updated_at)
       VALUES (?, ?, ?)`,
      txid,
      note,
      now,
    );
  }

  async getTxNote(txid: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<TxNoteRow>(
      "SELECT * FROM tx_notes WHERE txid = ?",
      txid,
    );
    return row?.note ?? null;
  }

  // -----------------------------------------------------------------------
  // Address labels
  // -----------------------------------------------------------------------

  async setAddressLabel(address: string, label: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `INSERT OR REPLACE INTO address_labels (address, label, updated_at)
       VALUES (?, ?, ?)`,
      address,
      label,
      now,
    );
  }

  async getAddressLabel(address: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<AddressLabelRow>(
      "SELECT * FROM address_labels WHERE address = ?",
      address,
    );
    return row?.label ?? null;
  }

  // -----------------------------------------------------------------------
  // Recent recipients
  // -----------------------------------------------------------------------

  async addRecentRecipient(address: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `INSERT INTO recent_recipients (address, last_used, use_count)
       VALUES (?, ?, 1)
       ON CONFLICT(address) DO UPDATE SET
         last_used = ?,
         use_count = use_count + 1`,
      address,
      now,
      now,
    );
  }

  async getRecentRecipients(limit: number): Promise<RecentRecipientRow[]> {
    return this.db.getAllAsync<RecentRecipientRow>(
      "SELECT * FROM recent_recipients ORDER BY last_used DESC LIMIT ?",
      limit,
    );
  }
}
