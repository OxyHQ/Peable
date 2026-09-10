/**
 * End-to-end: the F1 atomic flow across the whole Gateway, wired together.
 *
 *   create → (payer) submit_tx → settlement watcher → settled
 *          → realtime socket event  AND  signed webhook
 *
 * On-chain reads and webhook delivery are stubbed (FairCoin testnet is empty),
 * but every backend layer — routes, models, state machine, watcher, socket,
 * webhook signer/dispatcher — runs for real. Also asserts the non-custody
 * invariant: no private-key/seed field is ever persisted.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { IncomingMessage } from "node:http";
import { Socket as NetSocket } from "node:net";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { io as ioClient } from "socket.io-client";
import type { NetworkType } from "@fairco.in/core";
import type {
  OxyAuthRequest,
  SafeFetchResult,
} from "@oxy.so/core/server";
import { verifyWebhook } from "@peable.to/shared-types";
import { merchants, paymentIntents } from "../db/schema";
import {
  findMerchantByAppEnvironment,
  type MerchantRow,
} from "../db/merchants/merchantRepository";
import { findIntentByPublicId } from "../db/payments/paymentIntentRepository";
import { listDeliveriesForMerchant } from "../db/webhooks/webhookDeliveryRepository";
import {
  gatewayDb,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from "./helpers/gatewayTestDatabase";
import { createGateway, type Gateway } from "../server";
import { runWebhookOutboxPass } from "../services/webhookOutbox";
import type { SafeFetchFn } from "../services/webhookDispatcher";
import { intentRoom } from "../realtime/socket";
import type { ExplorerTx } from "../services/explorer";

const XPUB =
  "DRKVrRr8WgU4mARJnCLAp77sKJ5h5K79VH8sredx2qPY8BUKogTYqoAXdTAzzvS5MgBDGGWb2Zoa2AwzoLRsbGGkBm1q2r7QSfRYWCizWfvMfPZn";
const FIRST_ADDRESS = "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3";
const APP_ID = "app_e2e";
const WEBHOOK_SECRET = "whsec_e2e";
const AMOUNT = "150000000";
const TXID = "e2e_reported_txid_0001";

// Stub merchant service-auth (bypass real Oxy tokens).
const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: "e2e",
    scopes: ["payments:write"],
    credentialId: "c",
    ownerAccountId: "owner",
    environment: "development",
  };
  next();
};

// Stub optional service-auth for the dual-auth GET route (the e2e flow never
// calls it, but `createGateway` still needs a deterministic value independent
// of ambient env vars).
const stubOptionalServiceAuth = (
  _req: unknown,
  _res: unknown,
  next: (err?: Error) => void,
): void => next();

// Stub identity verifier for a socket connection that DOES present a
// handshake token (real prod default is `oxyClient.authSocket()`). Trivially
// accepts and attaches a fake identity. `initSocket` always wraps this in
// `optionalSocketAuth`, so a connection with NO token never reaches this
// stub at all — it stays anonymous.
const stubSocketAuth = (socket: unknown, next: (err?: Error) => void): void => {
  (socket as { data?: Record<string, unknown> }).data = { userId: "e2e_test_user" };
  next();
};

// Controllable on-chain reader.
let txResponse: ExplorerTx | null = null;
const stubGetTransaction = async (
  _txid: string,
  _network: NetworkType,
): Promise<ExplorerTx | null> => txResponse;

// Fake SSRF-safe fetch that captures the webhook delivery.
interface CapturedWebhook {
  url: string;
  headers: Record<string, string>;
  body: string;
}
const webhookCalls: CapturedWebhook[] = [];
const fakeSafeFetch = async (
  url: string,
  options?: { headers?: Record<string, string>; body?: string | Buffer },
): Promise<SafeFetchResult> => {
  const body = typeof options?.body === "string" ? options.body : "";
  webhookCalls.push({ url, headers: options?.headers ?? {}, body });
  const response = new IncomingMessage(new NetSocket());
  return { response, status: 200, headers: {}, finalUrl: url };
};

let gateway: Gateway;
let baseUrl: string;
/** The registered merchant, kept so the delivery-log read below has its id. */
let merchantRow: MerchantRow;

useGatewayDatabase();

beforeAll(async () => {
  merchantRow = await seedMerchant({
    publicId: "merch_test0000000000000001",
    oxyAppId: APP_ID,
    environment: "development",
    network: "testnet",
    xpub: XPUB,
    webhookUrl: "https://merchant.example/peable/webhook",
    webhookSecret: WEBHOOK_SECRET,
    requiredConfirmations: 1,
  });

  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: stubOptionalServiceAuth,
    socketAuth: stubSocketAuth,
    getTransaction: stubGetTransaction,
    safeFetch: fakeSafeFetch,
  });

  await new Promise<void>((resolve) => {
    gateway.httpServer.listen(0, resolve);
  });
  const address = gateway.httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("http server did not bind a port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  gateway.io.close();
  gateway.httpServer.close();
});

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    }),
  ]);
}

