import { test, expect, afterEach } from 'bun:test';
import {
  findIntentById,
  updateIntentState,
  type PaymentIntentRow,
} from '../../db/payments/paymentIntentRepository';
import {
  gatewayDb,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import type { ExplorerTx } from '../explorer';
import {
  BROADCAST_UNSEEN_MS,
  REORG_MISSING_GRACE_MS,
  SettlementWatcher,
  type WatcherDeps,
} from '../settlementWatcher';
import { must } from '../../__tests__/helpers/must';

const ADDRESS = 'TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3';
const AMOUNT = '100000000';
const PAID_VALUE = 100_000_000n;
const REQUIRED_CONFIRMATIONS = 2;

useGatewayDatabase();

afterEach(async () => {
  await resetGatewayTables();
});

test('a paid intent stays processing as confirmations climb, then succeeds', async () => {
  const merchant = await seedMerchant({
    publicId: 'merch_test0000000000000001',
    oxyAppId: 'app_settle',
    environment: 'development',
    network: 'testnet',
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
  });

  const now = new Date();
  const intent = await seedIntent(merchant, {
    publicId: 'pi_0000000000000000000000c1',
    amount: AMOUNT,
    network: 'testnet',
    address: ADDRESS,
    clientSecret: 'pi_0000000000000000000000c1_secret_x',
    idempotencyKey: 'idem_settle',
    expiresAt: new Date(now.getTime() + 60_000),
  });
  // A FairCoin intent is MINTED `requires_action`, and `processing` is reached
  // only by recording the payer's txid — status and txid in ONE statement, which
  // is what `payment_intents_processing_requires_txid_check` requires.
  await updateIntentState(gatewayDb(), intent.id, {
    from: 'requires_action',
    status: 'processing',
    txid: 'tx_settle',
  });

  // Stub the Explorer: same output paying the intent address in full, with the
  // confirmation count climbing 0 → 1 → 2 across successive check() calls.
  let observedConfirmations = 0;
  const getTransaction: WatcherDeps['getTransaction'] = async (txid) => {
    if (txid !== 'tx_settle') return null;
    const confirmations = observedConfirmations;
    if (observedConfirmations < REQUIRED_CONFIRMATIONS) {
      observedConfirmations += 1;
    }
    return {
      txid,
      confirmations,
      outputs: [{ address: ADDRESS, valueSat: PAID_VALUE }],
    } satisfies ExplorerTx;
  };

  const changes: string[] = [];
  const onChange: WatcherDeps['onChange'] = (updated: PaymentIntentRow) => {
    changes.push(updated.status);
  };

  const watcher = new SettlementWatcher({ getTransaction, onChange });

  // 0 confirmations: proven in the mempool, nothing new to write.
  await watcher.check();
  expect((await findIntentById(gatewayDb(), intent.id))?.status).toBe('processing');

  // 1 confirmation: still `processing`, and the count is written so the wire's
  // `faircoin.confirmations` is live.
  await watcher.check();
  const confirming = await findIntentById(gatewayDb(), intent.id);
  expect(confirming?.status).toBe('processing');
  expect(confirming?.confirmations).toBe(1);

  await watcher.check();
  const succeeded = await findIntentById(gatewayDb(), intent.id);
  expect(succeeded?.status).toBe('succeeded');
  expect(succeeded?.confirmations).toBe(REQUIRED_CONFIRMATIONS);
  expect(succeeded?.amountReceived).toBe(AMOUNT);

  // onChange fires once per WRITE: the new confirmation count, then success.
  // The first poll (0 = 0) writes nothing and does not fire.
  expect(changes).toEqual(['processing', 'succeeded']);
});

test('cancels an under-value payment as underpaid', async () => {
  const merchant = await seedMerchant({
    publicId: 'merch_test0000000000000002',
    oxyAppId: 'app_under',
    environment: 'development',
    network: 'testnet',
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
  });

  const now = new Date();
  const intent = await seedIntent(merchant, {
    publicId: 'pi_0000000000000000000000c2',
    amount: AMOUNT,
    network: 'testnet',
    address: ADDRESS,
    clientSecret: 'pi_0000000000000000000000c2_secret_y',
    idempotencyKey: 'idem_under',
    expiresAt: new Date(now.getTime() + 60_000),
  });
  await updateIntentState(gatewayDb(), intent.id, {
    from: 'requires_action',
    status: 'processing',
    txid: 'tx_under',
  });

  // A tx is present for this intent but pays less than the intent amount.
  const getTransaction: WatcherDeps['getTransaction'] = async (txid) => {
    if (txid !== 'tx_under') return null;
    return {
      txid,
      confirmations: 1,
      outputs: [{ address: ADDRESS, valueSat: 50_000_000n }],
    } satisfies ExplorerTx;
  };

  const changes: string[] = [];
  const onChange: WatcherDeps['onChange'] = (updated: PaymentIntentRow) => {
    changes.push(updated.status);
  };

  const watcher = new SettlementWatcher({ getTransaction, onChange });
  await watcher.check();

  const underpaid = await findIntentById(gatewayDb(), intent.id);
  expect(underpaid?.status).toBe('canceled');
  expect(underpaid?.cancellationReason).toBe('underpaid');
  expect(underpaid?.lastPaymentError?.code).toBe('payment_underpaid');
  expect(changes).toEqual(['canceled']);
});

/** A testnet merchant's FairCoin intent, `succeeded` at `confirmations` with txid `txid`. */
async function settledIntent(publicId: string, txid: string, confirmations: number) {
  const merchant = await seedMerchant({
    environment: 'development',
    network: 'testnet',
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
  });
  const intent = await seedIntent(merchant, {
    publicId,
    amount: AMOUNT,
    network: 'testnet',
    address: ADDRESS,
  });
  await updateIntentState(gatewayDb(), intent.id, {
    from: 'requires_action',
    status: 'processing',
    txid,
  });
  await updateIntentState(gatewayDb(), intent.id, {
    from: 'processing',
    status: 'succeeded',
    confirmations,
  });
  return intent;
}

function paying(txid: string, confirmations: () => number): WatcherDeps['getTransaction'] {
  return async (asked) =>
    asked === txid
      ? {
          txid,
          confirmations: confirmations(),
          outputs: [{ address: ADDRESS, valueSat: PAID_VALUE }],
        }
      : null;
}

test('a succeeded payment is re-read until final: deeper is recorded, a reorg below the threshold rewinds it (ADR 0021 D10)', async () => {
  const intent = await settledIntent('pi_0000000000000000000000d1', 'tx_reorg', 2);
  let observed = 5;
  let clock = Date.now();
  const changes: string[] = [];
  const watcher = new SettlementWatcher({
    getTransaction: paying('tx_reorg', () => observed),
    now: () => clock,
    onChange: (row) => {
      changes.push(`${row.status}:${row.confirmations}`);
    },
  });
  /** A settled payment is re-read at most once a minute. */
  const aMinuteLater = () => {
    clock += 61_000;
  };

  await watcher.check();
  const deeper = must(await findIntentById(gatewayDb(), intent.id));
  expect(deeper.status).toBe('succeeded');
  expect(deeper.confirmations).toBe(5);

  // Re-read within the minute: not asked again.
  observed = 7;
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), intent.id)).confirmations).toBe(5);

  // The block holding it is replaced: one confirmation, below the threshold of 2.
  observed = 1;
  aMinuteLater();
  await watcher.check();
  const rewound = must(await findIntentById(gatewayDb(), intent.id));
  expect(rewound.status).toBe('processing');
  expect(rewound.confirmations).toBe(1);
  expect(rewound.amountReceived).toBe('0');

  // Mined again: the ordinary path settles it once more.
  observed = 2;
  aMinuteLater();
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), intent.id)).status).toBe('succeeded');
  expect(changes).toEqual(['succeeded:5', 'processing:1', 'succeeded:2']);
});

