import { describe, test, expect, mock, afterEach } from 'bun:test';
import { broadcastTransaction, fetchFeePerByte } from './broadcast';

const RAW_TX = 'deadbeef';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondsWith(body: unknown, status = 200): void {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('broadcastTransaction', () => {
  test('returns the txid the daemon accepted', async () => {
    const txid = 'ab'.repeat(32);
    respondsWith({ txid });

    expect(await broadcastTransaction(RAW_TX, 'mainnet')).toBe(txid);
  });

  // A rejection is the one case that must never look like a send. The payer is
  // told their money moved; the coins are still theirs and the transaction does
  // not exist.
  test('throws the daemon"s reason when the network refuses the transaction', async () => {
    respondsWith({ error: 'Transaction rejected by the network node' }, 400);

    await expect(broadcastTransaction(RAW_TX, 'mainnet')).rejects.toThrow(
      /rejected by the network node/,
    );
  });

  test('throws when the response carries no txid', async () => {
    respondsWith({});

    await expect(broadcastTransaction(RAW_TX, 'mainnet')).rejects.toThrow(/no txid/);
  });
});

describe('fetchFeePerByte', () => {
  test('returns the rate the daemon currently wants', async () => {
    respondsWith({ feePerKb: 0.0001, feePerByte: 10, blocks: 6, network: 'mainnet' });

    expect(await fetchFeePerByte('mainnet')).toBe(10);
  });

  // Never fall back to a number of our own: a fee below the network's relay
  // minimum produces a transaction nothing forwards, with no error to show for
  // it. Failing here is how the caller gets to say so.
  test('throws rather than guessing when the rate is missing or unusable', async () => {
    respondsWith({ feePerKb: 0.0001 });
    await expect(fetchFeePerByte('mainnet')).rejects.toThrow(/no usable feePerByte/);

    respondsWith({ feePerByte: 0 });
    await expect(fetchFeePerByte('mainnet')).rejects.toThrow(/no usable feePerByte/);

    respondsWith({}, 503);
    await expect(fetchFeePerByte('mainnet')).rejects.toThrow(/HTTP 503/);
  });
});
