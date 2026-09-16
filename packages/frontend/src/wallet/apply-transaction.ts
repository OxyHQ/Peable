/**
 * Pure SPV receive/spend logic for the FairCoin wallet.
 *
 * Applies a parsed transaction to an in-memory {@link UTXOSet}: it credits
 * every output that pays one of the wallet's addresses and debits every input
 * that spends one of the wallet's existing UTXOs. The function is intentionally
 * free of any I/O — it returns a plain description of what changed so the
 * caller (the Zustand store) can mirror the result to SQLite and the UI.
 *
 * Keeping this logic pure makes the receive path (the part that decides whether
 * incoming funds appear in the wallet) directly unit-testable without a running
 * React Native / SQLite environment.
 */

import {
  extractAddressFromScript,
  hexToBytes,
  type NetworkConfig,
} from "@fairco.in/core";
import { parseTx, type ParsedTransaction } from "../p2p/messages";
import { UTXOSet, type UTXO } from "@peable.to/pay";
import type { WalletTransaction } from "./wallet-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Confirmation context for the transaction being applied. */
export interface ConfirmationInfo {
  /** Block height of the containing block, or -1 if unconfirmed (mempool). */
  readonly blockHeight: number;
  /** Hash (hex) of the containing block, or "" if unconfirmed. */
  readonly blockHash: string;
  /** Number of confirmations (0 if unconfirmed). */
  readonly confirmations: number;
}

/** A UTXO that was newly credited to the wallet. */
export interface CreditedOutput {
  readonly utxo: UTXO;
}

/** A wallet UTXO that was spent by one of the transaction's inputs. */
export interface DebitedInput {
  readonly txid: string;
  readonly vout: number;
  readonly value: bigint;
  readonly address: string;
}

export interface ApplyTransactionResult {
  /** Outputs paying us that were added to the UTXO set. */
  readonly credited: CreditedOutput[];
  /** Our UTXOs that were spent by this transaction's inputs. */
  readonly debited: DebitedInput[];
  /** Total value received by the wallet in this transaction (base units). */
  readonly receivedTotal: bigint;
  /** Total value of our UTXOs spent by this transaction (base units). */
  readonly spentTotal: bigint;
  /** Distinct wallet addresses that received funds (in output order). */
  readonly receiveAddresses: string[];
  /** Whether the transaction changed the wallet's UTXO set at all. */
  readonly changed: boolean;
}

/**
 * Reverse a byte array and return its hex encoding: converts a wire/internal
 * byte order hash (such as a tx input's `prevTxHash`) to the canonical display
 * txid used as the UTXO map key throughout the wallet.
 */
export function reverseBytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = bytes.length - 1; i >= 0; i--) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Apply a transaction to the wallet's UTXO set.
 *
 * @param utxoSet     The wallet's in-memory UTXO set (mutated in place).
 * @param tx          The parsed transaction delivered by the SPV client.
 * @param txid        The transaction id in display byte order.
 * @param ownsAddress Predicate returning true if an address belongs to us.
 * @param network     Network config (controls address version bytes).
 * @param confirmation Confirmation context for the containing block.
 * @returns A description of the credits and debits that were applied.
 *
 * Idempotent with respect to replays: adding a UTXO that already exists simply
 * overwrites it with identical data, and a confirmed UTXO is never downgraded
 * to unconfirmed by a later mempool copy of the same output.
 */
export function applyTransactionToWallet(
  utxoSet: UTXOSet,
  tx: ParsedTransaction,
  txid: string,
  ownsAddress: (address: string) => boolean,
  network: NetworkConfig,
  confirmation: ConfirmationInfo,
): ApplyTransactionResult {
  const confirmed = confirmation.blockHeight >= 0;
  const credited: CreditedOutput[] = [];
  const receiveAddresses: string[] = [];
  let receivedTotal = 0n;

  // ---- Credit outputs that pay one of our addresses ----------------------
  for (let vout = 0; vout < tx.outputs.length; vout++) {
    const output = tx.outputs[vout];
    const address = extractAddressFromScript(output.script, network);
    if (!address || !ownsAddress(address)) {
      continue;
    }

    if (!receiveAddresses.includes(address)) {
      receiveAddresses.push(address);
    }

    const existing = utxoSet.get(txid, vout);
    // Never downgrade a confirmed UTXO to unconfirmed on replay.
    if (existing && existing.confirmed && !confirmed) {
      continue;
    }

    const utxo: UTXO = {
      txid,
      vout,
      address,
      value: output.value,
      scriptPubKey: output.script,
      blockHeight: confirmation.blockHeight,
      confirmed,
    };
    utxoSet.add(utxo);
    credited.push({ utxo });
    receivedTotal += output.value;
  }

  // ---- Debit inputs that spend one of our UTXOs --------------------------
  const debited: DebitedInput[] = [];
  let spentTotal = 0n;
  for (const input of tx.inputs) {
    const prevTxid = reverseBytesToHex(input.prevTxHash);
    const spent = utxoSet.get(prevTxid, input.prevTxIndex);
    if (!spent) {
      continue;
    }
    utxoSet.spend(prevTxid, input.prevTxIndex);
    debited.push({
      txid: prevTxid,
      vout: input.prevTxIndex,
      value: spent.value,
      address: spent.address,
    });
    spentTotal += spent.value;
  }

  return {
    credited,
    debited,
    receivedTotal,
    spentTotal,
    receiveAddresses,
    changed: credited.length > 0 || debited.length > 0,
  };
}

