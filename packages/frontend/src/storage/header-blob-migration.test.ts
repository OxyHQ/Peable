/**
 * Tests for the `block_headers` hex → BLOB migration, run against a real
 * SQLite engine.
 *
 * The migration drops and rebuilds the only table the SPV client cannot
 * reconstruct without a full re-sync, so the conversion has to be exactly
 * lossless: a truncated or re-ordered hash silently breaks `prevBlock` linkage
 * and the wallet stops confirming payments with no visible error.
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  HEADER_BLOB_MIGRATION_SQL,
  needsHeaderBlobMigration,
} from "./header-blob-migration";

const LEGACY_SCHEMA = `
CREATE TABLE block_headers (
  height INTEGER PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  prev_hash TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  bits INTEGER NOT NULL,
  nonce INTEGER NOT NULL,
  version INTEGER NOT NULL
);
`;

// Real mainnet header at height 60000 — the sync anchor.
const HASH_60000 =
  "20711ef417c640875ad9c3a4ca8cc2b177bc61efef6c07a7c522a2756531b9b4";
const PREV_60000 =
  "3051e3f9084407e48f116991b36f022ba778f1f8b796a1039687863de88ba169";
const MERKLE_60000 =
  "ec808dc98d66a36184e5d577e684efe47d831483810c7b4ba7b0e2aa4702b63f";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function legacyDb(): Database {
  const db = new Database(":memory:");
  db.exec(LEGACY_SCHEMA);
  db.run(
    `INSERT INTO block_headers
      (height, hash, prev_hash, merkle_root, timestamp, bits, nonce, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [60000, HASH_60000, PREV_60000, MERKLE_60000, 1783843225, 454092943, 0, 3],
  );
  return db;
}

function hashColumnType(db: Database): string | undefined {
  const cols = db
    .query("SELECT name, type FROM pragma_table_info('block_headers')")
    .all() as { name: string; type: string }[];
  return cols.find((c) => c.name === "hash")?.type;
}

describe("needsHeaderBlobMigration", () => {
  test("a legacy TEXT column needs migrating", () => {
    expect(needsHeaderBlobMigration("TEXT")).toBe(true);
  });

  test("an already-converted BLOB column does not", () => {
    expect(needsHeaderBlobMigration("BLOB")).toBe(false);
    expect(needsHeaderBlobMigration("blob")).toBe(false);
  });

  test("an absent table does not (fresh wallet)", () => {
    expect(needsHeaderBlobMigration(undefined)).toBe(false);
  });
});

describe("HEADER_BLOB_MIGRATION_SQL", () => {
  test("converts hex text to the exact 32 raw bytes", () => {
    const db = legacyDb();
    expect(hashColumnType(db)).toBe("TEXT");

    db.exec(HEADER_BLOB_MIGRATION_SQL);

    expect(hashColumnType(db)).toBe("BLOB");
    const row = db
      .query("SELECT * FROM block_headers WHERE height = 60000")
      .get() as {
      hash: Uint8Array;
      prev_hash: Uint8Array;
      merkle_root: Uint8Array;
      timestamp: number;
      bits: number;
      nonce: number;
      version: number;
    };

    expect(row.hash).toHaveLength(32);
    expect(toHex(row.hash)).toBe(HASH_60000);
    expect(toHex(row.prev_hash)).toBe(PREV_60000);
    expect(toHex(row.merkle_root)).toBe(MERKLE_60000);
    // Non-hash columns must survive untouched.
    expect(row.timestamp).toBe(1783843225);
    expect(row.bits).toBe(454092943);
    expect(row.nonce).toBe(0);
    expect(row.version).toBe(3);
    db.close();
  });

  test("preserves every row and keeps height as the primary key", () => {
    const db = legacyDb();
    for (let i = 1; i <= 50; i++) {
      db.run(
        `INSERT INTO block_headers
          (height, hash, prev_hash, merkle_root, timestamp, bits, nonce, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          i,
          i.toString(16).padStart(64, "0"),
          (i - 1).toString(16).padStart(64, "0"),
          i.toString(16).padStart(64, "f"),
          1700000000 + i,
          454092943,
          0,
          3,
        ],
      );
    }

    db.exec(HEADER_BLOB_MIGRATION_SQL);

    const count = db
      .query("SELECT COUNT(*) AS c FROM block_headers")
      .get() as { c: number };
    expect(count.c).toBe(51);

    // The UNIQUE constraint on `hash` must carry over to the new table.
    expect(() =>
      db.run(
        `INSERT INTO block_headers
          (height, hash, prev_hash, merkle_root, timestamp, bits, nonce, version)
         VALUES (?, unhex(?), unhex(?), unhex(?), ?, ?, ?, ?)`,
        [
          9999,
          HASH_60000,
          PREV_60000,
          MERKLE_60000,
          1783843225,
          454092943,
          0,
          3,
        ],
      ),
    ).toThrow();
    db.close();
  });

  test("lookup by raw-byte hash finds the row", () => {
    const db = legacyDb();
    db.exec(HEADER_BLOB_MIGRATION_SQL);

    const bytes = Uint8Array.from(
      HASH_60000.match(/../g)!.map((b) => parseInt(b, 16)),
    );
    const found = db
      .query("SELECT height FROM block_headers WHERE hash = ?")
      .get(bytes) as { height: number } | null;

    expect(found?.height).toBe(60000);
    db.close();
  });

  test("is a no-op on an empty table", () => {
    const db = new Database(":memory:");
    db.exec(LEGACY_SCHEMA);
    db.exec(HEADER_BLOB_MIGRATION_SQL);

    expect(hashColumnType(db)).toBe("BLOB");
    const count = db
      .query("SELECT COUNT(*) AS c FROM block_headers")
      .get() as { c: number };
    expect(count.c).toBe(0);
    db.close();
  });
});
