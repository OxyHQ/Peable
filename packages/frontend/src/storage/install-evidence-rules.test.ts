/**
 * The install evidence counts only on the phone it was recorded on (security
 * review round 7, R7-7).
 */
import { describe, expect, test } from 'bun:test';
import {
  decideInstallEvidence,
  type EvidenceBinding,
  type EvidenceSandbox,
} from './install-evidence-rules';
import { walletIdOfDatabaseFile } from './wallet-keys';

function sandboxOf(files: { record?: string; unbound?: boolean; databases?: string[] }) {
  const state = { record: files.record ?? null, writes: 0 };
  const sandbox: EvidenceSandbox = {
    readRecord: async () => state.record,
    hasUnboundRecord: async () => files.unbound === true,
    databaseFileNames: async () => files.databases ?? [],
    writeRecord: async (text) => {
      state.writes += 1;
      state.record = text;
    },
  };
  return { sandbox, state };
}

function keychainOf(initial: string | null = null) {
  const state = { nonce: initial };
  const binding: EvidenceBinding = {
    read: async () => state.nonce,
    write: async (nonce) => {
      state.nonce = nonce;
    },
  };
  return { binding, state };
}

const idsOf = (names: readonly string[]) => {
  const ids = new Set<string>();
  for (const name of names) {
    const id = walletIdOfDatabaseFile(name);
    if (id !== null) ids.add(id);
  }
  return ids;
};
let counter = 0;
const nonce = () => `n${String(++counter)}`;

describe('install evidence is bound to this phone (R7-7)', () => {
  test('first look: the sandbox databases, bound to a nonce written before the record', async () => {
    const { sandbox, state } = sandboxOf({ databases: ['fairwallet_w1.db', 'other.db'] });
    const keychain = keychainOf();
    const evidence = await decideInstallEvidence(sandbox, keychain.binding, idsOf, nonce);
    expect([...evidence.walletIds]).toEqual(['w1']);
    expect(keychain.state.nonce).not.toBeNull();
    expect(JSON.parse(state.record ?? '{}')).toEqual({
      walletIds: ['w1'],
      nonce: keychain.state.nonce,
    });
    // The same phone, the next launch: the record counts.
    const again = await decideInstallEvidence(sandbox, keychain.binding, idsOf, nonce);
    expect([...again.walletIds]).toEqual(['w1']);
  });

  test('a sandbox restored onto another phone (no nonce in its keychain) is no evidence, and is not recomputed', async () => {
    const { sandbox, state } = sandboxOf({
      record: JSON.stringify({ walletIds: ['w1'], nonce: 'from-the-old-phone' }),
      databases: ['fairwallet_w1.db'],
    });
    const evidence = await decideInstallEvidence(sandbox, keychainOf().binding, idsOf, nonce);
    expect(evidence.walletIds.size).toBe(0);
    expect(state.writes).toBe(0);
  });

  test('a nonce that differs is no evidence', async () => {
    const { sandbox } = sandboxOf({ record: JSON.stringify({ walletIds: ['w1'], nonce: 'a' }) });
    const evidence = await decideInstallEvidence(sandbox, keychainOf('b').binding, idsOf, nonce);
    expect(evidence.walletIds.size).toBe(0);
  });

  test('the unbound round-6 record is never evidence: recorded empty and bound', async () => {
    const { sandbox, state } = sandboxOf({ unbound: true, databases: ['fairwallet_w1.db'] });
    const keychain = keychainOf();
    const evidence = await decideInstallEvidence(sandbox, keychain.binding, idsOf, nonce);
    expect(evidence.walletIds.size).toBe(0);
    expect(JSON.parse(state.record ?? '{}').walletIds).toEqual([]);
  });

  test('a keychain that cannot be read throws: no conclusion', async () => {
    const { sandbox } = sandboxOf({ record: JSON.stringify({ walletIds: ['w1'], nonce: 'a' }) });
    const binding: EvidenceBinding = {
      read: async () => {
        throw new Error('errSecInteractionNotAllowed');
      },
      write: async () => {},
    };
    await expect(decideInstallEvidence(sandbox, binding, idsOf, nonce)).rejects.toThrow();
  });

  test('a nonce that does not read back throws before any record is written', async () => {
    const { sandbox, state } = sandboxOf({ databases: ['fairwallet_w1.db'] });
    const binding: EvidenceBinding = { read: async () => null, write: async () => {} };
    await expect(decideInstallEvidence(sandbox, binding, idsOf, nonce)).rejects.toThrow();
    expect(state.writes).toBe(0);
  });
});