test('a succeeded payment whose transaction vanished is rewound only after the grace, and only while the Explorer answers', async () => {
  const intent = await settledIntent('pi_0000000000000000000000d2', 'tx_gone', 3);
  let clock = Date.now();
  let tipAnswers = true;
  const watcher = new SettlementWatcher({
    getTransaction: async () => null,
    getTip: async () => {
      if (!tipAnswers) throw new Error('explorer down');
      return 100;
    },
    now: () => clock,
    onChange: () => undefined,
  });

  await watcher.check();
  clock += REORG_MISSING_GRACE_MS - 1;
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), intent.id)).status).toBe('succeeded');

  // Past the grace, but the Explorer is not answering: nothing is concluded.
  clock += 61_000;
  tipAnswers = false;
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), intent.id)).status).toBe('succeeded');

  clock += 61_000;
  tipAnswers = true;
  await watcher.check();
  const rewound = must(await findIntentById(gatewayDb(), intent.id));
  expect(rewound.status).toBe('processing');
  expect(rewound.confirmations).toBe(0);
});

test('a reported broadcast never seen for a day, at an unpaid address, is lost: cancelled abandoned (ADR 0021 D9)', async () => {
  const merchant = await seedMerchant({ environment: 'development', network: 'testnet' });
  const lost = await seedIntent(merchant, { amount: AMOUNT, network: 'testnet', address: ADDRESS });
  await updateIntentState(gatewayDb(), lost.id, {
    from: 'requires_action',
    status: 'processing',
    txid: 'tx_never',
  });
  let usage: 'unused' | 'used' = 'used';
  let clock = Date.now();
  const watcher = new SettlementWatcher({
    getTransaction: async () => null,
    getTip: async () => 100,
    getAddressUsage: async () => usage,
    addressHasTransaction: async (_address, _network, txid) => (txid === 'tx_never' ? 'yes' : 'no'),
    now: () => clock,
    onChange: () => undefined,
  });

  // Young: never judged.
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), lost.id)).status).toBe('processing');

  // A day on, and the address received something — from the reported
  // transaction, by its own list: it stays the chain's to settle.
  clock += BROADCAST_UNSEEN_MS + 1;
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), lost.id)).status).toBe('processing');

  // Re-judged no sooner than its interval, and now the address is unpaid.
  usage = 'unused';
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), lost.id)).status).toBe('processing');
  clock += 10 * 60 * 1000 + 1;
  await watcher.check();
  const canceled = must(await findIntentById(gatewayDb(), lost.id));
  expect(canceled.status).toBe('canceled');
  expect(canceled.cancellationReason).toBe('abandoned');
});

