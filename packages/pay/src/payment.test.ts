import { describe, test, expect } from 'bun:test';
import {
  bytesToHex,
  decodeAddress,
  deserializeTransaction,
  getNetwork,
  hexToBytes,
  type NetworkType,
} from '@fairco.in/core';
import { KeyManager } from './wallet/key-manager';
import type { UTXO } from './wallet/utxo-set';
import type { AddressInfo } from './explorer/address';
import { quotePayment, readBalance, sendPayment, type ChainAccess } from './payment';

/**
 * Everything below runs the REAL flow — real BIP44 derivation, real coin
 * selection, real building, real ECDSA signing, real serialization. Only the
 * four chain calls are fakes, so a test that passes is a statement about the
 * bytes this package would have broadcast, not about a mock of it.
 */

const NETWORK: NetworkType = 'mainnet';
const NETWORK_CONFIG = getNetwork(NETWORK);

/** Fixed so every run derives the same wallet; never used on a real chain. */
const SEED = new Uint8Array(64).fill(7);
const PAYEE_SEED = new Uint8Array(64).fill(9);

/** Addresses of the wallet under test, far enough out to cover any scan. */
const { external: EXTERNAL, change: CHANGE } = (() => {
  const keyManager = KeyManager.fromSeed(SEED, NETWORK_CONFIG);
  keyManager.restoreCursors(200, 200);
  return { external: keyManager.getExternalAddresses(), change: keyManager.getChangeAddresses() };
})();

const PAYEE = KeyManager.fromSeed(PAYEE_SEED, NETWORK_CONFIG).getExternalAddresses()[0]!;

/** `OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG`, the only shape signed here. */
function p2pkhScript(address: string): Uint8Array {
  return hexToBytes(`76a914${bytesToHex(decodeAddress(address).hash)}88ac`);
}

let nextTxidByte = 0;
function coin(
  address: string,
  value: bigint,
  options: { blockHeight?: number } = {}
): UTXO {
  const blockHeight = options.blockHeight ?? 1_000;
  nextTxidByte += 1;
  return {
    txid: nextTxidByte.toString(16).padStart(2, '0').repeat(32),
    vout: 0,
    address,
    value,
    scriptPubKey: p2pkhScript(address),
    blockHeight,
    // The explorer reports height 0 for a mempool output; `confirmed` is that
    // question and nothing else, exactly as `fetchAddressInfo` decides it.
    confirmed: blockHeight > 0,
  };
}

/** An explorer that has seen exactly `coins`, and nothing else. */
function explorerHolding(coins: readonly UTXO[]) {
  return async (addresses: readonly string[]): Promise<Map<string, AddressInfo>> => {
    const info = new Map<string, AddressInfo>();
    for (const address of addresses) {
      const mine = coins.filter((utxo) => utxo.address === address);
      info.set(address, { txCount: mine.length, utxos: mine });
    }
    return info;
  };
}

interface Recorder extends ChainAccess {
  readonly broadcasts: string[];
  readonly feeRequests: NetworkType[];
  readonly tipRequests: NetworkType[];
  readonly addressesAsked: string[];
}

function chainHolding(
  coins: readonly UTXO[],
  overrides: Partial<{
    broadcast: (hex: string) => Promise<string>;
    feePerByte: () => Promise<number>;
    tip: number;
  }> = {}
): Recorder {
  const broadcasts: string[] = [];
  const feeRequests: NetworkType[] = [];
  const tipRequests: NetworkType[] = [];
  const addressesAsked: string[] = [];
  const explorer = explorerHolding(coins);
  return {
    broadcasts,
    feeRequests,
    tipRequests,
    addressesAsked,
    fetchAddressInfo: async (addresses) => {
      addressesAsked.push(...addresses);
      return await explorer(addresses);
    },
    fetchFeePerByte: async (network) => {
      feeRequests.push(network);
      return overrides.feePerByte ? await overrides.feePerByte() : 12;
    },
    fetchChainTip: async (network) => {
      tipRequests.push(network);
      return overrides.tip ?? 1_000;
    },
    broadcastTransaction: async (hex) => {
      broadcasts.push(hex);
      return overrides.broadcast ? await overrides.broadcast(hex) : 'daemon-txid';
    },
  };
}

