/**
 * The Stripe SDK client, and every call the gateway makes through it.
 *
 * One module owns the SDK so the adapter above it never imports `stripe`
 * directly: an adapter that reached for the SDK would make "which Stripe
 * version, with which key, through which idempotency mechanism" a question with
 * as many answers as call sites.
 *
 * Ported from Mercaria's `services/payments/stripe/client.ts` (ADR 0001 D2).
 * Two things came across unchanged and neither is style:
 *
 *  1. **The API version is PINNED in code**, not left to the account default.
 *     An account-default upgrade changes payload shapes under a running
 *     integration with no deploy and no signal; a pin makes a version change a
 *     deliberate PR that re-verifies the event fixtures.
 *  2. **`constructEventAsync`, never `constructEvent`.** Under Bun the
 *     synchronous crypto entry points throw, while the same code on Node works
 *     — so a webhook path built on the sync call passes every CI run on Node
 *     and rejects every real delivery in a Bun runtime image. This gateway
 *     RUNS TypeScript source under Bun (`AGENTS.md`), so it is the failing
 *     case, not the passing one.
 */

import Stripe from "stripe";
import { config } from "../../../config";
import { ProviderError, type ProviderStage } from "../provider";

/**
 * The Stripe API release train this integration is written against.
 *
 * Carried over from Mercaria's pin so both sides of the port speak the same
 * shapes while the migration is in flight. Changing it means re-verifying every
 * event fixture, deliberately.
 */
export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

let client: Stripe | undefined;

/**
 * The process-wide Stripe client.
 *
 * @throws when the rail is not configured. Callers reach this only through
 *   `resolveProvider`, which answers `undefined` for a rail this deployment has
 *   not configured — so this throw is a programming error, not an operator one.
 */
export function getStripeClient(): Stripe {
  if (client) return client;
  const secretKey = config.stripe.secretKey;
  if (!secretKey) {
    throw new Error(
      "Stripe is not configured: STRIPE_SECRET_KEY is absent. This is reachable " +
        "only by bypassing `resolveProvider`, which returns undefined for a rail " +
        "this deployment has not enabled.",
    );
  }
  client = new Stripe(secretKey, {
    // `as any` is not needed and not used: the pinned literal is the SDK's own
    // union member, so a version the installed SDK does not know is a COMPILE
    // error rather than a runtime surprise.
    apiVersion: STRIPE_API_VERSION,
    // Named so a Stripe support conversation can identify this integration in
    // their request logs without the operator guessing.
    appInfo: { name: "Peable Gateway", url: "https://peable.to" },
  });
  return client;
}

/** Drop the client. Test support — a suite must not inherit another's key. */
export function resetStripeClient(): void {
  client = undefined;
}

/**
 * Turn anything Stripe threw into a `ProviderError` the gateway can route on.
 *
 * The retryable/permanent split is the only thing callers branch on, and
 * getting it backwards is expensive in both directions: a permanent failure
 * marked retryable becomes a loop against a card that will never work, and a
 * transient one marked permanent abandons a payment that would have succeeded.
 *
 * Stripe's own taxonomy decides it. `StripeConnectionError`,
 * `StripeAPIError` and a 5xx are the provider having a bad moment;
 * `StripeCardError`, `StripeInvalidRequestError` and an authentication failure
 * are answers no retry changes. Anything unrecognised is treated as RETRYABLE,
 * because assuming an unknown defect is permanent is how a recoverable outage
 * becomes an abandoned payment.
 */
export function toProviderError(error: unknown, stage: ProviderStage): ProviderError {
  if (error instanceof ProviderError) return error;

  if (error instanceof Stripe.errors.StripeError) {
    const permanent =
      error instanceof Stripe.errors.StripeCardError ||
      error instanceof Stripe.errors.StripeInvalidRequestError ||
      error instanceof Stripe.errors.StripeAuthenticationError ||
      error instanceof Stripe.errors.StripePermissionError ||
      error instanceof Stripe.errors.StripeSignatureVerificationError ||
      error instanceof Stripe.errors.StripeIdempotencyError;
    return new ProviderError({
      provider: "stripe",
      stage,
      message: error.message,
      retryable: !permanent,
      ...(error.code !== undefined ? { code: error.code } : {}),
    });
  }

  return new ProviderError({
    provider: "stripe",
    stage,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });
}

