/**
 * The wallet database's round-6 rules (security review round 6, R6-1, R6-2,
 * R6-6), on a real SQLite: `bun:sqlite` behind the slice of `expo-sqlite`
 * `Database` uses.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
import { getPublicKey } from '@noble/secp256k1';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'peable-db-'));

type Bind = string | number | null;
function bindsOf(params: unknown[]): Bind[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
  return flat as Bind[];
}

function openShim(name: string) {
  const path = join(directory, name);
  const db = new BunSqlite(path, { create: true });
  return {
    databasePath: path,
    execAsync: async (sql: string) => {
      db.exec(sql);
    },
    getAllAsync: async (sql: string, ...params: unknown[]) => db.query(sql).all(...bindsOf(params)),
    getFirstAsync: async (sql: string, ...params: unknown[]) =>
      db.query(sql).get(...bindsOf(params)) ?? null,
    runAsync: async (sql: string, ...params: unknown[]) => {
      const result = db.query(sql).run(...bindsOf(params));
      return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
    },
    withTransactionAsync: async (fn: () => Promise<void>) => {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    prepareAsync: async (sql: string) => {
      const statement = db.query(sql);
      return {
        executeAsync: async (...params: unknown[]) => statement.run(...bindsOf(params)),
        finalizeAsync: async () => statement.finalize(),
      };
    },
    closeAsync: async () => db.close(),
  };
}

mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async (name: string) => openShim(name),
  deleteDatabaseAsync: async (name: string) => {
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(join(directory, name + suffix), { force: true });
  },
}));

const { Database } = await import('./database');
const { KeyManager } = await import('@peable.to/pay');
const {
  getNetwork,
  bytesToHex,
  hexToBytes,
  createMultisigRedeemScript,
  multisigAddress,
  parseMultisigRedeemScript,
  publicKeyToAddress,
} = await import('@fairco.in/core');
const { reachLegacyPocket } = await import('../wallet/identity-namespace');
const { openReceiveAddress, receiveProbeOf } = await import('../wallet/receive-address');

const testnet = getNetwork('testnet');
const OLD_KEY = '02'.padEnd(66, '1');
const NEW_KEY = '03'.padEnd(66, '2');
const oldTree = () => KeyManager.fromSeed(new Uint8Array(32).fill(1), testnet);
const newTree = () => KeyManager.fromSeed(new Uint8Array(32).fill(2), testnet);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** The wallet's probe of `tree`, as `wallet-store` builds it. */
const probe = (tree: { accountXpub(): string }) => receiveProbeOf(tree, testnet);

