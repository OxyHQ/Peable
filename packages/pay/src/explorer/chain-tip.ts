/**
 * The height of the confirmed chain, which is the only way to turn a UTXO's
 * block height into a confirmation count.
 *
 * A caller that wants more than one confirmation before spending — a merchant
 * refund, a large transfer — cannot answer that from the output alone: the
 * output carries the block it landed in, and "how deep is it now" is a
 * subtraction against this. Without it, `minConfirmations` could only ever mean
 * "confirmed at all", and asking for six would silently get one.
 */

import { EXPLORER_BASE_URL, type NetworkType } from '@fairco.in/core';

/**
 * Current confirmed chain tip for `network`.
 *
 * Throws rather than returning 0 on a bad answer. A tip of 0 would make every
 * output read as zero-or-negative confirmations, which either refuses a legal
 * payment or — with the subtraction the other way round — passes an unconfirmed
 * one; a caller that asked for a depth guarantee must not get a guess.
 */
export async function fetchChainTip(network: NetworkType): Promise<number> {
  const response = await fetch(`${EXPLORER_BASE_URL}/api/stats?network=${network}`);
  if (!response.ok) {
    throw new Error(`chain tip request failed: HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const blockHeight = (body as { stats?: { blockHeight?: unknown } } | null)?.stats?.blockHeight;
  if (typeof blockHeight !== 'number' || !Number.isInteger(blockHeight) || blockHeight <= 0) {
    throw new Error('chain tip response carried no usable blockHeight');
  }
  return blockHeight;
}
