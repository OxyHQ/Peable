import type {
  CheckoutSession,
  CheckoutSessionPublic,
  Dispute,
  Merchant,
  MerchantDisplay,
  PaymentIntent,
  PaymentLink,
  PublicPaymentLink,
  SocialPaymentSource,
  WebhookDelivery,
} from '@peable.to/shared-types';
import { canExpire } from '@peable.to/shared-types';
import type { ContributionDetails } from '@peable.to/contracts';
import { config } from '../config';
import { toUnix, toUnixOrNull } from './time';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import type { PaymentLinkRow } from '../db/payments/paymentLinkRepository';
import type { CheckoutSessionRow } from '../db/payments/checkoutSessionRepository';
import type { DisputeRow } from '../db/disputes/disputeRepository';
import type { StoredContribution } from '../db/schema/payments';
import type { WebhookDeliveryRow } from '../db/webhooks/webhookDeliveryRepository';

/**
 * Serialize a persisted PaymentIntent row to its public `PaymentIntent` DTO
 * (the wire/contract shape shared with the SDK, webhooks, and the wallet).
 * The internal-only `idempotencyKey` is deliberately omitted — the repository
 * never selects it — and instants become Unix seconds (ADR 0014 D1).
 *
 * `id` is the PUBLIC `pi_…`, which is what the wire contract has always
 * carried; the value lives in `public_id` beside the internal primary key. Emitting
 * `row.id` would put a uuid on a shipped contract.
 */