let counter = 0;
const fresh = () => Database.open(`w${String(++counter)}`);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('the receive address is the open key’s (R6-1)', () => {
  test('after a rotation the replaced key’s unused row is never offered', async () => {
    const db = await fresh();
    // Before the rotation: the old key's wallet showed its index 0..2.
    const before = oldTree();
    for (let i = 0; i < 3; i++) {
      const derived = before.getNextAddress();
      await db.insertAddress({ ...derived, isChange: false, identityPublicKey: OLD_KEY });
    }
    const after = newTree();
    const opened = await openReceiveAddress(db, after, NEW_KEY, probe(after));
    expect(after.ownsAddress(opened.receiveAddress)).toBe(true);
    expect(before.ownsAddress(opened.receiveAddress)).toBe(false);
    expect(opened.addresses.every((address) => after.ownsAddress(address))).toBe(true);
    await db.close();
  });

  test('rows written before keys were recorded: the open tree’s are bound, others never offered', async () => {
    const db = await fresh();
    const before = oldTree();
    const old0 = before.getNextAddress();
    // Round-5 rows had no key column value.
    await db.insertAddress({ ...old0, isChange: false, identityPublicKey: null });
    const after = newTree();
    const mine = after.getNextAddress();
    await db.insertAddress({ ...mine, isChange: false, identityPublicKey: null });

    const opened = await openReceiveAddress(db, newTree(), NEW_KEY, probe(newTree()));
    expect(opened.receiveAddress).toBe(mine.address);
    const rows = await db.getAddresses();
    expect(rows.find((r) => r.address === mine.address)?.identity_public_key).toBe(NEW_KEY);
    expect(rows.find((r) => r.address === old0.address)?.identity_public_key).toBeNull();
    await db.close();
  });

  test('another key’s used rows do not move the open tree’s cursor', async () => {
    const db = await fresh();
    const before = oldTree();
    for (let i = 0; i < 30; i++) {
      const derived = before.getNextAddress();
      await db.insertAddress({ ...derived, isChange: false, identityPublicKey: OLD_KEY });
      await db.markAddressUsed(derived.address);
    }
    expect(await db.getNextUnusedIndex(false, NEW_KEY)).toBe(0);
    expect(await db.getNextUnusedIndex(false, OLD_KEY)).toBe(30);
    const opened = await openReceiveAddress(db, newTree(), NEW_KEY, probe(newTree()));
    expect(opened.receiveAddress).toBe(newTree().getNextAddress().address);
    await db.close();
  });

  test('a used row far above a gap of unused ones is bound, and moves the cursor (R7-3)', async () => {
    const db = await fresh();
    // As the upgrade or a legacy move leaves it: every row unbound, the used
    // one at index 29 behind unused 0..28 — outside the open tree's first
    // window (0..19), on the receive chain and on the change chain.
    const writer = newTree();
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(writer.getNextAddress());
    const changeRows = [];
    for (let i = 0; i < 16; i++) changeRows.push(writer.getNextChangeAddress());
    for (const row of rows)
      await db.insertAddress({ ...row, isChange: false, identityPublicKey: null });
    for (const row of changeRows)
      await db.insertAddress({ ...row, isChange: true, identityPublicKey: null });
    const usedReceive = must(rows[29]);
    const usedChange = must(changeRows[15]);
    await db.markAddressUsed(usedReceive.address);
    await db.markAddressUsed(usedChange.address);
    // Another key's unbound rows stay unbound.
    const foreign = oldTree().getNextAddress();
    await db.insertAddress({ ...foreign, isChange: false, identityPublicKey: null });

    const tree = newTree();
    expect(tree.ownsAddress(usedReceive.address)).toBe(false);
    const opened = await openReceiveAddress(db, tree, NEW_KEY, probe(tree));

    const stored = await db.getAddresses();
    const keyOf = (address: string) =>
      stored.find((r) => r.address === address)?.identity_public_key;
    expect(keyOf(usedReceive.address)).toBe(NEW_KEY);
    expect(keyOf(usedChange.address)).toBe(NEW_KEY);
    expect(keyOf(foreign.address)).toBeNull();
    // The open tree now derives (signs for, watches) the used addresses and
    // the gap above them.
    expect(tree.ownsAddress(usedReceive.address)).toBe(true);
    expect(tree.ownsAddress(usedChange.address)).toBe(true);
    expect(tree.getNextExternalIndex()).toBe(30);
    expect(tree.getNextChangeIndex()).toBe(16);
    expect(await db.getNextUnusedIndex(false, NEW_KEY)).toBe(30);
    // The lowest unused row of the open key is still the one offered.
    expect(opened.receiveAddress).toBe(must(rows[0]).address);
    expect(opened.addresses).toContain(usedReceive.address);
    expect(opened.addresses).not.toContain(foreign.address);
    await db.close();
  });

  test('a BIP39 wallet (no key scope) keeps its rows, still checked against its tree', async () => {
    const db = await fresh();
    const tree = newTree();
    const derived = tree.getNextAddress();
    await db.insertAddress({ ...derived, isChange: false, identityPublicKey: null });
    // A row its tree does not derive (planted, or from another key) is never offered.
    const foreign = oldTree().getNextAddress();
    await db.insertAddress({ ...foreign, index: -1, isChange: false, identityPublicKey: null });
    const opened = await openReceiveAddress(db, newTree(), null, probe(newTree()));
    expect(opened.receiveAddress).toBe(derived.address);
    expect(opened.addresses).not.toContain(foreign.address);
    await db.close();
  });
});

