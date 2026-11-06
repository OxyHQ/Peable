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

import * as SQLite from 'expo-sqlite';
import { databaseFileName } from './db-name';
import { HEADER_BLOB_MIGRATION_SQL, needsHeaderBlobMigration } from './header-blob-migration';
import { HEADER_HASH_VERSION, planHeaderRepair } from './header-integrity';

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

/** A row of `social_receive_set` (ADR 0021 D9, amended 2026-11-06). Times are Unix seconds. */
export interface SocialReceiveSetRow {
  address: string;
  index_num: number;
  identity_public_key: string | null;
  created_at: number;
  used: number;
  checked_at: number | null;
  next_check_at: number | null;
  found_at: number | null;
  origin: 'gateway' | 'default' | 'legacy';
}

/** A row of `previous_key_trees` (ADR 0002, amended 2026-11-06). */
export interface PreviousKeyTreeRow {
  /** Compressed lowercase hex. */
  public_key: string;
  network: string;
  external_next: number;
  change_next: number;
  /** When its first discovery ran (Unix seconds); `null`: not yet. */
  discovered_at: number | null;
  /**
   * The Oxy account that vouched for this key when the tree was recorded
   * (R5-2): its key history named it, or the gateway recorded it on that
   * account's addresses. A tree opens on load only for that account; `null`
   * (recorded before round 5) waits for a refresh to vouch for it again.
   */
  vouched_for: string | null;
}

/** One address to add to the set. */
export interface SocialReceiveSetInsert {
  readonly address: string;
  readonly index: number;
  readonly identityPublicKey: string | null;
  readonly createdAt: number;
  readonly origin: SocialReceiveSetRow['origin'];
  readonly checkedAt?: number | null;
}

/** A check to persist on one row (`social-receive-watch.ts`'s `WatchSetCheck`). */
export interface SocialReceiveSetCheck {
  readonly address: string;
  readonly checkedAt: number;
  readonly nextCheckAt: number;
  readonly foundAt?: number;
}

/** Where the pull of the set stands (`social-receive-sync.ts`'s `SocialReceiveSyncState`). */
export interface SocialReceiveSyncStateRow {
  readonly cursor: number;
  readonly fullAfter: number | null;
  readonly fullAt: number | null;
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

/**
 * A buy order the bridge accepted, cached locally so the user can see what
 * happened to it after leaving the quote screen. The bridge remains the source
 * of truth; `status` is refreshed from its API.
 */
export interface BuyOrderRow {
  id: string;
  fair_amount_sats: string;
  payment_currency: string;
  payment_amount: string;
  payment_symbol: string;
  status: string;
  /** FairCoin txid of the delivery, "" until delivered. */
  delivery_txid: string;
  /** Bridge failure reason, "" unless failed. */
  error_message: string;
  created_at: number;
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

  -- The contiguous window before ADR 0021 D9's amendment (2026-11-06). Kept
  -- only so an upgraded wallet's rows are imported into social_receive_set
  -- (migrateSocialReceiveWindow); always empty afterwards.
  CREATE TABLE IF NOT EXISTS social_receive_addresses (
    index_num INTEGER PRIMARY KEY,
    address TEXT UNIQUE NOT NULL,
    used INTEGER DEFAULT 0
  );

  -- Every social-receive address this wallet knows of: what the gateway
  -- reports it handed out (any key the account has had), index 0, and an
  -- upgraded wallet's old window. Keyed by ADDRESS: two keys share indices.
  CREATE TABLE IF NOT EXISTS social_receive_set (
    address TEXT PRIMARY KEY,
    index_num INTEGER NOT NULL,
    identity_public_key TEXT,
    created_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER,
    next_check_at INTEGER,
    found_at INTEGER,
    origin TEXT NOT NULL
  );

