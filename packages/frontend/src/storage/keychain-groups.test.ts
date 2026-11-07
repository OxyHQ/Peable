/**
 * Peable's own keychain items after the iOS access-group split (oxy ADR 0062):
 * moved out of the shared group ONCE, before any other storage call, never
 * over a value the wallet group already holds, and never read from the shared
 * group again once the move's marker exists. Untouched on every other platform.
 */
import { describe, expect, test } from 'bun:test';
import type { KeychainAccess } from '@oxy.so/core/crypto';
import { readSharedWithoutInteraction } from '@oxy.so/core/session';
import {
  createGroupedKeychainAdapter,
  type KeychainStore,
  nonPromptingSharedRead,
  type SharedGroupPolicy,
} from './keychain-groups';
import {
  type InstallEvidence,
  KEYCHAIN_ADOPTED_WALLETS,
  KEYCHAIN_MOVE_MARKER,
  KEYCHAIN_RECHECK_MARKER,
  keychainMoveKeys,
  SECRET_PREFIXES,
  walletSecretKeys,
  walletSeedKey,
} from './wallet-keys';

const WALLET = 'ABCDE12345.so.oxy.wallet';
const SHARED = 'ABCDE12345.group.so.oxy.shared';
const PEABLE: KeychainAccess = {
  mode: 'grouped',
  prefix: 'ABCDE12345.',
  defaultGroup: WALLET,
  role: 'wallet',
};
const peable = async () => PEABLE;
const INDEX = JSON.stringify([{ id: 'w1', name: 'Wallet 1', createdAt: 1 }]);

/**
 * Apple's semantics, reduced: no group → every entitled group in order. With
 * `slowShared`, a read that can reach the shared group answers what it saw a
 * few milliseconds LATER, as a native call does — the window the app's own
 * writes and deletes used to race the move through.
 */
function keychain(entitlements = [WALLET, SHARED]) {
  const items = new Map<string, string>();
  const calls: Array<{ op: string; key: string; options?: { accessGroup?: string } }> = [];
  let failWrites = false;
  let slowShared = false;
  const store: KeychainStore = {
    getItemAsync: async (key, options?: { accessGroup?: string }) => {
      calls.push({ op: 'get', key, options });
      let found: string | null = null;
      for (const g of options?.accessGroup ? [options.accessGroup] : entitlements) {
        const v = items.get(`${g}|${key}`);
        if (v !== undefined) {
          found = v;
          break;
        }
      }
      if (slowShared && options?.accessGroup !== WALLET) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return found;
    },
    setItemAsync: async (key, value, options?: { accessGroup?: string }) => {
      calls.push({ op: 'set', key, options });
      if (failWrites) throw new Error('errSecIO');
      items.set(`${options?.accessGroup ?? entitlements[0]}|${key}`, value);
    },
    deleteItemAsync: async (key, options?: { accessGroup?: string }) => {
      calls.push({ op: 'delete', key, options });
      for (const g of options?.accessGroup ? [options.accessGroup] : entitlements) {
        items.delete(`${g}|${key}`);
      }
    },
  };
  return {
    items,
    calls,
    store,
    setFailWrites: (v: boolean) => (failWrites = v),
    setSlowShared: (v: boolean) => (slowShared = v),
  };
}

/** The sandbox of a phone that ran a pre-split build with these wallets. */
const PRE_SPLIT_INSTALL: InstallEvidence = {
  walletIds: new Set(['w1', 'oxy-org-abc', 'oxy-identity']),
};

/**
 * The shared group read without prompting (the store's read in these tests,
 * recorded as a `noninteractive` call) and the sandbox's evidence.
 */
function policyOf(
  k: ReturnType<typeof keychain>,
  evidence: InstallEvidence = PRE_SPLIT_INSTALL,
  reader = true,
): SharedGroupPolicy {
  return {
    readWithoutInteraction: reader
      ? async (key, accessGroup) => {
          k.calls.push({ op: 'noninteractive', key, options: { accessGroup } });
          return k.items.get(`${accessGroup}|${key}`) ?? null;
        }
      : null,
    evidence: async () => evidence,
    deviceOnly: {},
  };
}

