/**
 * The Stripe adapter — Stripe's vocabulary in, the gateway's vocabulary out.
 *
 * Nothing here decides anything. It does not persist, it does not transition an
 * intent, it does not enqueue a webhook. Those belong to the gateway, so "what
 * happens when a payment succeeds" is written once and cannot drift between
 * providers.
 *
 * Ported from Mercaria's `services/payments/stripe/stripe-provider.ts`
 * (ADR 0001 D3, ADR 0008), with the marketplace domain left behind: no ledger,
 * no fee schedule, no order. What crossed is the rail.
 */

import type Stripe from "stripe";
import type { CurrencyCode } from "@peable.to/shared-types";
import { config } from "../../../config";
import {
  cancelStripePaymentIntent,
  captureStripePaymentIntent,
  constructStripeEvent,
  createStripeAccountLink,
  createStripeConnectedAccountV2,
  createStripePaymentIntent,
  createStripeRefund,
  createStripeTransfer,
  createStripeTransferReversal,
  retrieveStripeAccount,
  retrieveStripeChargeWithBalance,
  retrieveStripePaymentIntent,
  retrieveStripeTransfer,
  updateStripeDispute,
} from "./client";
import {
  ProviderError,
  type AccountHoldingProvider,
  type DisputeEvidence,
  type DisputeHandlingProvider,
  type ProviderSettlement,
  UNKNOWN_SETTLEMENT,
  type SettlementReportingProvider,
  type SubmitDisputeEvidenceRequest,
  type AccountLinkRequest,
  type CreateAccountRequest,
  type CreatePaymentRequest,
  type CreateTransferRequest,
  type PaymentOperationRequest,
  type ProviderAccountSnapshot,
  type ProviderCapabilityStatus,
  type ProviderEventEnvelope,
  type ProviderEventInput,
  type ProviderPaymentResult,
  type ProviderPaymentStatus,
  type ProviderRefundResult,
  type ProviderTransferResult,
  type ProviderTransferReversalResult,
  type RefundRequest,
  type ReverseTransferRequest,
  type SettlingPaymentProvider,
} from "../provider";
import { mapPaymentIntentStatus, toProviderEventEnvelope } from "./verify";

/** Which endpoint a delivery arrived on. The two carry different secrets. */
export type StripeWebhookScope = "platform" | "connect";

/**
 * Stripe counts money in the currency's minor unit as a NUMBER; the gateway
 * carries it as a canonical integer STRING because the application works in
 * `bigint`, which is unbounded.
 *
 * The conversion happens here and nowhere else, and it REFUSES a value that
 * cannot survive the round trip. `Number.MAX_SAFE_INTEGER` is where a JS number
 * silently stops counting, and a payment amount that crossed it would be sent
 * to Stripe rounded — a real charge for an amount nobody authorised.
 */
function toStripeAmount(amount: string, stage: "createPayment" | "refund" | "transfer"): number {
  const value = Number(amount);
  if (!Number.isSafeInteger(value)) {
    throw new ProviderError({
      provider: "stripe",
      stage,
      message: `amount ${amount} cannot be represented exactly as a Stripe amount`,
      retryable: false,
      code: "amount_not_representable",
    });
  }
  return value;
}

/**
 * The charge id off a PaymentIntent's `latest_charge`, whichever shape it is in.
 *
 * Stripe returns it as a bare id string unless the caller expanded it, in which
 * case it is the whole Charge object. Both are ordinary, so both are read —
 * `typeof x === 'string'` alone would silently answer `undefined` for every
 * expanded read and send a settlement looking for a charge it already had.
 */
function readChargeId(
  latestCharge: Stripe.PaymentIntent["latest_charge"],
): string | undefined {
  if (typeof latestCharge === "string") return latestCharge;
  if (typeof latestCharge === "object" && latestCharge !== null) return latestCharge.id;
  return undefined;
}

/**
 * The gateway's evidence field names in Stripe's spelling.
 *
 * Written out rather than derived by case conversion, so a field the gateway
 * names differently from Stripe (or one Stripe renames) is a compile-time edit
 * here instead of a silently dropped piece of a merchant's defence.
 *
 * TOTAL over `DisputeEvidence` — that is what makes it safe. A field added to
 * the wire contract and not to this map is a field a merchant sends, the
 * gateway accepts, and the network never sees; they would find out when the
 * dispute is decided against them. As a `Record` it fails to compile instead.
 */
