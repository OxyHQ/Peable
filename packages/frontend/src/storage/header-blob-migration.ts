/**
 * Migration of `block_headers` from hex TEXT to raw BLOB.
 *
 * `block_headers` is the only table that grows without bound, and storing each
 * of a header's three hashes as 64 characters of hex made every row ~400 bytes
 * to represent 80 bytes of chain data. Measured on a synced mainnet wallet
 * (67,768 headers) the conversion takes the database from 25.7 MB to 10.6 MB.
 *
 * The SQL lives here, apart from `database.ts`, so it can be exercised against
 * a real SQLite engine in tests — `database.ts` imports `expo-sqlite`, which
 * the bun test runner cannot load.
 */

/** SQLite type name that means the table has already been converted. */
const BLOB_TYPE = "BLOB";

/**
 * Whether a `block_headers` table needs converting, given the declared type of
 * its `hash` column (`undefined` when the table does not exist yet).
 */
export function needsHeaderBlobMigration(
  hashColumnType: string | undefined,
): boolean {
  if (hashColumnType === undefined) return false;
  return hashColumnType.toUpperCase() !== BLOB_TYPE;
}

/**
 * Rebuild `block_headers` with BLOB hash columns, converting existing rows via
 * `unhex()` (SQLite 3.41+; expo-sqlite ships 3.49+).
 *
 * Must run inside a transaction: it drops the original table, so a failure
 * part-way through has to roll the whole thing back rather than leave the
 * wallet with no header chain.
 */
export const HEADER_BLOB_MIGRATION_SQL = `
CREATE TABLE block_headers_blob (
  height INTEGER PRIMARY KEY,
  hash BLOB UNIQUE NOT NULL,
  prev_hash BLOB NOT NULL,
  merkle_root BLOB NOT NULL,
  timestamp INTEGER NOT NULL,
  bits INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  version INTEGER NOT NULL
);
INSERT INTO block_headers_blob
  (height, hash, prev_hash, merkle_root, timestamp, bits, nonce, version)
SELECT height, unhex(hash), unhex(prev_hash), unhex(merkle_root),
       timestamp, bits, nonce, version
FROM block_headers;
DROP TABLE block_headers;
ALTER TABLE block_headers_blob RENAME TO block_headers;
`;
