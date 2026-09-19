/**
 * The Stripe adapter, against a FAKE Stripe client.
 *
 * Fake rather than mocked-per-test: every call goes through `client.ts`, and
 * `mock.module` replaces it for the whole file, so the adapter runs unchanged
 * and the assertions are about what it ASKED Stripe for. That is the half a
 * sandbox cannot check cheaply and the half that is expensive to get wrong —
 * an idempotency key in the wrong argument position, a missing
 * `source_transaction`, an amount that does not survive the round trip.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

interface Recorded {
  readonly fn: string;
  readonly args: readonly unknown[];
}

const calls: Recorded[] = [];
let paymentIntentResponse: Record<string, unknown> = {};
let refundResponse: Record<string, unknown> = {};
let transferResponse: Record<string, unknown> = {};
let accountResponse: Record<string, unknown> = {};

function record(fn: string, args: readonly unknown[]) {
  calls.push({ fn, args });
}

mock.module("../client", () => ({
  STRIPE_API_VERSION: "2026-07-29.dahlia",
  getStripeClient: () => {
    throw new Error("the adapter must not reach the SDK directly");
  },
  resetStripeClient: () => undefined,
  toProviderError: (error: unknown) => error,
  createStripePaymentIntent: async (...args: unknown[]) => {
    record("createStripePaymentIntent", args);
    return paymentIntentResponse;
  },
  retrieveStripePaymentIntent: async (...args: unknown[]) => {
    record("retrieveStripePaymentIntent", args);
    return paymentIntentResponse;
  },
  cancelStripePaymentIntent: async (...args: unknown[]) => {
    record("cancelStripePaymentIntent", args);
    return paymentIntentResponse;
  },
  captureStripePaymentIntent: async (...args: unknown[]) => {
    record("captureStripePaymentIntent", args);
    return paymentIntentResponse;
  },
  createStripeRefund: async (...args: unknown[]) => {
    record("createStripeRefund", args);
    return refundResponse;
  },
  retrieveStripeRefund: async (...args: unknown[]) => {
    record("retrieveStripeRefund", args);
    return refundResponse;
  },
  createStripeTransfer: async (...args: unknown[]) => {
    record("createStripeTransfer", args);
    return transferResponse;
  },
  createStripeTransferReversal: async (...args: unknown[]) => {
    record("createStripeTransferReversal", args);
    return transferResponse;
  },
  retrieveStripeTransfer: async (...args: unknown[]) => {
    record("retrieveStripeTransfer", args);
    return transferResponse;
  },
  createStripeConnectedAccountV2: async (...args: unknown[]) => {
    record("createStripeConnectedAccountV2", args);
    return { id: "acct_new" };
  },
  retrieveStripeAccount: async (...args: unknown[]) => {
    record("retrieveStripeAccount", args);
    return accountResponse;
  },
  createStripeAccountLink: async (...args: unknown[]) => {
    record("createStripeAccountLink", args);
    return { url: "https://connect.stripe.com/setup/e/x", expires_at: 1_700_000_300 };
  },
  constructStripeEvent: async () => ({
    id: "evt_1",
    type: "payment_intent.succeeded",
    livemode: false,
    api_version: "2026-07-29.dahlia",
    data: { object: { id: "pi_1", object: "payment_intent" } },
  }),
}));

const { StripePaymentProvider } = await import("../stripeProvider");
const { ProviderError } = await import("../../provider");

function argsOf(fn: string): readonly unknown[] {
  const call = calls.find((entry) => entry.fn === fn);
  if (!call) throw new Error(`${fn} was never called`);
  return call.args;
}

describe("StripePaymentProvider", () => {
  beforeEach(() => {
    calls.length = 0;
    paymentIntentResponse = {
      id: "pi_1",
      status: "requires_payment_method",
      client_secret: "pi_1_secret_x",
    };
    refundResponse = { id: "re_1", status: "succeeded" };
    transferResponse = { id: "tr_1", reversed: false, amount: 500 };
    accountResponse = {
      id: "acct_1",
      payouts_enabled: false,
      capabilities: { transfers: "pending" },
      requirements: { currently_due: ["business_profile.url"], past_due: [] },
      default_currency: "eur",
    };
  });

  test("creates a payment with the gateway's intent id in metadata and transfer_group", async () => {
    const provider = new StripePaymentProvider();
    const result = await provider.createPayment({
      intentId: "pi_public_1",
      amount: { amount: "2500", currency: "EUR" },
      idempotencyKey: "pay:pi_public_1",
      metadata: { order: "A-1" },
    });

    const [params, idempotencyKey] = argsOf("createStripePaymentIntent") as [
      Record<string, unknown>,
      string,
    ];
    expect(params.amount).toBe(2500);
    // Lowercase: Stripe's ISO code, not the gateway's uppercase set.
    expect(params.currency).toBe("eur");
    expect(params.transfer_group).toBe("pi_public_1");
    expect(params.metadata).toMatchObject({ order: "A-1", peable_intent_id: "pi_public_1" });
    expect(idempotencyKey).toBe("pay:pi_public_1");

    expect(result.providerObjectId).toBe("pi_1");
    expect(result.status).toBe("created");
    expect(result.clientAction).toEqual({ kind: "client_secret", value: "pi_1_secret_x" });
  });

  /**
   * The amount guard.
   *
   * Stripe counts in a JS `number`; the gateway carries an unbounded integer
   * string. Above `Number.MAX_SAFE_INTEGER` the conversion silently rounds —
   * a real charge for an amount nobody authorised. Refusing is the only safe
   * direction, and it is refused as PERMANENT because no retry makes the
   * number representable.
   */
  test("refuses an amount that cannot survive the conversion to a Stripe amount", async () => {
    const provider = new StripePaymentProvider();
    const attempt = provider.createPayment({
      intentId: "pi_public_2",
      amount: { amount: "9007199254740993", currency: "EUR" },
      idempotencyKey: "pay:pi_public_2",
      metadata: {},
    });

    await expect(attempt).rejects.toThrow(ProviderError);
    await expect(attempt).rejects.toMatchObject({ retryable: false });
    expect(calls.find((entry) => entry.fn === "createStripePaymentIntent")).toBeUndefined();
  });

  /**
   * Capture on a rail that already captured.
   *
   * `paymentIntents.capture` on an already-captured intent is an ERROR, not a
   * no-op — so "call it anyway for symmetry" turns a settled payment into a
   * failure. Reading it back is the honest action.
   */
  test("capture reads back rather than re-capturing an already captured payment", async () => {
    paymentIntentResponse = { id: "pi_1", status: "succeeded", client_secret: "s" };
    const provider = new StripePaymentProvider();

    const result = await provider.capture({
      intentId: "pi_public_1",
      providerObjectId: "pi_1",
      idempotencyKey: "cap:pi_public_1",
    });

    expect(result.status).toBe("succeeded");
    expect(calls.find((entry) => entry.fn === "captureStripePaymentIntent")).toBeUndefined();
  });

  test("capture does capture when the payment is genuinely awaiting it", async () => {
    paymentIntentResponse = { id: "pi_1", status: "requires_capture", client_secret: "s" };
    const provider = new StripePaymentProvider();

    await provider.capture({
      intentId: "pi_public_1",
      providerObjectId: "pi_1",
      idempotencyKey: "cap:pi_public_1",
    });

    expect(argsOf("captureStripePaymentIntent")).toEqual(["pi_1", "cap:pi_public_1"]);
  });

  /**
   * `source_transaction` is what makes the transfer WAIT for the charge's
   * funds. Without it a transfer created moments after a charge fails with
   * `balance_insufficient` against a platform whose money is real but not yet
   * available — an intermittent failure that looks like a Stripe outage.
   *
   * It takes a CHARGE id, which is why the request field is
   * `sourceChargeObjectId`. This test always passed a `ch_…` and the caller
   * always supplied a `pi_…`: the adapter is not where the substitution
   * happened, so no assertion here could have caught it. The name is now the
   * type's documentation, and `transferService` resolves the charge before it
   * calls.
   */
  test("a transfer names its source transaction and its group", async () => {
    const provider = new StripePaymentProvider();
    await provider.createTransfer({
      intentId: "pi_public_1",
      transferId: "tr_gateway_1",
      sourceChargeObjectId: "ch_1",
      destinationAccountId: "acct_seller",
      amount: { amount: "500", currency: "EUR" },
      groupRef: "group_1",
      idempotencyKey: "tr:tr_gateway_1",
      metadata: {},
    });

    const [params, key] = argsOf("createStripeTransfer") as [Record<string, unknown>, string];
    expect(params.source_transaction).toBe("ch_1");
    expect(params.destination).toBe("acct_seller");
    expect(params.transfer_group).toBe("group_1");
    expect(params.amount).toBe(500);
    expect(key).toBe("tr:tr_gateway_1");
  });

  /**
   * The CUMULATIVE reversed total, read off the transfer.
   *
   * A caller deciding whether a transfer is fully reversed must not have to add
   * up reversals it may not have all seen — so reporting this leg's amount
   * would make a second partial reversal look like the first.
   */
  test("a reversal reports the cumulative total, not this leg", async () => {
    transferResponse = {
      id: "trr_1",
      amount: 200,
      transfer: { id: "tr_1", amount_reversed: 500 },
    };
    const provider = new StripePaymentProvider();

    const result = await provider.reverseTransfer({
      transferId: "tr_gateway_1",
      transferObjectId: "tr_1",
      amount: { amount: "200", currency: "EUR" },
      idempotencyKey: "trr:tr_gateway_1",
      metadata: {},
    });

    expect(result.totalReversed).toBe("500");
  });

  /**
   * ADR 0008 D2-C and D2-D are ONE decision. `card_payments` is requested
   * beside transfers because Stripe refuses the pair otherwise outside the US,
   * AND because a recipient-only v2 account never emits `account.updated` —
   * the only readiness trigger there is. This test exists so removing the
   * "unnecessary" capability is a red build rather than a six-hour delay that a
   * demo passes.
   */
  test("account creation requests card_payments alongside transfers", async () => {
    const provider = new StripePaymentProvider();
    await provider.createAccount({
      accountId: "acc_gateway_1",
      country: "ES",
      businessType: "individual",
      idempotencyKey: "acct:acc_gateway_1",
      metadata: {},
    });

    const [body] = argsOf("createStripeConnectedAccountV2") as [Record<string, unknown>];
    const configuration = body.configuration as Record<string, Record<string, unknown>>;
    expect(configuration.merchant?.capabilities).toMatchObject({
      card_payments: { requested: true },
    });
    expect(configuration.recipient?.capabilities).toMatchObject({
      stripe_balance: { stripe_transfers: { requested: true } },
    });
    expect(body.dashboard).toBe("express");
    expect((body.defaults as Record<string, unknown>).responsibilities).toMatchObject({
      losses_collector: "application",
      fees_collector: "application",
    });
  });

  /**
   * The v2 create carries none of the readiness fields, so a snapshot built
   * from its response would report an account with no capabilities and no
   * requirements — indistinguishable from one that is genuinely blocked.
   */
  test("account creation reads the account back through the v1 API", async () => {
    const provider = new StripePaymentProvider();
    const snapshot = await provider.createAccount({
      accountId: "acc_gateway_1",
      country: "ES",
      businessType: "company",
      idempotencyKey: "acct:acc_gateway_1",
      metadata: {},
    });

    expect(argsOf("retrieveStripeAccount")).toEqual(["acct_new"]);
    expect(snapshot.payoutsEnabled).toBe(false);
    expect(snapshot.transfersCapability).toBe("pending");
    expect(snapshot.currentlyDue).toEqual(["business_profile.url"]);
    expect(snapshot.defaultCurrency).toBe("EUR");
  });

  /**
   * `eventually_due`, not `currently_due`. Otherwise a seller completes
   * onboarding, starts selling, and has payouts interrupted weeks later by a
   * requirement that was always coming.
   */
  test("an onboarding link collects eventually-due requirements", async () => {
    const provider = new StripePaymentProvider();
    const link = await provider.accountLink({
      providerAccountId: "acct_1",
      refreshUrl: "https://gateway.example/refresh",
      returnUrl: "https://gateway.example/return",
    });

    const [params] = argsOf("createStripeAccountLink") as [Record<string, unknown>];
    expect(params.type).toBe("account_onboarding");
    expect(params.collection_options).toMatchObject({ fields: "eventually_due" });
    expect(link.url).toContain("connect.stripe.com");
    expect(link.expiresAt).toBeInstanceOf(Date);
  });
});