const STRIPE_EVIDENCE_FIELDS: Record<
  keyof DisputeEvidence,
  keyof Stripe.DisputeUpdateParams.Evidence
> = {
  productDescription: "product_description",
  customerName: "customer_name",
  customerEmailAddress: "customer_email_address",
  customerPurchaseIp: "customer_purchase_ip",
  billingAddress: "billing_address",
  shippingAddress: "shipping_address",
  shippingCarrier: "shipping_carrier",
  shippingDate: "shipping_date",
  shippingTrackingNumber: "shipping_tracking_number",
  serviceDate: "service_date",
  accessActivityLog: "access_activity_log",
  cancellationPolicyDisclosure: "cancellation_policy_disclosure",
  cancellationRebuttal: "cancellation_rebuttal",
  duplicateChargeExplanation: "duplicate_charge_explanation",
  refundPolicyDisclosure: "refund_policy_disclosure",
  refundRefusalExplanation: "refund_refusal_explanation",
  uncategorizedText: "uncategorized_text",
};

/**
 * An omitted key is omitted from the request too — sending `undefined` would
 * clear a field the merchant had already provided.
 */
function toStripeEvidence(evidence: DisputeEvidence): Stripe.DisputeUpdateParams.Evidence {
  const out: Record<string, string> = {};
  for (const [ours, theirs] of Object.entries(STRIPE_EVIDENCE_FIELDS)) {
    const value = evidence[ours as keyof DisputeEvidence];
    if (value !== undefined) out[theirs] = value;
  }
  return out;
}

/** Stripe wants a lowercase ISO code; the gateway's set is uppercase. */
function toStripeCurrency(currency: string): string {
  return currency.toLowerCase();
}

/**
 * A Stripe capability string, narrowed — or `null` when Stripe reports nothing.
 *
 * `null` and `"inactive"` are DIFFERENT facts: nothing reported means the
 * capability was never requested, and Stripe declining it means it was. A
 * mapper that collapsed them would make "why will readiness never fire on this
 * account" unanswerable, which is precisely the six-hour failure ADR 0008 D2-D
 * records.
 */
function toCapabilityStatus(
  value: Stripe.Account.Capabilities[keyof Stripe.Account.Capabilities] | undefined,
): ProviderCapabilityStatus | null {
  if (value === "active" || value === "pending" || value === "inactive") return value;
  return null;
}

