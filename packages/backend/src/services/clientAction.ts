/**
 * What a payer's client has to do next, on demand.
 *
 * ## Why this is an operation and not a field
 *
 * `POST /v1/payment_intents` returns a `client_action` in its own response and
 * the DTO deliberately carries none: a client secret is a CONFIRMATION
 * CREDENTIAL, and putting one on the payment-intent shape would hand it out on
 * every list, every re-read and every dashboard query — including for payments
 * the reader has no business confirming.
 *
 * That left no way to RESUME. A payer who refreshed the page, returned from an
 * SCA challenge in a new tab, or came back the next day had nothing to confirm
 * with, and the only way to get one was to create a second payment. Mercaria's
 * own adapter has a `resumePayment` that re-reads the intent expecting this
 * field and finds nothing there.
 *
 * So it is a separate, bounded operation: one payment, named explicitly, by a
 * caller who has proven they may pay it. Never a list, never cached, and never
 * part of a shape something else serializes by accident.
 *
 * ## The two client secrets are not the same secret
 *
 * Peable's `client_secret` is the payer's capability over the INTENT — it
 * authorizes reading, subscribing and reporting a txid. The provider's is a
 * credential over the PAYMENT at the acquirer. This function takes the first
 * and returns the second, and the direction is one-way: nothing derives one
 * from the other, and the provider's is read live and never stored.
 */
import { canStillBePaid } from "@peable.to/shared-types";
import { config } from "../config";
import type { PaymentIntentRow } from "../db/payments/paymentIntentRepository";
import type { ProviderClientAction } from "./providers/provider";
import { resolveProvider } from "./providers/registry";

export interface ClientActionResult {
  readonly kind: ProviderClientAction["kind"];
  readonly value: string;
  /**
   * The provider's PUBLISHABLE key, when this deployment has one.
   *
   * Public by construction, and served here rather than baked into the hosted
   * checkout's bundle: that page is deployed once and serves whichever gateway
   * it is pointed at, so a compiled-in key would be the wrong mode the first
   * time a test deployment used the same page.
   */
  readonly publishableKey?: string;
}

export type ClientActionOutcome =
  | { readonly kind: "ok"; readonly action: ClientActionResult }
  /** This rail has no client action — FairCoin tells the payer an address instead. */
  | { readonly kind: "not_applicable" }
  /** The payment is over. Handing out a credential for it would be handing out nothing. */
  | { readonly kind: "unpayable"; readonly status: string }
  /** The rail is off on this deployment, or the provider could not be reached. */
  | { readonly kind: "unavailable"; readonly error: string };

/**
 * Read the payer's next step from the provider, live.
 *
 * Read rather than remembered, for the reason the field is absent from the DTO:
 * a stored client secret is one that appears in every backup and every support
 * query, and it stays valid.
 */
export async function resolveClientAction(
  intent: PaymentIntentRow,
): Promise<ClientActionOutcome> {
  if (intent.rail !== "card" || !intent.provider) return { kind: "not_applicable" };

  // A payment nobody can pay any more has no next step, and answering one would
  // be worse than answering nothing: a checkout that receives a credential
  // renders a card form over a payment that is already settled, expired or
  // rejected.
  if (!canStillBePaid(intent.status)) return { kind: "unpayable", status: intent.status };

  const provider = resolveProvider(intent.provider);
  if (!provider) {
    return {
      kind: "unavailable",
      error: `the ${intent.provider} rail is not configured on this deployment`,
    };
  }
  if (!intent.providerObjectId) {
    // The two-step create was interrupted and never finished. `createIntent`
    // resumes it on a replay of the merchant's `Idempotency-Key`; this surface
    // has no key to replay, so it reports honestly rather than creating a
    // second payment the merchant does not know about.
    return {
      kind: "unavailable",
      error: "this payment was never completed at the provider; create it again",
    };
  }

  const result = await provider.getStatus(intent.providerObjectId);
  if (!result.clientAction) {
    return {
      kind: "unavailable",
      error: "the provider offered no way to confirm this payment",
    };
  }

  return {
    kind: "ok",
    action: {
      kind: result.clientAction.kind,
      value: result.clientAction.value,
      ...(config.stripe.publishableKey === undefined
        ? {}
        : { publishableKey: config.stripe.publishableKey }),
    },
  };
}
