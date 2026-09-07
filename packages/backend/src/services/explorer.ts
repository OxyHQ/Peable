import { z } from "zod";
import { parseFairToUnits } from "@fairco.in/core";
import type { NetworkType } from "@fairco.in/core";
import { config } from "../config";

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
 * talks to the Explorer itself.
 */

export interface ExplorerOutput {
  address: string;
  valueSat: bigint;
}

export interface ExplorerTx {
  txid: string;
  confirmations: number;
  outputs: ExplorerOutput[];
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
    })
    .optional(),
});

function statsUrl(network: NetworkType): string {
  return `${config.explorerBaseUrl}/api/stats?network=${network}`;
}

function transactionUrl(txid: string, network: NetworkType): string {
  return `${config.explorerBaseUrl}/api/transaction/${encodeURIComponent(
    txid,
  )}?network=${network}`;
}

/** Current confirmed chain tip (block height) for the given network. */
export async function getTip(network: NetworkType): Promise<number> {
  const response = await fetch(statsUrl(network));
  if (!response.ok) {
    throw new Error(
      `Explorer stats request failed: ${response.status} ${response.statusText}`,
    );
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

  return { txid: tx.txid, confirmations: tx.confirmations, outputs };
}

/**
 * Pure settlement check: `paid` is true iff some output of `tx` pays exactly
 * `address` with at least `expectedSat` base units. Returns the transaction's
 * confirmation count so the caller can decide `confirming` vs `settled`.
 */
export function verifyPayment(
  tx: ExplorerTx,
  address: string,
  expectedSat: bigint,
): { paid: boolean; confirmations: number } {
  const paid = tx.outputs.some(
    (output) => output.address === address && output.valueSat >= expectedSat,
  );
  return { paid, confirmations: tx.confirmations };
}

