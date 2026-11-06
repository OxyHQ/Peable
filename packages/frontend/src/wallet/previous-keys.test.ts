/**
 * Previous identity keys stay spendable (Peable ADR 0002, amended 2026-11-06;
 * mainnet gate F1). Every key here is generated for the test.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPublicKey, utils } from '@noble/secp256k1';
import {
  buildTransaction,
  bytesToHex,
  deriveSocialReceiveAddress,
  getNetwork,
  createP2PKHScript,
  decodeAddress,
  publicKeyToAddress,
  verifyPartialSignature,
  type Transaction,
} from '@fairco.in/core';
import { signSocialReceiveDigest } from '@oxy.so/core/crypto';
import { KeyManager, type UTXO } from '@peable.to/pay';
import {
  advanceTreeOverKnownAddresses,
  canonicalKey,
  discoverPreviousTree,
  groupPreviousKeys,
  MOVE_FEE_RATE_MAX,
  MOVE_FEE_RATE_MIN,
  parseMoveFeeRate,
  PREVIOUS_KEY_MOVE_MAX_INPUTS,
  planPreviousKeyMove,
  samePreviousKeyMovePlan,
  previousKeyCopy,
  previousKeyDefaultRow,
  probePreviousKeys,
  signWalletInput,
  type DiscoveryUsage,
  type InputSigner,
} from './previous-keys';
import { p2pkhSigHash, signSocialReceiveInput, type SocialReceiveSign } from './social-receive';
import type { WatchSetRow } from './social-receive-watch';
import {
  partitionStrandedCoins,
  previousKeyCoins,
  signableCoins,
  sumCoinValues,
} from './spendable';

const TESTNET = getNetwork('testnet');
const PERSON = { kind: 'personal', accountId: '0123456789abcdef01234567' } as const;

const scriptForAddress = (address: string, _network: unknown): Uint8Array =>
  createP2PKHScript(decodeAddress(address).hash);

/** A fresh identity key pair: private hex, uncompressed and compressed public hex. */
function identityKey(): { priv: string; uncompressed: string; compressed: string } {
  const priv = utils.randomPrivateKey();
  return {
    priv: bytesToHex(priv),
    uncompressed: bytesToHex(getPublicKey(priv, false)),
    compressed: bytesToHex(getPublicKey(priv, true)),
  };
}

function seed(): Uint8Array {
  return utils.randomPrivateKey();
}

function row(address: string, index: number, identityPublicKey: string | null): WatchSetRow {
  return {
    address,
    index,
    identityPublicKey,
    createdAt: 1,
    used: false,
    checkedAt: null,
    nextCheckAt: null,
    foundAt: null,
    origin: 'gateway',
  };
}

function socialRow(
  key: { compressed: string },
  index: number,
  recorded: string | null,
): WatchSetRow {
  const address = deriveSocialReceiveAddress(
    Uint8Array.from(Buffer.from(key.compressed, 'hex')),
    index,
    TESTNET,
  );
  return row(address, index, recorded);
}