test("GET /health is an unauthenticated 200 liveness probe", async () => {
  const res = await fetch(`${baseUrl}/health`);
  expect(res.status).toBe(200);
  expect((await res.json()) as { status: string }).toEqual({ status: "ok" });
});

test("atomic flow: create -> submit_tx -> watcher settles -> socket + webhook", async () => {
  // 1. Merchant creates the charge.
  const createRes = await fetch(`${baseUrl}/v1/payment_intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "e2e-1" },
    body: JSON.stringify({ amount: AMOUNT, network: "testnet" }),
  });
  expect(createRes.status).toBe(201);
  expect(createRes.headers.get("Peable-Version")).toBe("2026-07-18");
  const created = (await createRes.json()) as {
    id: string;
    address: string;
    status: string;
    client_secret: string;
  };
  expect(created.status).toBe("created");
  expect(created.address).toBe(FIRST_ADDRESS);

  // 2. Payer's wallet opens a realtime channel for this intent — with NO Oxy
  // identity (anonymous checkout/embed payer, the whole point of the
  // capability model: connection auth is optional, `subscribe` isn't).
  const client = ioClient(baseUrl, { transports: ["websocket"], forceNew: true });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("connect_error", (err: Error) => reject(err));
    }),
    5000,
    "socket connect",
  );
  const subAck = await withTimeout(
    new Promise<{ ok: boolean }>((resolve) => {
      client.emit(
        "subscribe",
        { intentId: created.id, clientSecret: created.client_secret },
        resolve,
      );
    }),
    5000,
    "subscribe ack",
  );
  expect(subAck.ok).toBe(true);

  // 2b. The authenticated flow (a socket that DOES carry an Oxy identity)
  // must keep working exactly as before the connection auth went optional.
  const authedClient = ioClient(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
    auth: { token: "e2e-identity-token" },
  });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      authedClient.on("connect", () => resolve());
      authedClient.on("connect_error", (err: Error) => reject(err));
    }),
    5000,
    "authed socket connect",
  );
  const authedSubAck = await withTimeout(
    new Promise<{ ok: boolean }>((resolve) => {
      authedClient.emit(
        "subscribe",
        { intentId: created.id, clientSecret: created.client_secret },
        resolve,
      );
    }),
    5000,
    "authed subscribe ack",
  );
  expect(authedSubAck.ok).toBe(true);

  const settled = withTimeout(
    new Promise<{ status: string; id: string }>((resolve) => {
      client.on("intent.updated", (payload: { status: string; id: string }) => {
        if (payload.status === "settled") resolve(payload);
      });
    }),
    5000,
    "settled socket event",
  );
  const authedSettled = withTimeout(
    new Promise<{ status: string; id: string }>((resolve) => {
      authedClient.on("intent.updated", (payload: { status: string; id: string }) => {
        if (payload.status === "settled") resolve(payload);
      });
    }),
    5000,
    "authed settled socket event",
  );

  // 3. Payer reports the broadcast txid (self-custody: they signed it).
  const submitRes = await fetch(
    `${baseUrl}/v1/payment_intents/${created.id}/submit_tx`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_secret: created.client_secret, txid: TXID }),
    },
  );
  expect(submitRes.status).toBe(200);
  expect(((await submitRes.json()) as { status: string }).status).toBe(
    "broadcast",
  );

  // 4. The chain now shows the tx paid + confirmed; the watcher reconciles.
  txResponse = {
    txid: TXID,
    confirmations: 1,
    outputs: [{ address: FIRST_ADDRESS, valueSat: BigInt(AMOUNT) }],
  };
  await gateway.watcher.check();

  // 5. The payer's socket received the settled update — anonymous AND
  // identity-authed connections both subscribed via the same client_secret
  // capability, so both get it.
  const event = await settled;
  expect(event.id).toBe(created.id);
  expect(event.status).toBe("settled");
  const authedEvent = await authedSettled;
  expect(authedEvent.id).toBe(created.id);
  expect(authedEvent.status).toBe("settled");

  // 6. The intent is settled in the DB.
  const doc = await findIntentByPublicId(gatewayDb(), created.id);
  expect(doc?.status).toBe("settled");

  // 7. The merchant's event was ENQUEUED by the transition, and the dispatcher
  // delivers it. Two steps rather than one since ADR 0001 D7: the watcher's
  // commit writes a durable promise, and a separate pass keeps it. The pass is
  // run explicitly here because `createGateway` deliberately starts no
  // background loop — that happens in `start()`, so a suite building a gateway
  // does not acquire one making real requests.
  const beforeDispatch = (
    await listDeliveriesForMerchant(gatewayDb(), {
      merchantId: merchantRow.id,
      limit: 50,
    })
  ).data;
  expect(beforeDispatch.at(0)?.lastStatus).toBe("pending");
  expect(webhookCalls).toHaveLength(0);

  const pass = await runWebhookOutboxPass({ safeFetch: fakeSafeFetch as SafeFetchFn });
  expect(pass).toMatchObject({ claimed: 1, delivered: 1 });

  // A correctly-signed settled webhook reached the merchant.
  const hook = webhookCalls.at(-1);
  if (!hook) throw new Error("no webhook captured");
  const signature = hook.headers["Peable-Signature"];
  if (signature === undefined) throw new Error("webhook missing signature");
  expect(
    verifyWebhook(
      WEBHOOK_SECRET,
      hook.body,
      signature,
      300,
      Math.floor(Date.now() / 1000),
    ),
  ).toBe(true);
  const payload = JSON.parse(hook.body) as {
    type: string;
    data: { object: { status: string } };
  };
  expect(payload.type).toBe("payment_intent.settled");
  expect(payload.data.object.status).toBe("settled");

  // 7b. And the promise is now recorded as kept.
  const deliveryLog = (
    await listDeliveriesForMerchant(gatewayDb(), {
      merchantId: merchantRow.id,
      limit: 50,
    })
  ).data;
  expect(deliveryLog.length).toBeGreaterThan(0);
  // NEWEST first — `listDeliveriesForMerchant` is the paginated read and orders
  // by primary key descending, where the Mongo `find()` this replaces returned
  // insertion order. `at(0)` is the same delivery `at(-1)` used to name.
  const lastDelivery = deliveryLog.at(0);
  expect(lastDelivery?.delivered).toBe(true);
  expect(lastDelivery?.intentPublicId).toBe(created.id);

  // 8. Non-custody invariant: no private-key/seed field was ever persisted.
  // Every column of both rows, not a repository projection: a projection can
  // only report the columns it selects, and the question here is what the
  // table HOLDS — which is what Mongo's `.lean()` answered.
  const [merchantDoc] = await gatewayDb()
    .select()
    .from(merchants)
    .where(eq(merchants.oxyAppId, APP_ID));
  const [intentDoc] = await gatewayDb()
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.publicId, created.id));
  const persistedKeys = [
    ...Object.keys(merchantDoc ?? {}),
    ...Object.keys(intentDoc ?? {}),
  ];
  const custodyField = persistedKeys.find((k) =>
    /(private|mnemonic|seed|xprv)/i.test(k),
  );
  expect(custodyField).toBeUndefined();

  client.close();
  authedClient.close();
});

test("subscribe is capability-scoped by client_secret — a wrong secret joins nothing, and an authed identity does not substitute for the capability (no leak)", async () => {
  const merchant = await findMerchantByAppEnvironment(gatewayDb(), APP_ID, "development");
  if (!merchant) throw new Error("e2e merchant fixture missing");
  const intent = await seedIntent(merchant, {
    publicId: "pi_0000000000000000000000e1",
    amount: AMOUNT,
    network: "testnet",
    address: FIRST_ADDRESS,
    clientSecret: "pi_0000000000000000000000e1_secret_real",
    idempotencyKey: "idem_no_leak",
    expiresAt: new Date(Date.now() + 60_000),
  });

  const anon = ioClient(baseUrl, { transports: ["websocket"], forceNew: true });
  const authed = ioClient(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
    auth: { token: "e2e-identity-token" },
  });
  await Promise.all([
    withTimeout(
      new Promise<void>((resolve, reject) => {
        anon.on("connect", () => resolve());
        anon.on("connect_error", (err: Error) => reject(err));
      }),
      5000,
      "anon connect",
    ),
    withTimeout(
      new Promise<void>((resolve, reject) => {
        authed.on("connect", () => resolve());
        authed.on("connect_error", (err: Error) => reject(err));
      }),
      5000,
      "authed connect",
    ),
  ]);

  const anonAck = await withTimeout(
    new Promise<{ ok: boolean }>((resolve) => {
      anon.emit("subscribe", { intentId: intent.publicId, clientSecret: "wrong-secret" }, resolve);
    }),
    5000,
    "anon wrong-secret subscribe ack",
  );
  expect(anonAck.ok).toBe(false);

  const authedAck = await withTimeout(
    new Promise<{ ok: boolean }>((resolve) => {
      authed.emit("subscribe", { intentId: intent.publicId, clientSecret: "wrong-secret" }, resolve);
    }),
    5000,
    "authed wrong-secret subscribe ack",
  );
  expect(authedAck.ok).toBe(false);

  // Neither socket actually joined the intent's room — a failed capability
  // check never falls back to identity, so `emitIntentUpdate` would reach
  // no one. Checked server-side (deterministic; no fixed-delay listener).
  const room = gateway.io.sockets.adapter.rooms.get(intentRoom(intent.publicId));
  expect(room).toBeUndefined();

  anon.close();
  authed.close();
});
