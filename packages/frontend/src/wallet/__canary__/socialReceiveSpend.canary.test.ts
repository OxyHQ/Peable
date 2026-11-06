/**
 * The end-to-end FairCoin TESTNET canary, wallet half (ADR 0002 "Still required
 * before mainnet", item 4; evidence in `docs/audits/2026-11-06-mainnet-gate/`).
 *
 * The gateway half (`packages/backend/src/__tests__/canary/`) paid a person's
 * `@username` and two merchants (one owned by that person, one by an
 * organization) on a FairCoin testnet chain, and recorded each recipient's
 * cursor and its watch set (`GET /v1/social/me/receive_addresses`, ADR 0021 D9
 * amended 2026-11-06). Here each recipient's wallet does what `wallet-store.ts`
 * does with those answers — compare the key, keep the set's rows of its own key,
 * choose the active tier and read through the Explorer what is due — using this
 * package's own `social-receive*.ts`, finds every coin on the chain,
 * and spends them all with the identity key's holder (`signSocialReceiveInput`
 * over `@oxy.so/core`'s `signSocialReceiveDigest`, the function the iOS SDK
 * runs and Commons' identity host reproduces natively).
 *
 * Skipped unless `CANARY_NODE_CONF`, `CANARY_KEYS` (the canary's throwaway
 * testnet keys) and `CANARY_GATEWAY_EVIDENCE` are set.
 */
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildTransaction,
  getNetwork,
  hashTransaction,
  hexToBytes,
  bytesToHex,
  serializeTransaction,
} from '@fairco.in/core';
import { Point, getPublicKey } from '@noble/secp256k1';

const CONF = process.env.CANARY_NODE_CONF;
const KEYS = process.env.CANARY_KEYS;
const GATEWAY = process.env.CANARY_GATEWAY_EVIDENCE;
const OUT = process.env.CANARY_WALLET_EVIDENCE_OUT;
const ENABLED = Boolean(CONF && KEYS && GATEWAY && OUT);

interface Received {
  address: string;
  txid: string;
  amount: string;
}
interface WalletEvidence {
  account: string;
  cursor: {
    reserved_through: number;
    identity_public_key: string | null;
    account_identity_public_key?: string | null;
  };
  received: Received[];
}

const keys: { person: string; org: string } = ENABLED
  ? JSON.parse(readFileSync(String(KEYS), 'utf8'))
  : { person: '11'.repeat(32), org: '22'.repeat(32) };
type ReceiveAddresses = import('@peable.to/contracts').SocialReceiveAddressesResponse;
const gateway: {
  wallets: { person: WalletEvidence; organization: WalletEvidence };
  receiveAddresses?: { person?: ReceiveAddresses; organization?: ReceiveAddresses };
} | null = ENABLED ? JSON.parse(readFileSync(String(GATEWAY), 'utf8')) : null;
const ORG_ACCOUNT = gateway?.wallets.organization.account ?? 'org';

// The key's holder, as on a phone: the person's key for personal requests, the
// organization's for `{ accountId }` — and never one for the other.
const realOxyCrypto = { ...(await import('@oxy.so/core/crypto')) };
// A `publicKey` selector reaches only the key it names (oxy ADR 0061 D7).
type KeySelector = { accountId?: string; publicKey?: string };
const holderOf = (opts?: KeySelector): string | null => {
  const key =
    opts?.accountId !== undefined
      ? opts.accountId === ORG_ACCOUNT
        ? keys.org
        : null
      : keys.person;
  if (key === null) return null;
  if (
    opts?.publicKey !== undefined &&
    Point.fromHex(opts.publicKey.toLowerCase()).toHex(true) !==
      bytesToHex(getPublicKey(hexToBytes(key), true))
  ) {
    return null;
  }
  return key;
};
mock.module('@oxy.so/core/crypto', () => ({
  ...realOxyCrypto,
  getOrganizationPublicKey: async (accountId: string) =>
    accountId === ORG_ACCOUNT ? bytesToHex(getPublicKey(hexToBytes(keys.org), false)) : null,
  KeyManager: {
    getSharedPublicKey: async () => bytesToHex(getPublicKey(hexToBytes(keys.person), false)),
    deriveScopedSeed: async (info: string, opts?: KeySelector) => {
      const key = holderOf(opts);
      return key ? realOxyCrypto.deriveScopedSeedFromKey(key, info) : null;
    },
    signSocialReceive: async (index: number, digest: string, opts?: KeySelector) => {
      const key = holderOf(opts);
      return key ? realOxyCrypto.signSocialReceiveDigest(key, index, digest) : null;
    },
  },
}));