describe('groupPreviousKeys', () => {
  const current = identityKey();
  const old = identityKey();
  const older = identityKey();

  test("from an EMPTY database, a key Commons lists has its index 0 — the old Receive sheet's address — watched (R4-1)", () => {
    // A phone that rotated, then was reinstalled: no stored row, no gateway row
    // for index 0 (the gateway never hands it out). Only Commons' list.
    const groups = groupPreviousKeys({
      rows: [],
      currentKeys: [current.compressed],
      extraKeys: [old.uncompressed],
      network: TESTNET,
      now: 1_800_000_000,
    });
    expect(groups).toHaveLength(1);
    const zero = groups[0]?.rows[0];
    expect(zero?.index).toBe(0);
    expect(zero?.origin).toBe('default');
    expect(zero?.identityPublicKey).toBe(old.compressed);
    expect(zero?.checkedAt).toBeNull();
    expect(zero?.address).toBe(socialRow(old, 0, null).address);
    // It is the old key's default address, never the current key's.
    expect(zero?.address).not.toBe(socialRow(current, 0, null).address);
  });

  test('a key whose gateway rows are listed also gets index 0, once (a stored index 0 is not doubled)', () => {
    const stored = { ...socialRow(old, 0, old.compressed), origin: 'default' as const };
    const groups = groupPreviousKeys({
      rows: [stored, socialRow(old, 4, old.compressed)],
      currentKeys: [current.compressed],
      network: TESTNET,
    });
    expect(groups[0]?.rows.map((r) => r.index)).toEqual([0, 4]);
    expect(groups[0]?.rows[0]).toBe(stored);
  });

  test('one key in two encodings is ONE previous key; the current key is never one', () => {
    const groups = groupPreviousKeys({
      rows: [
        socialRow(old, 1, old.uncompressed),
        socialRow(old, 2, old.compressed.toUpperCase()),
        // The current key recorded uncompressed while the device holds it compressed.
        socialRow(current, 3, current.uncompressed),
      ],
      currentKeys: [current.compressed],
      network: TESTNET,
    });
    expect(groups.map((g) => g.key)).toEqual([old.compressed]);
    expect(groups[0]?.rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  test('the published key is not a previous key either, whatever the device holds', () => {
    const groups = groupPreviousKeys({
      rows: [socialRow(old, 1, old.compressed), socialRow(current, 2, current.compressed)],
      currentKeys: [old.compressed, current.uncompressed],
      network: TESTNET,
    });
    expect(groups).toEqual([]);
  });

  test('a keyless row joins the previous key that reproduces it; the rest are left out', () => {
    const groups = groupPreviousKeys({
      rows: [
        socialRow(old, 1, old.compressed),
        socialRow(old, 7, null),
        socialRow(current, 8, null),
        row('Tnobody', 9, null),
      ],
      currentKeys: [current.compressed],
      network: TESTNET,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows.map((r) => r.index)).toEqual([0, 1, 7]);
  });

  test("extra keys (Commons' ring) join with no rows; garbage keys are ignored", () => {
    const groups = groupPreviousKeys({
      rows: [row('Tx', 1, 'not-a-key')],
      currentKeys: [current.compressed, null, undefined],
      extraKeys: [older.uncompressed, current.uncompressed, 'zz'],
      network: TESTNET,
    });
    expect(groups).toEqual([
      { key: older.compressed, rows: [previousKeyDefaultRow(older.compressed, TESTNET, 0)] },
    ]);
    expect(canonicalKey('zz')).toBeNull();
  });
});

describe('probePreviousKeys', () => {
  test('reachable keys build a tree from their seed, which is zeroed after', async () => {
    const seeds = new Map<string, Uint8Array>([['a', seed()]]);
    const seen: string[] = [];
    const { reachable, unreachable } = await probePreviousKeys(
      ['a', 'b', 'c'],
      async (key) => {
        if (key === 'c') throw new Error('Commons absent');
        return seeds.get(key) ?? null;
      },
      (key, bytes) => {
        seen.push(`${key}:${bytes.some((b) => b !== 0)}`);
        return key.toUpperCase();
      },
    );
    expect([...reachable.entries()]).toEqual([['a', 'A']]);
    expect(unreachable).toEqual(['b', 'c']);
    expect(seen).toEqual(['a:true']);
    expect(seeds.get('a')?.every((b) => b === 0)).toBe(true);
  });
});

/** An Explorer over `used` (address -> heights; `[]` = spent out) and `unknown`. */
function explorer(
  used: ReadonlyMap<string, readonly number[]>,
  unknown: ReadonlySet<string> = new Set(),
) {
  const reads: string[][] = [];
  const usage = async (addresses: readonly string[]) => {
    reads.push([...addresses]);
    const answer = new Map<string, DiscoveryUsage>();
    for (const address of addresses) {
      const heights = used.get(address);
      answer.set(address, {
        usage: unknown.has(address) ? 'unknown' : heights ? 'used' : 'unused',
        confirmedHeights: heights ?? [],
        hasUnconfirmed: false,
      });
    }
    return answer;
  };
  return { usage, reads };
}

describe('discoverPreviousTree', () => {
  test('gap-limit discovery follows used addresses, spent-out ones included', async () => {
    // A twin tree tells the addresses without moving the one discovered.
    const twinSeed = seed();
    const tree = KeyManager.fromSeed(twinSeed, TESTNET);
    const twin = KeyManager.fromSeed(twinSeed, TESTNET);
    twin.restoreCursors(61, 0);
    const at = (i: number) => twin.getExternalAddresses()[i] as string;
    const change4 = twin.getChangeAddresses()[4] as string;
    // External 0 spent out (used, no coins), 15 holds coins at 900, 30 —
    // reachable only once 15 moved the window — at 1200; change 4 at 1000;
    // 60 lies past a full unused gap after 30, where no real tree reaches.
    const { usage } = explorer(
      new Map([
        [at(0), []],
        [at(15), [900]],
        [at(30), [1200]],
        [at(60), [5]],
        [change4, [1000]],
      ]),
    );
    const result = await discoverPreviousTree(tree, usage);
    expect(result).toEqual({
      conclusive: true,
      externalNext: 31,
      changeNext: 5,
      rescanFrom: 900,
      holdsCoins: true,
    });
    expect(tree.ownsAddress(at(30))).toBe(true);
    expect(tree.ownsAddress(at(60))).toBe(false);
  });

  test("an address the Explorer cannot judge ends discovery inconclusive (testnet's node)", async () => {
    const tree = KeyManager.fromSeed(seed(), TESTNET);
    const first = tree.getExternalAddresses()[0] as string;
    const { usage } = explorer(new Map(), new Set([first]));
    const result = await discoverPreviousTree(tree, usage);
    expect(result.conclusive).toBe(false);
    expect(result.rescanFrom).toBeNull();
  });

  test('an Explorer failure throws: nothing is recorded as discovered', async () => {
    const tree = KeyManager.fromSeed(seed(), TESTNET);
    await expect(
      discoverPreviousTree(tree, async () => {
        throw new Error('502');
      }),
    ).rejects.toThrow('502');
  });
});

describe('advanceTreeOverKnownAddresses', () => {
  test("a phone that rotated finds its old tree's coins without the Explorer", () => {
    const s = seed();
    const twin = KeyManager.fromSeed(s, TESTNET);
    twin.restoreCursors(40, 0);
    const at15 = twin.getExternalAddresses()[15] as string;
    const at33 = twin.getExternalAddresses()[33] as string;
    const tree = KeyManager.fromSeed(s, TESTNET);
    // 33 is outside the initial window; 15 brings it in.
    expect(tree.ownsAddress(at33)).toBe(false);
    expect(advanceTreeOverKnownAddresses(tree, [at33, 'Tsomeone', at15])).toBe(2);
    expect(tree.getNextExternalIndex()).toBe(34);
  });
});

const coin = (address: string, value: bigint, confirmed = true): UTXO => ({
  txid: `${address}-tx`.padEnd(64, '0').slice(0, 64),
  vout: 0,
  address,
  value,
  scriptPubKey: new Uint8Array(),
  blockHeight: confirmed ? 10 : -1,
  confirmed,
});

describe('the balance with previous keys', () => {
  test('reachable previous-key coins are held and signable; unreachable ones are stranded', () => {
    const current = coin('Tcurrent', 10n);
    const previousHd = coin('Tprev_hd', 20n);
    const previousSocial = coin('Tprev_social', 30n);
    const unreachable = coin('Tunreachable', 40n);
    const previousOwner = new Map([
      ['Tprev_hd', 'k1'],
      ['Tprev_social', 'k1'],
    ]);
    const watched = (a: string) => a === 'Tcurrent' || previousOwner.has(a);
    const { held, stranded } = partitionStrandedCoins(
      [current, previousHd, previousSocial, unreachable],
      watched,
      () => true,
    );
    // F8 still holds: the balance is exactly what this wallet can sign for.
    expect(sumCoinValues(held)).toBe(60n);
    expect(signableCoins(held, watched)).toEqual(held);
    expect(stranded).toEqual([unreachable]);
    expect(sumCoinValues(previousKeyCoins(held, (a) => previousOwner.get(a) ?? null))).toBe(50n);
  });
});

/** The pieces of a P2PKH scriptSig: `<sig+hashtype> <pubkey>`. */
function parseScriptSig(script: Uint8Array): { signature: Uint8Array; publicKey: Uint8Array } {
  const sigLength = script[0] as number;
  const signature = script.slice(1, 1 + sigLength);
  const keyLength = script[1 + sigLength] as number;
  const publicKey = script.slice(2 + sigLength, 2 + sigLength + keyLength);
  return { signature, publicKey };
}

/** Every input of `tx` carries a valid signature by the key owning the coin it spends. */
function expectEveryInputSignedByItsOwner(tx: Transaction, coins: readonly UTXO[]): void {
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i];
    const utxo = coins.find((c) => c.txid === input?.txid && c.vout === input?.vout);
    if (!input || !utxo) throw new Error(`input ${String(i)} spends nothing known`);
    const { signature, publicKey } = parseScriptSig(input.scriptSig);
    expect(publicKeyToAddress(publicKey, TESTNET)).toBe(utxo.address);
    expect(
      verifyPartialSignature(signature, publicKey, p2pkhSigHash(tx, i, utxo.scriptPubKey)),
    ).toBe(true);
  }
}

/**
 * The fixture of the mixed-key transaction: the current key's HD tree and
 * social address, a previous key's HD tree and social address, and a fake
 * holder that answers `signSocialReceive` like Commons — the current key
 * without a selector, the key a selector names otherwise, `null` for a key it
 * does not hold.
 */
function mixedWallet() {
  const currentIdentity = identityKey();
  const previousIdentity = identityKey();
  const currentHd = KeyManager.fromSeed(seed(), TESTNET);
  const previousHd = KeyManager.fromSeed(seed(), TESTNET);
  const currentSocial = socialRow(currentIdentity, 2, currentIdentity.compressed);
  const previousSocial = socialRow(previousIdentity, 3, previousIdentity.compressed);
  const held = new Map([
    [currentIdentity.compressed, currentIdentity.priv],
    [previousIdentity.compressed, previousIdentity.priv],
  ]);
  const calls: { index: number; publicKey: string | undefined }[] = [];
  const sign: SocialReceiveSign = async (index, digest, opts) => {
    calls.push({ index, publicKey: opts?.publicKey });
    const selected = opts?.publicKey
      ? held.get(canonicalKey(opts.publicKey) ?? '')
      : currentIdentity.priv;
    return selected ? signSocialReceiveDigest(selected, index, digest) : null;
  };
  const utxo = (address: string, value: bigint, n: number): UTXO => ({
    txid: n.toString(16).padStart(64, '0'),
    vout: n,
    address,
    value,
    scriptPubKey: scriptForAddress(address, TESTNET),
    blockHeight: 100 + n,
    confirmed: true,
  });
  const coins = [
    utxo(currentHd.getExternalAddresses()[0] as string, 100_000_000n, 1),
    utxo(previousHd.getExternalAddresses()[4] as string, 200_000_000n, 2),
    utxo(previousHd.getChangeAddresses()[1] as string, 50_000_000n, 3),
    utxo(previousSocial.address, 300_000_000n, 4),
    utxo(currentSocial.address, 25_000_000n, 5),
  ];
  const signerFor = (address: string): InputSigner | null => {
    if (currentHd.ownsAddress(address)) {
      return { kind: 'hd', privateKey: currentHd.getPrivateKeyForAddress(address) };
    }
    if (previousHd.ownsAddress(address)) {
      return { kind: 'hd', privateKey: previousHd.getPrivateKeyForAddress(address) };
    }
    if (address === currentSocial.address) return { kind: 'social', index: 2, publicKey: null };
    if (address === previousSocial.address) {
      // Recorded uncompressed by the gateway: the holder canonicalises.
      return { kind: 'social', index: 3, publicKey: previousIdentity.uncompressed };
    }
    return null;
  };
  const signers = (signWith: SocialReceiveSign) => ({
    signerFor,
    signSocial: (
      tx: Transaction,
      i: number,
      spk: Uint8Array,
      index: number,
      address: string,
      publicKey: string | null,
    ) =>
      signSocialReceiveInput(tx, i, spk, index, address, TESTNET, PERSON, {
        sign: signWith,
        ...(publicKey === null ? {} : { publicKey }),
      }),
  });
  return {
    currentHd,
    previousIdentity,
    coins,
    calls,
    sign,
    signers,
    held,
  };
}

async function signAll(
  tx: Transaction,
  coins: readonly UTXO[],
  signers: Parameters<typeof signWalletInput>[3],
) {
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i];
    const utxo = coins.find((c) => c.txid === input?.txid && c.vout === input?.vout);
    if (!input || !utxo) throw new Error('unknown input');
    tx.inputs[i] = { ...input, scriptSig: await signWalletInput(tx, i, utxo, signers) };
  }
}

