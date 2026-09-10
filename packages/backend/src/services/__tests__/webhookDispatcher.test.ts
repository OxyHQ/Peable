import { test, expect } from "bun:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { SsrfRejection, type SafeFetchResult } from "@oxy.so/core/server";
import { verifyWebhook, type PaymentIntent } from "@peable.to/shared-types";
import {
  attemptDelivery,
  buildEvent,
  type SafeFetchFn,
  type WebhookTarget,
} from "../webhookDispatcher";

const TOLERANCE_SEC = 300;

const TARGET: WebhookTarget = {
  url: "https://merchant.example/peable/webhook",
  secret: "whsec_test_secret",
};

const INTENT: PaymentIntent = {
  id: "pi_0000000000000000000000a1",
  object: "payment_intent",
  status: "settled",
  rail: "faircoin",
  amount: "100000000",
  currency: "FAIR",
  network: "testnet",
  address: "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3",
  merchantId: "merch_1",
  txid: "tx_1",
  confirmations: 2,
  clientSecret: "pi_0000000000000000000000a1_secret_x",
  metadata: {},
  expiresAt: "2026-07-18T00:00:00.000Z",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

// Build a SafeFetchResult backed by a REAL IncomingMessage so `response`
// satisfies the type without a cast, while letting us observe destroy().
function fakeResult(status: number): {
  result: SafeFetchResult;
  wasDestroyed: () => boolean;
} {
  const response = new IncomingMessage(new Socket());
  let destroyed = false;
  response.destroy = (_error?: Error) => {
    destroyed = true;
    return response;
  };
  return {
    result: { response, status, headers: {}, finalUrl: TARGET.url },
    wasDestroyed: () => destroyed,
  };
}

test("delivers a correctly-signed webhook and destroys the response on 2xx", async () => {
  const captured: { body?: string; signature?: string; contentType?: string } = {};
  const { result, wasDestroyed } = fakeResult(200);
  const fakeSafeFetch: SafeFetchFn = async (_url, options) => {
    captured.body = typeof options?.body === "string" ? options.body : undefined;
    captured.signature = options?.headers?.["Peable-Signature"];
    captured.contentType = options?.headers?.["Content-Type"];
    return result;
  };

  const event = buildEvent("payment_intent.settled", INTENT);
  const outcome = await attemptDelivery(event, TARGET, { safeFetch: fakeSafeFetch });

  expect(outcome).toEqual({ kind: "delivered" });
  expect(captured.contentType).toBe("application/json");
  if (captured.body === undefined || captured.signature === undefined) {
    throw new Error("safeFetch was not called with a body + signature header");
  }
  expect(captured.body).toBe(JSON.stringify(event));
  expect(
    verifyWebhook(
      TARGET.secret,
      captured.body,
      captured.signature,
      TOLERANCE_SEC,
      Math.floor(Date.now() / 1000),
    ),
  ).toBe(true);
  expect(wasDestroyed()).toBe(true);
});

/**
 * ONE request per call, whatever happens.
 *
 * This function used to loop internally — three attempts inside 150ms — and
 * that loop is what made a merchant's brief outage a lost event: it could only
 * retry for as long as one caller was willing to wait. The retry schedule now
 * belongs to the outbox, so the property to pin here is that this makes exactly
 * one attempt and reports what it saw.
 */
test("makes exactly one request, whatever the response", async () => {
  for (const status of [200, 500, 422]) {
    let calls = 0;
    const fakeSafeFetch: SafeFetchFn = async () => {
      calls += 1;
      return fakeResult(status).result;
    };
    await attemptDelivery(buildEvent("payment_intent.settled", INTENT), TARGET, {
      safeFetch: fakeSafeFetch,
    });
    expect(calls).toBe(1);
  }
});

/**
 * The classification IS the retry policy — the outbox reschedules a `retry` and
 * closes a `refused`, so getting these the wrong way round either abandons a
 * recoverable endpoint or hammers one that will never accept the payload.
 */
test("classifies a 5xx as retryable and a 4xx as refused", async () => {
  const { result: serverError, wasDestroyed: serverDestroyed } = fakeResult(503);
  const retry = await attemptDelivery(buildEvent("payment_intent.settled", INTENT), TARGET, {
    safeFetch: async () => serverError,
  });
  expect(retry.kind).toBe("retry");
  expect(serverDestroyed()).toBe(true);

  const { result: rejected, wasDestroyed: rejectedDestroyed } = fakeResult(422);
  const refused = await attemptDelivery(buildEvent("payment_intent.failed", INTENT), TARGET, {
    safeFetch: async () => rejected,
  });
  expect(refused.kind).toBe("refused");
  expect(rejectedDestroyed()).toBe(true);
});

test("an SsrfRejection is refused, not retried", async () => {
  const outcome = await attemptDelivery(buildEvent("payment_intent.settled", INTENT), TARGET, {
    safeFetch: async () => {
      throw new SsrfRejection("blocked");
    },
  });

  expect(outcome.kind).toBe("refused");
});

/**
 * An unrecognised failure is RETRYABLE, and the direction is deliberate:
 * assuming an unknown defect is permanent is how a recoverable outage becomes
 * an abandoned event, and the attempt budget bounds the cost of being wrong
 * this way round.
 */
test("an unrecognised error is retryable", async () => {
  const outcome = await attemptDelivery(buildEvent("payment_intent.settled", INTENT), TARGET, {
    safeFetch: async () => {
      throw new Error("something nobody anticipated");
    },
  });

  expect(outcome.kind).toBe("retry");
});
