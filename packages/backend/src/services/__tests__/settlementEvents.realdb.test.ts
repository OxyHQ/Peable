/**
 * The two loops that keep settlement state true: account and transfer events in
 * the drain, and the sync sweep behind them.
 *
 * The sweep exists for the events that never arrive. Without it a seller who
 * finished onboarding while the endpoint was misconfigured stays unpayable
 * forever, and nothing anywhere says why — so the case that matters most here
 * is the one where no event is delivered at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { WebhookEvent } from "@peable.to/shared-types";

const providerCalls: string[] = [];
let accountReadiness: Record<string, unknown> = {};
let getAccountThrows: Error | null = null;

const fakeProvider = {
  id: "stripe" as const,
  getAccount: async (providerAccountId: string) => {
    providerCalls.push(`getAccount:${providerAccountId}`);
    if (getAccountThrows) throw getAccountThrows;
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
      ...accountReadiness,
    };
  },
  createAccount: async () => {
    throw new Error("not used");
  },
  accountLink: async () => {
    throw new Error("not used");
  },
  createTransfer: async () => {
    throw new Error("not used");
  },
  reverseTransfer: async () => {
    throw new Error("not used");
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

// Inert outside this describe block — `mock.module` is process-global in bun.
const {
  resolveProvider: realResolveProvider,
  resolveCardProvider: realResolveCardProvider,
  resetProviders: realResetProviders,
} = await import("../providers/registry");
let useFake = false;

mock.module("../providers/registry", () => ({
  resolveProvider: (id: "stripe") => (useFake ? fakeProvider : realResolveProvider(id)),
  resolveCardProvider: () => (useFake ? fakeProvider : realResolveCardProvider()),
  resetProviders: () => {
    realResetProviders();
  },
}));

const { runProviderEventDrainPass } = await import("../providerEventDrain");
const { runAccountSyncPass } = await import("../accountSync");
const { insertProviderEvent, findProviderEventById } = await import(
  "../../db/providers/providerEventRepository"
);
const { applyAccountSnapshot, findAccountByExternalRef, insertConnectedAccount } = await import(
  "../../db/accounts/connectedAccountRepository"
);
const { findTransferByExternalRef, insertTransfer, markTransferPaid } = await import(
  "../../db/transfers/transferRepository"
);
const { insertPaymentIntent, linkProviderObject, updateIntentState } = await import(
  "../../db/payments/paymentIntentRepository"
);
const { webhookDeliveries } = await import("../../db/schema");
const { gatewayDb, seedMerchant, useGatewayDatabase } = await import(
  "../../__tests__/helpers/gatewayTestDatabase"
);
const { POSTGRES_TESTS_ENABLED } = await import("../../db/testDatabase");
const { uuidv7 } = await import("@oxy.so/db");

type Merchant = Awaited<ReturnType<typeof seedMerchant>>;
let merchant: Merchant;
let intentInternalId = "";
let eventCounter = 0;

/** Store an event exactly as a verified ingress would have. */
async function storeEvent(
  type: string,
  objectIds: Record<string, string>,
  payload: Record<string, unknown> = {},
): Promise<string> {
  eventCounter += 1;
  const id = await insertProviderEvent(gatewayDb(), {
    provider: "stripe",
    providerEventId: `evt_settle_${String(eventCounter)}`,
    providerAccountId: objectIds.account ?? null,
    type,
    livemode: false,
    apiVersion: "2026-07-29.dahlia",
    objectIds,
    payload: { id: `evt_settle_${String(eventCounter)}`, object: "event", type, ...payload },
  });
  if (!id) throw new Error("the event was already stored");
  return id;
}

/** Every readiness notification enqueued so far, with its envelope parsed. */
async function accountDeliveries(): Promise<
  { paymentIntentId: string | null; event: WebhookEvent<"connected_account.updated"> }[]
> {
  const rows = await gatewayDb()
    .select({
      paymentIntentId: webhookDeliveries.paymentIntentId,
      payload: webhookDeliveries.payload,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.eventType, "connected_account.updated"));
  return rows.map((row) => ({
    paymentIntentId: row.paymentIntentId,
    event: row.payload as unknown as WebhookEvent<"connected_account.updated">,
  }));
}