describe('a send mixing the current key with a previous one', () => {
  test('every input is signed by the key that owns it', async () => {
    const wallet = mixedWallet();
    const tx = buildTransaction({
      utxos: wallet.coins,
      recipients: [
        { address: wallet.currentHd.getExternalAddresses()[7] as string, value: 600_000_000n },
      ],
      changeAddress: wallet.currentHd.getChangeAddresses()[0] as string,
      feePerByte: 5n,
      network: TESTNET,
    });
    await signAll(tx, wallet.coins, wallet.signers(wallet.sign));
    expectEveryInputSignedByItsOwner(tx, wallet.coins);
    // The current key's social input asked for no key; the previous one's
    // named its key (oxy canonicalises the encoding).
    expect(wallet.calls).toEqual([
      { index: 3, publicKey: wallet.previousIdentity.uncompressed },
      { index: 2, publicKey: undefined },
    ]);
  });

  test('a previous key the holder does not reach fails that input, never signs with another', async () => {
    const wallet = mixedWallet();
    wallet.held.delete(wallet.previousIdentity.compressed);
    const tx = buildTransaction({
      utxos: wallet.coins,
      recipients: [
        { address: wallet.currentHd.getExternalAddresses()[7] as string, value: 1_000n },
      ],
      changeAddress: wallet.currentHd.getChangeAddresses()[0] as string,
      feePerByte: 5n,
      network: TESTNET,
    });
    await expect(signAll(tx, wallet.coins, wallet.signers(wallet.sign))).rejects.toThrow(
      'without the Oxy identity',
    );
  });

  test('a coin no key of this wallet owns is refused', async () => {
    const wallet = mixedWallet();
    const stranger = { address: 'Tstranger', scriptPubKey: new Uint8Array() };
    const tx = buildTransaction({
      utxos: wallet.coins,
      recipients: [
        { address: wallet.currentHd.getExternalAddresses()[7] as string, value: 1_000n },
      ],
      changeAddress: wallet.currentHd.getChangeAddresses()[0] as string,
      feePerByte: 5n,
      network: TESTNET,
    });
    await expect(signWalletInput(tx, 0, stranger, wallet.signers(wallet.sign))).rejects.toThrow(
      'Address not found',
    );
  });
});

