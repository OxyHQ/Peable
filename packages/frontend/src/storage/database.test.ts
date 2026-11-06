/**
 * The wallet database's round-6 rules (security review round 6, R6-1, R6-2,
 * R6-6), on a real SQLite: `bun:sqlite` behind the slice of `expo-sqlite`
 * `Database` uses.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
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
const { getNetwork } = await import('@fairco.in/core');
const { openReceiveAddress } = await import('../wallet/receive-address');

const testnet = getNetwork('testnet');
const OLD_KEY = '02'.padEnd(66, '1');
const NEW_KEY = '03'.padEnd(66, '2');
const oldTree = () => KeyManager.fromSeed(new Uint8Array(32).fill(1), testnet);
const newTree = () => KeyManager.fromSeed(new Uint8Array(32).fill(2), testnet);

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
    const opened = await openReceiveAddress(db, after, NEW_KEY);
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

    const opened = await openReceiveAddress(db, newTree(), NEW_KEY);
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
    const opened = await openReceiveAddress(db, newTree(), NEW_KEY);
    expect(opened.receiveAddress).toBe(newTree().getNextAddress().address);
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
    const opened = await openReceiveAddress(db, newTree(), null);
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
