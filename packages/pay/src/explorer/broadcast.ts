/**
 * Handing a signed transaction to the network, and asking what a fee should be.
 *
 * The Peable wallet broadcasts over its P2P connection, which is why paying
 * used to require the app: an embedded client has no peers. The Explorer
 * relays for it — `POST /api/tx/broadcast` reaches the same daemon — so the
 * only thing an embedding app needs is HTTP.
 *
 * Neither call is a place to be clever. A broadcast that half-worked, or a fee
 * guessed from a stale constant, both end the same way: a transaction the
 * network will not relay, with the coins still looking spendable.
 */

import { EXPLORER_BASE_URL, type NetworkType } from '@fairco.in/core';

/**
 * Fee rate the Explorer's daemon currently wants, in base units per byte.
 *
 * Asked rather than hardcoded. The wallet's `FEE_RATES` are three fixed numbers
 * chosen once; a network that raises its relay minimum above them would reject
 * every transaction this package builds, and the only symptom would be a
 * broadcast that fails for no stated reason.
 */
export async function fetchFeePerByte(network: NetworkType): Promise<number> {
  const response = await fetch(`${EXPLORER_BASE_URL}/api/fee-estimate?network=${network}`);
  if (!response.ok) {
    throw new Error(`fee estimate failed: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const feePerByte = (body as { feePerByte?: unknown }).feePerByte;
  if (typeof feePerByte !== 'number' || !Number.isFinite(feePerByte) || feePerByte <= 0) {
    throw new Error('fee estimate returned no usable feePerByte');
  }
  return feePerByte;
}

/**
 * Relay a signed transaction and return its txid.
 *
 * The txid comes from the DAEMON, not from hashing the bytes locally: a local
 * hash says what was sent, and this has to say what was accepted. A rejection
 * (already spent, fee too low, malformed) is an error here, never a txid —
 * silently returning one would tell the payer their money moved when it did
 * not.
 */
export async function broadcastTransaction(
  rawTransactionHex: string,
  network: NetworkType,
): Promise<string> {
  const response = await fetch(`${EXPLORER_BASE_URL}/api/tx/broadcast?network=${network}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hex: rawTransactionHex }),
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as { error?: unknown } | null)?.error;
    throw new Error(
      typeof message === 'string' ? message : `broadcast failed: HTTP ${response.status}`,
    );
  }

  const txid = (body as { txid?: unknown } | null)?.txid;
  if (typeof txid !== 'string' || txid.length === 0) {
    throw new Error('broadcast returned no txid');
  }
  return txid;
}