describe('moving previous-key coins to the current key', () => {
  test('every confirmed previous-key coin, one output, no change, the planned fee', async () => {
    const wallet = mixedWallet();
    const previous = wallet.coins.slice(1, 4);
    const pending = { ...coin('Tpending', 9_000n, false) };
    const plan = planPreviousKeyMove({
      coins: [...previous, pending],
      feePerByte: 5,
      dustThreshold: TESTNET.minRelayFee,
    });
    if (plan.kind !== 'ready') throw new Error(`plan is ${plan.kind}`);
    expect([...plan.inputs].sort((a, b) => a.txid.localeCompare(b.txid))).toEqual(
      [...previous].sort((a, b) => a.txid.localeCompare(b.txid)),
    );
    expect(plan.remaining).toBe(0);
    const total = sumCoinValues(previous);
    expect(plan.amount + plan.fee).toBe(total);
    // What the store builds, exactly.
    const destination = wallet.currentHd.getNextAddress().address;
    const tx = buildTransaction({
      utxos: plan.inputs,
      recipients: [{ address: destination, value: plan.amount }],
      changeAddress: destination,
      feePerByte: 5n,
      network: TESTNET,
    });
    expect(tx.outputs).toHaveLength(1);
    expect(tx.outputs[0]?.value).toBe(plan.amount);
    expect(bytesToHex(tx.outputs[0]?.scriptPubKey ?? new Uint8Array())).toBe(
      bytesToHex(scriptForAddress(destination, TESTNET)),
    );
    await signAll(tx, plan.inputs, wallet.signers(wallet.sign));
    expectEveryInputSignedByItsOwner(tx, plan.inputs);
  });

  test('the move spends the CONFIRMED plan, or asks again (R4-13)', () => {
    const coins = [coin('Ta', 500_000n), coin('Tb', 400_000n)];
    const plan = (list: UTXO[], feePerByte = 5) =>
      planPreviousKeyMove({ coins: list, feePerByte, dustThreshold: TESTNET.minRelayFee });
    const confirmed = plan(coins);
    if (confirmed.kind !== 'ready') throw new Error(`plan is ${confirmed.kind}`);
    expect(confirmed.feePerByte).toBe(5);
    expect(samePreviousKeyMovePlan(confirmed, plan([...coins].reverse()))).toBe(true);
    // A coin arrived, one was spent, the rate moved: each is a different move.
    expect(samePreviousKeyMovePlan(confirmed, plan([...coins, coin('Tc', 300_000n)]))).toBe(false);
    expect(samePreviousKeyMovePlan(confirmed, plan(coins.slice(0, 1)))).toBe(false);
    expect(samePreviousKeyMovePlan(confirmed, plan(coins, 6))).toBe(false);
    expect(samePreviousKeyMovePlan(confirmed, { kind: 'nothing' })).toBe(false);
  });

  test('many small coins move in batches under the standard transaction size (R4-13)', () => {
    // ~670 inputs pass 100 000 bytes; a key dusted with 1 200 coins still moves.
    const coins = Array.from({ length: 1_200 }, (_, i) =>
      coin(`T${String(i)}`, BigInt(100_000 + i)),
    );
    const plan = planPreviousKeyMove({
      coins,
      feePerByte: 5,
      dustThreshold: TESTNET.minRelayFee,
    });
    if (plan.kind !== 'ready') throw new Error(`plan is ${plan.kind}`);
    expect(plan.inputs).toHaveLength(PREVIOUS_KEY_MOVE_MAX_INPUTS);
    expect(plan.remaining).toBe(1_200 - PREVIOUS_KEY_MOVE_MAX_INPUTS);
    // The largest coins first.
    expect(plan.inputs[0]?.value).toBe(100_000n + 1_199n);
    // 10 bytes of envelope, 148 per input, 34 per output: the no-change size.
    expect(10 + 148 * plan.inputs.length + 34).toBeLessThan(100_000);
    const rest = planPreviousKeyMove({
      coins: coins.filter((c) => !plan.inputs.includes(c)),
      feePerByte: 5,
      dustThreshold: TESTNET.minRelayFee,
    });
    if (rest.kind !== 'ready') throw new Error(`rest is ${rest.kind}`);
    expect(rest.remaining).toBe(1_200 - 2 * PREVIOUS_KEY_MOVE_MAX_INPUTS);
  });

  test('dust is refused, and unconfirmed coins wait', () => {
    const fee = 5n * BigInt(10 + 148 + 34);
    expect(
      planPreviousKeyMove({
        coins: [coin('Ta', fee + TESTNET.minRelayFee)],
        feePerByte: 5,
        dustThreshold: TESTNET.minRelayFee,
      }),
    ).toEqual({ kind: 'dust', total: fee + TESTNET.minRelayFee, fee });
    expect(
      planPreviousKeyMove({
        coins: [coin('Ta', 10n ** 9n, false)],
        feePerByte: 5,
        dustThreshold: TESTNET.minRelayFee,
      }),
    ).toEqual({ kind: 'nothing' });
  });
});

