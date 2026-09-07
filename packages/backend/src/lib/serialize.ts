import type {
  CheckoutSession,
  CheckoutSessionPublic,
  Dispute,
  Merchant,
  MerchantDisplay,
  PaymentIntent,
  PaymentLink,
  PublicPaymentLink,
  WebhookDelivery,
} from "@peable.to/shared-types";
import { config } from "../config";
import type { MerchantRow } from "../db/merchants/merchantRepository";
import type { PaymentIntentRow } from "../db/payments/paymentIntentRepository";
import type { PaymentLinkRow } from "../db/payments/paymentLinkRepository";
import type { CheckoutSessionRow } from "../db/payments/checkoutSessionRepository";
import type { DisputeRow } from "../db/disputes/disputeRepository";
import type { WebhookDeliveryRow } from "../db/webhooks/webhookDeliveryRepository";

/**
 * Serialize a persisted PaymentIntent row to its public `PaymentIntent` DTO
 * (the wire/contract shape shared with the SDK, webhooks, and the wallet).
 * The internal-only `idempotencyKey` is deliberately omitted — the repository
 * never selects it — and dates become ISO strings.
 *
 * `id` is the PUBLIC `pi_…`, which is what the wire contract has always
 * carried: the Mongo schema field was itself called `id`, and here the same
 * value lives in `public_id` beside the internal primary key. Emitting
 * `row.id` would put a uuid on a shipped contract.
 */