/** A keychain as a pre-split build left it: everything in the shared group. */
function preSplit(entries: Record<string, string>) {
  const k = keychain();
  for (const [key, value] of Object.entries(entries)) k.items.set(`${SHARED}|${key}`, value);
  return k;
}

/** Run `fn` a millisecond from now: while a slow shared read is in flight. */
async function later(fn: () => Promise<void>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await fn();
}

const sharedReads = (k: ReturnType<typeof keychain>) =>
  k.calls.filter(
    (c) => (c.op === 'get' || c.op === 'noninteractive') && c.options?.accessGroup !== WALLET,
  );

describe('the one-shot move out of the shared group', () => {
  test('every indexed wallet secret moves — but never a cached seed or the legacy phrase (R4-8, R6-4)', async () => {
    const entries: Record<string, string> = {
      fairwallet_wallets_index: INDEX,
      fairwallet_active_wallet: 'w1',
    };
    for (const key of walletSecretKeys(['w1'])) entries[key] ??= `v:${key}`;
    const k = preSplit(entries);
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    await kv.getItem('fairwallet_currency');
    const neverFromShared = (key: string) =>
      key.startsWith(SECRET_PREFIXES.seed) ||
      key === 'fairwallet_mnemonic' ||
      key === 'fairwallet_pin';
    for (const [key, value] of Object.entries(entries)) {
      if (neverFromShared(key)) {
        expect(k.items.has(`${WALLET}|${key}`)).toBe(false);
        expect(k.items.get(`${SHARED}|${key}`)).toBe(value);
        continue;
      }
      expect(k.items.get(`${WALLET}|${key}`)).toBe(value);
      expect(k.items.has(`${SHARED}|${key}`)).toBe(false);
    }
    expect(k.items.has(`${WALLET}|${walletSeedKey('default')}`)).toBe(false);
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
    expect(k.items.has(`${SHARED}|${KEYCHAIN_MOVE_MARKER}`)).toBe(false);
    // The phrase came from the group every Oxy app writes: confirmed before receiving.
    expect(JSON.parse(k.items.get(`${WALLET}|${KEYCHAIN_ADOPTED_WALLETS}`) ?? '[]')).toEqual([
      'w1',
    ]);
  });

  test('the move covers every secret clearAll deletes, and the preferences', () => {
    const moved = new Set(keychainMoveKeys(['w1', 'oxy-org-abc']));
    for (const key of walletSecretKeys(['w1', 'oxy-org-abc'])) expect(moved.has(key)).toBe(true);
    for (const key of ['fairwallet_pockets_oxy-identity', 'fairwallet_pin_attempts']) {
      expect(moved.has(key)).toBe(true);
    }
    expect(moved.has(KEYCHAIN_MOVE_MARKER)).toBe(false);
  });

  test('the active identity wallet is enumerated although no index names it', async () => {
    const k = preSplit({
      fairwallet_active_wallet: 'oxy-org-abc',
      'fairwallet_pockets_oxy-org-abc': '[0,1]',
    });
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await kv.getItem('fairwallet_pockets_oxy-org-abc')).toBe('[0,1]');
    expect(k.items.has(`${SHARED}|fairwallet_pockets_oxy-org-abc`)).toBe(false);
  });

  test('a newer value in the wallet group is never overwritten (R4-14)', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_mnemonic_w1: 'old words' });
    k.items.set(`${WALLET}|fairwallet_mnemonic_w1`, 'new words');
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBe('new words');
    expect(k.items.has(`${SHARED}|fairwallet_mnemonic_w1`)).toBe(false);
  });

  test('a write issued while the move runs lands after it, and wins (R4-14)', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_pin: 'old record' });
    k.setSlowShared(true);
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    // The write is issued while the first read is still waiting on the keychain.
    await Promise.all([
      kv.getItem('fairwallet_pin'),
      later(() => kv.setItem('fairwallet_pin', 'new record')),
    ]);
    expect(await kv.getItem('fairwallet_pin')).toBe('new record');
    expect(k.items.get(`${WALLET}|fairwallet_pin`)).toBe('new record');
  });

  test('a deleted phrase is not resurrected — this launch or the next (R4-14)', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_mnemonic_w1: 'words' });
    k.setSlowShared(true);
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    await Promise.all([
      kv.getItem('fairwallet_mnemonic_w1'),
      later(() => kv.deleteItem('fairwallet_mnemonic_w1')),
    ]);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
    const nextLaunch = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await nextLaunch.getItem('fairwallet_mnemonic_w1')).toBeNull();
  });

  test('a failed move: read-only fallback, no marker, retried next launch', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_mnemonic_w1: 'words' });
    k.setFailWrites(true);
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBe('words');
    // Answered from the shared group: adopted, unconfirmed, though not copied.
    expect(await kv.getItem(KEYCHAIN_ADOPTED_WALLETS)).toBe('["w1"]');
    expect(k.items.get(`${SHARED}|fairwallet_mnemonic_w1`)).toBe('words');
    expect(k.items.has(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe(false);
    k.setFailWrites(false);
    const nextLaunch = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await nextLaunch.getItem('fairwallet_mnemonic_w1')).toBe('words');
    expect(k.items.has(`${SHARED}|fairwallet_mnemonic_w1`)).toBe(false);
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });

  test('without a marker, a key this launch deleted is not answered from the shared group', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX });
    k.setFailWrites(true);
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    await kv.deleteItem('fairwallet_mnemonic_w1');
    k.items.set(`${SHARED}|fairwallet_mnemonic_w1`, 'planted');
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
  });

  test('only the wallet keys are adopted: anything else in the shared group is ignored', async () => {
    const k = preSplit({ some_other_app_key: 'x', fairwallet_unknown: 'y' });
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await kv.getItem('some_other_app_key')).toBeNull();
    expect(await kv.getItem('fairwallet_unknown')).toBeNull();
    expect(k.items.has(`${WALLET}|some_other_app_key`)).toBe(false);
  });

  test('an index id no keychain key can carry does not block the marker', async () => {
    const k = preSplit({
      fairwallet_wallets_index: JSON.stringify([{ id: 'bad id/..' }, { id: 'w1' }]),
    });
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    await kv.getItem('fairwallet_currency');
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });
});

