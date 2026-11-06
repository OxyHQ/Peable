/**
 * The end-to-end FairCoin TESTNET canary, wallet half (ADR 0002 "Still required
 * before mainnet", item 4; evidence in `docs/audits/2026-11-06-mainnet-gate/`).
 *
 * The gateway half (`packages/backend/src/__tests__/canary/`) paid a person's
 * `@username` and two merchants (one owned by that person, one by an
 * organization) on a FairCoin testnet chain, and recorded each recipient's
 * cursor. Here each recipient's wallet does what `wallet-store.ts` does with
 * that answer — compare the key, derive the watch window through the cursor —
 * using this package's own `social-receive.ts`, finds every coin on the chain,
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
import { getPublicKey } from '@noble/secp256k1';

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
const gateway: { wallets: { person: WalletEvidence; organization: WalletEvidence } } | null =
  ENABLED ? JSON.parse(readFileSync(String(GATEWAY), 'utf8')) : null;
const ORG_ACCOUNT = gateway?.wallets.organization.account ?? 'org';

// The key's holder, as on a phone: the person's key for personal requests, the
// organization's for `{ accountId }` — and never one for the other.
const realOxyCrypto = { ...(await import('@oxy.so/core/crypto')) };
mock.module('@oxy.so/core/crypto', () => ({
  ...realOxyCrypto,
  getOrganizationPublicKey: async (accountId: string) =>
    accountId === ORG_ACCOUNT ? bytesToHex(getPublicKey(hexToBytes(keys.org), false)) : null,
  KeyManager: {
    getSharedPublicKey: async () => bytesToHex(getPublicKey(hexToBytes(keys.person), false)),
    signSocialReceive: async (index: number, digest: string, opts?: { accountId?: string }) => {
      if (opts?.accountId !== undefined) {
        return opts.accountId === ORG_ACCOUNT
          ? realOxyCrypto.signSocialReceiveDigest(keys.org, index, digest)
          : null;
      }
      return realOxyCrypto.signSocialReceiveDigest(keys.person, index, digest);
    },
  },
}));

const {
  SOCIAL_RECEIVE_GAP_LIMIT,
  deriveSocialReceiveWatchWindow,
  getIdentityPublicKeyHex,
  highestIndex,
  judgeSocialReceiveKey,
  planSocialReceiveWindow,
  signSocialReceiveInput,
} = await import('../social-receive');
const { checkSocialReceiveAddresses } = await import('../social-receive-sync');
const { PERSONAL_SUBJECT } = await import('../identity-wallet');
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

async function sweep(label: string, wallet: WalletEvidence, subject: IdentitySubject) {
  // 1. The key this phone holds is the key the account publishes (the cursor
  // carries the DID's current `#key-1`) — `setUpSocialReceive`'s verdict.
  const deviceKey = await getIdentityPublicKeyHex(subject);
  expect(deviceKey).not.toBeNull();
  const verdict = judgeSocialReceiveKey({
    deviceKey: String(deviceKey),
    accountKey: wallet.cursor.account_identity_public_key,
    lastReservedKey: wallet.cursor.identity_public_key,
  });
  expect(verdict).toBe('match');

  // 2. The watch window, exactly as `setUpSocialReceive` plans it: the initial
  // gap, then through everything the cursor says was ever reserved.
  const window = deriveSocialReceiveWatchWindow(
    String(deviceKey),
    0,
    SOCIAL_RECEIVE_GAP_LIMIT,
    network,
  );
  const plan = planSocialReceiveWindow({
    highestWatched: highestIndex(window.map((entry) => entry.index)),
    highestUsed: -1,
    highestReserved: wallet.cursor.reserved_through > 0 ? wallet.cursor.reserved_through : -1,
  });
  expect(plan.capped).toBe(false);
  if (plan.extension) {
    window.push(
      ...deriveSocialReceiveWatchWindow(
        String(deviceKey),
        plan.extension.start,
        plan.extension.count,
        network,
      ),
    );
  }
  const indexOf = new Map(window.map((entry) => [entry.address, entry.index]));
  for (const coin of wallet.received) expect(indexOf.has(coin.address)).toBe(true);

  // 2b. The running wallet's check of every watched index (the fix for payments
  // that land beyond what SPV already scanned): the chain answers, and the
  // rescan is sent back to the block of the first payment.
  const rescans: number[] = [];
  const check = await checkSocialReceiveAddresses({
    watched: window,
    checkedThrough: -1,
    scanHasBegun: true,
    fetchActivity: async (addresses) => {
      const activity = new Map<string, AddressActivity>();
      for (const address of addresses) {
        const utxos = await rpc<{ height: number }[]>('getaddressutxos', [
          { addresses: [address] },
        ]);
        activity.set(address, {
          confirmedHeights: utxos.map((utxo) => utxo.height).sort((a, b) => a - b),
          hasUnconfirmed: false,
        });
      }
      return activity;
    },
    requestRescanFrom: async (height) => {
      rescans.push(height);
    },
    markCheckedThrough: async () => {},
    isCurrent: () => true,
  });
  expect(check.checkedThrough).toBe(highestIndex(window.map((entry) => entry.index)));
  expect(check.rescanFrom).not.toBeNull();

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
    watched_indices: [window[0]?.index, window.at(-1)?.index],
    key_verdict: verdict,
    checked_through: check.checkedThrough,
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
      await sweep('person', wallets.person, PERSONAL_SUBJECT);
      await sweep('organization', wallets.organization, {
        kind: 'organization',
        accountId: ORG_ACCOUNT,
      });
      evidence.finished_at = new Date().toISOString();
      writeFileSync(String(OUT), `${JSON.stringify(evidence, null, 2)}\n`);
    }, 600_000);
  },
);
