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
import { SettlementWatcher, type WatcherDeps } from '../settlementWatcher';

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