describe('nothing is taken from the shared group without proof of an earlier install (R6-4)', () => {
  /** What a malicious Oxy app plants before Peable's first launch. */
  const planted = {
    fairwallet_wallets_index: JSON.stringify([{ id: 'evil', name: 'Wallet', createdAt: 1 }]),
    fairwallet_active_wallet: 'evil',
    fairwallet_mnemonic_evil: 'attacker words',
    fairwallet_pin: 'attacker pin record',
    fairwallet_seed_evil: 'attacker seed',
  };

  test('a fresh install (no evidence) adopts nothing, leaves it where it is, and finishes', async () => {
    const k = preSplit(planted);
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k, { walletIds: new Set() }));
    expect(await kv.getItem('fairwallet_wallets_index')).toBeNull();
    expect(await kv.getItem('fairwallet_active_wallet')).toBeNull();
    expect(await kv.getItem('fairwallet_mnemonic_evil')).toBeNull();
    expect(await kv.getItem('fairwallet_pin')).toBeNull();
    expect(k.items.get(`${SHARED}|fairwallet_mnemonic_evil`)).toBe('attacker words');
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
    expect(sharedReads(k)).toEqual([]);
  });

  test('with evidence of other wallets, a planted wallet, pointer and seed are not taken', async () => {
    const k = preSplit({
      ...planted,
      fairwallet_wallets_index: INDEX.replace(']', `,${planted.fairwallet_wallets_index.slice(1)}`),
    });
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await kv.getItem('fairwallet_wallets_index')).toBe(INDEX);
    expect(await kv.getItem('fairwallet_active_wallet')).toBeNull();
    expect(await kv.getItem('fairwallet_mnemonic_evil')).toBeNull();
    expect(await kv.getItem('fairwallet_seed_evil')).toBeNull();
  });

  test('without a non-prompting reader the shared group is never read', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_mnemonic_w1: 'words' });
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k, PRE_SPLIT_INSTALL, false));
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
    expect(k.calls.filter((c) => c.options?.accessGroup === SHARED && c.op !== 'delete')).toEqual(
      [],
    );
  });

  test('every shared-group read goes through the non-prompting reader', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_mnemonic_w1: 'words' });
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBe('words');
    expect(k.calls.some((c) => c.op === 'noninteractive')).toBe(true);
    expect(k.calls.filter((c) => c.op === 'get' && c.options?.accessGroup === SHARED)).toEqual([]);
  });
});

