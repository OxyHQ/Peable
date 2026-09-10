/**
 * The settlement API — accounts and transfers — over HTTP, against a real
 * database and a fake provider.
 *
 * Two things are being defended here that a repository test cannot see: that a
 * merchant can never read or settle another merchant's rows, and that the
 * provider's own ids never reach the wire. The second is easy to break by
 * adding one convenient field, and impossible to take back once an integrator
 * depends on it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxy.so/core/server";

interface ProviderCall {
  readonly fn: string;
  readonly request: Record<string, unknown>;
}

const providerCalls: ProviderCall[] = [];
let accountCounter = 0;
let transferCounter = 0;
let accountSnapshotOverrides: Record<string, unknown> = {};
let createAccountThrows: Error | null = null;

const fakeProvider = {
  id: "stripe" as const,
  createAccount: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "createAccount", request });
    if (createAccountThrows) throw createAccountThrows;
    accountCounter += 1;
    return {
      providerAccountId: `acct_fake_${String(accountCounter)}`,
      payoutsEnabled: false,
      chargesEnabled: false,
      transfersCapability: "pending",
      cardPaymentsCapability: "pending",
      currentlyDue: ["business_profile.url"],
      eventuallyDue: [],
      pastDue: [],
      pendingVerification: [],
      ...accountSnapshotOverrides,
    };
  },
  getAccount: async (providerAccountId: string) => {
    providerCalls.push({ fn: "getAccount", request: { providerAccountId } });
    return {
      providerAccountId,
      payoutsEnabled: true,
      chargesEnabled: true,
      transfersCapability: "active",
      cardPaymentsCapability: "active",
      currentlyDue: [],
      eventuallyDue: [],
      pastDue: [],
      pendingVerification: [],
      defaultCurrency: "EUR",
      ...accountSnapshotOverrides,
    };
  },
  accountLink: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "accountLink", request });
    return { url: "https://connect.example/setup/x", expiresAt: new Date(Date.now() + 300_000) };
  },
  createTransfer: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "createTransfer", request });
    transferCounter += 1;
    return { providerObjectId: `tr_fake_${String(transferCounter)}`, status: "paid" };
  },
  reverseTransfer: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "reverseTransfer", request });
    return {
      providerObjectId: `trr_fake_${String(transferCounter)}`,
      totalReversed: String(request.amount ? (request.amount as { amount: string }).amount : "0"),
    };
  },
  createPayment: async () => {
    throw new Error("not used");
  },
  capture: async () => {
    throw new Error("not used");
  },
  cancel: async () => {
    throw new Error("not used");
  },
  refund: async () => {
    throw new Error("not used");
  },
  getStatus: async () => {
    throw new Error("not used");
  },
  verifyEvent: async () => {
    throw new Error("not used");
  },
};

/**
 * The registry, faked — and INERT outside this file's tests.
 *
 * `mock.module` is process-global in bun and bun's file order is not
 * alphabetical, so an unconditional mock here would reach every other suite.
 * Delegating to the real module unless this describe block is running is what
 * scopes it, in both orderings.
 */
const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  resetProviders: realResetProviders,
} = await import("../../services/providers/registry");
let useFake = false;

mock.module("../../services/providers/registry", () => ({
  resolveProvider: (id: "stripe") => (useFake ? fakeProvider : realResolveProvider(id)),
  resolveCardProvider: () => (useFake ? fakeProvider : realResolveCardProvider()),
  resetProviders: () => {
    realResetProviders();
  },
}));

const { createConnectedAccountsRouter } = await import("../connectedAccounts");
const { createTransfersRouter } = await import("../transfers");
const { insertPaymentIntent } = await import("../../db/payments/paymentIntentRepository");
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let otherMerchant: Merchant;
let settledIntentId = "";