export function toPaymentIntentDTO(row: PaymentIntentRow): PaymentIntent {
  return {
    id: row.publicId,
    object: "payment_intent",
    status: row.status,
    rail: row.rail,
    amount: row.amount,
    // Read off the column, never written as a literal. The literal "FAIR" that
    // stood here was the reason widening the CHECK alone would have produced
    // rows the API described incorrectly, with every test green (ADR 0001 D4).
    currency: row.currency,
    network: row.network,
    address: row.address,
    merchantId: row.merchantId,
    txid: row.txid,
    confirmations: row.confirmations,
    clientSecret: row.clientSecret,
    metadata: row.metadata,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a persisted Merchant row to its public `Merchant` DTO.
 * `webhookSecret` and `nextDerivationIndex` are deliberately omitted (see
 * `@peable.to/shared-types`'s `Merchant` doc comment); the repository does not
 * select the secret at all.
 */
export function toMerchantDTO(row: MerchantRow): Merchant {
  return {
    id: row.publicId,
    object: "merchant",
    oxyAppId: row.oxyAppId,
    environment: row.environment,
    network: row.network,
    xpub: row.xpub,
    webhookUrl: row.webhookUrl ?? undefined,
    requiredConfirmations: row.requiredConfirmations,
    displayName: row.displayName ?? undefined,
    avatarFileId: row.avatarFileId ?? undefined,
    description: row.description ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a persisted WebhookDelivery row to its public `WebhookDelivery`
 * DTO.
 *
 * `intentPublicId` is a SEPARATE parameter rather than a field of the row,
 * because the delivery stores the intent's internal primary key while
 * `WebhookDelivery.intentId` on the wire carries the public `pi_…`. The two
 * callers get it two different ways — the list path joins it in
 * (`listDeliveriesForMerchant` returns `intentPublicId` per row) and the
 * redelivery path already holds the intent row it loaded — so requiring it
 * explicitly is what stops a caller silently emitting a uuid on a shipped
 * contract.
 */
export function toWebhookDeliveryDTO(
  row: WebhookDeliveryRow,
  intentPublicId: string,
): WebhookDelivery {
  return {
    id: row.id,
    object: "webhook_delivery",
    merchantId: row.merchantId,
    intentId: intentPublicId,
    eventId: row.eventId,
    eventType: row.eventType,
    url: row.url,
    attempts: row.attempts,
    delivered: row.delivered,
    lastStatus: row.lastStatus,
    // Omitted rather than emitted as `null`: the DTO's optional fields mean
    // "there is nothing to say", and a `lastError: null` on a delivered
    // delivery reads like an error field a consumer has to check.
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    ...(row.nextAttemptAt !== null
      ? { nextAttemptAt: row.nextAttemptAt.toISOString() }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a persisted PaymentLink row to its merchant-facing DTO
 * (the SDK/dashboard CRUD shape). `url` is built from `config.checkoutBaseUrl`
 * so it always points at the hosted checkout page for the CURRENT deploy.
 */
export function toPaymentLinkDTO(row: PaymentLinkRow): PaymentLink {
  return {
    id: row.publicId,
    object: "payment_link",
    amount: row.amount,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    active: row.active,
    metadata: row.metadata,
    successUrl: row.successUrl ?? undefined,
    url: `${config.checkoutBaseUrl}/l/${row.publicId}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a persisted PaymentLink row to what an UNAUTHENTICATED
 * checkout-page visitor may see: no `metadata`, no `successUrl`, no internal
 * ids beyond the public one. `merchant` is resolved separately by
 * `services/merchantDisplay.ts` and passed in — this function never touches
 * the network to build it.
 */
export function toPublicPaymentLinkDTO(
  row: PaymentLinkRow,
  merchant: MerchantDisplay,
): PublicPaymentLink {
  return {
    id: row.publicId,
    object: "payment_link",
    amount: row.amount,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    active: row.active,
    merchant,
  };
}

/**
 * Serialize a persisted CheckoutSession row to its merchant/SDK-facing DTO.
 * The wrapped intent is passed in rather than re-fetched here, and supplies
 * both `paymentIntentId` and `clientSecret` — the session row itself
 * deliberately never stores a copy of the secret.
 *
 * `paymentIntentId` is the intent's PUBLIC `pi_…`, not the internal reference
 * the session stores, because that is what the shipped contract carries.
 */
export function toCheckoutSessionDTO(
  row: CheckoutSessionRow,
  intent: PaymentIntentRow,
): CheckoutSession {
  return {
    id: row.publicId,
    object: "checkout_session",
    paymentIntentId: intent.publicId,
    clientSecret: intent.clientSecret,
    amount: row.amount,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    metadata: row.metadata,
    successUrl: row.successUrl ?? undefined,
    cancelUrl: row.cancelUrl ?? undefined,
    url: `${config.checkoutBaseUrl}/c/${row.publicId}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a persisted CheckoutSession row to what the checkout page
 * loads at `/c/:id`, authorized by possession of the wrapped intent's
 * `client_secret` (see `routes/checkoutSessions.ts`'s public GET). Reuses
 * `toPaymentIntentDTO`'s output unchanged for `paymentIntent` — it already
 * carries `clientSecret`, which the page needs to open the socket and to
 * `submit_tx`.
 */
export function toCheckoutSessionPublicDTO(
  row: CheckoutSessionRow,
  merchant: MerchantDisplay,
  intent: PaymentIntentRow,
): CheckoutSessionPublic {
  return {
    id: row.publicId,
    object: "checkout_session",
    successUrl: row.successUrl ?? undefined,
    cancelUrl: row.cancelUrl ?? undefined,
    merchant,
    paymentIntent: toPaymentIntentDTO(intent),
  };
}

/**
 * A dispute row on the wire.
 *
 * Takes the intent's PUBLIC id as an argument rather than reading it, for the
 * reason `listDeliveriesForMerchant` joins it in: the row holds the INTERNAL
 * foreign key, and every contract here calls the public `pi_…` the `id`.
 *
 * The network's own dispute id never appears. It is the acquirer's handle, not
 * the merchant's, and putting it on a contract would make an acquirer detail
 * something integrations start depending on — which is the coupling ADR 0001 D3
 * exists to prevent.
 */
export function toDisputeDTO(row: DisputeRow, paymentIntentPublicId: string): Dispute {
  return {
    id: row.publicId,
    object: 'dispute',
    paymentIntentId: paymentIntentPublicId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    evidenceDueAt: row.evidenceDueAt ? row.evidenceDueAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
