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
/** What the authoritative payment read reports. `succeeded` is the normal case. */
let getStatusStatus = "succeeded";
let getStatusThrows: Error | null = null;
/**
 * A transient provider failure on the settlement call.
 *
 * RETRYABLE, which is what leaves the row `pending` and unlinked — a permanent
 * refusal is recorded as `failed` and is terminal. The pending, unlinked row is
 * the state the resume case needs.
 */
let createTransferThrows: Error | null = null;
let reversalCounter = 0;
/** The provider's own cumulative `amount_reversed`, per transfer object. */
const reversedByTransfer = new Map<string, bigint>();

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
    if (createTransferThrows) throw createTransferThrows;
    transferCounter += 1;
    return { providerObjectId: `tr_fake_${String(transferCounter)}`, status: "paid" };
  },
  /**
   * ACCUMULATES, because a real provider does.
   *
   * This fake used to answer `totalReversed: <this leg's amount>`, which is
   * precisely the bug the adapter had — so the suite agreed with the defect and
   * could not see it. Two 500 reversals both reported 500, the stored total
   * never moved past 500, and the seller kept half of what had been taken back.
   */
  reverseTransfer: async (request: Record<string, unknown>) => {
    providerCalls.push({ fn: "reverseTransfer", request });
    const transferObjectId = String(request.transferObjectId);
    const leg = BigInt((request.amount as { amount: string }).amount);
    const total = (reversedByTransfer.get(transferObjectId) ?? 0n) + leg;
    reversedByTransfer.set(transferObjectId, total);
    reversalCounter += 1;
    return {
      providerObjectId: `trr_fake_${String(reversalCounter)}`,
      totalReversed: total.toString(),
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
  /**
   * The AUTHORITATIVE read a settlement makes before it moves anything.
   *
   * `transferService` resolves the CHARGE here — `source_transaction` names a
   * `ch_…` and the caller used to hand it the payment's `pi_…`, which Stripe
   * refuses with `No such charge`. A fake that answered only a status would let
   * that bug back in, so it answers both ids, distinctly.
   */
  getStatus: async (providerObjectId: string) => {
    providerCalls.push({ fn: "getStatus", request: { providerObjectId } });
    if (getStatusThrows) throw getStatusThrows;
    return {
      providerObjectId,
      status: getStatusStatus,
      ...(getStatusStatus === "succeeded"
        ? { chargeObjectId: providerObjectId.replace(/^pi_/, "ch_") }
        : {}),
    };
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

const { ProviderError } = await import("../../services/providers/provider");
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
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
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
    getStatusStatus = "succeeded";
    getStatusThrows = null;
    createTransferThrows = null;
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

  /**
   * A fresh SETTLED card payment, with its own `pi_…`.
   *
   * The file's shared `pi_settled_for_transfers` cannot serve the cases below:
   * the charge is cached on the intent after the first settlement, and the
   * budget is a property of one payment, so two cases sharing a payment would
   * each be reading state the other left. Each one mints its own.
   */
  async function settledCardIntent(publicId: string, amount: string): Promise<void> {
    const { updateIntentState, linkProviderObject } = await import(
      "../../db/payments/paymentIntentRepository"
    );
    const intent = await insertPaymentIntent(gatewayDb(), {
      publicId,
      merchantId: merchant.id,
      rail: "card",
      amount,
      currency: "EUR",
      network: null,
      address: null,
      provider: "stripe",
      clientSecret: `cs_${publicId}`,
      idempotencyKey: `idem_${publicId}`,
      metadata: {},
      expiresAt: new Date(Date.now() + 900_000),
    });
    if (!intent) throw new Error(`could not seed ${publicId}`);
    await linkProviderObject(gatewayDb(), intent.id, "stripe", `pi_stripe_${publicId}`);
    await updateIntentState(gatewayDb(), intent.id, { from: "created", status: "settled" });
  }

  async function payableAccount(ref: string): Promise<string> {
    const created = await call("POST", "/v1/connected_accounts", {
      externalRef: ref,
      country: "ES",
      businessType: "individual",
    });
    await call("POST", `/v1/connected_accounts/${String(created.json.id)}/refresh`);
    return String(created.json.id);
  }

  /**
   * The seller list PAGINATES.
   *
   * It used to take a hard `limit` of 100 with no cursor and no `has_more`, so
   * a marketplace with more sellers than that could not reach the rest and
   * nothing in the response said so. A silently truncated list is worse than a
   * refusal: a caller reconciling against it concludes the sellers are gone.
   */
  test("pages through sellers with a cursor and says when there are more", async () => {
    for (const ref of ["page_a", "page_b", "page_c"]) {
      await call("POST", "/v1/connected_accounts", {
        externalRef: ref,
        country: "ES",
        businessType: "individual",
      });
    }

    const first = await call("GET", "/v1/connected_accounts?limit=2");
    expect(first.status).toBe(200);
    const firstPage = first.json.data as { id: string }[];
    expect(firstPage).toHaveLength(2);
    expect(first.json.has_more).toBe(true);

    const second = await call(
      "GET",
      `/v1/connected_accounts?limit=2&starting_after=${firstPage[1]?.id ?? ""}`,
    );
    const secondPage = second.json.data as { id: string }[];
    // No overlap: the cursor walks the primary key, which is unique where a
    // timestamp is not.
    expect(secondPage.map((row) => row.id)).not.toContain(firstPage[0]?.id);
    expect(secondPage.map((row) => row.id)).not.toContain(firstPage[1]?.id);
  });

  /**
   * A cursor naming ANOTHER merchant's seller is refused exactly like an
   * unknown one, and never confirms that the account exists.
   */
  test("refuses a cursor from another merchant without confirming it", async () => {
    const mine = await call("POST", "/v1/connected_accounts", {
      externalRef: "cursor_owner",
      country: "ES",
      businessType: "individual",
    });

    actingApp = otherMerchant.oxyAppId;
    const foreign = await call(
      "GET",
      `/v1/connected_accounts?starting_after=${String(mine.json.id)}`,
    );
    const unknown = await call("GET", "/v1/connected_accounts?starting_after=ca_nope");

    expect(foreign.status).toBe(422);
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(foreign.json)).toEqual(JSON.stringify(unknown.json));
  });

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
   *
   * It takes a CHARGE id and this used to be handed the PAYMENT's. Stripe
   * answers `No such charge: 'pi_…'`, so every settlement failed at the
   * provider, which reads as an outage rather than as two ids being confused.
   * The assertion is now on `ch_…` AND on it not being the `pi_…`: asserting
   * only that some id was passed is what let the original bug look correct.
   */
  test("names the source CHARGE, not the payment, and the payment's own group", async () => {
    const accountId = await payableAccount("store_t_b");
    await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_group",
      amount: "5000",
    });

    const created = providerCalls.find((entry) => entry.fn === "createTransfer");
    expect(created?.request.sourceChargeObjectId).toBe("ch_stripe_settled");
    expect(created?.request.sourceChargeObjectId).not.toBe("pi_stripe_settled");
    expect(created?.request.groupRef).toBe("pi_settled_for_transfers");
    expect(created?.request.idempotencyKey).toBe(`tr:${String(created?.request.transferId)}`);
  });

  /**
   * The charge is resolved ONCE per payment, not once per seller.
   *
   * A multi-seller cart settles N times out of one payment. Re-reading the
   * payment per seller is N provider round trips for one fact that cannot
   * change, and `payment_intents.provider_charge_id` exists to hold it.
   */
  test("resolves the charge once and reuses it for the next seller", async () => {
    await settledCardIntent("pi_cart_two_sellers", "100000");
    const first = await payableAccount("store_charge_a");
    const second = await payableAccount("store_charge_b");
    providerCalls.length = 0;

    await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_cart_two_sellers",
      connectedAccountId: first,
      externalRef: "order_charge_1",
      amount: "1000",
    });
    const readsAfterFirst = providerCalls.filter((entry) => entry.fn === "getStatus").length;

    await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_cart_two_sellers",
      connectedAccountId: second,
      externalRef: "order_charge_2",
      amount: "1000",
    });
    const readsAfterSecond = providerCalls.filter((entry) => entry.fn === "getStatus").length;

    expect(readsAfterFirst).toBe(1);
    expect(readsAfterSecond).toBe(1);
    // ...and the second settlement still names the charge.
    const transfers = providerCalls.filter((entry) => entry.fn === "createTransfer");
    expect(transfers).toHaveLength(2);
    expect(transfers[1]?.request.sourceChargeObjectId).toBe("ch_stripe_pi_cart_two_sellers");
  });

  /**
   * The settlement budget: a payment cannot fund more than it brought in.
   *
   * Nothing used to bound how much one payment could settle. The overflow comes
   * out of the platform's GENERAL balance, which is other merchants' money in
   * flight — so an arithmetic slip in one marketplace's split is paid for by
   * everybody else's payments, and the only signal is a balance that drifts.
   */
  test("refuses to settle more than the payment brought in", async () => {
    await settledCardIntent("pi_budget", "10000");
    const seller = await payableAccount("store_budget_a");
    const other = await payableAccount("store_budget_b");

    const first = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_budget",
      connectedAccountId: seller,
      externalRef: "budget_1",
      amount: "9000",
    });
    expect(first.status).toBe(201);

    const second = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_budget",
      connectedAccountId: other,
      externalRef: "budget_2",
      amount: "2000",
    });
    expect(second.status).toBe(422);
    // The message says how much is LEFT, because that is the number the
    // merchant has to correct their split against.
    expect(String((second.json.error as Record<string, string>).message)).toContain("1000");

    // ...and the remaining 1000 still settles.
    const third = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_budget",
      connectedAccountId: other,
      externalRef: "budget_3",
      amount: "1000",
    });
    expect(third.status).toBe(201);
  });

  /**
   * An interrupted settlement is FINISHED by the retry.
   *
   * The row is written before the provider call so a crash between them leaves
   * something recovery can finish. Nothing finished it: the retry found the
   * pending row and answered 200, describing a seller who had not been paid,
   * and no path would ever pay them.
   */
  test("finishes an interrupted settlement on the retry", async () => {
    await settledCardIntent("pi_resume", "50000");
    const seller = await payableAccount("store_resume");
    createTransferThrows = new ProviderError({
      provider: "stripe",
      stage: "transfer",
      message: "the acquirer timed out",
      retryable: true,
    });

    const first = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_resume",
      connectedAccountId: seller,
      externalRef: "order_resume",
      amount: "1000",
    });
    // A retryable provider failure surfaces as a 502 and leaves the row pending.
    expect(first.status).toBe(502);

    createTransferThrows = null;
    providerCalls.length = 0;
    const retry = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_resume",
      connectedAccountId: seller,
      externalRef: "order_resume",
      amount: "1000",
    });

    expect(retry.status).toBe(201);
    expect(retry.json.status).toBe("paid");
    // The provider WAS called this time — the retry completed the settlement
    // rather than describing it.
    expect(providerCalls.filter((entry) => entry.fn === "createTransfer")).toHaveLength(1);

    // ...and only ONE settlement exists for the order.
    const listed = await call("GET", "/v1/payment_intents/pi_resume/transfers");
    expect((listed.json.data as unknown[]).length).toBe(1);
  });

  /**
   * A settled order stays answerable when the provider is unreachable.
   *
   * "A retry of an order that already settled is a question about history" is
   * only true if history can still be read — so the existing-row check runs
   * BEFORE the charge is resolved, which is the only provider call on this
   * path.
   */
  test("answers a completed settlement from history during a provider outage", async () => {
    await settledCardIntent("pi_history", "50000");
    const seller = await payableAccount("store_history");
    const first = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_history",
      connectedAccountId: seller,
      externalRef: "order_history",
      amount: "1000",
    });
    expect(first.status).toBe(201);

    getStatusThrows = new Error("the acquirer could not be reached");
    createTransferThrows = new Error("the acquirer could not be reached");

    const replay = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_history",
      connectedAccountId: seller,
      externalRef: "order_history",
      amount: "1000",
    });

    expect(replay.status).toBe(200);
    expect(replay.json.id).toBe(first.json.id);
  });

  /**
   * A settlement reference naming a DIFFERENT operation is a conflict.
   *
   * `external_ref` is the merchant's own id for what a transfer settles and the
   * key this table converges on. A second request reusing it with another
   * payment or amount is not a replay, and answering 200 with the stored row
   * tells the caller their new settlement succeeded when nothing happened —
   * which is how a seller silently does not get paid.
   */
  test("refuses a settlement reference reused for another amount", async () => {
    await settledCardIntent("pi_conflict", "50000");
    const seller = await payableAccount("store_conflict");

    const first = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_conflict",
      connectedAccountId: seller,
      externalRef: "conflict_ref",
      amount: "1000",
    });
    expect(first.status).toBe(201);

    const reused = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_conflict",
      connectedAccountId: seller,
      externalRef: "conflict_ref",
      amount: "2000",
    });
    expect(reused.status).toBe(409);

    // The same reference with the SAME content is still an ordinary replay.
    const replay = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_conflict",
      connectedAccountId: seller,
      externalRef: "conflict_ref",
      amount: "1000",
    });
    expect(replay.status).toBe(200);
    expect(replay.json.id).toBe(first.json.id);
  });

  /**
   * A payment the PROVIDER does not report as captured funds no transfer.
   *
   * The gateway's own `settled` status can be right while the money is not
   * there — an out-of-order event, a repaired row — and a transfer with no
   * `source_transaction` behind it draws on the platform's GENERAL balance,
   * which is other merchants' money in flight. 409, because the two sides
   * disagree about a fact rather than the request being malformed.
   */
  test("refuses to settle when the provider reports no captured charge", async () => {
    await settledCardIntent("pi_no_charge", "100000");
    const accountId = await payableAccount("store_no_charge");
    getStatusStatus = "processing";

    const { status } = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_no_charge",
      connectedAccountId: accountId,
      externalRef: "order_no_charge",
      amount: "1000",
    });

    expect(status).toBe(409);
    // Nothing was created, at the provider or here.
    expect(providerCalls.filter((entry) => entry.fn === "createTransfer")).toHaveLength(0);
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
      { "Idempotency-Key": "rev_op_1" },
    );
    expect(reversed.status).toBe(201);
    expect(reversed.json.amountReversed).toBe("2000");
    expect(reversed.json.status).toBe("partially_reversed");

    /**
     * The idempotency key names the REVERSAL's own durable id — not the
     * transfer, and not the amount.
     *
     * It used to be `trr:<transfer>:<amount>`, with a comment arguing that
     * putting the LEG in the key was what kept two partial reversals distinct.
     * It does not: two distinct reversals of the same amount are ordinary, and
     * they presented one key, so the provider answered the first one's object
     * to the second request.
     */
    const key = providerCalls.find((entry) => entry.fn === "reverseTransfer")?.request
      .idempotencyKey;
    const reversal = reversed.json.reversal as Record<string, string>;
    expect(String(key)).toBe(`trr:${reversal.id ?? ""}`);
    expect(reversal.externalRef).toBe("rev_op_1");
    expect(reversal.status).toBe("succeeded");
  });

  /**
   * THE case this whole table exists for, and the acceptance criterion issue
   * #70 §6 states verbatim: reversal A of 500 and reversal B of 500 return
   * 1000; repeating A adds nothing; a third of 300 makes 1300.
   *
   * Under the old key (`trr:<transfer>:<amount>`) B presented A's key, the
   * provider returned A's object, the stored total stayed at 500 and the seller
   * kept the other 500. Nothing recorded that B had been asked for.
   */
  test("two distinct reversals of the same amount both happen; a replay does not", async () => {
    await settledCardIntent("pi_two_reversals", "100000");
    const accountId = await payableAccount("store_two_rev");
    const created = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_two_reversals",
      connectedAccountId: accountId,
      externalRef: "order_two_rev",
      amount: "2000",
    });
    const transferId = String(created.json.id);
    const reversalPath = `/v1/transfers/${transferId}/reversals`;

    const a = await call("POST", reversalPath, { amount: "500" }, { "Idempotency-Key": "leg_a" });
    expect(a.status).toBe(201);
    expect(a.json.amountReversed).toBe("500");

    const b = await call("POST", reversalPath, { amount: "500" }, { "Idempotency-Key": "leg_b" });
    expect(b.status).toBe(201);
    expect(b.json.amountReversed).toBe("1000");

    // Repeating A adds nothing, at the provider or here. 200, not 201.
    const replay = await call(
      "POST",
      reversalPath,
      { amount: "500" },
      { "Idempotency-Key": "leg_a" },
    );
    expect(replay.status).toBe(200);
    expect((replay.json.reversal as Record<string, string>).id).toBe(
      (a.json.reversal as Record<string, string>).id,
    );

    const c = await call("POST", reversalPath, { amount: "300" }, { "Idempotency-Key": "leg_c" });
    expect(c.json.amountReversed).toBe("1300");

    // Three operations reached the provider, not four: the replay never did.
    const calls = providerCalls.filter(
      (entry) =>
        entry.fn === "reverseTransfer" && String(entry.request.transferId) === transferId,
    );
    expect(calls).toHaveLength(3);
    // ...and each carried its own key.
    expect(new Set(calls.map((entry) => String(entry.request.idempotencyKey))).size).toBe(3);
  });

  /**
   * A reversal with no operation identity is refused rather than given one.
   *
   * Inventing a key here would make every retry a second reversal, which is the
   * failure the table exists to prevent — so the refusal names what is missing.
   */
  test("refuses a reversal that carries no operation identity", async () => {
    const accountId = await payableAccount("store_no_key");
    const created = await call("POST", "/v1/transfers", {
      paymentIntentId: "pi_settled_for_transfers",
      connectedAccountId: accountId,
      externalRef: "order_no_key",
      amount: "1000",
    });

    const { status, json } = await call(
      "POST",
      `/v1/transfers/${String(created.json.id)}/reversals`,
      { amount: "500" },
    );
    expect(status).toBe(400);
    expect(String((json.error as Record<string, string>).message)).toContain("Idempotency-Key");
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
      { "Idempotency-Key": "rev_over" },
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