/** Run a Stripe call, mapping every failure into the gateway's vocabulary. */
async function call<T>(stage: ProviderStage, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  try {
    return await fn(getStripeClient());
  } catch (error) {
    throw toProviderError(error, stage);
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export function createStripePaymentIntent(
  params: Stripe.PaymentIntentCreateParams,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  return call("createPayment", (stripe) =>
    stripe.paymentIntents.create(params, { idempotencyKey }),
  );
}

export function retrieveStripePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
  return call("getStatus", (stripe) => stripe.paymentIntents.retrieve(id));
}

export function cancelStripePaymentIntent(
  id: string,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  // The idempotency key is a REQUEST OPTION (third argument), not a body
  // parameter. Passing it as the second argument type-checks in some SDK
  // versions and silently sends it as a field Stripe ignores — so the retry
  // that this key exists to make safe would create a second effect.
  return call("cancel", (stripe) => stripe.paymentIntents.cancel(id, {}, { idempotencyKey }));
}

export function captureStripePaymentIntent(
  id: string,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  return call("capture", (stripe) => stripe.paymentIntents.capture(id, {}, { idempotencyKey }));
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export function createStripeRefund(
  params: Stripe.RefundCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Refund> {
  return call("refund", (stripe) => stripe.refunds.create(params, { idempotencyKey }));
}

export function retrieveStripeRefund(id: string): Promise<Stripe.Refund> {
  return call("refund", (stripe) => stripe.refunds.retrieve(id));
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export function createStripeTransfer(
  params: Stripe.TransferCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Transfer> {
  return call("transfer", (stripe) => stripe.transfers.create(params, { idempotencyKey }));
}

export function createStripeTransferReversal(
  transferId: string,
  params: Stripe.TransferCreateReversalParams,
  idempotencyKey: string,
): Promise<Stripe.TransferReversal> {
  return call("transfer", (stripe) =>
    stripe.transfers.createReversal(transferId, params, { idempotencyKey }),
  );
}

export function retrieveStripeTransfer(id: string): Promise<Stripe.Transfer> {
  return call("transfer", (stripe) => stripe.transfers.retrieve(id));
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

/**
 * Submit a merchant's response to a dispute.
 *
 * `disputes.update` is the same call for saving a draft and for submitting; the
 * difference is `submit`, and it is one-way. The gateway only ever sends
 * `submit: true` (`services/disputeEvidence.ts` says why), so this signature
 * takes the whole body rather than hiding the flag.
 */
export function updateStripeDispute(
  id: string,
  params: Stripe.DisputeUpdateParams,
  idempotencyKey: string,
): Promise<Stripe.Dispute> {
  return call("dispute", (stripe) => stripe.disputes.update(id, params, { idempotencyKey }));
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * A charge with its BALANCE TRANSACTION expanded.
 *
 * Expanded rather than fetched separately because the id is on the charge and
 * the figures are on the transaction: two calls to answer one question, with a
 * window between them in which the charge could be refunded. The expansion is
 * one round trip and one consistent view.
 *
 * `balance_transaction` is null while Stripe has not created one — a payment
 * that has not settled. That is a real state and the caller reports it as
 * `pending`, never as zero fees.
 */
export function retrieveStripeChargeWithBalance(id: string): Promise<Stripe.Charge> {
  return call("settlement", (stripe) =>
    stripe.charges.retrieve(id, { expand: ["balance_transaction"] }),
  );
}

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

/**
 * Create a connected account with **Accounts v2** (Mercaria ADR 0008 D2-A).
 *
 * `POST /v1/accounts` is REFUSED on a modern platform account for every input,
 * measured, including a minimal `type=express` with no controller block. The v2
 * account reads back through `GET /v1/accounts/<id>` carrying ADR 0001 D2's
 * controller block verbatim, with `requirement_collection: stripe` DERIVED
 * rather than sent — which is the property that decision wanted, now obtained
 * by construction rather than by assertion.
 *
 * Typed through `rawRequest` because `stripe@22` ships the v2 account surface
 * with a shape that moves between minor versions; the response is narrowed by
 * the caller, which is the only place that knows which fields it needs.
 */
export function createStripeConnectedAccountV2(
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  return call("account", (stripe) =>
    stripe.rawRequest("POST", "/v2/core/accounts", body, {
      idempotencyKey,
    } as Stripe.RequestOptions),
  );
}

/**
 * Read a connected account through the **v1** API, deliberately (ADR 0008 D2-B).
 *
 * `v2.core.account` carries no `payouts_enabled`, `charges_enabled`,
 * `disabled_reason`, `default_currency` or payout schedule — readiness is
 * expressible in none of them. Reading through v1 answers all of it from the
 * same account. The obligation this creates is stated where the decision was
 * made: the v1 read is load-bearing, and if Stripe withdraws it, readiness
 * loses its inputs.
 */
export function retrieveStripeAccount(id: string): Promise<Stripe.Account> {
  return call("account", (stripe) => stripe.accounts.retrieve(id));
}

export function createStripeAccountLink(
  params: Stripe.AccountLinkCreateParams,
): Promise<Stripe.AccountLink> {
  return call("account", (stripe) => stripe.accountLinks.create(params));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Verify a webhook signature over the RAW body.
 *
 * **`constructEventAsync`, never `constructEvent`** — see the module header.
 * This is the single most transplantable bug in the port: the synchronous call
 * is what an example in Stripe's own docs uses, it type-checks, and under Bun
 * it throws on every real delivery.
 *
 * Tries each candidate secret in turn, which is what makes an endpoint-secret
 * rotation possible at all: Stripe cannot atomically swap one, so for the
 * length of the swap some deliveries are signed with the old secret and some
 * with the new. Trying only the current one rejects half of them as forgeries.
 */
export async function constructStripeEvent(
  payload: string,
  signature: string,
  secrets: readonly string[],
): Promise<Stripe.Event> {
  const stripe = getStripeClient();
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return await stripe.webhooks.constructEventAsync(payload, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProviderError({
    provider: "stripe",
    stage: "verifyEvent",
    message:
      lastError instanceof Error ? lastError.message : "webhook signature verification failed",
    // NEVER retryable. A bad signature is not a transient condition, and
    // retrying one is how a forged event eventually gets a lucky window.
    retryable: false,
    code: "invalid_signature",
  });
}