// ---------------------------------------------------------------------------
// History reconstruction (init hydration path)
// ---------------------------------------------------------------------------

/**
 * The persisted `transactions` fields a reconstruction needs. A real
 * {@link import("../storage/database").TransactionRow} is structurally
 * assignable, so callers pass DB rows directly without a cast.
 */
export interface StoredTransactionRow {
  readonly txid: string;
  readonly raw_hex: string;
  readonly block_height: number;
  readonly timestamp: number;
}

/** Value + owning address of a previous output, used to price a spent input. */
export interface PrevoutValue {
  readonly value: bigint;
  readonly address: string;
}

/**
 * Rebuild a {@link WalletTransaction} from a persisted `transactions` row.
 *
 * The `transactions` table stores `raw_hex` + block metadata but NOT the derived
 * display fields (amount/address/type/confirmations). At init the store loads
 * balance/UTXOs from SQLite but the tx history is only ever pushed into the
 * store in-memory by the live receive path — so after an unlock the Activity
 * list is empty even though the balance is correct. This re-derives each row's
 * display fields the SAME way {@link applyTransactionToWallet} +
 * `processIncomingTransaction` do, so the reloaded list is identical to the
 * live one:
 *
 * - `receivedTotal` = sum of outputs paying an address we own; `firstReceive`
 *   is the first such address in output order (mirrors `receiveAddresses[0]`).
 * - `spentTotal` = sum of inputs whose prevout is one of our (now-spent) UTXOs,
 *   valued via `lookupPrevout`; `firstSpent` is the first such address in input
 *   order (mirrors `debited[0]?.address`).
 * - `net = receivedTotal - spentTotal`; a pure receive is positive, spending our
 *   coins (with change back) nets negative. `net === 0n` means the wallet has no
 *   involvement (Bloom false positive) — return null so it isn't listed, mirroring
 *   `processIncomingTransaction`'s `if (net !== 0n)` gate.
 *
 * Pure and I/O-free (`lookupPrevout` is the only injected dependency) so the
 * reload path is unit-testable without the native DB or the store.
 *
 * @param chainHeight Best chain tip known at reload; a background sync refines
 *   confirmations later. Unconfirmed rows (block_height < 0) report 0.
 */
export function reconstructWalletTransaction(
  row: StoredTransactionRow,
  ownsAddress: (address: string) => boolean,
  lookupPrevout: (txid: string, vout: number) => PrevoutValue | undefined,
  network: NetworkConfig,
  chainHeight: number,
): WalletTransaction | null {
  const tx = parseTx(hexToBytes(row.raw_hex));

  let receivedTotal = 0n;
  let firstReceiveAddress = "";
  for (const output of tx.outputs) {
    const address = extractAddressFromScript(output.script, network);
    if (!address || !ownsAddress(address)) {
      continue;
    }
    if (firstReceiveAddress === "") {
      firstReceiveAddress = address;
    }
    receivedTotal += output.value;
  }

  let spentTotal = 0n;
  let firstSpentAddress = "";
  for (const input of tx.inputs) {
    const prevTxid = reverseBytesToHex(input.prevTxHash);
    const prevout = lookupPrevout(prevTxid, input.prevTxIndex);
    if (!prevout) {
      continue;
    }
    if (firstSpentAddress === "") {
      firstSpentAddress = prevout.address;
    }
    spentTotal += prevout.value;
  }

  const net = receivedTotal - spentTotal;
  if (net === 0n) {
    return null;
  }

  const confirmations =
    row.block_height >= 0 ? Math.max(0, chainHeight - row.block_height + 1) : 0;

  return {
    txid: row.txid,
    amount: net,
    address: net > 0n ? firstReceiveAddress : firstSpentAddress,
    timestamp: row.timestamp,
    confirmations,
    type: net > 0n ? "receive" : "send",
  };
}