export function toPaymentIntentDTO(row: PaymentIntentRow): PaymentIntent {
  return {
    id: row.publicId,
    object: 'payment_intent',
    livemode: row.livemode,
    status: row.status,
    rail: row.rail,
    amount: row.amount,
    // Read off the column, never written as a literal. The literal "FAIR" that
    // stood here was the reason widening the CHECK alone would have produced
    // rows the API described incorrectly, with every test green (ADR 0001 D4).
    currency: row.currency,
    network: row.network,
    address: row.address,
    merchant_id: row.merchantId,
    // The PUBLIC `ca_…`, read in the same statement as the row. Never the
    // internal `connectedAccountId` — that is a uuid this contract never names.
    connected_account: row.connectedAccountPublicId ?? null,
    txid: row.txid,
    confirmations: row.confirmations,
    client_secret: row.clientSecret,
    metadata: row.metadata,
    expires_at: toUnix(row.expiresAt),
    // ADR 0012 D9: a broadcast or confirming payment never expires, whatever
    // `expiresAt` says — said per intent so a platform never has to know the set.
    can_expire: canExpire(row.status),
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
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
    object: 'merchant',
    livemode: row.livemode,
    oxy_app_id: row.oxyAppId,
    environment: row.environment,
    network: row.network,
    xpub: row.xpub,
    webhook_url: row.webhookUrl ?? undefined,
    required_confirmations: row.requiredConfirmations,
    display_name: row.displayName ?? undefined,
    avatar_file_id: row.avatarFileId ?? undefined,
    description: row.description ?? undefined,
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * Serialize a persisted WebhookDelivery row to its public `WebhookDelivery`
 * DTO.
 *
 * `intentPublicId` is a SEPARATE parameter rather than a field of the row,
 * because the delivery stores the intent's internal primary key while
 * `WebhookDelivery.intent_id` on the wire carries the public `pi_…`. The two
 * callers get it two different ways — the list path joins it in
 * (`listDeliveriesForMerchant` returns `intentPublicId` per row) and the
 * redelivery path already holds the intent row it loaded — so requiring it
 * explicitly is what stops a caller silently emitting a uuid on a shipped
 * contract.
 */
export function toWebhookDeliveryDTO(
  row: WebhookDeliveryRow,
  /**
   * `null` when the event is not about a payment — `connected_account.updated`
   * is about a seller. Passed explicitly rather than read off the row for the
   * reason the transfer serializer takes its ids explicitly: the row holds the
   * internal key, and a serializer reaching for it would put a uuid on a
   * contract that promises a `pi_…`.
   */
  intentPublicId: string | null,
): WebhookDelivery {
  return {
    id: row.id,
    object: 'webhook_delivery',
    livemode: row.livemode,
    merchant_id: row.merchantId,
    intent_id: intentPublicId,
    event_id: row.eventId,
    event_type: row.eventType,
    url: row.url,
    attempts: row.attempts,
    delivered: row.delivered,
    last_status: row.lastStatus,
    // Omitted rather than emitted as `null`: the DTO's optional fields mean
    // "there is nothing to say", and a `lastError: null` on a delivered
    // delivery reads like an error field a consumer has to check.
    ...(row.lastError !== null ? { last_error: row.lastError } : {}),
    ...(row.nextAttemptAt !== null ? { next_attempt_at: toUnix(row.nextAttemptAt) } : {}),
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * A contribution's stored details on the wire: snake_case, and the expiry as
 * Unix seconds. The stored shape keeps the keys its CHECK constraint reads
 * (`StoredContribution`); this is the one place the two meet.
 */
export function toContributionDetails(stored: StoredContribution): ContributionDetails {
  return {
    organization_id: stored.organizationId,
    purpose: stored.purpose,
    amount_mode: stored.amountMode,
    expires_at: stored.expiresAt === null ? null : toUnix(new Date(stored.expiresAt)),
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
    object: 'payment_link',
    livemode: row.livemode,
    amount: row.amount,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    active:
      row.active &&
      (!row.contribution?.expiresAt || Date.parse(row.contribution.expiresAt) > Date.now()),
    ...(row.contribution ? { contribution: toContributionDetails(row.contribution) } : {}),
    metadata: row.metadata,
    success_url: row.successUrl ?? undefined,
    url: `${config.checkoutBaseUrl}/l/${row.publicId}`,
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * Serialize a persisted PaymentLink row to what an UNAUTHENTICATED
 * checkout-page visitor may see: no `metadata`, no `success_url`, no internal
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
    object: 'payment_link',
    livemode: row.livemode,
    amount: row.amount,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    active:
      row.active &&
      (!row.contribution?.expiresAt || Date.parse(row.contribution.expiresAt) > Date.now()),
    ...(row.contribution ? { contribution: toContributionDetails(row.contribution) } : {}),
    merchant,
  };
}

/**
 * Serialize a persisted CheckoutSession row to its merchant/SDK-facing DTO.
 * The wrapped intent is passed in rather than re-fetched here, and supplies
 * both `payment_intent` and `client_secret` — the session row itself
 * deliberately never stores a copy of the secret.
 *
 * `payment_intent` is the intent's PUBLIC `pi_…`, not the internal reference
 * the session stores, because that is what the shipped contract carries.
 */
export function toCheckoutSessionDTO(
  row: CheckoutSessionRow,
  intent: PaymentIntentRow,
): CheckoutSession {
  return {
    id: row.publicId,
    object: 'checkout_session',
    livemode: row.livemode,
    payment_intent: intent.publicId,
    client_secret: intent.clientSecret,
    amount: row.amount,
    currency: row.currency,
    rail: row.rail,
    network: row.network,
    // From the INTENT, which carries the public `ca_…`; the session row holds
    // only the internal id.
    connected_account: intent.connectedAccountPublicId ?? null,
    metadata: row.metadata,
    success_url: row.successUrl ?? undefined,
    cancel_url: row.cancelUrl ?? undefined,
    url: `${config.checkoutBaseUrl}/c/${row.publicId}`,
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * Serialize a persisted CheckoutSession row to what the checkout page
 * loads at `/c/:id`, authorized by possession of the wrapped intent's
 * `client_secret` (see `routes/checkoutSessions.ts`'s public GET). Reuses
 * `toPaymentIntentDTO`'s output unchanged for `payment_intent` — it already
 * carries `client_secret`, which the page needs to open the socket and to
 * `submit_tx`.
 */
export function toCheckoutSessionPublicDTO(
  row: CheckoutSessionRow,
  merchant: MerchantDisplay,
  intent: PaymentIntentRow,
): CheckoutSessionPublic {
  return {
    id: row.publicId,
    object: 'checkout_session',
    livemode: row.livemode,
    success_url: row.successUrl ?? undefined,
    cancel_url: row.cancelUrl ?? undefined,
    merchant,
    payment_intent: toPaymentIntentDTO(intent),
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
    livemode: row.livemode,
    payment_intent: paymentIntentPublicId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    evidence_due_at: toUnixOrNull(row.evidenceDueAt),
    evidence_submitted_at: toUnixOrNull(row.evidenceSubmittedAt),
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * The two source columns of a social attribution as the wire's optional
 * `SocialPaymentSource`, or `undefined` when the payer's app named nothing.
 *
 * `undefined` and not `{ app: 'unknown' }`: a payment with no context is the
 * ordinary case (one person paying another), and a placeholder would be the
 * gateway asserting something no caller said. A client renders the context or
 * renders nothing.
 *
 * `app` decides, never `ref`. A ref with no app is refused by
 * `social_send_attributions_source_ref_needs_app_check`, so the row cannot say
 * otherwise — and keying off `ref` would drop the context of an app that named
 * itself without pointing at one thing.
 *
 * `ref` is copied out verbatim and is not inspected. Nothing in this repository
 * parses, resolves or links it; that is the property that keeps "what was this
 * payment for" a string the two parties' apps understand rather than something
 * the gateway knows.
 */
export function toSocialPaymentSource(row: {
  sourceApp: string | null;
  sourceRef: string | null;
}): SocialPaymentSource | undefined {
  if (row.sourceApp === null) return undefined;
  // `ref` is omitted rather than set to `null` when absent: the contract types
  // it optional, and `JSON.stringify` drops an `undefined` property, so the two
  // shapes are not interchangeable on the wire.
  return row.sourceRef === null
    ? { app: row.sourceApp }
    : { app: row.sourceApp, ref: row.sourceRef };
}