async function seedAccount(ref: string, providerAccountId: string) {
  const row = await insertConnectedAccount(gatewayDb(), {
    publicId: `ca_${uuidv7()}`,
    merchantId: merchant.id,
    externalRef: ref,
    provider: "stripe",
    providerAccountId,
    country: "ES",
  });
  if (!row) throw new Error(`seedAccount: ${ref} exists`);
  return row;
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)("settlement events and the sync sweep", () => {
  useGatewayDatabase();

  beforeAll(async () => {
    useFake = true;
    // BOTH halves, deliberately: `findWebhookTarget` answers null unless the
    // url AND the secret are present, and a null target makes every enqueue
    // return without writing a row — which would leave the readiness-event
    // assertions below vacuously empty.
    merchant = await seedMerchant({
      webhookUrl: "https://merchant.invalid/hook",
      webhookSecret: "whsec_settlement_events",
    });

    const intent = await insertPaymentIntent(gatewayDb(), {
      publicId: `pi_${uuidv7()}`,
      merchantId: merchant.id,
      rail: "card",
      amount: "100000",
      currency: "EUR",
      network: null,
      address: null,
      provider: "stripe",
      clientSecret: "cs_x",
      idempotencyKey: uuidv7(),
      metadata: {},
      expiresAt: new Date(Date.now() + 900_000),
    });
    if (!intent) throw new Error("could not seed the intent");
    await linkProviderObject(gatewayDb(), intent.id, "stripe", "pi_stripe_for_settlement");
    await updateIntentState(gatewayDb(), intent.id, { from: "created", status: "settled" });
    intentInternalId = intent.id;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    accountReadiness = {};
    getAccountThrows = null;
  });

  afterAll(() => {
    useFake = false;
  });

  // ── account events ───────────────────────────────────────────────────────

  /**
   * The event says something changed; the only trustworthy account of WHAT is a
   * fresh read. Parsing the account out of the delivery would work until the
   * payload is redacted — which it is — and then it would work partially, which
   * is worse than not at all.
   */
  test("an account event re-reads the account from the provider", async () => {
    const account = await seedAccount("store_evt_1", "acct_evt_1");
    const eventId = await storeEvent("account.updated", { account: "acct_evt_1" });

    const result = await runProviderEventDrainPass();
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(providerCalls).toContain("getAccount:acct_evt_1");

    const after = await findAccountByExternalRef(gatewayDb(), merchant.id, "store_evt_1");
    expect(after?.payoutsEnabled).toBe(true);
    expect(after?.transfersCapability).toBe("active");
    expect(after?.lastSyncedAt).toBeInstanceOf(Date);
    expect(after?.id).toBe(account.id);
    expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).not.toBeNull();
  });

  /**
   * ...and the MERCHANT is told, which they were not.
   *
   * The handler refreshed the local row and enqueued nothing, so the only ways
   * a marketplace could learn that a seller had finished onboarding were to
   * poll `GET /v1/connected_accounts` or to attempt a settlement and read the
   * refusal. Readiness is the one fact about a seller a marketplace cannot act
   * without.
   *
   * The delivery names NO payment intent — this is the first event that is not
   * about a payment, and naming an unrelated payment to satisfy the old NOT
   * NULL would have been worse than the gap.
   */
  test("tells the merchant when a seller's readiness changes", async () => {
    await seedAccount("store_evt_notify", "acct_evt_notify");
    // The seeded row is all-false; the fake provider reports `active`, so this
    // refresh is a real readiness change.
    await storeEvent("account.updated", { account: "acct_evt_notify" });
    await runProviderEventDrainPass();

    // Scoped to THIS seller: the cases above also change readiness, and every
    // one of them rightly enqueues its own notification.
    const rows = (await accountDeliveries()).filter(
      (row) => row.event.data.object.externalRef === "store_evt_notify",
    );

    expect(rows).toHaveLength(1);
    // NO payment intent. This is the first event that is not about a payment,
    // and naming an unrelated one to satisfy the old NOT NULL would have been
    // worse than the gap.
    expect(rows[0]?.paymentIntentId).toBeNull();

    // The payload is the ACCOUNT, and it carries what a merchant acts on.
    const event = rows[0]?.event;
    expect(event?.data.object.object).toBe("connected_account");
    expect(event?.data.object.payable).toBe(true);
    // ...and never the provider's own account id (ADR 0001 D3).
    expect(JSON.stringify(event)).not.toContain("acct_evt_notify");
  });

  /**
   * A refresh that changes NOTHING tells the merchant nothing.
   *
   * The sync sweep re-reads every account periodically whether or not anything
   * moved. An event per sweep would be a stream a merchant learns to ignore,
   * which is the same as no notification at all — so the enqueue is gated on a
   * change to the fields they act on, not on the row having been written.
   */
  test("says nothing when a refresh changes nothing", async () => {
    await seedAccount("store_evt_quiet", "acct_evt_quiet");
    await storeEvent("account.updated", { account: "acct_evt_quiet" });
    await runProviderEventDrainPass();

    const before = (await accountDeliveries()).length;
    // A second identical refresh.
    await storeEvent("account.updated", { account: "acct_evt_quiet" });
    await runProviderEventDrainPass();

    expect((await accountDeliveries()).length).toBe(before);
  });

  /**
   * `capability.updated` is handled too, and it is not decoration: on a
   * recipient-only account it can be the ONLY signal Stripe sends. Mercaria's
   * ADR 0008 D2-D is the record of that costing six hours.
   */
  test("a capability event refreshes the account the same way", async () => {
    await seedAccount("store_evt_cap", "acct_evt_cap");
    await storeEvent("capability.updated", { account: "acct_evt_cap" });

    await runProviderEventDrainPass();
    expect(providerCalls).toContain("getAccount:acct_evt_cap");
  });

  /**
   * An account this gateway never opened stays UNPROCESSED — the same as an
   * unmatched payment. The likely cause is our own create not having committed
   * yet, and marking it handled would drop a readiness change permanently.
   */
  test("leaves an event for an unknown account unprocessed", async () => {
    const eventId = await storeEvent("account.updated", { account: "acct_never_opened" });

    const result = await runProviderEventDrainPass();
    expect(result.unmatched).toBeGreaterThanOrEqual(1);
    expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).toBeNull();
    expect(providerCalls).not.toContain("getAccount:acct_never_opened");
  });

  // ── transfer events ──────────────────────────────────────────────────────

  async function seedPaidTransfer(ref: string, amount: string, providerObjectId: string) {
    const account = await seedAccount(`store_for_${ref}`, `acct_for_${ref}`);
    const row = await insertTransfer(gatewayDb(), {
      publicId: `tr_${uuidv7()}`,
      merchantId: merchant.id,
      paymentIntentId: intentInternalId,
      connectedAccountId: account.id,
      externalRef: ref,
      amount,
      currency: "EUR",
      provider: "stripe",
      sourcePaymentObjectId: "pi_stripe_for_settlement",
    });
    if (!row) throw new Error(`seedPaidTransfer: ${ref} exists`);
    await markTransferPaid(gatewayDb(), row.id, providerObjectId);
    return row;
  }

  /**
   * A reversal made from the provider's own dashboard, which this gateway never
   * initiated. Without this handler the seller's balance is right at the
   * provider and wrong here, and nothing reconciles them.
   */
  test("applies a reversal reported by the provider", async () => {
    await seedPaidTransfer("order_evt_rev", "5000", "tr_stripe_evt_rev");
    await storeEvent(
      "transfer.reversed",
      { transfer: "tr_stripe_evt_rev" },
      { data: { object: { id: "tr_stripe_evt_rev", object: "transfer", amount_reversed: 2000 } } },
    );

    await runProviderEventDrainPass();

    const after = await findTransferByExternalRef(gatewayDb(), merchant.id, "order_evt_rev");
    expect(after?.amountReversed).toBe("2000");
    expect(after?.status).toBe("partially_reversed");
  });

  test("a full reversal reported by the provider closes the transfer", async () => {
    await seedPaidTransfer("order_evt_full", "5000", "tr_stripe_evt_full");
    await storeEvent(
      "transfer.reversed",
      { transfer: "tr_stripe_evt_full" },
      { data: { object: { id: "tr_stripe_evt_full", object: "transfer", amount_reversed: 5000 } } },
    );

    await runProviderEventDrainPass();

    const after = await findTransferByExternalRef(gatewayDb(), merchant.id, "order_evt_full");
    expect(after?.status).toBe("reversed");
  });

  /**
   * THE reason `readReversedTotal` refuses rather than guesses.
   *
   * `amount_reversed` survives redaction because it is on the allow-list. A
   * field that did NOT would read as the string `"[redacted]"` — not as
   * missing — and a numeric conversion of it produces `NaN`, which as an amount
   * is a reversal of an unknown quantity. Refusing is the only safe direction.
   */
  test("refuses a redacted or non-integer total instead of writing an amount", async () => {
    await seedPaidTransfer("order_evt_bad", "5000", "tr_stripe_evt_bad");
    await storeEvent(
      "transfer.reversed",
      { transfer: "tr_stripe_evt_bad" },
      {
        data: {
          object: { id: "tr_stripe_evt_bad", object: "transfer", amount_reversed: "[redacted]" },
        },
      },
    );

    const result = await runProviderEventDrainPass();
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const after = await findTransferByExternalRef(gatewayDb(), merchant.id, "order_evt_bad");
    expect(after?.amountReversed).toBe("0");
    expect(after?.status).toBe("paid");
  });

  test("leaves an event for a transfer this gateway never made unprocessed", async () => {
    const eventId = await storeEvent(
      "transfer.reversed",
      { transfer: "tr_stripe_unknown" },
      { data: { object: { id: "tr_stripe_unknown", object: "transfer", amount_reversed: 1 } } },
    );

    const result = await runProviderEventDrainPass();
    expect(result.unmatched).toBeGreaterThanOrEqual(1);
    expect((await findProviderEventById(gatewayDb(), eventId))?.processedAt).toBeNull();
  });

  // ── the sync sweep ───────────────────────────────────────────────────────

  /**
   * THE case the sweep exists for: no event ever arrives.
   *
   * A seller finishes onboarding while the endpoint is misconfigured. Without
   * this, they stay unpayable forever and nothing says why.
   */
  test("refreshes a never-synced account with no event at all", async () => {
    await seedAccount("store_sweep_1", "acct_sweep_1");

    const result = await runAccountSyncPass({ batchSize: 50 });
    expect(result.refreshed).toBeGreaterThanOrEqual(1);

    const after = await findAccountByExternalRef(gatewayDb(), merchant.id, "store_sweep_1");
    expect(after?.payoutsEnabled).toBe(true);
    expect(after?.lastSyncedAt).toBeInstanceOf(Date);
  });

  /**
   * Never-synced accounts come FIRST. PostgreSQL's default `ASC` is `NULLS
   * LAST`, which would queue the accounts nothing is known about behind every
   * account already known to be fine — exactly backwards.
   */
  test("visits a never-synced account before one synced long ago", async () => {
    const stale = await seedAccount("store_sweep_stale", "acct_sweep_stale");
    await applyAccountSnapshot(
      gatewayDb(),
      stale.id,
      {
        payoutsEnabled: false,
        chargesEnabled: false,
        transfersCapability: null,
        cardPaymentsCapability: null,
        currentlyDue: [],
        eventuallyDue: [],
        pastDue: [],
        pendingVerification: [],
        disabledReasonCodes: [],
        defaultCurrency: null,
      },
      new Date(Date.now() - 86_400_000),
    );
    const fresh = await seedAccount("store_sweep_fresh", "acct_sweep_fresh");

    providerCalls.length = 0;
    await runAccountSyncPass({ batchSize: 1 });

    // Exactly one account, and it is the one nothing was known about.
    expect(providerCalls).toEqual([`getAccount:${fresh.providerAccountId}`]);
  });

  /**
   * One seller the provider refuses to read must not hold up every account
   * behind it — which it would, permanently, because the queue is ordered by
   * sync time and a never-synced failure stays at the front.
   */
  test("keeps going past an account the provider will not read", async () => {
    await seedAccount("store_sweep_bad", "acct_sweep_bad");
    await seedAccount("store_sweep_good", "acct_sweep_good");

    let calls = 0;
    const original = fakeProvider.getAccount;
    // Fail the FIRST read of this pass, whichever account it is.
    (fakeProvider as { getAccount: unknown }).getAccount = async (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("provider refused");
      return original(id);
    };

    try {
      const result = await runAccountSyncPass({ batchSize: 50 });
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.refreshed).toBeGreaterThanOrEqual(1);
    } finally {
      (fakeProvider as { getAccount: unknown }).getAccount = original;
    }
  });

  test("does nothing, without error, when there is nothing to sync", async () => {
    const result = await runAccountSyncPass({ batchSize: 0 });
    expect(result).toEqual({ examined: 0, refreshed: 0, failed: 0 });
  });
});