describe('a moved legacy namespace keeps only its owner’s data (R6-2)', () => {
  test('another account’s addresses, coins, history, labels and multisig go', async () => {
    const db = await fresh();
    const owner = oldTree();
    const other = newTree();
    const mine = owner.getNextAddress();
    const theirs = other.getNextAddress();
    await db.insertAddress({ ...mine, isChange: false, identityPublicKey: null });
    await db.insertAddress({ ...theirs, isChange: false, identityPublicKey: null });
    const coin = (txid: string, address: string) =>
      db.insertUTXO({
        txid,
        vout: 0,
        address,
        value: 1000n,
        script_pub_key: '76a9',
        block_height: 10,
      });
    await coin('aa'.repeat(32), mine.address);
    await coin('bb'.repeat(32), theirs.address);
    for (const txid of ['aa'.repeat(32), 'bb'.repeat(32)]) {
      await db.insertTransaction({
        txid,
        raw_hex: '00',
        block_height: 10,
        block_hash: '',
        timestamp: 1,
        fee: 0,
        confirmed: 1,
      });
      await db.setTxNote(txid, 'note');
    }
    await db.setAddressLabel(theirs.address, 'their label');
    await db.insertWatchAddress('3Multisig', '52ae', 'theirs?');
    await db.insertSocialReceiveSet([
      { address: 'Smine', index: 1, identityPublicKey: OLD_KEY, createdAt: 1, origin: 'gateway' },
      { address: 'Stheirs', index: 1, identityPublicKey: NEW_KEY, createdAt: 1, origin: 'gateway' },
      { address: 'Skeyless', index: 2, identityPublicKey: null, createdAt: 1, origin: 'legacy' },
    ]);

    await db.keepOnlyOwnerData({
      ownsHdAddress: (address) => owner.ownsAddress(address),
      keepsKey: (key) => key === OLD_KEY,
      derivesSocialRow: () => false,
      namesOwnerKey: () => false,
    });

    expect((await db.getAddresses()).map((r) => r.address)).toEqual([mine.address]);
    expect((await db.getAllUTXOs()).map((u) => u.address)).toEqual([mine.address]);
    expect(await db.getTransaction('bb'.repeat(32))).toBeNull();
    expect(await db.getTransaction('aa'.repeat(32))).not.toBeNull();
    expect(await db.getTxNote('bb'.repeat(32))).toBeNull();
    expect(await db.getAddressLabel(theirs.address)).toBeNull();
    expect(await db.getWatchAddresses()).toEqual([]);
    expect((await db.getSocialReceiveSet()).map((r) => r.address)).toEqual(['Smine']);
    await db.close();
  });
});