  -- A PREVIOUS identity key's HD tree (ADR 0002, amended 2026-11-06 "previous
  -- keys stay spendable"): where its cursors stand on each network, and when
  -- its first discovery ran. Public data only: the key's public half, never a
  -- seed or a private key — the tree is re-derived from Commons on every open.
  CREATE TABLE IF NOT EXISTS previous_key_trees (
    public_key TEXT NOT NULL,
    network TEXT NOT NULL,
    external_next INTEGER NOT NULL DEFAULT 0,
    change_next INTEGER NOT NULL DEFAULT 0,
    discovered_at INTEGER,
    vouched_for TEXT,
    PRIMARY KEY (public_key, network)
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

  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS buy_orders (
    id TEXT PRIMARY KEY,
    fair_amount_sats TEXT NOT NULL,
    payment_currency TEXT NOT NULL,
    payment_amount TEXT NOT NULL,
    payment_symbol TEXT NOT NULL,
    status TEXT NOT NULL,
    delivery_txid TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
  CREATE INDEX IF NOT EXISTS idx_social_receive_set_next_check ON social_receive_set(next_check_at);
  CREATE INDEX IF NOT EXISTS idx_social_receive_set_key ON social_receive_set(identity_public_key);
  CREATE INDEX IF NOT EXISTS idx_contacts_address ON contacts(address);
  CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
  CREATE INDEX IF NOT EXISTS idx_buy_orders_created ON buy_orders(created_at);
`;

/**
 * Columns added after the initial release. `CREATE TABLE IF NOT EXISTS` never
 * alters an existing table, so for wallets created before reorg tracking we add
 * the columns idempotently. SQLite has no "ADD COLUMN IF NOT EXISTS", so each
 * statement is run individually and a duplicate-column error is ignored.
 */
const UTXO_MIGRATION_COLUMNS: readonly { name: string; ddl: string }[] = [
  {
    name: 'spent_height',
    ddl: 'ALTER TABLE utxos ADD COLUMN spent_height INTEGER NOT NULL DEFAULT 0',
  },
  {
    name: 'spent_txid',
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
    await this.migratePreviousKeyTreeColumns();
    await this.migrateSocialReceiveWindow();
    await this.repairHeaderStore();
  }

  /**
   * Import the contiguous social-receive window of a wallet created before the
   * watch set (ADR 0021 D9, amended 2026-11-06), once, then empty it. Its
   * addresses derive from the key the window recorded, and some may have been
   * handed out before the gateway recorded every index — so they stay watched
   * (origin `legacy`) rather than being dropped. Rows the window had already
   * looked at for earlier coins keep that, as checked now.
   */
  private async migrateSocialReceiveWindow(): Promise<void> {
    const old = await this.db.getAllAsync<{ index_num: number; address: string; used: number }>(
      'SELECT index_num, address, used FROM social_receive_addresses',
    );
    if (old.length === 0) return;
    const keyRow = await this.db.getFirstAsync<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'social_receive_identity_key'",
    );
    const checkedRow = await this.db.getFirstAsync<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'social_receive_checked_through'",
    );
    const checkedThrough = checkedRow ? Number(checkedRow.value) : -1;
    const now = Math.floor(Date.now() / 1000);
    await this.db.withTransactionAsync(async () => {
      const stmt = await this.db.prepareAsync(
        `INSERT OR IGNORE INTO social_receive_set
           (address, index_num, identity_public_key, created_at, used, checked_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const row of old) {
          await stmt.executeAsync(
            row.address,
            row.index_num,
            keyRow?.value ?? null,
            now,
            row.used ? 1 : 0,
            Number.isSafeInteger(checkedThrough) && row.index_num <= checkedThrough ? now : null,
            row.index_num === 0 ? 'default' : 'legacy',
          );
        }
      } finally {
        await stmt.finalizeAsync();
      }
      await this.db.runAsync('DELETE FROM social_receive_addresses');
      await this.db.runAsync(
        "DELETE FROM schema_meta WHERE key IN ('social_receive_checked_through', 'social_receive_identity_key')",
      );
    });
  }

  /**
   * Drop a header store written by a broken hash implementation, once.
   *
   * Runs only while the persisted hash version is behind the current one, so
   * an intact store costs a single `schema_meta` read per launch rather than a
   * Quark hash. See `header-integrity.ts` for why this lives here.
   */
  private async repairHeaderStore(): Promise<void> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'header_hash_version'",
    );
    const storedVersion = row ? Number(row.value) : 0;

    const tip = await this.getLatestHeader();
    const plan = planHeaderRepair(storedVersion, tip);
    if (plan === 'up-to-date') return;

    if (plan === 'wipe') {
      await this.db.runAsync('DELETE FROM block_headers');
      // The rescan is described in heights of a chain that no longer exists.
      await this.db.runAsync('DELETE FROM rescan_state');
    }

    await this.db.runAsync(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('header_hash_version', ?)",
      String(HEADER_HASH_VERSION),
    );
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
    const hashColumn = columns.find((c) => c.name === 'hash');
    if (!needsHeaderBlobMigration(hashColumn?.type)) return;

    await this.db.withTransactionAsync(async () => {
      await this.db.execAsync(HEADER_BLOB_MIGRATION_SQL);
    });

    // DROP TABLE only frees pages for reuse; without this the file keeps the
    // old size on disk and the user sees none of the ~15 MB back. VACUUM
    // cannot run inside a transaction, hence its position here. Best-effort:
    // the data is already correct, reclaiming space is not worth failing boot.
    try {
      await this.db.execAsync('VACUUM');
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
      'CREATE INDEX IF NOT EXISTS idx_utxos_spent_height ON utxos(spent_height)',
    );
  }

  /** `previous_key_trees.vouched_for` (round 5, R5-2) on a wallet created before it. */
  private async migratePreviousKeyTreeColumns(): Promise<void> {
    const existing = await this.db.getAllAsync<{ name: string }>(
      "SELECT name FROM pragma_table_info('previous_key_trees')",
    );
    if (existing.some((column) => column.name === 'vouched_for')) return;
    await this.db.execAsync('ALTER TABLE previous_key_trees ADD COLUMN vouched_for TEXT');
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }

  /** Delete a wallet + Pocket's database file. The caller has closed every handle to it. */
  static async deleteFile(walletId: string, account = 0): Promise<void> {
    await SQLite.deleteDatabaseAsync(databaseFileName(walletId, account));
  }

  /** Whether this database holds a wallet: any HD address stored. */
  async hasWalletData(): Promise<boolean> {
    const row = await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM addresses');
    return (row?.n ?? 0) > 0;
  }

  /**
   * Copy this database, whole and consistent, to the file `walletId` +
   * `account` would open (`VACUUM INTO`, which also folds in the WAL). The
   * target must not exist; the caller deletes a partial one first.
   */
  async copyTo(walletId: string, account = 0): Promise<void> {
    const path = this.db.databasePath;
    const directory = path.slice(0, path.lastIndexOf('/') + 1);
    const target = `${directory}${databaseFileName(walletId, account)}`;
    await this.db.runAsync('VACUUM INTO ?', target);
  }

  /**
   * Drop what another account could have left in a moved legacy namespace
   * (R5-2): social-receive rows and previous-key trees under a key `keep`
   * refuses, and where the gateway pull stood — the next pull reads the
   * session account's whole set again (`INSERT OR IGNORE`).
   */
  async dropForeignIdentityData(keep: (storedKey: string | null) => boolean): Promise<void> {
    const keys = await this.db.getAllAsync<{ identity_public_key: string | null }>(
      'SELECT DISTINCT identity_public_key FROM social_receive_set',
    );
    const trees = await this.db.getAllAsync<{ public_key: string }>(
      'SELECT DISTINCT public_key FROM previous_key_trees',
    );
    await this.db.withTransactionAsync(async () => {
      for (const { identity_public_key: key } of keys) {
        if (key !== null && !keep(key)) {
          await this.db.runAsync(
            'DELETE FROM social_receive_set WHERE identity_public_key = ?',
            key,
          );
        }
      }
      for (const { public_key: key } of trees) {
        if (!keep(key)) {
          await this.db.runAsync('DELETE FROM previous_key_trees WHERE public_key = ?', key);
        }
      }
      // Every remaining tree must be vouched for again by its new owner.
      await this.db.runAsync('UPDATE previous_key_trees SET vouched_for = NULL');
      await this.db.runAsync(
        "DELETE FROM schema_meta WHERE key IN ('social_receive_sync_cursor', 'social_receive_full_sync_after', 'social_receive_full_sync_at', 'identity_wallet_key')",
      );
    });
  }

  /**
   * The identity key this wallet last opened with (compressed hex), vouched
   * for by its account when it was stored (R5-1): the only key an identity
   * wallet opens with while Oxy cannot be asked. In this file, never in a
   * keychain group another app can write.
   */
  async getIdentityWalletKey(): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'identity_wallet_key'",
    );
    return row?.value ?? null;
  }

  async setIdentityWalletKey(key: string): Promise<void> {
    await this.db.runAsync(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('identity_wallet_key', ?)",
      key,
    );
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
      'SELECT * FROM block_headers ORDER BY height DESC LIMIT 1',
    );
    return row ?? null;
  }

  async getHeaderByHeight(height: number): Promise<BlockHeaderRow | null> {
    const row = await this.db.getFirstAsync<BlockHeaderRow>(
      'SELECT * FROM block_headers WHERE height = ?',
      height,
    );
    return row ?? null;
  }

  async getHeaderByHash(hash: Uint8Array): Promise<BlockHeaderRow | null> {
    const row = await this.db.getFirstAsync<BlockHeaderRow>(
      'SELECT * FROM block_headers WHERE hash = ?',
      hash,
    );
    return row ?? null;
  }

  async getHeaderCount(): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM block_headers',
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
      'SELECT * FROM transactions WHERE txid = ?',
      txid,
    );
    return row ?? null;
  }

  async getTransactions(limit: number, offset: number): Promise<TransactionRow[]> {
    return this.db.getAllAsync<TransactionRow>(
      'SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ? OFFSET ?',
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
      utxo.spent_txid ?? '',
    );
  }

  /**
   * Mark a UTXO as spent, recording the spending transaction and the height it
   * was spent at (-1 if unconfirmed) so a later reorg can un-spend it precisely.
   */
  async markUTXOSpent(
    txid: string,
    vout: number,
    spendingTxid = '',
    spentHeight = -1,
  ): Promise<void> {
    await this.db.runAsync(
      'UPDATE utxos SET spent = 1, spent_txid = ?, spent_height = ? WHERE txid = ? AND vout = ?',
      spendingTxid,
      spentHeight,
      txid,
      vout,
    );
  }

  async getUnspentUTXOs(): Promise<UTXORow[]> {
    return this.db.getAllAsync<UTXORow>('SELECT * FROM utxos WHERE spent = 0');
  }

  /**
   * Every stored UTXO, spent AND unspent. Used at init to price the inputs of
   * historical send transactions when reconstructing the display history: a
   * spent input's value/address is only known from the (now-spent) row it
   * consumed. `getUnspentUTXOs` alone cannot value those, so history
   * reconstruction reads the full set through this method.
   */
  async getAllUTXOs(): Promise<UTXORow[]> {
    return this.db.getAllAsync<UTXORow>('SELECT * FROM utxos');
  }

  /**
   * Update the recorded block height of a stored UTXO. Used by the
   * confirmation-reconciler when a transaction was received before its
   * containing header was known (block_height was persisted as -1) and we
   * later learn the real height (H-3).
   */
  async updateUTXOBlockHeight(txid: string, vout: number, blockHeight: number): Promise<void> {
    await this.db.runAsync(
      'UPDATE utxos SET block_height = ? WHERE txid = ? AND vout = ?',
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
  async updateUTXOSpentHeight(txid: string, vout: number, spentHeight: number): Promise<void> {
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
  async getPendingHeightUTXOs(): Promise<{ txid: string; vout: number; block_hash: string }[]> {
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
  async getPendingHeightTransactions(): Promise<{ txid: string; block_hash: string }[]> {
    return this.db.getAllAsync<{ txid: string; block_hash: string }>(
      `SELECT txid, block_hash FROM transactions
        WHERE block_height < 0
          AND block_hash IS NOT NULL
          AND block_hash <> ''`,
    );
  }

  async getUnspentUTXOsForAddress(address: string): Promise<UTXORow[]> {
    return this.db.getAllAsync<UTXORow>(
      'SELECT * FROM utxos WHERE spent = 0 AND address = ?',
      address,
    );
  }

  async getUTXOCount(): Promise<{ total: number; unspent: number }> {
    const total = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM utxos',
    );
    const unspent = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM utxos WHERE spent = 0',
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
        'SELECT COUNT(*) as count FROM utxos WHERE block_height > ?',
        forkHeight,
      );
      deletedUtxos = createdAbove?.count ?? 0;

      const spentAbove = await this.db.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) as count FROM utxos WHERE spent = 1 AND spent_height > ?',
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
      await this.db.runAsync('DELETE FROM utxos WHERE block_height > ?', forkHeight);

      // Orphaned transactions: drop them. If they re-confirm on the new chain
      // the merkle-block receive path re-inserts them.
      await this.db.runAsync('DELETE FROM transactions WHERE block_height > ?', forkHeight);

      const headerCount = await this.db.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) as count FROM block_headers WHERE height > ?',
        forkHeight,
      );
      deletedHeaders = headerCount?.count ?? 0;

      // 3. Delete orphaned headers.
      await this.db.runAsync('DELETE FROM block_headers WHERE height > ?', forkHeight);
    });

    return { deletedUtxos, restoredUtxos, deletedHeaders };
  }

  /**
   * Delete all stored headers strictly above `height` (without touching UTXOs).
   * Used by the SPV client when accepting a longer competing branch.
   */
  async deleteHeadersAboveHeight(height: number): Promise<void> {
    await this.db.runAsync('DELETE FROM block_headers WHERE height > ?', height);
  }

  // -----------------------------------------------------------------------
  // Rescan state (resumable historical scan)
  // -----------------------------------------------------------------------

  async getRescanState(): Promise<RescanStateRow | null> {
    const row = await this.db.getFirstAsync<RescanStateRow>(
      'SELECT * FROM rescan_state WHERE id = 1',
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
    return this.db.getAllAsync<AddressRow>('SELECT * FROM addresses ORDER BY is_change, index_num');
  }

  async getUnusedAddress(isChange: boolean): Promise<AddressRow | null> {
    const row = await this.db.getFirstAsync<AddressRow>(
      'SELECT * FROM addresses WHERE is_change = ? AND used = 0 ORDER BY index_num ASC LIMIT 1',
      isChange ? 1 : 0,
    );
    return row ?? null;
  }

  async markAddressUsed(address: string): Promise<void> {
    await this.db.runAsync('UPDATE addresses SET used = 1 WHERE address = ?', address);
  }

  // -----------------------------------------------------------------------
  // Watch addresses (non-HD, e.g. multisig)
  // -----------------------------------------------------------------------

  async insertWatchAddress(address: string, redeemScript: string, label: string): Promise<void> {
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
      'SELECT * FROM watch_addresses ORDER BY created_at',
    );
  }

  /**
   * The next unused derivation index for a chain: one past the highest *used*
   * index in the database (0 if none are used). Used to restore the BIP44
   * cursor on startup so used addresses are never re-issued (SPV_AUDIT.md §4.5).
   */
  async getNextUnusedIndex(isChange: boolean): Promise<number> {
    const row = await this.db.getFirstAsync<{ max_used: number | null }>(
      'SELECT MAX(index_num) as max_used FROM addresses WHERE is_change = ? AND used = 1',
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
   * Add addresses to the set. `INSERT OR IGNORE`: an address already stored
   * keeps its check state, so a full re-read of the gateway's set is a no-op.
   */
  async insertSocialReceiveSet(rows: readonly SocialReceiveSetInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.withTransactionAsync(async () => {
      const stmt = await this.db.prepareAsync(
        `INSERT OR IGNORE INTO social_receive_set
           (address, index_num, identity_public_key, created_at, used, checked_at, origin)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      );
      try {
        for (const row of rows) {
          await stmt.executeAsync(
            row.address,
            row.index,
            row.identityPublicKey,
            row.createdAt,
            row.checkedAt ?? null,
            row.origin,
          );
        }
      } finally {
        await stmt.finalizeAsync();
      }
    });
  }

  /** Every row of the set, of every key, in index order. */
  async getSocialReceiveSet(): Promise<SocialReceiveSetRow[]> {
    return this.db.getAllAsync<SocialReceiveSetRow>(
      'SELECT * FROM social_receive_set ORDER BY index_num ASC, address ASC',
    );
  }

  /** The rows with these addresses (a page just stored, say). */
  async getSocialReceiveSetRows(addresses: readonly string[]): Promise<SocialReceiveSetRow[]> {
    const rows: SocialReceiveSetRow[] = [];
    for (let start = 0; start < addresses.length; start += 500) {
      const chunk = addresses.slice(start, start + 500);
      const found = await this.db.getAllAsync<SocialReceiveSetRow>(
        `SELECT * FROM social_receive_set WHERE address IN (${chunk.map(() => '?').join(',')})`,
        ...chunk,
      );
      for (const row of found) rows.push(row);
    }
    return rows;
  }

  /**
   * Every key the set records (as stored: the gateway's encoding), for finding
   * previous keys — with `gatewayOnly`, only keys on rows the GATEWAY handed
   * out to this wallet's account (`origin = 'gateway'`), the only rows that
   * vouch for a key without the account's key history (R5-2, R4-5).
   */
  async getSocialReceiveSetKeys(gatewayOnly = false): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ identity_public_key: string }>(
      `SELECT DISTINCT identity_public_key FROM social_receive_set WHERE identity_public_key IS NOT NULL${
        gatewayOnly ? " AND origin = 'gateway'" : ''
      }`,
    );
    return rows.map((row) => row.identity_public_key);
  }

  /**
   * The rows recorded under these keys (exactly as stored), and — when
   * `withKeyless` — every row recorded without a key, in index order.
   */
  async getSocialReceiveSetRowsForKeys(
    storedKeys: readonly string[],
    withKeyless: boolean,
  ): Promise<SocialReceiveSetRow[]> {
    const rows: SocialReceiveSetRow[] = [];
    for (let start = 0; start < storedKeys.length; start += 500) {
      const chunk = storedKeys.slice(start, start + 500);
      const found = await this.db.getAllAsync<SocialReceiveSetRow>(
        `SELECT * FROM social_receive_set WHERE identity_public_key IN (${chunk.map(() => '?').join(',')})`,
        ...chunk,
      );
      for (const row of found) rows.push(row);
    }
    if (withKeyless) {
      const keyless = await this.db.getAllAsync<SocialReceiveSetRow>(
        'SELECT * FROM social_receive_set WHERE identity_public_key IS NULL',
      );
      for (const row of keyless) rows.push(row);
    }
    return rows.sort((a, b) => a.index_num - b.index_num || (a.address < b.address ? -1 : 1));
  }

  /** The previous-key trees recorded for `network`. */
  async getPreviousKeyTrees(network: string): Promise<PreviousKeyTreeRow[]> {
    return this.db.getAllAsync<PreviousKeyTreeRow>(
      'SELECT * FROM previous_key_trees WHERE network = ? ORDER BY public_key',
      network,
    );
  }

  /**
   * Record where a previous key's tree stands. Cursors only move forward, and
   * a discovery once recorded stays recorded.
   */
  async savePreviousKeyTree(row: PreviousKeyTreeRow): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO previous_key_trees (public_key, network, external_next, change_next, discovered_at, vouched_for)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (public_key, network) DO UPDATE SET
         external_next = MAX(external_next, excluded.external_next),
         change_next = MAX(change_next, excluded.change_next),
         discovered_at = COALESCE(discovered_at, excluded.discovered_at),
         vouched_for = COALESCE(excluded.vouched_for, vouched_for)`,
      row.public_key,
      row.network,
      row.external_next,
      row.change_next,
      row.discovered_at,
      row.vouched_for,
    );
  }

  async markSocialReceiveAddressUsed(address: string): Promise<void> {
    await this.db.runAsync('UPDATE social_receive_set SET used = 1 WHERE address = ?', address);
  }

  /** Persist checks, one transaction. A found coin also marks the row used. */
  async recordSocialReceiveChecks(checks: readonly SocialReceiveSetCheck[]): Promise<void> {
    if (checks.length === 0) return;
    await this.db.withTransactionAsync(async () => {
      const stmt = await this.db.prepareAsync(
        `UPDATE social_receive_set
            SET checked_at = ?, next_check_at = ?,
                found_at = COALESCE(?, found_at),
                used = CASE WHEN ? IS NULL THEN used ELSE 1 END
          WHERE address = ?`,
      );
      try {
        for (const check of checks) {
          const foundAt = check.foundAt ?? null;
          await stmt.executeAsync(
            check.checkedAt,
            check.nextCheckAt,
            foundAt,
            foundAt,
            check.address,
          );
        }
      } finally {
        await stmt.finalizeAsync();
      }
    });
  }

  /**
   * The set's addresses that hold an unspent output in this wallet's UTXO set,
   * each with the value it holds (base units). The value decides whether the
   * address is active (`planActiveSet`'s floor and funded cap, R4-2), so it
   * is summed exactly as bigints, never in SQL arithmetic.
   */
  async getSocialReceiveCoinsHeld(): Promise<Map<string, bigint>> {
    const rows = await this.db.getAllAsync<{ address: string; value: string }>(
      `SELECT s.address, u.value FROM social_receive_set s
         JOIN utxos u ON u.address = s.address
        WHERE u.spent = 0`,
    );
    const held = new Map<string, bigint>();
    for (const row of rows) {
      let value: bigint;
      try {
        value = BigInt(row.value);
      } catch {
        continue;
      }
      held.set(row.address, (held.get(row.address) ?? 0n) + value);
    }
    return held;
  }

  /** Where the pull of the gateway's set stands. */
  async getSocialReceiveSyncState(): Promise<SocialReceiveSyncStateRow> {
    const rows = await this.db.getAllAsync<{ key: string; value: string }>(
      "SELECT key, value FROM schema_meta WHERE key IN ('social_receive_sync_cursor', 'social_receive_full_sync_after', 'social_receive_full_sync_at')",
    );
    const read = (key: string): number | null => {
      const value = Number(rows.find((row) => row.key === key)?.value ?? Number.NaN);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    return {
      cursor: read('social_receive_sync_cursor') ?? 0,
      fullAfter: read('social_receive_full_sync_after'),
      fullAt: read('social_receive_full_sync_at'),
    };
  }

  async setSocialReceiveSyncState(state: SocialReceiveSyncStateRow): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      const put = async (key: string, value: number | null) => {
        if (value === null) {
          await this.db.runAsync('DELETE FROM schema_meta WHERE key = ?', key);
        } else {
          await this.db.runAsync(
            'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
            key,
            String(value),
          );
        }
      };
      await put('social_receive_sync_cursor', state.cursor);
      await put('social_receive_full_sync_after', state.fullAfter);
      await put('social_receive_full_sync_at', state.fullAt);
    });
  }

  /**
   * Drop the whole social-receive set and where its pull stood. `databaseFileName`
   * has no network component, so this DB file is shared across mainnet/testnet
   * for a given wallet+Pocket — a set synced on one network is the wrong
   * network's addresses on the other. Called on `switchNetwork` only, so the
   * next `setUpSocialReceive` pulls the new network's set; a key change never
   * drops rows (the addresses of a previous key keep their coins).
   */
  async clearSocialReceiveAddresses(): Promise<void> {
    await this.db.runAsync('DELETE FROM social_receive_set');
    await this.db.runAsync('DELETE FROM social_receive_addresses');
    await this.db.runAsync(
      "DELETE FROM schema_meta WHERE key IN ('social_receive_sync_cursor', 'social_receive_full_sync_after', 'social_receive_full_sync_at', 'social_receive_checked_through', 'social_receive_identity_key')",
    );
  }

  /**
   * The lowest block height the historical rescan still has to go back to,
   * or `null`. Kept apart from `rescan_state`, which a running scan rewrites
   * after every window: the driver folds this in when no scan is running.
   */
  async getPendingRescanFrom(): Promise<number | null> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'pending_rescan_from'",
    );
    if (!row) return null;
    const value = Number(row.value);
    return Number.isSafeInteger(value) ? value : null;
  }

  /** Record `height`, keeping the lower of it and any height already pending. */
  async requestRescanFrom(height: number): Promise<void> {
    const pending = await this.getPendingRescanFrom();
    const lowest = pending === null ? height : Math.min(pending, height);
    await this.db.runAsync(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('pending_rescan_from', ?)",
      String(lowest),
    );
  }

  async clearPendingRescanFrom(): Promise<void> {
    await this.db.runAsync("DELETE FROM schema_meta WHERE key = 'pending_rescan_from'");
  }

  // -----------------------------------------------------------------------
  // Peers
  // -----------------------------------------------------------------------

  async insertPeer(host: string, port: number, services: number): Promise<void> {
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

  // -----------------------------------------------------------------------
  // Buy orders
  // -----------------------------------------------------------------------

  /**
   * Insert or refresh a buy order. Keyed on the bridge's order id, so
   * re-recording the same order (a retry, a resumed screen) is idempotent.
   */
  async upsertBuyOrder(row: BuyOrderRow): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO buy_orders
        (id, fair_amount_sats, payment_currency, payment_amount, payment_symbol,
         status, delivery_txid, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.fair_amount_sats,
      row.payment_currency,
      row.payment_amount,
      row.payment_symbol,
      row.status,
      row.delivery_txid,
      row.error_message,
      row.created_at,
      row.updated_at,
    );
  }

  async updateBuyOrderStatus(
    id: string,
    status: string,
    deliveryTxid: string,
    errorMessage: string,
    updatedAt: number,
  ): Promise<void> {
    await this.db.runAsync(
      `UPDATE buy_orders
         SET status = ?, delivery_txid = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
      status,
      deliveryTxid,
      errorMessage,
      updatedAt,
      id,
    );
  }

  async getBuyOrders(limit: number): Promise<BuyOrderRow[]> {
    return this.db.getAllAsync<BuyOrderRow>(
      'SELECT * FROM buy_orders ORDER BY created_at DESC LIMIT ?',
      limit,
    );
  }

  async getKnownPeers(limit: number): Promise<PeerRow[]> {
    return this.db.getAllAsync<PeerRow>(
      'SELECT * FROM peers ORDER BY last_success DESC LIMIT ?',
      limit,
    );
  }

  // -----------------------------------------------------------------------
  // Contacts
  // -----------------------------------------------------------------------

  async insertContact(id: string, name: string, address: string, notes: string): Promise<void> {
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

  async updateContact(id: string, name: string, address: string, notes: string): Promise<void> {
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
    await this.db.runAsync('DELETE FROM contacts WHERE id = ?', id);
  }

  async getContacts(): Promise<ContactRow[]> {
    return this.db.getAllAsync<ContactRow>('SELECT * FROM contacts ORDER BY name ASC');
  }

  async getContactByAddress(address: string): Promise<ContactRow | null> {
    const row = await this.db.getFirstAsync<ContactRow>(
      'SELECT * FROM contacts WHERE address = ? LIMIT 1',
      address,
    );
    return row ?? null;
  }

  /**
   * Search contacts by name or address.
   * Escapes LIKE wildcards in user input to prevent unintended matches.
   */
  async searchContacts(query: string): Promise<ContactRow[]> {
    const escaped = query.replace(/[%_]/g, '\\$&');
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
      'SELECT * FROM tx_notes WHERE txid = ?',
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
      'SELECT * FROM address_labels WHERE address = ?',
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
      'SELECT * FROM recent_recipients ORDER BY last_used DESC LIMIT ?',
      limit,
    );
  }
}
