/**
 * Regression tests for init-time transaction history reconstruction.
 *
 * The bug: after unlock the balance was correct (restored from persisted UTXOs)
 * but the Activity list showed "No activity yet" — the init hydration set
 * `balance`/UTXOs/addresses but never re-read the `transactions` table, so
 * `transactions` stayed `[]`. The persisted rows store `raw_hex` + block
 * metadata but NOT the derived display fields (amount/address/type), so they
 * must be re-derived on load. {@link reconstructWalletTransaction} does that the
 * SAME way the live SPV receive path does; these tests pin that equivalence.
 *
 * The fixture is the SAME real mainnet transaction used by `receive.test.ts`:
 *
 *   txid b7953d1d04a5909fe73e939fe3150054b4237f0d9f21dc118cd8df823019f4fc
 *   output #0 pays 4.9999601 FAIR to FRxmgpEqeAEHVRh1YEiNf61cXzvGatCgtB
 *   output #1 pays 10 FAIR to FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek
 *   input #0 spends ac7b900bee96297c1fe2d1fd3ba524c907ee3702a71b309f69fd21bd12c1c59b:1
 */

import { describe, test, expect } from 'bun:test';
import { UNITS_PER_COIN, getNetwork } from '@fairco.in/core';
import {
  reconstructWalletTransaction,
  type StoredTransactionRow,
  type PrevoutValue,
} from './apply-transaction';

const MAINNET = getNetwork('mainnet');

const RAW_TX_HEX =
  '01000000019bc5c112bd21fd699f301ba70237ee07c924a53bfdd1e21f7c2996ee0b907bac' +
  '0100000048473044022063217b3fbff910185d1b3caf4fa6d248d0c5cd27ea33729c6cdc2b' +
  '99b17049580220280664029acc5259de8249d74175f16ec601b228f6e19fc8bcf3468af9ce' +
  '90aa01ffffffff026a55cd1d000000001976a914dcd555e41658449bc79d13d561f7f85dff' +
  'e76d6e88ac00ca9a3b000000001976a91430dcb7d3cc3a4733d0e478c66835a0946cfcfacf' +
  '88ac00000000';

const TXID = 'b7953d1d04a5909fe73e939fe3150054b4237f0d9f21dc118cd8df823019f4fc';
const RECEIVE_ADDRESS = 'FAHUJmcTfwvRYCcDXAzsu7YRiittDC8Jek';
const CHANGE_ADDRESS = 'FRxmgpEqeAEHVRh1YEiNf61cXzvGatCgtB';
const SPENT_PREV_TXID = 'ac7b900bee96297c1fe2d1fd3ba524c907ee3702a71b309f69fd21bd12c1c59b';
const SPENT_PREV_VOUT = 1;
const TEN_FAIR = 10n * UNITS_PER_COIN; // output #1
const CHANGE_VALUE = 499_996_010n; // output #0 (4.9999601 FAIR)

const CONFIRMED_ROW: StoredTransactionRow = {
  txid: TXID,
  raw_hex: RAW_TX_HEX,
  block_height: 100,
  timestamp: 1_700_000_000,
};

/** No prevout is ours (nothing spent). */
const noPrevout = (): PrevoutValue | undefined => undefined;

describe('reconstructWalletTransaction', () => {
  test('a persisted receive row rebuilds the exact receive WalletTransaction', () => {
    const tx = reconstructWalletTransaction(
      CONFIRMED_ROW,
      (address) => address === RECEIVE_ADDRESS,
      noPrevout,
      MAINNET,
      105, // tip 5 blocks past the containing block
    );

    expect(tx).not.toBeNull();
    expect(tx?.txid).toBe(TXID);
    expect(tx?.type).toBe('receive');
    expect(tx?.amount).toBe(TEN_FAIR); // net = received - spent = +10 FAIR
    expect(tx?.address).toBe(RECEIVE_ADDRESS);
    expect(tx?.timestamp).toBe(1_700_000_000);
    // 105 - 100 + 1 = 6 confirmations.
    expect(tx?.confirmations).toBe(6);
  });

  test('a persisted send row nets negative and reports the spent address', () => {
    // We owned the spent input (15 FAIR) but none of the outputs → pure send.
    const spentAddress = 'FSpEnDaddrESSxxxxxxxxxxxxxxxxxxxxxx';
    const fifteenFair = 15n * UNITS_PER_COIN;
    const lookupPrevout = (prevTxid: string, vout: number): PrevoutValue | undefined =>
      prevTxid === SPENT_PREV_TXID && vout === SPENT_PREV_VOUT
        ? { value: fifteenFair, address: spentAddress }
        : undefined;

    const tx = reconstructWalletTransaction(
      CONFIRMED_ROW,
      () => false, // own no outputs
      lookupPrevout,
      MAINNET,
      100,
    );

    expect(tx).not.toBeNull();
    expect(tx?.type).toBe('send');
    expect(tx?.amount).toBe(-fifteenFair); // net = 0 - 15 FAIR
    expect(tx?.address).toBe(spentAddress);
    expect(tx?.confirmations).toBe(1); // 100 - 100 + 1
  });

  test('a self-send (change back + owned input) nets the amount that left', () => {
    // Own the change output (#0) AND the spent input → net = change - input.
    const fifteenFair = 15n * UNITS_PER_COIN;
    const tx = reconstructWalletTransaction(
      CONFIRMED_ROW,
      (address) => address === CHANGE_ADDRESS,
      (prevTxid, vout) =>
        prevTxid === SPENT_PREV_TXID && vout === SPENT_PREV_VOUT
          ? { value: fifteenFair, address: CHANGE_ADDRESS }
          : undefined,
      MAINNET,
      100,
    );

    expect(tx).not.toBeNull();
    expect(tx?.type).toBe('send');
    expect(tx?.amount).toBe(CHANGE_VALUE - fifteenFair); // negative
    // net < 0 → address is the first spent address.
    expect(tx?.address).toBe(CHANGE_ADDRESS);
  });

  test('a Bloom false positive (no owned in/out) reconstructs to null', () => {
    const tx = reconstructWalletTransaction(CONFIRMED_ROW, () => false, noPrevout, MAINNET, 105);
    expect(tx).toBeNull();
  });

  test('an unconfirmed (mempool) receive row reports zero confirmations', () => {
    const tx = reconstructWalletTransaction(
      { ...CONFIRMED_ROW, block_height: -1 },
      (address) => address === RECEIVE_ADDRESS,
      noPrevout,
      MAINNET,
      105,
    );

    expect(tx?.type).toBe('receive');
    expect(tx?.amount).toBe(TEN_FAIR);
    expect(tx?.confirmations).toBe(0);
  });
});