const { deriveSocialReceiveWatchWindow, judgeSocialReceiveKey, signSocialReceiveInput } =
  await import('../social-receive');
const { checkSocialReceiveDue } = await import('../social-receive-sync');
const { planActiveSet, planSocialReceiveChecks, watchableRows } = await import(
  '../social-receive-watch'
);
type WatchSetRow = import('../social-receive-watch').WatchSetRow;
const { deriveIdentitySeed, personalSubject } = await import('../identity-wallet');
const { decideIdentityKey } = await import('../identity-key');
type IdentitySubject = import('../identity-wallet').IdentitySubject;
type AddressActivity = import('../../services/explorer-address').AddressActivity;

async function rpc<T>(method: string, params: readonly unknown[] = []): Promise<T> {
  const conf = new Map(
    readFileSync(String(CONF), 'utf8')
      .split('\n')
      .map((line) => line.split('=').map((part) => part.trim()) as [string, string]),
  );
  const response = await fetch(`http://127.0.0.1:${conf.get('rpcport')}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${conf.get('rpcuser')}:${conf.get('rpcpassword')}`).toString('base64')}`,
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result: T; error: { message: string } | null };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function mineOne(): Promise<number> {
  const start = await rpc<number>('getblockcount');
  await rpc('setgenerate', [true, 1]);
  while ((await rpc<number>('getblockcount')) <= start) await Bun.sleep(250);
  await rpc('setgenerate', [false]);
  return rpc<number>('getblockcount');
}

const network = getNetwork('testnet');
const evidence: Record<string, unknown> = { started_at: new Date().toISOString() };

async function sweep(
  label: 'person' | 'organization',
  wallet: WalletEvidence,
  subject: IdentitySubject,
) {
  // 1. The wallet opens with the key the account publishes (the cursor carries
  // the DID's current `#key-1`), proven held by deriving its seed with the key
  // named (R5-1) — and `syncSocialReceiveSet`'s verdict confirms it.
  const decision = await decideIdentityKey({
    accountKeys: {
      current: wallet.cursor.account_identity_public_key ?? null,
      history: new Set<string>(),
    },
    storedKey: null,
    deviceHint: async () => null,
    derive: (key) => deriveIdentitySeed(subject, key),
  });
  expect(decision.kind).toBe('current');
  if (decision.kind === 'none') throw new Error('the account key is not held');
  decision.seed.fill(0);
  const deviceKey = decision.key;
  const verdict = judgeSocialReceiveKey({
    deviceKey: String(deviceKey),
    accountKey: wallet.cursor.account_identity_public_key,
    lastReservedKey: wallet.cursor.identity_public_key,
  });
  expect(verdict).toBe('match');

  // 2. The watch set, exactly as `setUpSocialReceive` builds it: index 0 of
  // this key, plus the rows of the gateway's set this key owns.
  const set = gateway?.receiveAddresses?.[label];
  if (!set) {
    throw new Error(
      `the gateway evidence has no receiveAddresses.${label}: rerun the gateway canary (it records GET /v1/social/me/receive_addresses per recipient)`,
    );
  }
  expect(set.has_more).toBe(false);
  const now = Math.floor(Date.now() / 1000);
  const [zero] = deriveSocialReceiveWatchWindow(String(deviceKey), 0, 1, network);
  if (!zero) throw new Error('no index 0');
  const rows: WatchSetRow[] = [
    {
      address: zero.address,
      index: 0,
      identityPublicKey: String(deviceKey),
      createdAt: now,
      used: false,
      checkedAt: null,
      nextCheckAt: null,
      foundAt: null,
      origin: 'default',
    },
  ];
  for (const item of set.addresses) {
    expect(item.network).toBe('testnet');
    rows.push({
      address: item.address,
      index: item.derivation_index,
      identityPublicKey: item.identity_public_key,
      createdAt: item.created,
      used: false,
      checkedAt: null,
      nextCheckAt: null,
      foundAt: null,
      origin: 'gateway',
    });
  }
  const watched = watchableRows(rows, String(deviceKey), network);
  // Every address the gateway handed out is this key's (no rotation in the run).
  expect(watched).toHaveLength(rows.length);
  const indexOf = new Map(watched.map((entry) => [entry.address, entry.index]));
  for (const coin of wallet.received) expect(indexOf.has(coin.address)).toBe(true);
  const active = planActiveSet({ watchable: watched, holdingCoins: new Map(), now });
  for (const coin of wallet.received) expect(active.has(coin.address)).toBe(true);

  // 2b. The running wallet's look at every address not yet looked at (the
  // filter only shows what is paid from now on): the chain answers, and the
  // rescan is sent back to the block of the first payment.
  const plan = planSocialReceiveChecks({ watchable: watched, active, now, scanHasBegun: true });
  expect(plan.due).toHaveLength(watched.length);
  const rescans: number[] = [];
  const check = await checkSocialReceiveDue({
    due: plan.due,
    now: () => Math.floor(Date.now() / 1000),
    fetchActivity: async (addresses: readonly string[]) => {
      const activity = new Map<string, AddressActivity>();
      for (const address of addresses) {
        const utxos = await rpc<{ height: number; satoshis: number }[]>('getaddressutxos', [
          { addresses: [address] },
        ]);
        activity.set(address, {
          confirmedHeights: utxos.map((utxo) => utxo.height).sort((a, b) => a - b),
          hasUnconfirmed: false,
          valueSat: utxos.reduce((sum, utxo) => sum + BigInt(utxo.satoshis), 0n),
        });
      }
      return activity;
    },
    requestRescanFrom: async (height: number) => {
      rescans.push(height);
    },
    record: async () => {},
    isCurrent: () => true,
  });
  expect(check.checked).toBe(watched.length);
  expect(check.rescanFrom).not.toBeNull();
  for (const coin of wallet.received) expect(check.found).toContain(coin.address);

  // 3. The coins, as the chain has them.
  const utxos = await rpc<
    { address: string; txid: string; outputIndex: number; script: string; satoshis: number }[]
  >('getaddressutxos', [{ addresses: wallet.received.map((coin) => coin.address) }]);
  // Every payment the gateway settled is one of them (an earlier canary run may
  // have paid the same addresses: each run's database starts a fresh cursor).
  for (const coin of wallet.received) {
    const found = utxos.find((utxo) => utxo.txid === coin.txid && utxo.address === coin.address);
    expect(found?.satoshis).toBe(Number(coin.amount));
  }
  const total = utxos.reduce((sum, utxo) => sum + BigInt(utxo.satoshis), 0n);

  // 4. Spend them all, signed by the holder, and let the network judge it.
  const destination = await rpc<string>('getnewaddress');
  const tx = buildTransaction({
    utxos: utxos.map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.outputIndex,
      value: BigInt(utxo.satoshis),
      scriptPubKey: hexToBytes(utxo.script),
    })),
    recipients: [{ address: destination, value: total - 100_000n }],
    changeAddress: destination,
    feePerByte: 10n,
    network,
  });
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i];
    const utxo = utxos.find((u) => u.txid === input?.txid && u.outputIndex === input?.vout);
    if (!input || !utxo) throw new Error(`no utxo for input ${i}`);
    tx.inputs[i] = {
      ...input,
      scriptSig: await signSocialReceiveInput(
        tx,
        i,
        hexToBytes(utxo.script),
        Number(indexOf.get(utxo.address)),
        utxo.address,
        network,
        subject,
      ),
    };
  }
  const txid = await rpc<string>('sendrawtransaction', [bytesToHex(serializeTransaction(tx))]);
  expect(txid).toBe(hashTransaction(tx));
  const tip = await mineOne();
  const confirmed = await rpc<{ confirmations: number }>('getrawtransaction', [txid, 1]);
  expect(confirmed.confirmations).toBeGreaterThanOrEqual(1);
  const left = await rpc<unknown[]>('getaddressutxos', [
    { addresses: wallet.received.map((coin) => coin.address) },
  ]);
  expect(left.length).toBe(0);
  evidence[label] = {
    at: new Date().toISOString(),
    account: wallet.account,
    reserved_through: wallet.cursor.reserved_through,
    watched_indices: watched.map((entry) => entry.index),
    active: active.size,
    key_verdict: verdict,
    checked: check.checked,
    found: check.found,
    rescan_from_height: check.rescanFrom,
    spent: utxos.map((utxo) => ({
      address: utxo.address,
      index: indexOf.get(utxo.address),
      outpoint: `${utxo.txid}:${utxo.outputIndex}`,
      satoshis: utxo.satoshis,
    })),
    sweep_txid: txid,
    confirmations: confirmed.confirmations,
    tip,
  };
}

describe.skipIf(!ENABLED)(
  'testnet canary: the recipients spend what the gateway handed out',
  () => {
    test('the person (social + person-owned merchant) and the organization', async () => {
      const wallets = gateway?.wallets;
      if (!wallets) throw new Error('no gateway evidence');
      await sweep('person', wallets.person, personalSubject(wallets.person.account));
      await sweep('organization', wallets.organization, {
        kind: 'organization',
        accountId: ORG_ACCOUNT,
      });
      evidence.finished_at = new Date().toISOString();
      writeFileSync(String(OUT), `${JSON.stringify(evidence, null, 2)}\n`);
    }, 600_000);
  },
);