let server: Server | undefined;
let baseUrl = "";
/** Which merchant the stubbed credential currently speaks for. */
let actingApp = "";

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("the settlement API", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    merchant = await seedMerchant();
    otherMerchant = await seedMerchant();
    actingApp = merchant.oxyAppId;

    const intent = await insertPaymentIntent(gatewayDb(), {
      publicId: "pi_settled_for_transfers",
      merchantId: merchant.id,
      rail: "card",
      amount: "100000",
      currency: "EUR",
      network: null,
      address: null,
      provider: "stripe",
      clientSecret: "cs_x",
      idempotencyKey: "idem_settled",
      metadata: {},
      expiresAt: new Date(Date.now() + 900_000),
    });
    if (!intent) throw new Error("could not seed the intent");
    settledIntentId = intent.id;
    // Straight to `settled` with a provider object, which is what a captured
    // card payment looks like and the only state a transfer may draw on.
    const { updateIntentState, linkProviderObject } = await import(
      "../../db/payments/paymentIntentRepository"
    );
    await linkProviderObject(gatewayDb(), intent.id, "stripe", "pi_stripe_settled");
    await updateIntentState(gatewayDb(), intent.id, { from: "created", status: "settled" });

    // The credential stub: whichever merchant `actingApp` names. Both routers
    // resolve the merchant through it, so switching it is how the
    // cross-merchant cases are written.
    const stubMerchantAuth: RequestHandler = (req, _res, next) => {
      (req as OxyAuthRequest).serviceApp = {
        appId: actingApp,
        appName: "t",
        scopes: ["payments:read", "payments:write"],
        credentialId: "c",
        ownerAccountId: "acct_settlement",
        environment: "development",
      };
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createConnectedAccountsRouter({ requireMerchant: stubMerchantAuth }));
    app.use(createTransfersRouter({ requireMerchant: stubMerchantAuth }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    accountSnapshotOverrides = {};
    createAccountThrows = null;
    actingApp = merchant.oxyAppId;
  });

  afterAll(async () => {
    useFake = false;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => {
        resolve();
      });
    });
  });

  // ── accounts ─────────────────────────────────────────────────────────────

  test("opens an account for a seller and returns 201", async () => {
    const { status, json } = await call("POST", "/v1/connected_accounts", {
      externalRef: "store_1",
      country: "es",
      businessType: "individual",
    });

    expect(status).toBe(201);
    expect(json.object).toBe("connected_account");
    expect(json.externalRef).toBe("store_1");
    // Upper-cased on the way in, which is the form the CHECK insists on.
    expect(json.country).toBe("ES");
    expect(json.payable).toBe(false);
    expect((json.requirements as Record<string, number>).currentlyDue).toBe(1);
  });

  /**
   * THE rule this whole DTO file exists for (ADR 0001 D3). A merchant
   * integrates against Peable and never learns which acquirer sat behind their
   * seller — because the day that changes should be a Peable deploy and not a
   * merchant migration.
   */
  test("never puts the provider's account id or name on the wire", async () => {
    const created = await call("POST", "/v1/connected_accounts", {
      externalRef: "store_secret",
      country: "ES",
      businessType: "company",
    });
    const listed = await call("GET", "/v1/connected_accounts");
    const fetched = await call("GET", "/v1/connected_accounts/by_ref/store_secret");

    for (const payload of [created.json, listed.json, fetched.json]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain("acct_fake");
      expect(text).not.toContain("providerAccountId");
      expect(text).not.toContain("stripe");
    }
  });

  /**
   * An account at a provider CANNOT BE DELETED. Opening a second for one seller
   * leaves them with one nobody uses, generating requirement emails forever —
   * so a repeated create converges and says so with a 200.
   */
  test("a repeated create converges on the same account and answers 200", async () => {
    const first = await call("POST", "/v1/connected_accounts", {
      externalRef: "store_repeat",
      country: "ES",
      businessType: "individual",
    });
    providerCalls.length = 0;
    const second = await call("POST", "/v1/connected_accounts", {
      externalRef: "store_repeat",
      country: "ES",
      businessType: "individual",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);
    // ...and, decisively, no second account was opened at the provider.
    expect(providerCalls.filter((entry) => entry.fn === "createAccount")).toHaveLength(0);
  });

  /**
   * The provider idempotency key is derived from the merchant and their own
   * seller id — never random. A random key would open a second real account on
   * every retry of a create whose response was lost.
   */
  test("derives the provider idempotency key from the merchant and the seller ref", async () => {
    await call("POST", "/v1/connected_accounts", {
      externalRef: "store_key",
      country: "ES",
      businessType: "individual",
    });
    const call0 = providerCalls.find((entry) => entry.fn === "createAccount");
    expect(call0?.request.idempotencyKey).toBe(`acct:${merchant.id}:store_key`);
  });

  test("refreshing an account stores what the provider now says", async () => {
    const created = await call("POST", "/v1/connected_accounts", {
      externalRef: "store_refresh",
      country: "ES",
      businessType: "individual",
    });
    const refreshed = await call(
      "POST",
      `/v1/connected_accounts/${String(created.json.id)}/refresh`,
    );

    expect(refreshed.status).toBe(200);
    expect(refreshed.json.payable).toBe(true);
    expect((refreshed.json.requirements as Record<string, number>).currentlyDue).toBe(0);
    expect(refreshed.json.defaultCurrency).toBe("EUR");
  });

  test("mints a short-lived onboarding link and never stores it", async () => {
    const created = await call("POST", "/v1/connected_accounts", {
      externalRef: "store_link",
      country: "ES",
      businessType: "individual",
    });
    const link = await call(
      "POST",
      `/v1/connected_accounts/${String(created.json.id)}/account_links`,
      { refreshUrl: "https://shop.example/refresh", returnUrl: "https://shop.example/done" },
    );

    expect(link.status).toBe(201);
    expect(String(link.json.url)).toContain("connect.example");
    // Not on the account itself, on any read.
    const fetched = await call("GET", `/v1/connected_accounts/${String(created.json.id)}`);
    expect(JSON.stringify(fetched.json)).not.toContain("connect.example");
  });

  /** One merchant must never read another's seller. */
  test("does not return another merchant's account", async () => {
    const created = await call("POST", "/v1/connected_accounts", {
      externalRef: "store_private",
      country: "ES",
      businessType: "individual",
    });

    actingApp = otherMerchant.oxyAppId;
    const asOther = await call("GET", `/v1/connected_accounts/${String(created.json.id)}`);
    const byRef = await call("GET", "/v1/connected_accounts/by_ref/store_private");
    const listed = await call("GET", "/v1/connected_accounts");

    expect(asOther.status).toBe(404);
    expect(byRef.status).toBe(404);
    expect((listed.json.data as unknown[]).length).toBe(0);
  });

  // ── transfers ────────────────────────────────────────────────────────────

  async function payableAccount(ref: string): Promise<string> {
    const created = await call("POST", "/v1/connected_accounts", {
      externalRef: ref,
      country: "ES",
      businessType: "individual",
    });
    await call("POST", `/v1/connected_accounts/${String(created.json.id)}/refresh`);
    return String(created.json.id);
  }

  test("settles a seller and reports the public ids only", async () => {
    const accountId = await payableAccount("store_t_a");
    const { status, json } = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_1",
      amount: "5000",
    });

    expect(status).toBe(201);
    expect(json.object).toBe("transfer");
    expect(json.connectedAccountId).toBe(accountId);
    expect(json.paymentIntentId).toBe("pi_settled_for_transfers");
    expect(json.status).toBe("paid");
    const text = JSON.stringify(json);
    expect(text).not.toContain("acct_fake");
    expect(text).not.toContain("tr_fake");
    expect(text).not.toContain(settledIntentId);
  });

  /**
   * `source_transaction` is what makes the transfer WAIT for the charge's
   * funds. Without it a transfer created moments after a charge fails against a
   * platform balance that is real but not yet available — intermittently,
   * which reads as a provider outage.
   */
  test("names the source charge and the payment's own transfer group", async () => {
    const accountId = await payableAccount("store_t_b");
    await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_group",
      amount: "5000",
    });

    const created = providerCalls.find((entry) => entry.fn === "createTransfer");
    expect(created?.request.sourcePaymentObjectId).toBe("pi_stripe_settled");
    expect(created?.request.groupRef).toBe("pi_settled_for_transfers");
    expect(created?.request.idempotencyKey).toBe(`tr:${String(created?.request.transferId)}`);
  });

  /**
   * A merchant retrying after a timeout needs to know whether they just paid a
   * seller twice. They did not, and the 200 says so.
   */
  test("a repeated settlement of one order converges and does not pay twice", async () => {
    const accountId = await payableAccount("store_t_c");
    const first = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_dup",
      amount: "5000",
    });
    providerCalls.length = 0;
    const second = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_dup",
      amount: "5000",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);
    expect(providerCalls.filter((entry) => entry.fn === "createTransfer")).toHaveLength(0);
  });

  /**
   * The retry of a settled order must answer from HISTORY. Checking the
   * seller's readiness first would turn a successful settlement into a 422 on
   * its own retry, because an account can be restricted after being paid.
   */
  test("answers a retry even after the seller stops being payable", async () => {
    const accountId = await payableAccount("store_t_restricted");
    const first = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_restricted",
      amount: "5000",
    });
    expect(first.status).toBe(201);

    // The provider restricts the seller.
    accountSnapshotOverrides = {
      payoutsEnabled: false,
      transfersCapability: "inactive",
      pastDue: ["individual.verification.document"],
    };
    await call("POST", `/v1/connected_accounts/${accountId}/refresh`);

    const retry = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_restricted",
      amount: "5000",
    });
    expect(retry.status).toBe(200);
    expect(retry.json.id).toBe(first.json.id);
  });

  test("refuses to settle to a seller who cannot receive one", async () => {
    // Created and never refreshed, so `transfers` is still `pending`.
    const created = await call("POST", "/v1/connected_accounts", {
      externalRef: "store_t_unready",
      country: "ES",
      businessType: "individual",
    });
    const { status, json } = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: String(created.json.id),
      externalRef: "order_unready",
      amount: "5000",
    });

    expect(status).toBe(422);
    expect(String((json.error as Record<string, string>).message)).toContain("cannot receive");
  });

  test("names the seller by the merchant's own ref as well as by ca_…", async () => {
    await payableAccount("store_t_byref");
    const { status, json } = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountRef: "store_t_byref",
      externalRef: "order_byref",
      amount: "1000",
    });
    expect(status).toBe(201);
    expect(json.externalRef).toBe("order_byref");
  });

  test("refuses a body naming the seller twice or not at all", async () => {
    const both = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: "ca_x",
      connectedAccountRef: "store_x",
      externalRef: "order_both",
      amount: "1000",
    });
    const neither = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      externalRef: "order_neither",
      amount: "1000",
    });
    expect(both.status).toBe(422);
    expect(neither.status).toBe(422);
  });

  /**
   * A float amount is refused by the SAME predicate the database CHECK is
   * rendered from — the reason amounts are strings on this contract at all.
   */
  test("refuses an amount that is not a canonical base-unit integer", async () => {
    const accountId = await payableAccount("store_t_amount");
    for (const amount of ["10.50", "-1", "01", "1e3", ""]) {
      const { status } = await call("POST", "/v1/transfers", {
        paymentIntentId: "pi_settled_for_transfers",
        connectedAccountId: accountId,
        externalRef: `order_amount_${amount || "empty"}`,
        amount,
      });
      expect([amount, status]).toEqual([amount, 422]);
    }
  });

  test("reverses a settlement and reports the cumulative total", async () => {
    const accountId = await payableAccount("store_t_rev");
    const created = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_rev",
      amount: "5000",
    });

    const reversed = await call(
      "POST",
      `/v1/transfers/${String(created.json.id)}/reversals`,
      { amount: "2000" },
    );
    expect(reversed.status).toBe(201);
    expect(reversed.json.amountReversed).toBe("2000");
    expect(reversed.json.status).toBe("partially_reversed");

    /**
     * The idempotency key names the LEG, not just the transfer. Two partial
     * reversals of one transfer are two operations, and a key naming only the
     * transfer would make the second a replay of the first — silently returning
     * the first reversal and leaving the money unreturned.
     */
    const key = providerCalls.find((entry) => entry.fn === "reverseTransfer")?.request
      .idempotencyKey;
    expect(String(key)).toBe(`trr:${String(created.json.id)}:2000`);
  });

  test("refuses a reversal larger than the transfer", async () => {
    const accountId = await payableAccount("store_t_over");
    const created = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_over",
      amount: "5000",
    });
    const { status } = await call(
      "POST",
      `/v1/transfers/${String(created.json.id)}/reversals`,
      { amount: "5001" },
    );
    expect(status).toBe(422);
  });

  test("does not settle, read or reverse across merchants", async () => {
    const accountId = await payableAccount("store_t_cross");
    const created = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_cross",
      amount: "1000",
    });

    actingApp = otherMerchant.oxyAppId;
    // The other merchant cannot see the payment at all, so it is a 404 rather
    // than a 403: distinguishing them would tell them the `pi_…` is real.
    const settle = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountRef: "store_t_cross",
      externalRef: "order_cross_2",
      amount: "1000",
    });
    const reverse = await call(
      "POST",
      `/v1/transfers/${String(created.json.id)}/reversals`,
      { amount: "100" },
    );
    const list = await call("GET", "/v1/payment_intents/pi_settled_for_transfers/transfers");

    expect(settle.status).toBe(404);
    expect(reverse.status).toBe(404);
    expect(list.status).toBe(404);
  });

  test("lists what one payment settled", async () => {
    const accountId = await payableAccount("store_t_list");
    await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_list_1",
      amount: "1000",
    });

    const { status, json } = await call(
      "GET",
      "/v1/payment_intents/pi_settled_for_transfers/transfers",
    );
    expect(status).toBe(200);
    const refs = (json.data as { externalRef: string }[]).map((row) => row.externalRef);
    expect(refs).toContain("order_list_1");
    expect(JSON.stringify(json)).not.toContain("acct_fake");
  });
});