/** The outpoints a broadcast transaction actually spends. */
function spentOutpoints(rawHex: string): string[] {
  return deserializeTransaction(hexToBytes(rawHex)).inputs.map(
    (input) => `${input.txid}:${input.vout}`
  );
}

function outpoint(utxo: UTXO): string {
  return `${utxo.txid}:${utxo.vout}`;
}

describe('sendPayment', () => {
  test('spends the selected coins and returns the txid the daemon gave back', async () => {
    const big = coin(EXTERNAL[0]!, 3_000_000n);
    const small = coin(EXTERNAL[4]!, 900_000n);
    const chain = chainHolding([big, small]);

    const result = await sendPayment(
      { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    // Largest-first covers the amount with one coin, so the other must not move.
    expect(spentOutpoints(chain.broadcasts[0]!)).toEqual([outpoint(big)]);
    expect(result.txid).toBe('daemon-txid');
  });

  /**
   * The txid must be the network's answer, not a local hash of what was sent.
   * A local hash says what we tried; only the daemon says what it kept.
   */
  test('the txid is the daemon\'s, not one computed locally', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)], {
      broadcast: async () => 'f'.repeat(64),
    });

    const result = await sendPayment(
      { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    expect(result.txid).toBe('f'.repeat(64));
  });

  test('insufficient funds fails before anything is signed or broadcast', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 100_000n)]);

    await expect(
      sendPayment(
        { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 5_000_000n, feePerByte: 10 },
        chain
      )
    ).rejects.toThrow(/[Ii]nsufficient funds/);

    // Nothing reached the network: the refusal happened in selection, upstream
    // of the builder and the signer.
    expect(chain.broadcasts).toEqual([]);
  });

  /**
   * Unconfirmed change is how a wallet builds a chain the network may drop: if
   * the parent never confirms, every descendant is invalid and the wallet has
   * spent coins that do not exist.
   */
  test('an unconfirmed output is never spent, even when it is the larger coin', async () => {
    const mempool = coin(EXTERNAL[0]!, 50_000_000n, { blockHeight: 0 });
    const settled = coin(EXTERNAL[1]!, 3_000_000n);
    const chain = chainHolding([mempool, settled]);

    await sendPayment(
      { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    expect(spentOutpoints(chain.broadcasts[0]!)).toEqual([outpoint(settled)]);
  });

  test('a wallet holding only unconfirmed coins cannot pay at all', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 50_000_000n, { blockHeight: 0 })]);

    await expect(
      sendPayment(
        { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
        chain
      )
    ).rejects.toThrow(/[Ii]nsufficient funds/);
    expect(chain.broadcasts).toEqual([]);
  });

  test('a broadcast rejection propagates as an error, never as a txid', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)], {
      broadcast: async () => {
        throw new Error('bad-txns-inputs-missingorspent');
      },
    });

    await expect(
      sendPayment(
        { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
        chain
      )
    ).rejects.toThrow('bad-txns-inputs-missingorspent');
  });

  /**
   * Change to an address the wallet cannot reach is a valid transaction that
   * confirms and pays a stranger — the one failure with no error anywhere.
   */
  test('change goes to a change address this wallet owns', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)]);

    await sendPayment(
      { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    const outputs = deserializeTransaction(hexToBytes(chain.broadcasts[0]!)).outputs;
    const payeeScript = bytesToHex(p2pkhScript(PAYEE));
    const changeScripts = outputs
      .map((output) => bytesToHex(output.scriptPubKey))
      .filter((script) => script !== payeeScript);

    expect(changeScripts).toHaveLength(1);
    expect(CHANGE.map((address) => bytesToHex(p2pkhScript(address)))).toContain(
      changeScripts[0]!
    );
  });

  /**
   * A rate guessed from a stale constant can sit under the network's relay
   * minimum, and the whole symptom is a broadcast that fails for no stated
   * reason while the coins still look spendable.
   */
  test('no rate given and none fetchable fails rather than guessing one', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)], {
      feePerByte: async () => {
        throw new Error('fee estimate failed: HTTP 503');
      },
    });

    await expect(
      sendPayment({ seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n }, chain)
    ).rejects.toThrow('fee estimate failed: HTTP 503');
    expect(chain.broadcasts).toEqual([]);
  });

  test('a non-positive rate from the caller is refused', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)]);

    await expect(
      sendPayment(
        { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 0 },
        chain
      )
    ).rejects.toThrow(/feePerByte must be a positive number/);
    expect(chain.broadcasts).toEqual([]);
  });

  test('a destination that is not an address fails before broadcast', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)]);

    await expect(
      sendPayment(
        { seed: SEED, network: NETWORK, to: 'not-an-address', amountSat: 500_000n, feePerByte: 10 },
        chain
      )
    ).rejects.toThrow();
    expect(chain.broadcasts).toEqual([]);
  });

  /**
   * The wallet holds a key for exactly the addresses its own HD tree derives.
   * A coin anywhere else must never reach selection, because `signEveryInput`
   * has no key for it and no fallback — and a wrong signature is a transaction
   * the network rejects AFTER the bytes have left.
   */
  test('only this wallet\'s own addresses are read, so a foreign coin cannot be selected', async () => {
    const foreign = coin(PAYEE, 50_000_000n);
    const mine = coin(EXTERNAL[0]!, 3_000_000n);
    const chain = chainHolding([foreign, mine]);

    await sendPayment(
      { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    expect(chain.addressesAsked).not.toContain(PAYEE);
    expect(chain.addressesAsked).toContain(EXTERNAL[0]!);
    expect(spentOutpoints(chain.broadcasts[0]!)).toEqual([outpoint(mine)]);
  });

  test('a coin shallower than minConfirmations is not spendable', async () => {
    const shallow = coin(EXTERNAL[0]!, 50_000_000n, { blockHeight: 998 });
    const deep = coin(EXTERNAL[1]!, 3_000_000n, { blockHeight: 900 });
    const chain = chainHolding([shallow, deep], { tip: 1_000 });

    await sendPayment(
      {
        seed: SEED,
        network: NETWORK,
        to: PAYEE,
        amountSat: 500_000n,
        feePerByte: 10,
        minConfirmations: 6,
      },
      chain
    );

    // shallow is 3 deep (1000 - 998 + 1); deep is 101.
    expect(spentOutpoints(chain.broadcasts[0]!)).toEqual([outpoint(deep)]);
  });

  test('the default depth costs no chain-tip request', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)]);

    await sendPayment(
      { seed: SEED, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    expect(chain.tipRequests).toEqual([]);
  });

  test('minConfirmations of 0 is refused, not clamped', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)]);

    await expect(
      sendPayment(
        {
          seed: SEED,
          network: NETWORK,
          to: PAYEE,
          amountSat: 500_000n,
          feePerByte: 10,
          minConfirmations: 0,
        },
        chain
      )
    ).rejects.toThrow(/minConfirmations/);
    expect(chain.broadcasts).toEqual([]);
  });

  /** The seed is the caller's; using it must not damage it. */
  test('the caller\'s seed survives the call intact', async () => {
    const seed = new Uint8Array(64).fill(7);
    await sendPayment(
      { seed, network: NETWORK, to: PAYEE, amountSat: 500_000n, feePerByte: 10 },
      chainHolding([coin(EXTERNAL[0]!, 3_000_000n)])
    );

    expect(seed).toEqual(new Uint8Array(64).fill(7));
  });
});