describe('the copy for a previous key this phone cannot reach', () => {
  const source = readFileSync(join(__dirname, '..', 'i18n', 'index.ts'), 'utf8');

  test('names the way to spend it here — Commons — for a person and an organization', () => {
    for (const kind of ['personal', 'organization'] as const) {
      const { body, stranded } = previousKeyCopy(kind);
      // Both tables (en, es) carry each key.
      expect(source.split(`'${stranded}':`).length - 1).toBe(2);
      expect(source.split(`'${body}':`).length - 1).toBe(2);
    }
    expect(source).toContain('Add your previous recovery phrase in Commons');
    expect(source).toContain("Add the organization's previous phrase in Commons");
  });

  test('never says the coins are recoverable only outside Peable', () => {
    expect(source).not.toContain('outside Peable');
    expect(source).not.toContain("can be spent only with that key's recovery phrase");
    expect(source).not.toContain('wallet.strandedBalance');
  });
});

describe('the move fee the person chooses (R6-11)', () => {
  test('a custom rate is a whole number within bounds', () => {
    expect(parseMoveFeeRate('1')).toBe(MOVE_FEE_RATE_MIN);
    expect(parseMoveFeeRate(' 25 ')).toBe(25);
    expect(parseMoveFeeRate(String(MOVE_FEE_RATE_MAX))).toBe(MOVE_FEE_RATE_MAX);
    for (const bad of ['0', '101', '2.5', '-3', '', 'abc', '99999']) {
      expect(parseMoveFeeRate(bad)).toBeNull();
    }
  });

  test('the chosen rate is the plan’s, and a plan at another rate is not the confirmed one', () => {
    const coins = [coin('Ta', 50_000_000n)];
    const low = planPreviousKeyMove({ coins, feePerByte: 1, dustThreshold: TESTNET.minRelayFee });
    const high = planPreviousKeyMove({ coins, feePerByte: 40, dustThreshold: TESTNET.minRelayFee });
    if (low.kind !== 'ready' || high.kind !== 'ready') throw new Error('expected ready plans');
    expect(low.feePerByte).toBe(1);
    expect(high.fee > low.fee).toBe(true);
    expect(samePreviousKeyMovePlan(low, high)).toBe(false);
  });
});
