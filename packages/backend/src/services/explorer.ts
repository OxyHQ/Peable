import { z } from 'zod';
import { parseFairToUnits } from '@fairco.in/core';
import type { NetworkType } from '@fairco.in/core';
import { config } from '../config';

/**
 * FairCoin Explorer HTTP client (read-only — non-custodial by construction:
 * the backend only ever *reads* the chain; the payer signs and broadcasts).
 *
 * Endpoints pinned live 2026-07-18:
 *
 *   GET /api/stats?network=<net>
 *     -> { "stats": { "blockHeight": 67763, ... }, ... }
 *
 *   GET /api/transaction/:txid?network=<net>
 *     -> { "transaction": {
 *            "txid": "...",
 *            "confirmations": 1,
 *            "blockheight": 67763,
 *            "vout": [
 *              { "value": 0, "n": 0, "scriptPubKey": { "type": "nonstandard" } },
 *              { "value": 3769.9894497, "n": 1,
 *                "scriptPubKey": { "type": "pubkey",
 *                                  "addresses": ["FRwfg..."] } }
 *            ]
 *          }, "network": "mainnet" }
 *
 * `vout[].value` is a FAIR decimal number; outputs may lack
 * `scriptPubKey.addresses` (nonstandard) and are skipped. A missing/unknown
 * txid answers with a non-200 or a body without `transaction`.
 *
 * Settlement is verified from the payer-reported txid via `getTransaction` +
 * `verifyPayment`, which proves a SPECIFIC payment. This client stays that
 * narrow on purpose: the gateway reads the chain to settle intents, and is not
 * a chain proxy for wallets. `/api/address/:a` DOES answer (measured
 * 2026-09-06 — an older note here claimed `addressindex` was off and it could
 * not be used, which was false and stopped a feature being built), but the
 * surface that needs address balances is the wallet, and the wallet already
 * talks to the Explorer itself. The gateway's one address read is
 * {@link getAddressUsage}: whether an address it reserved ever received
 * anything, before handing it to another payment (ADR 0021 D9).
 *
 *   GET /api/address/:a?network=<net>   (measured 2026-11-06)
 *     mainnet, unused: { "addressInfo": { "txCount": 0, "totalReceivedSat": 0,
 *                        "utxos": [], … }, "network": "mainnet" }
 *     testnet (no address index on its node), ANY address:
 *                      { "addressInfo": { "txCount": 0, …, "isValid": false,
 *                        "note": "addressindex not enabled on node; limited data available" } }
 *
 * The second shape says nothing: `txCount: 0` beside `isValid: false` or a
 * `note` is not evidence of an unused address, and is read as `unknown`.
 */

export interface ExplorerOutput {
  address: string;
  valueSat: bigint;
}

export interface ExplorerTx {
  txid: string;
  confirmations: number;
  outputs: ExplorerOutput[];
  /**
   * The block it is in (`blockhash`), `null` while unconfirmed. Absent where a
   * caller built the transaction itself (tests): read as "not known".
   */
  blockHash?: string | null;
  /** When it was first seen or mined, Unix seconds (`time`); `null` when not answered. */
  time?: number | null;
}

const statsResponseSchema = z.object({
  stats: z.object({
    blockHeight: z.number(),
  }),
});

const voutSchema = z.object({
  value: z.number(),
  scriptPubKey: z
    .object({
      addresses: z.array(z.string()).optional(),
    })
    .optional(),
});

const transactionResponseSchema = z.object({
  transaction: z
    .object({
      txid: z.string(),
      confirmations: z.number(),
      vout: z.array(voutSchema),
      blockhash: z.string().optional(),
      time: z.number().optional(),
    })
    .optional(),
});

const addressResponseSchema = z.object({
  addressInfo: z.object({
    txCount: z.number(),
    totalReceivedSat: z.number(),
    utxos: z.array(z.unknown()),
    isValid: z.boolean().optional(),
    note: z.string().optional(),
  }),
});

const addressTransactionsSchema = z.object({
  transactions: z.array(
    z.object({ txid: z.string(), amount: z.number().optional(), time: z.number().optional() }),
  ),
  total: z.number(),
});

/** One entry of an address's transaction list (`GET /api/address/:a/txs`). */
export interface AddressTransaction {
  readonly txid: string;
  /**
   * What the transaction moved at this address, in base units, as the
   * Explorer's float `amount` rounded — a pre-filter only, never a settlement
   * figure (`verifyPayment` reads the transaction itself). `null` when absent.
   */
  readonly amountSat: bigint | null;
  /** Unix seconds; `null` when absent. */
  readonly time: number | null;
}

function addressUrl(address: string, network: NetworkType): string {
  return `${config.explorerBaseUrl}/api/address/${encodeURIComponent(address)}?network=${network}`;
}

function statsUrl(network: NetworkType): string {
  return `${config.explorerBaseUrl}/api/stats?network=${network}`;
}

function transactionUrl(txid: string, network: NetworkType): string {
  return `${config.explorerBaseUrl}/api/transaction/${encodeURIComponent(txid)}?network=${network}`;
}