export class StripePaymentProvider
  implements
    SettlingPaymentProvider,
    AccountHoldingProvider,
    DisputeHandlingProvider,
    SettlementReportingProvider
{
  readonly id = "stripe" as const;

  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    const params: Stripe.PaymentIntentCreateParams = {
      amount: toStripeAmount(request.amount.amount, "createPayment"),
      currency: toStripeCurrency(request.amount.currency),
      // `automatic_payment_methods` rather than a hand-listed set: the methods a
      // payment can offer are a dashboard decision an operator changes without a
      // deploy, and hard-coding them here would make that dashboard lie.
      automatic_payment_methods: { enabled: true },
      metadata: { ...request.metadata, peable_intent_id: request.intentId },
      // Ties every movement of one checkout together at Stripe, so a support
      // conversation can find the charge and its transfers from one id.
      transfer_group: request.intentId,
      ...(request.onBehalfOf !== undefined
        ? { on_behalf_of: request.onBehalfOf }
        : {}),
    };
    const intent = await createStripePaymentIntent(params, request.idempotencyKey);
    return this.toResult(intent);
  }

  /**
   * Capture.
   *
   * With `automatic_payment_methods` and no `capture_method: 'manual'`, Stripe
   * captures as part of confirmation — so there is nothing to capture and this
   * READS the payment back rather than pretending to act. Calling
   * `paymentIntents.capture` on an already-captured intent is an error, not a
   * no-op, so "just call it anyway" would turn a settled payment into a failure.
   */
  async capture(request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    const current = await retrieveStripePaymentIntent(request.providerObjectId);
    if (current.status !== "requires_capture") return this.toResult(current);
    const captured = await captureStripePaymentIntent(
      request.providerObjectId,
      request.idempotencyKey,
    );
    return this.toResult(captured);
  }

  async cancel(request: PaymentOperationRequest): Promise<ProviderPaymentResult> {
    const canceled = await cancelStripePaymentIntent(
      request.providerObjectId,
      request.idempotencyKey,
    );
    return this.toResult(canceled);
  }

  async refund(request: RefundRequest): Promise<ProviderRefundResult> {
    const refund = await createStripeRefund(
      {
        payment_intent: request.providerObjectId,
        amount: toStripeAmount(request.amount.amount, "refund"),
        metadata: { ...request.metadata, peable_refund_id: request.refundId },
      },
      request.idempotencyKey,
    );

    // Re-read the PAYMENT rather than inferring its state from the refund: only
    // Stripe knows whether this refund exhausted the charge, and computing that
    // here would need the charge's total and every earlier refund — a sum this
    // adapter has no business keeping.
    const payment = await retrieveStripePaymentIntent(request.providerObjectId);

    return {
      providerObjectId: refund.id,
      status: this.refundedPaymentStatus(payment),
      state: refund.status === "succeeded" ? "succeeded" : refund.status === "failed" ? "failed" : "pending",
      ...(refund.failure_reason !== undefined && refund.failure_reason !== null
        ? { failureCode: refund.failure_reason }
        : {}),
    };
  }

  async getStatus(providerObjectId: string): Promise<ProviderPaymentResult> {
    return this.toResult(await retrieveStripePaymentIntent(providerObjectId));
  }

  /**
   * Verify a delivery on the PLATFORM endpoint.
   *
   * The scope is not a parameter here because `PaymentProvider` is
   * scope-agnostic; the ingress route, which knows which endpoint the request
   * arrived on, calls `verifyEventForScope` instead. This exists so the adapter
   * satisfies the interface and so the contract suite has something to drive.
   */
  async verifyEvent(input: ProviderEventInput): Promise<ProviderEventEnvelope> {
    return this.verifyEventForScope(input, "platform");
  }

  /**
   * Verify against the secrets for ONE endpoint.
   *
   * The two endpoints have separate secrets on purpose: a Connect-scope
   * delivery verified with the platform secret would fail, and accepting either
   * secret on either endpoint would mean a leaked platform secret could forge a
   * connected-account event.
   */
  async verifyEventForScope(
    input: ProviderEventInput,
    scope: StripeWebhookScope,
  ): Promise<ProviderEventEnvelope> {
    const secrets = (
      scope === "platform"
        ? [config.stripe.webhookSecret, config.stripe.webhookSecretPrevious]
        : [config.stripe.connectWebhookSecret, config.stripe.connectWebhookSecretPrevious]
    ).filter((secret): secret is string => secret !== undefined);

    if (secrets.length === 0) {
      throw new ProviderError({
        provider: "stripe",
        stage: "verifyEvent",
        message: `no ${scope} webhook secret is configured`,
        retryable: false,
        code: "webhook_secret_missing",
      });
    }

    const event = await constructStripeEvent(input.payload, input.signature, secrets);
    return toProviderEventEnvelope(event);
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  async createTransfer(request: CreateTransferRequest): Promise<ProviderTransferResult> {
    const transfer = await createStripeTransfer(
      {
        amount: toStripeAmount(request.amount.amount, "transfer"),
        currency: toStripeCurrency(request.amount.currency),
        destination: request.destinationAccountId,
        transfer_group: request.groupRef,
        // Makes the transfer WAIT for the charge's funds instead of failing
        // against a balance that has not landed yet. Without it, a transfer
        // created moments after a charge fails with `balance_insufficient` on a
        // platform whose money is real but not yet available.
        //
        // It takes a CHARGE id. This used to be handed the PaymentIntent's
        // `pi_…`, which Stripe refuses with `No such charge` — so every
        // multi-seller settlement failed, and it failed at the provider rather
        // than here, which reads as an outage. `transferService` now resolves
        // the charge (`latest_charge`) before it calls, and the parameter name
        // says which id it wants.
        source_transaction: request.sourceChargeObjectId,
        metadata: { ...request.metadata, peable_transfer_id: request.transferId },
      },
      request.idempotencyKey,
    );
    return {
      providerObjectId: transfer.id,
      status: transfer.reversed ? "reversed" : "paid",
    };
  }

  async reverseTransfer(
    request: ReverseTransferRequest,
  ): Promise<ProviderTransferReversalResult> {
    const reversal = await createStripeTransferReversal(
      request.transferObjectId,
      {
        amount: toStripeAmount(request.amount.amount, "transfer"),
        metadata: { ...request.metadata, peable_transfer_id: request.transferId },
      },
      request.idempotencyKey,
    );

    /**
     * The CUMULATIVE total, off the TRANSFER — never this leg's amount.
     *
     * The fallback this replaces was `String(reversal.amount)`, and it is the
     * expensive kind of fallback: `reversal.transfer` is an expanded object
     * only when Stripe happened to expand it, which on `createReversal` it does
     * not. So the fallback was the NORMAL path, and every partial reversal
     * reported its own leg as the cumulative figure. `applyTransferReversal`
     * stores that verbatim and guards on the new total being no SMALLER than
     * the stored one — so reversing 500 and then 500 again left
     * `amount_reversed` at 500, the transfer never reached `reversed`, and the
     * seller kept half of what had been taken back.
     *
     * A second round trip is the price of an authoritative number. The
     * expansion is still read first, so a Stripe version that starts expanding
     * costs nothing.
     */
    const expanded = reversal.transfer;
    if (typeof expanded === "object" && expanded !== null && "amount_reversed" in expanded) {
      return { providerObjectId: reversal.id, totalReversed: String(expanded.amount_reversed) };
    }

    const transfer = await retrieveStripeTransfer(request.transferObjectId);
    return {
      providerObjectId: reversal.id,
      totalReversed: String(transfer.amount_reversed),
    };
  }

  // -------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------

  /**
   * Submit a merchant's response.
   *
   * `submit: true`, always. Stripe's update call doubles as a draft save, and
   * the draft is one-way once submitted — so a gateway offering both would owe
   * every draft a durable identity to keep a retry from becoming a second
   * write. `services/disputeEvidence.ts` records that decision; this is where
   * it becomes a literal.
   *
   * The evidence is CONVERTED here and nowhere else: Stripe's field names are
   * snake_case and the gateway's are not, and an adapter is exactly the place
   * that difference belongs.
   */
  async submitDisputeEvidence(request: SubmitDisputeEvidenceRequest): Promise<void> {
    await updateStripeDispute(
      request.providerObjectId,
      { evidence: toStripeEvidence(request.evidence), submit: true },
      request.idempotencyKey,
    );
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /**
   * What a charge actually came to.
   *
   * Reads the CHARGE with its balance transaction expanded, because the fee
   * attaches to the charge and not to the payment — and because a second call
   * to fetch the transaction by id leaves a window in which the charge can be
   * refunded between the two reads.
   *
   * Reports `pending` rather than zeros when Stripe has no balance transaction
   * yet. It is the whole reason this method exists: a settlement report that
   * renders an unknown fee as `0` is one a merchant reconciles against and
   * cannot explain, and zero is a number somebody will subtract.
   */
  async getSettlement(chargeObjectId: string): Promise<ProviderSettlement> {
    const charge = await retrieveStripeChargeWithBalance(chargeObjectId);
    const balance = charge.balance_transaction;

    if (typeof balance !== "object" || balance === null) {
      // Either an unexpanded id — which cannot happen, this asked for the
      // expansion — or no transaction at all, which is an uncaptured or
      // not-yet-settled charge. Neither is "the fee was nothing".
      return UNKNOWN_SETTLEMENT;
    }

    return {
      status: balance.status === "available" ? "available" : "pending",
      gross: String(balance.amount),
      fee: String(balance.fee),
      net: String(balance.net),
      currency: balance.currency.toUpperCase() as CurrencyCode,
      // Seconds since the epoch, like every Stripe timestamp.
      availableOn: new Date(balance.available_on * 1000).toISOString(),
      // Only when the settlement currency differs from the charge's. `null`
      // rather than `1` for a same-currency settlement: a rate of one is a
      // conversion that happened, and none happened.
      exchangeRate: balance.exchange_rate ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Connected accounts
  // -------------------------------------------------------------------------

  /**
   * Create a connected account (Mercaria ADR 0008 D2-A, D2-C, D2-D).
   *
   * **`card_payments` is requested alongside transfers and that is ONE decision
   * with the readiness path, not two.** Stripe refuses `stripe_transfers`
   * without `card_payments` outside the US (measured, `country: es`) — and a v2
   * account with only a `recipient` configuration NEVER emits `account.updated`,
   * which is the only readiness trigger there is. So the forced `merchant`
   * configuration is also what makes readiness work. Removing the "unnecessary"
   * capability breaks onboarding in a way a demo passes: the staleness sweep
   * still gets every seller to ready, up to six hours late, each raising a drift
   * row that reads like a flaky provider.
   */
  async createAccount(request: CreateAccountRequest): Promise<ProviderAccountSnapshot> {
    const created = (await createStripeConnectedAccountV2(
      {
        // Derived, not sent: a v2 account created this way reads back through
        // the v1 API carrying `requirement_collection: stripe` — the property
        // that keeps identity documents out of this database, obtained by
        // construction rather than by assertion.
        dashboard: "express",
        identity: { country: request.country, entity_type: request.businessType },
        defaults: {
          responsibilities: {
            losses_collector: "application",
            fees_collector: "application",
          },
        },
        configuration: {
          merchant: { capabilities: { card_payments: { requested: true } } },
          recipient: {
            capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
          },
        },
        metadata: { ...request.metadata, peable_account_id: request.accountId },
      },
      request.idempotencyKey,
    )) as { id?: unknown };

    if (typeof created.id !== "string") {
      throw new ProviderError({
        provider: "stripe",
        stage: "account",
        message: "Stripe returned no account id",
        retryable: true,
      });
    }

    // Read back through v1 immediately: v2 carries none of the readiness
    // fields, so a snapshot built from the create response would report an
    // account with no capabilities and no requirements — indistinguishable from
    // one that is genuinely blocked.
    return this.getAccount(created.id);
  }

  async accountLink(request: AccountLinkRequest): Promise<{ url: string; expiresAt: Date }> {
    const link = await createStripeAccountLink({
      account: request.providerAccountId,
      refresh_url: request.refreshUrl,
      return_url: request.returnUrl,
      type: "account_onboarding",
      // Collect what will EVENTUALLY be due, not only what is due now.
      // Otherwise a seller completes onboarding, starts selling, and has payouts
      // interrupted weeks later by a requirement that was always coming.
      collection_options: { fields: "eventually_due" },
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  async getAccount(providerAccountId: string): Promise<ProviderAccountSnapshot> {
    const account = await retrieveStripeAccount(providerAccountId);
    const requirements = account.requirements;
    const transfers = account.capabilities?.transfers;
    const cardPayments = account.capabilities?.card_payments;

    return {
      providerAccountId: account.id,
      payoutsEnabled: account.payouts_enabled === true,
      chargesEnabled: account.charges_enabled === true,
      transfersCapability: toCapabilityStatus(transfers) ?? "inactive",
      // NULL, not `inactive`, when Stripe reports nothing: never requested is a
      // different fact from declined, and collapsing them makes "why is this
      // seller stuck" unanswerable.
      cardPaymentsCapability: toCapabilityStatus(cardPayments),
      // Requirement IDENTIFIERS only, never their values. The gateway records
      // that a seller owes a document; it never learns what the document says.
      currentlyDue: requirements?.currently_due ?? [],
      eventuallyDue: requirements?.eventually_due ?? [],
      pastDue: requirements?.past_due ?? [],
      pendingVerification: requirements?.pending_verification ?? [],
      ...(requirements?.disabled_reason
        ? { disabledReason: requirements.disabled_reason }
        : {}),
      ...(account.default_currency
        ? { defaultCurrency: account.default_currency.toUpperCase() as ProviderAccountSnapshot["defaultCurrency"] }
        : {}),
    };
  }

  // -------------------------------------------------------------------------

  private toResult(intent: Stripe.PaymentIntent): ProviderPaymentResult {
    const status = mapPaymentIntentStatus(intent.status);
    const chargeObjectId = readChargeId(intent.latest_charge);
    return {
      providerObjectId: intent.id,
      status,
      // Handed to the payer in the same response and never stored, so it cannot
      // become a credential sitting in a database.
      ...(intent.client_secret
        ? { clientAction: { kind: "client_secret" as const, value: intent.client_secret } }
        : {}),
      // The CHARGE, which is a different object from the payment and is what a
      // transfer's `source_transaction` names. Absent while the payment has not
      // produced one.
      ...(chargeObjectId !== undefined ? { chargeObjectId } : {}),
    };
  }

  /** Whether a refund left the payment fully or partially refunded. */
  private refundedPaymentStatus(intent: Stripe.PaymentIntent): ProviderPaymentStatus {
    const charge = intent.latest_charge;
    if (typeof charge === "object" && charge !== null) {
      if (charge.refunded) return "refunded";
      if ((charge.amount_refunded ?? 0) > 0) return "partially_refunded";
    }
    // Stripe did not expand the charge. `partially_refunded` is the
    // conservative answer: a refund was created, so SOMETHING came back, and
    // claiming the payment is fully refunded when it is not would stop a later
    // legitimate refund.
    return "partially_refunded";
  }
}
