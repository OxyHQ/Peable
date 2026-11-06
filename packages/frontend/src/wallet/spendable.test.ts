import { describe, test, expect } from 'bun:test';
import { partitionStrandedCoins, signableCoins, sumCoinValues } from './spendable';

const coin = (address: string, value: bigint) => ({ address, value });

// The F8 scenario: the identity key rotated, so the social window was
// re-derived from the new key. A 50 FAIR coin received under the old key sits
// in the database at an address nothing here derives any more.
const HD = coin('F_hd', 10n);
const SOCIAL = coin('F_social_now', 20n);
const MULTISIG = coin('F_multisig', 5n);
const OLD_KEY = coin('F_social_previous_key', 50n);
const TESTNET = coin('T_other_network', 7n);
const watched = new Set(['F_hd', 'F_social_now', 'F_multisig']);
const signable = new Set(['F_hd', 'F_social_now']);

describe('partitionStrandedCoins', () => {
  test('keeps a coin under a previous key apart, never drops it', () => {
    const { held, stranded, otherNetwork } = partitionStrandedCoins(
      [OLD_KEY, HD, SOCIAL, MULTISIG, TESTNET],
      (a) => watched.has(a),
      (a) => a.startsWith('F'),
    );
    expect(held).toEqual([HD, SOCIAL, MULTISIG]);
    expect(stranded).toEqual([OLD_KEY]);
    // The database is shared by both networks: a testnet coin is the testnet
    // view's, neither this view's balance nor a "previous key" coin.
    expect(otherNetwork).toEqual([TESTNET]);
    expect(sumCoinValues(stranded)).toBe(50n);
  });
});

describe('signableCoins', () => {
  // Largest-first selection used to pick the 50 FAIR coin first and the send
  // threw at signing — every send, while the balance said the money was there.
  test('a send never selects a coin it cannot sign for', () => {
    const candidates = signableCoins([OLD_KEY, HD, SOCIAL, MULTISIG], (a) => signable.has(a));
    expect(candidates).toEqual([HD, SOCIAL]);
  });
});

describe('sumCoinValues', () => {
  test('is 0 for nothing', () => {
    expect(sumCoinValues([])).toBe(0n);
  });
});
