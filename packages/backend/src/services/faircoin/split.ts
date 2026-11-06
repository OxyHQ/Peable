/**
 * How a FairCoin payment of a multi-seller order is divided (ADR 0021 D6) — the
 * ONE place the split is decided. Pure, exact, `bigint`.
 *
 * Each recipient's share of `total` is proportional to its WEIGHT (the sum of
 * its lines' `amount_subtotal`, before discount and tax): the floor of
 * `total × weight ÷ Σ weights`. The units the floors leave over — fewer than
 * the number of recipients — go one each to the recipients with the largest
 * remainders, ties to the earlier recipient: the largest remainder method, so
 * the shares always sum to `total` exactly and no recipient is ever more than
 * one base unit from its exact share. Recipients whose weights are all zero
 * share equally (an order of free lines with a shipping charge).
 *
 * A recipient whose share is zero gets no output. Nothing here knows who the
 * recipients are; the caller keys them.
 */

export interface SplitWeight<K> {
  readonly key: K;
  /** Non-negative. */
  readonly weight: bigint;
}

export interface SplitShare<K> {
  readonly key: K;
  /** Positive. */
  readonly amount: bigint;
}

export function splitFaircoinAmount<K>(
  total: bigint,
  recipients: readonly SplitWeight<K>[],
): SplitShare<K>[] {
  if (total < 0n) throw new Error('a split total cannot be negative');
  if (recipients.length === 0) throw new Error('a split needs at least one recipient');
  for (const recipient of recipients) {
    if (recipient.weight < 0n) throw new Error('a split weight cannot be negative');
  }
  const allZero = recipients.every((recipient) => recipient.weight === 0n);
  const weights = recipients.map((recipient) => (allZero ? 1n : recipient.weight));
  const sum = weights.reduce((acc, weight) => acc + weight, 0n);

  const floors = weights.map((weight) => (total * weight) / sum);
  const remainders = weights.map((weight) => (total * weight) % sum);
  let left = total - floors.reduce((acc, share) => acc + share, 0n);

  // Largest remainder first; a stable sort keeps the earlier recipient first on a tie.
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1));
  const amounts = [...floors];
  for (const { index } of order) {
    if (left === 0n) break;
    amounts[index] = (amounts[index] ?? 0n) + 1n;
    left -= 1n;
  }

  const shares: SplitShare<K>[] = [];
  recipients.forEach((recipient, index) => {
    const amount = amounts[index] ?? 0n;
    if (amount > 0n) shares.push({ key: recipient.key, amount });
  });
  return shares;
}