describe('quotePayment', () => {
  /**
   * The bill has to be the quote. Two separately computed fees for one decision
   * is a payer shown one number and charged another.
   */
  test('the fee charged is exactly the fee the dry run quoted', async () => {
    const coins = [coin(EXTERNAL[0]!, 3_000_000n), coin(EXTERNAL[2]!, 1_500_000n)];
    const request = {
      seed: SEED,
      network: NETWORK,
      to: PAYEE,
      amountSat: 2_500_000n,
      feePerByte: 10,
    };

    const quote = await quotePayment(request, chainHolding(coins));
    const chain = chainHolding(coins);
    const result = await sendPayment({ ...request, feePerByte: quote.feePerByte }, chain);

    expect(quote.insufficientFunds).toBe(false);
    expect(result.feeSat).toBe(quote.feeSat!);
    expect(quote.totalSat).toBe(2_500_000n + result.feeSat);

    // And the charged fee is what the transaction really pays: inputs - outputs.
    const tx = deserializeTransaction(hexToBytes(chain.broadcasts[0]!));
    const spent = new Set(tx.inputs.map((input) => `${input.txid}:${input.vout}`));
    const totalIn = coins
      .filter((utxo) => spent.has(outpoint(utxo)))
      .reduce((sum, utxo) => sum + utxo.value, 0n);
    const totalOut = tx.outputs.reduce((sum, output) => sum + output.value, 0n);
    expect(totalIn - totalOut).toBe(result.feeSat);
  });

  test('an unaffordable amount is an answer, not an exception', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 100_000n)]);

    const quote = await quotePayment(
      { seed: SEED, network: NETWORK, amountSat: 5_000_000n, feePerByte: 10 },
      chain
    );

    expect(quote.insufficientFunds).toBe(true);
    expect(quote.feeSat).toBeNull();
    expect(quote.totalSat).toBeNull();
    expect(quote.maxSendableSat).toBeGreaterThan(0n);
  });

  test('quoting never signs or broadcasts', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)]);

    await quotePayment(
      { seed: SEED, network: NETWORK, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    expect(chain.broadcasts).toEqual([]);
  });

  /** A send screen quotes a fee and a maximum before an address is typed. */
  test('a quote needs no destination', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)]);

    const quote = await quotePayment(
      { seed: SEED, network: NETWORK, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    expect(quote.insufficientFunds).toBe(false);
    expect(quote.feeSat).toBeGreaterThan(0n);
  });

  test('the rate is fetched when the caller gives none, and reported back', async () => {
    const chain = chainHolding([coin(EXTERNAL[0]!, 3_000_000n)]);

    const quote = await quotePayment(
      { seed: SEED, network: NETWORK, amountSat: 500_000n },
      chain
    );

    expect(chain.feeRequests).toEqual([NETWORK]);
    expect(quote.feePerByte).toBe(12);
  });

  test('unconfirmed coins are not counted as sendable', async () => {
    const chain = chainHolding([
      coin(EXTERNAL[0]!, 3_000_000n),
      coin(EXTERNAL[1]!, 50_000_000n, { blockHeight: 0 }),
    ]);

    const quote = await quotePayment(
      { seed: SEED, network: NETWORK, amountSat: 500_000n, feePerByte: 10 },
      chain
    );

    expect(quote.maxSendableSat).toBeLessThan(3_000_000n);
  });
});

