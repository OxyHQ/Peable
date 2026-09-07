import { test, expect, afterEach } from "bun:test";
import {
  findIntentById,
  updateIntentState,
  type PaymentIntentRow,
} from "../../db/payments/paymentIntentRepository";
import {
  gatewayDb,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from "../../__tests__/helpers/gatewayTestDatabase";
import type { ExplorerTx } from "../explorer";
import { SettlementWatcher, type WatcherDeps } from "../settlementWatcher";

// Real TESTNET account xpub for the canonical all-"abandon" + "art" mnemonic
// (m/44'/1'/0' neutered) — public-key-only, cannot spend. Its index-0 external
// address is TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3.
const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const ADDRESS = "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3";
const AMOUNT = "100000000";
const PAID_VALUE = 100_000_000n;
const REQUIRED_CONFIRMATIONS = 2;

useGatewayDatabase();

afterEach(async () => {
  await resetGatewayTables();
});

test("advances a paid intent broadcast → confirming → settled as confirmations climb", async () => {
  const merchant = await seedMerchant({
    publicId: "merch_test0000000000000001",
    oxyAppId: "app_settle",
    environment: "development",
    network: "testnet",
    xpub: XPUB,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
  });

  const now = new Date();
  const intent = await seedIntent(merchant, {
    publicId: "pi_0000000000000000000000c1",
    amount: AMOUNT,
    network: "testnet",
    address: ADDRESS,
    clientSecret: "pi_0000000000000000000000c1_secret_x",
    idempotencyKey: "idem_settle",
    expiresAt: new Date(now.getTime() + 60_000),
  });
  // `status` and `txid` are not seed parameters: an intent is MINTED `created`,
  // and `broadcast` is reached only by recording the payer's txid.
  // `updateIntentState` is the writer production uses for exactly that, and it
  // sets both in ONE statement — which is what
  // `payment_intents_broadcast_requires_txid_check` requires.
  await updateIntentState(gatewayDb(), intent.id, {
    from: "created",
    status: "broadcast",
    txid: "tx_settle",
  });

  // Stub the Explorer: same output paying the intent address in full, with the
  // confirmation count climbing 0 → 1 → 2 across successive check() calls.
  let observedConfirmations = 0;
  const getTransaction: WatcherDeps["getTransaction"] = async (txid) => {
    if (txid !== "tx_settle") return null;
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
  const onChange: WatcherDeps["onChange"] = (updated: PaymentIntentRow) => {
    changes.push(updated.status);
  };

  const watcher = new SettlementWatcher({ getTransaction, onChange });

  await watcher.check();
  expect((await findIntentById(gatewayDb(), intent.id))?.status).toBe("confirming");

  await watcher.check();
  expect((await findIntentById(gatewayDb(), intent.id))?.status).toBe("confirming");

  await watcher.check();
  const settled = await findIntentById(gatewayDb(), intent.id);
  expect(settled?.status).toBe("settled");
  expect(settled?.confirmations).toBe(REQUIRED_CONFIRMATIONS);

  // onChange fires ONCE per actual status change: broadcast→confirming, then
  // confirming→settled. The middle poll (confirming→confirming) does not fire.
  expect(changes).toEqual(["confirming", "settled"]);
});

test("marks an under-value payment as failed", async () => {
  const merchant = await seedMerchant({
    publicId: "merch_test0000000000000002",
    oxyAppId: "app_under",
    environment: "development",
    network: "testnet",
    xpub: XPUB,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
  });

  const now = new Date();
  const intent = await seedIntent(merchant, {
    publicId: "pi_0000000000000000000000c2",
    amount: AMOUNT,
    network: "testnet",
    address: ADDRESS,
    clientSecret: "pi_0000000000000000000000c2_secret_y",
    idempotencyKey: "idem_under",
    expiresAt: new Date(now.getTime() + 60_000),
  });
  await updateIntentState(gatewayDb(), intent.id, {
    from: "created",
    status: "broadcast",
    txid: "tx_under",
  });

  // A tx is present for this intent but pays less than the intent amount.
  const getTransaction: WatcherDeps["getTransaction"] = async (txid) => {
    if (txid !== "tx_under") return null;
    return {
      txid,
      confirmations: 1,
      outputs: [{ address: ADDRESS, valueSat: 50_000_000n }],
    } satisfies ExplorerTx;
  };

  const changes: string[] = [];
  const onChange: WatcherDeps["onChange"] = (updated: PaymentIntentRow) => {
    changes.push(updated.status);
  };

  const watcher = new SettlementWatcher({ getTransaction, onChange });
  await watcher.check();

  expect((await findIntentById(gatewayDb(), intent.id))?.status).toBe("failed");
  expect(changes).toEqual(["failed"]);
});