/** Current confirmed chain tip (block height) for the given network. */
export async function getTip(network: NetworkType): Promise<number> {
  const response = await fetch(statsUrl(network));
  if (!response.ok) {
    throw new Error(`Explorer stats request failed: ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  return statsResponseSchema.parse(body).stats.blockHeight;
}

/**
 * Fetch a transaction and normalise its standard outputs to
 * `{ address, valueSat }`. Returns `null` when the txid is unknown (non-200)
 * or the body carries no (well-formed) `transaction`. Outputs without a
 * `scriptPubKey.addresses[0]`, or whose value fails to parse, are skipped.
 */
export async function getTransaction(
  txid: string,
  network: NetworkType,
): Promise<ExplorerTx | null> {
  const response = await fetch(transactionUrl(txid, network));
  if (!response.ok) return null;

  const body: unknown = await response.json();
  const parsed = transactionResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.transaction === undefined) return null;

  const tx = parsed.data.transaction;
  const outputs: ExplorerOutput[] = [];
  for (const vout of tx.vout) {
    const address = vout.scriptPubKey?.addresses?.[0];
    if (address === undefined) continue;
    const valueSat = parseFairToUnits(String(vout.value));
    if (valueSat === null) continue;
    outputs.push({ address, valueSat });
  }

  return {
    txid: tx.txid,
    confirmations: tx.confirmations,
    outputs,
    blockHash: tx.blockhash ?? null,
    time: tx.time ?? null,
  };
}

/**
 * Pure settlement check (ADR 0021 D6): `paid` is true iff EVERY expected output
 * is in `tx` — some output pays exactly its `address` with at least its amount.
 * One output short is not paid: the payment is underpaid as a whole. Returns
 * the transaction's confirmation count so the caller can decide `confirming`
 * vs `settled`.
 */
export function verifyPayment(
  tx: ExplorerTx,
  expected: readonly { readonly address: string; readonly amount: bigint }[],
): { paid: boolean; confirmations: number } {
  const paid =
    expected.length > 0 &&
    expected.every(({ address, amount }) =>
      tx.outputs.some((output) => output.address === address && output.valueSat >= amount),
    );
  return { paid, confirmations: tx.confirmations };
}

/**
 * What the chain says about an address the gateway reserved: `used` when it
 * shows any transaction, anything received or an unspent output; `unused` only
 * on a FULL answer showing none; `unknown` for everything else — a
 * failed request, a body that does not parse, or the Explorer saying it cannot
 * tell (testnet's node has no address index). Recycling an address needs
 * `unused` (ADR 0021 D9); `unknown` never counts as it.
 */
export type AddressUsage = 'unused' | 'used' | 'unknown';

export async function getAddressUsage(
  address: string,
  network: NetworkType,
): Promise<AddressUsage> {
  let body: unknown;
  try {
    const response = await fetch(addressUrl(address, network));
    if (!response.ok) return 'unknown';
    body = await response.json();
  } catch {
    return 'unknown';
  }
  const parsed = addressResponseSchema.safeParse(body);
  if (!parsed.success) return 'unknown';
  const info = parsed.data.addressInfo;
  if (info.txCount !== 0 || info.totalReceivedSat !== 0 || info.utxos.length !== 0) return 'used';
  if (info.isValid === false || info.note !== undefined) return 'unknown';
  return 'unused';
}

/** The Explorer's page size for an address's transactions (it caps `limit` at 50, measured 2026-11-06). */
const ADDRESS_TXS_PAGE = 50;
/**
 * Pages read before an address's list counts as read: 1 000 transactions. A
 * single-use payment address holds a handful; one with more was filled on
 * purpose, and the reported txid not being among the first thousand is taken
 * as its absence rather than letting dust buy an unbounded hold.
 */
const ADDRESS_TXS_MAX_PAGES = 20;

/**
 * Whether `txid` is among the transactions the Explorer lists for `address`
 * (`GET /api/address/:a/txs?page=&limit=`, measured 2026-11-06: `{transactions:
 * [{txid, …}], page, limit, total}`, `limit` capped at 50). Asked only of an
 * address the chain shows USED while the reported transaction cannot be read.
 * `no` once every page has been read without it — or {@link
 * ADDRESS_TXS_MAX_PAGES} pages have — so that coins someone else sent, however
 * many times, cannot keep a made-up txid open. Any page that fails or does not
 * parse is `unknown`.
 */
export async function addressHasTransaction(
  address: string,
  network: NetworkType,
  txid: string,
): Promise<'yes' | 'no' | 'unknown'> {
  const listed = await listAddressTransactions(address, network);
  if (listed === null) return 'unknown';
  return listed.some((entry) => entry.txid === txid) ? 'yes' : 'no';
}

/**
 * Every transaction the Explorer lists for `address` (measured 2026-11-06:
 * `{txid, blockhash, blockHeight, confirmations, time, amount, type}`), newest
 * first as it answers — up to {@link ADDRESS_TXS_MAX_PAGES} pages, past which
 * the list is taken as read (see {@link addressHasTransaction}). `null` when
 * any page fails, does not parse, or is short before the total.
 */
export async function listAddressTransactions(
  address: string,
  network: NetworkType,
): Promise<AddressTransaction[] | null> {
  const txids: AddressTransaction[] = [];
  for (let page = 1; page <= ADDRESS_TXS_MAX_PAGES; page += 1) {
    let body: unknown;
    try {
      const response = await fetch(
        `${config.explorerBaseUrl}/api/address/${encodeURIComponent(address)}/txs?network=${network}&page=${page}&limit=${ADDRESS_TXS_PAGE}`,
      );
      if (!response.ok) return null;
      body = await response.json();
    } catch {
      return null;
    }
    const parsed = addressTransactionsSchema.safeParse(body);
    if (!parsed.success) return null;
    const { transactions, total } = parsed.data;
    for (const entry of transactions) {
      txids.push({
        txid: entry.txid,
        amountSat:
          entry.amount === undefined || !Number.isFinite(entry.amount)
            ? null
            : BigInt(Math.round(entry.amount * 1e8)),
        time: entry.time ?? null,
      });
    }
    if (txids.length >= total) return txids;
    // A short page before the total: the list is not what it says.
    if (transactions.length === 0) return null;
  }
  return txids;
}