describe('readBalance', () => {
  /**
   * One summed number would tell an owner a payment will go through, then fail
   * it on funds still on screen.
   */
  test('separates what can be spent from what is still pending', async () => {
    const chain = chainHolding([
      coin(EXTERNAL[0]!, 3_000_000n),
      coin(EXTERNAL[3]!, 1_000_000n),
      coin(EXTERNAL[5]!, 7_000_000n, { blockHeight: 0 }),
    ]);

    const balance = await readBalance({ seed: SEED, network: NETWORK }, chain);

    expect(balance.spendableSat).toBe(4_000_000n);
    expect(balance.pendingSat).toBe(7_000_000n);
    expect(balance.totalSat).toBe(11_000_000n);
  });

  test('a wallet nobody has paid holds nothing', async () => {
    const balance = await readBalance({ seed: SEED, network: NETWORK }, chainHolding([]));

    expect(balance).toEqual({ spendableSat: 0n, pendingSat: 0n, totalSat: 0n });
  });

  test('a deeper minConfirmations moves shallow coins into pending', async () => {
    const chain = chainHolding(
      [coin(EXTERNAL[0]!, 3_000_000n, { blockHeight: 999 }), coin(EXTERNAL[1]!, 1_000_000n, { blockHeight: 500 })],
      { tip: 1_000 }
    );

    const balance = await readBalance(
      { seed: SEED, network: NETWORK, minConfirmations: 6 },
      chain
    );

    expect(balance.spendableSat).toBe(1_000_000n);
    expect(balance.pendingSat).toBe(3_000_000n);
  });
});

describe('the network config the flow derives against', () => {
  /**
   * The dust rule the fee depends on is the network's `minRelayFee`, and
   * selection is handed exactly that. A change to it must move both sides.
   */
  test('dust is the network relay minimum', () => {
    expect(NETWORK_CONFIG.minRelayFee).toBe(10_000n);
  });
});