describe('round 7: bound evidence, no PIN, a recheck of 1.2–1.4 adoptions (R7-7)', () => {
  test('the PIN record is never taken from the shared group, even with evidence', async () => {
    const k = preSplit({
      fairwallet_wallets_index: INDEX,
      fairwallet_mnemonic_w1: 'words',
      fairwallet_pin: 'planted pin record',
      fairwallet_pin_attempts: '9',
    });
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await kv.getItem('fairwallet_pin')).toBeNull();
    expect(await kv.getItem('fairwallet_pin_attempts')).toBeNull();
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBe('words');
    expect(k.items.get(`${SHARED}|fairwallet_pin`)).toBe('planted pin record');
  });

  test('evidence that cannot be read now: nothing from the shared group, and no marker', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX, fairwallet_mnemonic_w1: 'words' });
    const locked: SharedGroupPolicy = {
      ...policyOf(k),
      evidence: async () => {
        throw new Error('errSecInteractionNotAllowed');
      },
    };
    const kv = createGroupedKeychainAdapter(k.store, peable, locked);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
    expect(k.items.has(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe(false);
    // The next launch, with the keychain readable, takes it.
    const next = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await next.getItem('fairwallet_mnemonic_w1')).toBe('words');
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });

  test('the evidence is bound through a device-only nonce in the wallet group', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX });
    const readBack: string[] = [];
    const policy: SharedGroupPolicy = {
      ...policyOf(k),
      deviceOnly: { keychainAccessible: 'this-device-only' },
      evidence: async (binding) => {
        await binding.write('nonce-1');
        readBack.push((await binding.read()) ?? '');
        return PRE_SPLIT_INSTALL;
      },
    };
    await createGroupedKeychainAdapter(k.store, peable, policy).getItem('fairwallet_currency');
    expect(readBack).toEqual(['nonce-1']);
    expect(k.items.get(`${WALLET}|peable_install_evidence_v2`)).toBe('nonce-1');
    const set = k.calls.find((c) => c.op === 'set' && c.key === 'peable_install_evidence_v2');
    expect(set?.options as object).toEqual({
      keychainAccessible: 'this-device-only',
      accessGroup: WALLET,
    });
  });

  test('wallets a 1.2–1.4 build moved are listed as adopted once, then never again', async () => {
    // As a 1.4 build left it: everything in the wallet group, its marker, no list.
    const k = keychain();
    const index = JSON.stringify([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
    k.items.set(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`, '1');
    k.items.set(`${WALLET}|fairwallet_wallets_index`, index);
    k.items.set(`${WALLET}|fairwallet_mnemonic_w1`, 'words');
    k.items.set(`${WALLET}|fairwallet_xpub_w2`, 'xpub');
    // w3 has no phrase or xpub here (nothing spendable to adopt).
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(JSON.parse((await kv.getItem(KEYCHAIN_ADOPTED_WALLETS)) ?? '[]')).toEqual(['w1', 'w2']);
    expect(k.items.get(`${WALLET}|${KEYCHAIN_RECHECK_MARKER}`)).toBe('1');
    expect(sharedReads(k)).toEqual([]);

    // The person confirms w1; the next launch does not list it again.
    await kv.setItem(KEYCHAIN_ADOPTED_WALLETS, JSON.stringify(['w2']));
    const next = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(JSON.parse((await next.getItem(KEYCHAIN_ADOPTED_WALLETS)) ?? '[]')).toEqual(['w2']);
  });
});

describe('after the marker', () => {
  test('the shared group is never read again, and a planted item is ignored (R4-7)', async () => {
    const k = preSplit({ fairwallet_wallets_index: INDEX });
    await createGroupedKeychainAdapter(k.store, peable, policyOf(k)).getItem('fairwallet_pin');
    expect(k.items.get(`${WALLET}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');

    // Another Oxy app plants a wallet in the group it can write.
    k.items.set(`${SHARED}|fairwallet_mnemonic_evil`, 'attacker words');
    k.items.set(`${SHARED}|fairwallet_active_wallet`, 'evil');
    k.items.set(`${SHARED}|fairwallet_pin`, 'attacker pin record');
    k.calls.length = 0;

    const nextLaunch = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    expect(await nextLaunch.getItem('fairwallet_mnemonic_evil')).toBeNull();
    expect(await nextLaunch.getItem('fairwallet_active_wallet')).toBeNull();
    expect(await nextLaunch.getItem('fairwallet_pin')).toBeNull();
    expect(sharedReads(k)).toEqual([]);
    expect(k.items.has(`${WALLET}|fairwallet_mnemonic_evil`)).toBe(false);
  });

  test('a write lands in the wallet group and removes a shared copy', async () => {
    const k = preSplit({});
    const kv = createGroupedKeychainAdapter(k.store, peable, policyOf(k));
    await kv.getItem('fairwallet_pin');
    k.items.set(`${SHARED}|fairwallet_pin`, 'planted');
    await kv.setItem('fairwallet_pin', 'new');
    expect(k.items.get(`${WALLET}|fairwallet_pin`)).toBe('new');
    expect(k.items.has(`${SHARED}|fairwallet_pin`)).toBe(false);
    expect(await kv.getItem('fairwallet_pin')).toBe('new');
  });
});

describe("a native build with the app's own group (core 7.31+, ADR 0062 D6)", () => {
  const APP = 'ABCDE12345.to.peable.app';
  const WITH_APP: KeychainAccess = { ...PEABLE, appGroup: APP };
  const withApp = async () => WITH_APP;
  /** A keychain as the wallet-group build left it, plus anything still shared. */
  function walletGroupBuild(wallet: Record<string, string>, shared: Record<string, string> = {}) {
    const k = keychain([WALLET, SHARED, APP]);
    for (const [key, value] of Object.entries(wallet)) k.items.set(`${WALLET}|${key}`, value);
    for (const [key, value] of Object.entries(shared)) k.items.set(`${SHARED}|${key}`, value);
    return k;
  }

  test('what the wallet group holds moves to the app group; a planted shared item does not', async () => {
    const k = walletGroupBuild(
      {
        [KEYCHAIN_MOVE_MARKER]: '1',
        fairwallet_wallets_index: INDEX,
        fairwallet_mnemonic_w1: 'words',
        fairwallet_pin: 'pin record',
      },
      { fairwallet_seed_w1: 'planted seed', fairwallet_currency: 'XXX' },
    );
    const kv = createGroupedKeychainAdapter(k.store, withApp, policyOf(k));
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBe('words');
    expect(await kv.getItem('fairwallet_seed_w1')).toBeNull();
    expect(await kv.getItem('fairwallet_currency')).toBeNull();
    expect(k.items.get(`${APP}|fairwallet_wallets_index`)).toBe(INDEX);
    expect(k.items.get(`${APP}|fairwallet_pin`)).toBe('pin record');
    expect(k.items.has(`${WALLET}|fairwallet_mnemonic_w1`)).toBe(false);
    expect(k.items.has(`${WALLET}|fairwallet_pin`)).toBe(false);
    expect(k.items.has(`${APP}|fairwallet_seed_w1`)).toBe(false);
    expect(k.items.get(`${APP}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });

  test('straight from a pre-split build: the shared items move to the app group', async () => {
    const k = walletGroupBuild({}, { fairwallet_wallets_index: INDEX, fairwallet_xpub_w1: 'xp' });
    const kv = createGroupedKeychainAdapter(k.store, withApp, policyOf(k));
    expect(await kv.getItem('fairwallet_xpub_w1')).toBe('xp');
    expect(k.items.get(`${APP}|fairwallet_xpub_w1`)).toBe('xp');
    expect(k.items.has(`${SHARED}|fairwallet_xpub_w1`)).toBe(false);
    expect(k.items.get(`${APP}|${KEYCHAIN_ADOPTED_WALLETS}`)).toBe('["w1"]');
    expect(k.items.get(`${APP}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
  });

  test('an unfinished wallet-group move: its value wins over the shared one', async () => {
    const k = walletGroupBuild(
      { fairwallet_pin: 'newer' },
      { fairwallet_pin: 'older', fairwallet_wallets_index: INDEX },
    );
    const kv = createGroupedKeychainAdapter(k.store, withApp, policyOf(k));
    expect(await kv.getItem('fairwallet_pin')).toBe('newer');
    expect(k.items.has(`${WALLET}|fairwallet_pin`)).toBe(false);
    // The shared PIN record is never taken (R7-7): it stays where it is.
    expect(k.items.get(`${SHARED}|fairwallet_pin`)).toBe('older');
    expect(await kv.getItem('fairwallet_wallets_index')).toBe(INDEX);
  });

  test('a failed move falls back to the wallet group, never to a closed shared group', async () => {
    const k = walletGroupBuild(
      { [KEYCHAIN_MOVE_MARKER]: '1', fairwallet_wallets_index: INDEX },
      { fairwallet_mnemonic_w1: 'planted' },
    );
    k.setFailWrites(true);
    const kv = createGroupedKeychainAdapter(k.store, withApp, policyOf(k));
    expect(await kv.getItem('fairwallet_wallets_index')).toBe(INDEX);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
    expect(k.items.has(`${APP}|${KEYCHAIN_MOVE_MARKER}`)).toBe(false);
  });

  test('after the marker neither earlier group is read; a write clears both copies', async () => {
    const k = walletGroupBuild({ [KEYCHAIN_MOVE_MARKER]: '1' });
    await createGroupedKeychainAdapter(k.store, withApp, policyOf(k)).getItem('fairwallet_pin');
    k.items.set(`${WALLET}|fairwallet_pin`, 'stale');
    k.items.set(`${SHARED}|fairwallet_pin`, 'planted');
    k.calls.length = 0;
    const nextLaunch = createGroupedKeychainAdapter(k.store, withApp, policyOf(k));
    expect(await nextLaunch.getItem('fairwallet_pin')).toBeNull();
    expect(k.calls.filter((c) => c.op === 'get' && c.options?.accessGroup !== APP)).toEqual([]);
    await nextLaunch.setItem('fairwallet_pin', 'new');
    expect(k.items.get(`${APP}|fairwallet_pin`)).toBe('new');
    expect(k.items.has(`${WALLET}|fairwallet_pin`)).toBe(false);
    expect(k.items.has(`${SHARED}|fairwallet_pin`)).toBe(false);
  });

  test('a delete names the app group: wiping a wallet never rests on the default group', async () => {
    const k = walletGroupBuild({ [KEYCHAIN_MOVE_MARKER]: '1' });
    const kv = createGroupedKeychainAdapter(k.store, withApp, policyOf(k));
    await kv.setItem('fairwallet_seed_w1', 'seed');
    k.items.set(`${WALLET}|fairwallet_seed_w1`, 'stale');
    k.calls.length = 0;
    await kv.deleteItem('fairwallet_seed_w1');
    const deletes = k.calls.filter((c) => c.op === 'delete').map((c) => c.options?.accessGroup);
    expect(deletes).toEqual([APP, WALLET, SHARED, undefined]);
    expect(await kv.getItem('fairwallet_seed_w1')).toBeNull();
  });

  test('the dev build uses its own groups: to.peable.app.dev, then so.oxy.wallet.dev', async () => {
    const DEV_WALLET = 'ABCDE12345.so.oxy.wallet.dev';
    const DEV_APP = 'ABCDE12345.to.peable.app.dev';
    const dev: KeychainAccess = {
      mode: 'grouped',
      prefix: 'ABCDE12345.',
      defaultGroup: DEV_WALLET,
      role: 'wallet',
      appGroup: DEV_APP,
      variant: '.dev',
    };
    const k = keychain([DEV_WALLET, SHARED, DEV_APP]);
    k.items.set(`${DEV_WALLET}|fairwallet_pin`, 'dev pin');
    const kv = createGroupedKeychainAdapter(k.store, async () => dev, policyOf(k));
    expect(await kv.getItem('fairwallet_pin')).toBe('dev pin');
    expect(k.items.get(`${DEV_APP}|fairwallet_pin`)).toBe('dev pin');
    expect(k.calls.some((c) => c.options?.accessGroup === WALLET)).toBe(false);
    expect(k.calls.some((c) => c.options?.accessGroup === SHARED)).toBe(false);
  });
});

describe('a development build never touches the shared group (R5-5)', () => {
  const DEV_WALLET = 'ABCDE12345.so.oxy.wallet.dev';
  const DEV_APP = 'ABCDE12345.to.peable.app.dev';
  const dev: KeychainAccess = {
    mode: 'grouped',
    prefix: 'ABCDE12345.',
    defaultGroup: DEV_WALLET,
    role: 'wallet',
    appGroup: DEV_APP,
    variant: '.dev',
  };
  /** A phone carrying the production wallet's pre-split items in the shared group. */
  function devPhone() {
    const k = keychain([DEV_WALLET, SHARED, DEV_APP]);
    k.items.set(`${SHARED}|fairwallet_wallets_index`, INDEX);
    k.items.set(`${SHARED}|fairwallet_mnemonic_w1`, 'production words');
    k.items.set(`${SHARED}|fairwallet_pin`, 'production pin');
    return k;
  }
  const sharedCalls = (k: ReturnType<typeof keychain>) =>
    k.calls.filter((c) => c.options?.accessGroup === SHARED || c.options === undefined);

  test('the move neither adopts nor deletes what the shared group holds', async () => {
    const k = devPhone();
    const kv = createGroupedKeychainAdapter(k.store, async () => dev, policyOf(k));
    expect(await kv.getItem('fairwallet_wallets_index')).toBeNull();
    expect(await kv.getItem('fairwallet_pin')).toBeNull();
    expect(k.items.get(`${SHARED}|fairwallet_mnemonic_w1`)).toBe('production words');
    expect(k.items.get(`${SHARED}|fairwallet_pin`)).toBe('production pin');
    expect(k.items.has(`${DEV_APP}|fairwallet_pin`)).toBe(false);
    expect(k.items.get(`${DEV_APP}|${KEYCHAIN_MOVE_MARKER}`)).toBe('1');
    expect(sharedCalls(k)).toEqual([]);
  });

  test('a failed move falls back to the dev wallet group only', async () => {
    const k = devPhone();
    k.items.set(`${DEV_WALLET}|fairwallet_wallets_index`, INDEX);
    k.setFailWrites(true);
    const kv = createGroupedKeychainAdapter(k.store, async () => dev, policyOf(k));
    expect(await kv.getItem('fairwallet_wallets_index')).toBe(INDEX);
    expect(await kv.getItem('fairwallet_mnemonic_w1')).toBeNull();
    expect(sharedCalls(k)).toEqual([]);
  });

  test('writes and deletes leave the shared copy alone and make no unscoped call', async () => {
    const k = devPhone();
    const kv = createGroupedKeychainAdapter(k.store, async () => dev, policyOf(k));
    await kv.setItem('fairwallet_pin', 'dev pin');
    expect(k.items.get(`${DEV_APP}|fairwallet_pin`)).toBe('dev pin');
    await kv.deleteItem('fairwallet_pin');
    expect(k.items.has(`${DEV_APP}|fairwallet_pin`)).toBe(false);
    const deletes = k.calls.filter((c) => c.op === 'delete').map((c) => c.options?.accessGroup);
    expect(deletes).toEqual([DEV_WALLET, DEV_APP, DEV_WALLET]);
    expect(k.items.get(`${SHARED}|fairwallet_pin`)).toBe('production pin');
    expect(sharedCalls(k)).toEqual([]);
  });
});

describe('other platforms', () => {
  test('Android, web and a build without the probe make the calls they always made', async () => {
    const k = keychain([SHARED]);
    const kv = createGroupedKeychainAdapter(
      k.store,
      async () => ({ mode: 'ungrouped' }),
      policyOf(k),
    );
    await kv.setItem('fairwallet_currency', 'EUR');
    expect(await kv.getItem('fairwallet_currency')).toBe('EUR');
    await kv.deleteItem('fairwallet_currency');
    expect(k.calls.map((c) => c.op)).toEqual(['set', 'get', 'delete']);
    expect(k.calls.every((c) => c.options === undefined)).toBe(true);
  });
});

describe("the shared group is read through core's readSharedWithoutInteraction (R6-16)", () => {
  test('with the native reader: one non-prompting read of the named group', async () => {
    const seen: unknown[] = [];
    const read = nonPromptingSharedRead(async (_store, key, options, shared) => {
      seen.push({ key, options, shared });
      return 'planted?';
    });
    expect(await read('fairwallet_pin', SHARED)).toBe('planted?');
    expect(seen).toEqual([{ key: 'fairwallet_pin', options: {}, shared: { accessGroup: SHARED } }]);
  });

  test("without it, core's fallback store answers nothing: no expo-secure-store read", async () => {
    // Core falls back to the store it is given on a native module that predates
    // the reader; the store it is given here never reads the keychain.
    const read = nonPromptingSharedRead((store, key, options, shared) =>
      store.getItemAsync(key, { ...options, ...shared }),
    );
    expect(await read('fairwallet_pin', SHARED)).toBeNull();
  });

  test('the real core function, with no native module, reads nothing', async () => {
    const read = nonPromptingSharedRead(readSharedWithoutInteraction);
    expect(await read('fairwallet_pin', SHARED)).toBeNull();
  });

  test('a thrown read (a locked keychain) propagates; it is never "absent"', async () => {
    const read = nonPromptingSharedRead(async () => {
      throw new Error('errSecInteractionNotAllowed');
    });
    await expect(read('fairwallet_pin', SHARED)).rejects.toThrow('errSecInteractionNotAllowed');
  });

  test('the fallback store refuses writes and deletes', async () => {
    const given: KeychainStore[] = [];
    await nonPromptingSharedRead(async (store) => {
      given.push(store);
      return null;
    })('k', SHARED);
    expect(given).toHaveLength(1);
    await expect(given[0].setItemAsync('k', 'v')).rejects.toThrow();
    await expect(given[0].deleteItemAsync('k')).rejects.toThrow();
  });
});