test('on mainnet an Explorer that cannot tell (`unknown`) never makes a broadcast lost; a new watcher observes for an hour first', async () => {
  const merchant = await seedMerchant({ network: 'mainnet' });
  const MAINNET_ADDRESS = 'FLyY3WG7h7iPFMeGN81hXrAVzWMocDyT7a';
  const pending = await seedIntent(merchant, {
    amount: AMOUNT,
    network: 'mainnet',
    address: MAINNET_ADDRESS,
  });
  await updateIntentState(gatewayDb(), pending.id, {
    from: 'requires_action',
    status: 'processing',
    txid: 'tx_unknown',
  });
  let usage: 'unknown' | 'unused' = 'unknown';
  // Already a day old when this watcher first looks (a restart, say).
  let clock = Date.now() + BROADCAST_UNSEEN_MS + 1;
  const watcher = new SettlementWatcher({
    getTransaction: async () => null,
    getTip: async () => 100,
    getAddressUsage: async () => usage,
    now: () => clock,
    onChange: () => undefined,
  });

  // Not judged until this watcher has itself seen it missing for an hour.
  usage = 'unused';
  await watcher.check();
  clock += 30 * 60 * 1000;
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), pending.id)).status).toBe('processing');

  // An hour of misses, but the address read cannot tell: kept.
  usage = 'unknown';
  clock += 31 * 60 * 1000;
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), pending.id)).status).toBe('processing');

  // The Explorer answers in full: lost.
  usage = 'unused';
  clock += 11 * 60 * 1000;
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), pending.id)).status).toBe('canceled');
});

test('a made-up txid plus dust sent to the address does not hold it for ever: the reported payment is lost (ADR 0021 D9)', async () => {
  const merchant = await seedMerchant({ network: 'mainnet' });
  const dusted = await seedIntent(merchant, {
    amount: AMOUNT,
    network: 'mainnet',
    address: 'FLyY3WG7h7iPFMeGN81hXrAVzWMocDyT7a',
  });
  await updateIntentState(gatewayDb(), dusted.id, {
    from: 'requires_action',
    status: 'processing',
    txid: 'f'.repeat(64),
  });
  let listed: 'yes' | 'no' | 'unknown' = 'unknown';
  let clock = Date.now() + BROADCAST_UNSEEN_MS + 1;
  const watcher = new SettlementWatcher({
    getTransaction: async () => null,
    getTip: async () => 100,
    // Something arrived at the address…
    getAddressUsage: async () => 'used',
    // …and whether it was the reported transaction is what decides.
    addressHasTransaction: async () => listed,
    now: () => clock,
    onChange: () => undefined,
  });
  await watcher.check();
  clock += 61 * 60 * 1000;
  // The address's list cannot be read: nothing concluded.
  await watcher.check();
  expect(must(await findIntentById(gatewayDb(), dusted.id)).status).toBe('processing');
  // The list is read in full and the reported txid is not on it: lost.
  listed = 'no';
  clock += 11 * 60 * 1000;
  await watcher.check();
  const canceled = must(await findIntentById(gatewayDb(), dusted.id));
  expect(canceled.status).toBe('canceled');
  expect(canceled.cancellationReason).toBe('abandoned');
});