describe('a moved legacy namespace keeps everything its owner’s trees made (R7-6)', () => {
  test('a change coin past index 9, a previous key’s far coin and the owner’s multisig stay', async () => {
    const db = await fresh();
    const owner = oldTree();
    const previousTree = () => KeyManager.fromSeed(new Uint8Array(32).fill(3), testnet);
    const previousKey = bytesToHex(getPublicKey(new Uint8Array(32).fill(7), true));
    // Stored: the owner's receive rows 0..2, no change row at all.
    for (let i = 0; i < 3; i++) {
      await db.insertAddress({
        ...owner.getNextAddress(),
        isChange: false,
        identityPublicKey: null,
      });
    }
    // A coin at the owner's change index 25: the old window (0..9) dropped it.
    const changeWriter = oldTree();
    let farChange = changeWriter.getNextChangeAddress();
    while (farChange.index < 25) farChange = changeWriter.getNextChangeAddress();
    // A previous key's tree recorded at external 200, its coin at index 210.
    await db.savePreviousKeyTree({
      public_key: previousKey,
      network: 'testnet',
      external_next: 200,
      change_next: 0,
      discovered_at: 1,
      vouched_for: null,
    });
    const previousWriter = previousTree();
    previousWriter.restoreCursors(210, 0);
    const farPrevious = previousWriter.getNextAddress();
    expect(farPrevious.index).toBe(210);
    const coin = (txid: string, address: string) =>
      db.insertUTXO({ txid, vout: 0, address, value: 1n, script_pub_key: '76a9', block_height: 5 });
    await coin('a1'.repeat(32), farChange.address);
    await coin('a2'.repeat(32), farPrevious.address);
    // Multisig: one naming the owner's receive key 0, one naming nobody's.
    const ownerPubkey = hexToBytes(
      bytesToHex(
        getPublicKey(owner.getPrivateKeyForAddress(owner.getExternalAddresses()[0] ?? ''), true),
      ),
    );
    const stranger = getPublicKey(new Uint8Array(32).fill(9), true);
    const mine = createMultisigRedeemScript(1, [ownerPubkey, stranger]);
    const theirs = createMultisigRedeemScript(1, [stranger]);
    await db.insertWatchAddress(multisigAddress(mine, testnet), bytesToHex(mine), 'ours');
    await db.insertWatchAddress(multisigAddress(theirs, testnet), bytesToHex(theirs), 'theirs');
    await coin('a3'.repeat(32), multisigAddress(mine, testnet));

    // The owner's candidate trees, as the move derives them.
    const facts = await db.legacyPocketFacts();
    const owned = new Set<string>();
    for (const [tree, key] of [
      [oldTree(), OLD_KEY],
      [previousTree(), previousKey],
    ] as const) {
      reachLegacyPocket(tree, facts, key);
      for (const address of [...tree.getExternalAddresses(), ...tree.getChangeAddresses()]) {
        owned.add(address);
      }
    }
    await db.keepOnlyOwnerData({
      ownsHdAddress: (address) => owned.has(address),
      keepsKey: (key) => key === OLD_KEY || key === previousKey,
      derivesSocialRow: () => false,
      namesOwnerKey: (script) =>
        parseMultisigRedeemScript(hexToBytes(script)).pubkeys.some((pubkey) =>
          owned.has(publicKeyToAddress(pubkey, testnet)),
        ),
    });

    const kept = new Set((await db.getAllUTXOs()).map((u) => u.address));
    expect(kept.has(farChange.address)).toBe(true);
    expect(kept.has(farPrevious.address)).toBe(true);
    expect(kept.has(multisigAddress(mine, testnet))).toBe(true);
    expect((await db.getWatchAddresses()).map((w) => w.address)).toEqual([
      multisigAddress(mine, testnet),
    ]);
    await db.close();
  });
});

describe('a late proof merges into the wallet in use (R6-6)', () => {
  test('what the wallet has wins; what it lacks is added; the rescan starts at the lowest coin', async () => {
    const target = await fresh();
    const source = await fresh();
    const tree = oldTree();
    const a = tree.getNextAddress();
    const b = tree.getNextAddress();
    await target.insertAddress({ ...a, isChange: false, identityPublicKey: OLD_KEY });
    await target.markAddressUsed(a.address);
    await source.insertAddress({ ...a, isChange: false, identityPublicKey: null });
    await source.insertAddress({ ...b, isChange: false, identityPublicKey: null });
    await source.insertUTXO({
      txid: 'cc'.repeat(32),
      vout: 1,
      address: b.address,
      value: 5n,
      script_pub_key: '76a9',
      block_height: 42,
    });
    await source.insertContact('c1', 'Ana', 'fAddress', '');

    expect(await target.mergeFrom(source)).toBe(42);
    const rows = await target.getAddresses();
    expect(rows.find((r) => r.address === a.address)).toMatchObject({
      used: 1,
      identity_public_key: OLD_KEY,
    });
    expect(rows.some((r) => r.address === b.address)).toBe(true);
    expect((await target.getAllUTXOs()).length).toBe(1);
    expect((await target.getContacts()).map((c) => c.name)).toEqual(['Ana']);
    await target.close();
    await source.close();
  });
});
