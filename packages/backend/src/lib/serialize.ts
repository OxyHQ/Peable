import { buildFairCoinURI } from '@fairco.in/core';
import type {
  CurrencyCode,
  DisputeEvidence,
  Charge,
  Customer,
  DeletedCustomer,
  PaymentMethod,
  SetupIntent,
  Dispute,
  Merchant,
  PaymentIntent,
  PaymentIntentNextAction,
  Refund,
  RequestLog,
  Settlement,
  SocialPaymentSource,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  WebhookEvent,
} from '@peable.to/shared-types';
import { UNITS_PER_COIN, canExpire, normalizeDisputeReason } from '@peable.to/shared-types';
import type { ContributionDetails } from '@peable.to/contracts/contributions';
import { toUnix, toUnixOrNull } from './time';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import { faircoinOutputsOf, type PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import type { ChargeRow } from '../db/payments/chargeRepository';
import type { CustomerRow } from '../db/customers/customerRepository';
import type { PaymentMethodRow } from '../db/customers/paymentMethodRepository';
import type { SetupIntentRow } from '../db/customers/setupIntentRepository';
import type { DisputeRow } from '../db/disputes/disputeRepository';
import type { RefundRow } from '../db/refunds/refundRepository';
import type { ProviderSettlement } from '../services/providers/provider';
import type { StoredContribution } from '../db/schema/payments';
import type { WebhookDeliveryRow } from '../db/webhooks/webhookDeliveryRepository';
import type { WebhookEndpointRow } from '../db/webhooks/webhookEndpointRepository';
import type { EventRow } from '../db/events/eventRepository';
import type { RequestLogRow } from '../db/requestLogs/requestLogRepository';

/**
 * A FAIR base-unit amount as the decimal a `faircoin:` URI carries — exact,
 * never through a float: `150000000` → `"1.5"`.
 */
export function fairDecimal(baseUnits: string): string {
  const units = BigInt(baseUnits);
  const per = BigInt(UNITS_PER_COIN);
  const whole = units / per;
  const fraction = (units % per).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * What the payer must do next — derived from the row, never stored (ADR 0019).
 *
 * The card's confirmation credential is deliberately NOT here: the intent is
 * listed, polled and delivered in webhooks, and a credential on it would be a
 * credential in every one of those. `use_peable_sdk` tells the payer's client to
 * fetch it through `POST …/client_action`.
 */
function nextActionFor(row: PaymentIntentRow): PaymentIntentNextAction | null {
  if (row.status !== 'requires_action') return null;
  if (row.rail === 'faircoin' && row.address !== null && row.network !== null) {
    // ADR 0021 D6: one transaction with every output. A `faircoin:` URI names
    // ONE address, so a payment of several outputs has no `address`/`uri`.
    const outputs = faircoinOutputsOf(row);
    const single = outputs.length === 1 ? outputs[0] : undefined;
    return {
      type: 'faircoin_payment',
      faircoin_payment: {
        address: single?.address ?? null,
        network: row.network,
        amount: row.amount,
        currency: 'FAIR',
        uri: single ? buildFairCoinURI(single.address, fairDecimal(single.amount)) : null,
        outputs: outputs.map((output) => ({ address: output.address, amount: output.amount })),
      },
    };
  }
  return { type: 'use_peable_sdk' };
}

/**
 * Serialize a persisted PaymentIntent row to its public `PaymentIntent` DTO
 * (the wire/contract shape shared with the SDK, webhooks, and the wallet).
 * Instants become Unix seconds (ADR 0014 D1).
 *
 * Every id is the PUBLIC one, read in the same statement as the row: `pi_…`,
 * `merch_…`, `ca_…`, `cus_…`, `pm_…`, `ch_…`. Emitting an internal column would
 * put a uuid on a shipped contract (AGENTS.md "every id is two ids").
 */
export function toPaymentIntentDTO(row: PaymentIntentRow): PaymentIntent {
  const card = row.rail === 'card';
  return {
    id: row.publicId,
    object: 'payment_intent',
    livemode: row.livemode,
    status: row.status,
    rail: row.rail,
    // A card row written before payment method breadth carries no types until
    // the post-phase backfill sets them to the only thing it offered: card.
    payment_method_types: card ? (row.paymentMethodTypes ?? ['card']) : ['faircoin'],
    payment_method_configuration_details:
      card && row.paymentMethodConfigurationPublicId !== null
        ? { id: row.paymentMethodConfigurationPublicId }
        : null,
    amount: row.amount,
    amount_capturable: row.status === 'requires_capture' ? row.amount : '0',
    amount_received: row.amountReceived,
    amount_refunded: row.amountRefunded,
    // Read off the column, never written as a literal (ADR 0001 D4).
    currency: row.currency,
    capture_method: row.captureMethod,
    setup_future_usage: row.setupFutureUsage,
    customer: row.customerPublicId,
    payment_method: row.paymentMethodPublicId,
    latest_charge: card ? row.latestChargePublicId : null,
    next_action: nextActionFor(row),
    last_payment_error: row.lastPaymentError,
    cancellation_reason: row.cancellationReason,
    canceled_at: row.canceledAt === null ? null : toUnix(row.canceledAt),
    description: row.description,
    receipt_email: row.receiptEmail,
    statement_descriptor_suffix: row.statementDescriptorSuffix,
    shipping: row.shipping,
    faircoin:
      row.rail === 'faircoin' && row.network !== null && row.address !== null
        ? {
            network: row.network,
            address: faircoinOutputsOf(row).length === 1 ? row.address : null,
            outputs: faircoinOutputsOf(row).map((output) => ({
              address: output.address,
              amount: output.amount,
              connected_account: output.connectedAccountPublicId,
            })),
            txid: row.txid,
            confirmations: row.confirmations,
            required_confirmations: row.requiredConfirmations,
            quote: row.faircoinQuote ?? null,
            recipient_key_replaced_at: row.faircoinRecipientKeyReplacedAt
              ? toUnix(row.faircoinRecipientKeyReplacedAt)
              : null,
          }
        : null,
    merchant_id: row.merchantPublicId,
    // The PUBLIC `ca_…`. Never the internal `connectedAccountId`.
    connected_account: row.connectedAccountPublicId ?? null,
    // A destination charge (ADR 0015 §2): PUBLIC `ca_…`s, read with the row.
    application_fee_amount: row.applicationFeeAmount ?? null,
    transfer_data: row.transferDestinationPublicId
      ? { destination: row.transferDestinationPublicId, amount: row.transferAmount ?? null }
      : null,
    on_behalf_of: row.onBehalfOfPublicId ?? null,
    client_secret: row.clientSecret,
    metadata: row.metadata,
    expires_at: toUnix(row.expiresAt),
    // ADR 0012 D9: a processing payment never expires, whatever `expiresAt` says.
    can_expire: canExpire(row.status),
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/** Peable's own one-line explanation of an outcome — never the provider's prose. */
function sellerMessageFor(type: string | null): string | null {
  switch (type) {
    case 'authorized':
      return 'Payment complete.';
    case 'manual_review':
      return 'The payment is held for review.';
    case 'issuer_declined':
      return 'The bank declined this payment.';
    case 'blocked':
      return 'This payment was blocked as too risky.';
    case 'invalid':
      return 'The payment details were invalid.';
    default:
      return null;
  }
}

/**
 * A charge on the wire (ADR 0019). `captured` / `refunded` read the INTENT's
 * status with the row: a held authorization is not captured, and one released
 * by a cancellation is refunded in full.
 */
export function toChargeDTO(row: ChargeRow): Charge {
  const captured = row.amountCaptured !== '0';
  const released = !captured && row.intentStatus === 'canceled';
  return {
    id: row.publicId,
    object: 'charge',
    livemode: row.livemode,
    payment_intent: row.paymentIntentPublicId,
    customer: row.customerPublicId,
    payment_method: row.paymentMethodPublicId,
    amount: row.amount,
    amount_captured: row.amountCaptured,
    amount_refunded: released ? row.amount : row.amountRefunded,
    currency: row.currency,
    status: 'succeeded',
    paid: true,
    captured,
    refunded: released || (captured && BigInt(row.amountRefunded) >= BigInt(row.amountCaptured)),
    disputed: row.disputed,
    outcome:
      row.outcome === null
        ? null
        : {
            network_status: row.outcome.networkStatus,
            risk_level: row.outcome.riskLevel,
            type: row.outcome.type,
            seller_message: sellerMessageFor(row.outcome.type),
          },
    billing_details: row.billingDetails,
    payment_method_details: row.paymentMethodDetails,
    receipt_url: null,
    balance_transaction: row.balanceTransactionPublicId,
    application_fee: row.applicationFeePublicId,
    application_fee_amount: row.applicationFeeAmount,
    description: row.description,
    receipt_email: row.receiptEmail,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

/**
 * Serialize a persisted Merchant row to its public `Merchant` DTO.
 * `nextDerivationIndex` is deliberately omitted (see
 * `@peable.to/shared-types`'s `Merchant` doc comment).
 */
export function toMerchantDTO(row: MerchantRow): Merchant {
  return {
    id: row.publicId,
    object: 'merchant',
    livemode: row.livemode,
    oxy_app_id: row.oxyAppId,
    environment: row.environment,
    network: row.network,
    owner_account: row.ownerAccountId,
    required_confirmations: row.requiredConfirmations,
    display_name: row.displayName ?? undefined,
    avatar_file_id: row.avatarFileId ?? undefined,
    business_logo: row.businessLogo ?? undefined,
    description: row.description ?? undefined,
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * Serialize a delivery to its public `WebhookDelivery` DTO. The event and the
 * endpoint are named by their PUBLIC ids, joined in by the repository — the
 * row holds their primary keys, which no contract names.
 */
export function toWebhookDeliveryDTO(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    object: 'webhook_delivery',
    livemode: row.livemode,
    event_id: row.eventPublicId,
    event_type: row.eventType,
    webhook_endpoint_id: row.endpointPublicId,
    url: row.url,
    attempts: row.attempts,
    delivered: row.delivered,
    last_status: row.lastStatus,
    // Omitted rather than emitted as `null`: the DTO's optional fields mean
    // "there is nothing to say".
    ...(row.lastError !== null ? { last_error: row.lastError } : {}),
    ...(row.nextAttemptAt !== null ? { next_attempt_at: toUnix(row.nextAttemptAt) } : {}),
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * Render a stored event (ADR 0014 D4) — the body of every webhook delivery of
 * it and the answer of `GET /v1/events/:id`, byte for byte the same object.
 *
 * Rendered from the stored snapshot, never rebuilt from the resource as it is
 * now: an event describes a moment.
 */
export function toEventDTO(row: EventRow): WebhookEvent {
  return {
    id: row.publicId,
    object: 'event',
    type: row.type,
    created: toUnix(row.createdAt),
    livemode: row.livemode,
    api_version: row.apiVersion,
    ...(row.account !== null ? { account: row.account } : {}),
    data: {
      object: row.dataObject,
      ...(row.previousAttributes !== null ? { previous_attributes: row.previousAttributes } : {}),
    },
    request: { id: row.requestId, idempotency_key: row.idempotencyKey },
  } as unknown as WebhookEvent;
}

/** Serialize one request log. Its `id` is the request's `Request-Id`. */
export function toRequestLogDTO(row: RequestLogRow): RequestLog {
  return {
    id: row.requestId,
    object: 'request_log',
    livemode: row.livemode,
    method: row.method,
    path: row.path,
    status: row.status,
    duration_ms: row.durationMs,
    idempotency_key: row.idempotencyKey,
    created: toUnix(row.createdAt),
  };
}

/** Serialize an endpoint, as every answer but a create and a roll renders it: never the secret. */
export function toWebhookEndpointDTO(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.publicId,
    object: 'webhook_endpoint',
    livemode: row.livemode,
    url: row.url,
    description: row.description,
    enabled_events: row.enabledEvents,
    status: row.status,
    disabled_reason: row.disabledReason,
    api_version: row.apiVersion,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * The endpoint with its signing secret — ONLY the two responses that show it,
 * the create and a roll, call this. The row never carries the secret; the
 * caller passes the one it just generated.
 */
export function toWebhookEndpointWithSecretDTO(
  row: WebhookEndpointRow,
  secret: string,
): WebhookEndpointWithSecret {
  return { ...toWebhookEndpointDTO(row), secret };
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
 * A refund on the wire — the provider's own refund id never appears in it. The
 * intent's PUBLIC id is a parameter, for `toDisputeDTO`'s reason.
 */
export function toRefundDTO(row: RefundRow, paymentIntentPublicId: string): Refund {
  return {
    id: row.publicId,
    object: 'refund',
    livemode: row.livemode,
    external_ref: row.externalRef,
    origin: row.origin,
    payment_intent: paymentIntentPublicId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    failure_code: row.failureCode,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * The ONE `settlement` object (`GET …/settlement` of a payment, a refund or a
 * dispute): the provider's figures as read, beside the public ids of what they
 * describe — `refund` and `dispute` `null` unless it is theirs.
 */
export function toSettlementDTO(
  settlement: ProviderSettlement,
  subject: {
    readonly livemode: boolean;
    readonly paymentIntentPublicId: string;
    readonly refundPublicId?: string;
    readonly disputePublicId?: string;
  },
): Settlement {
  return {
    object: 'settlement',
    livemode: subject.livemode,
    payment_intent: subject.paymentIntentPublicId,
    refund: subject.refundPublicId ?? null,
    dispute: subject.disputePublicId ?? null,
    status: settlement.status,
    gross: settlement.gross,
    fee: settlement.fee,
    net: settlement.net,
    currency: settlement.currency,
    available_on: toUnixOrNull(settlement.availableOn),
    exchange_rate: settlement.exchangeRate,
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
export function toDisputeDTO(
  row: DisputeRow,
  paymentIntentPublicId: string,
  /**
   * The evidence, on a LIVE read only (`services/disputeEvidence.ts`). An event
   * payload and a list item are built without it: an event is stored, and
   * evidence carries a customer's personal data this gateway does not keep.
   */
  evidence?: DisputeEvidence,
  now: Date = new Date(),
): Dispute {
  const submitted = row.evidenceSubmittedAt !== null;
  return {
    id: row.publicId,
    object: 'dispute',
    livemode: row.livemode,
    amount: row.amount,
    currency: row.currency as CurrencyCode,
    charge: row.chargePublicId,
    payment_intent: paymentIntentPublicId,
    status: row.status,
    // The provider's word stays on the row; the wire speaks Stripe's enum.
    reason: normalizeDisputeReason(row.reason),
    is_charge_refundable: row.isChargeRefundable,
    evidence_details: {
      due_by: toUnixOrNull(row.evidenceDueAt),
      has_evidence: row.hasEvidence || submitted,
      past_due:
        !submitted && row.evidenceDueAt !== null && row.evidenceDueAt.getTime() <= now.getTime(),
      submission_count: submitted ? 1 : 0,
      submitted_at: toUnixOrNull(row.evidenceSubmittedAt),
    },
    ...(evidence === undefined ? {} : { evidence }),
    metadata: row.metadata,
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

/** A customer on the wire (ADR 0016) — the provider binding never appears. */
export function toCustomerDTO(row: CustomerRow): Customer {
  return {
    id: row.publicId,
    object: 'customer',
    livemode: row.livemode,
    email: row.email,
    name: row.name,
    phone: row.phone,
    description: row.description,
    address: row.address,
    shipping: row.shipping,
    preferred_locales: [...row.preferredLocales],
    invoice_settings: { default_payment_method: row.defaultPaymentMethodPublicId },
    metadata: row.metadata,
    balance: row.balance,
    currency: row.currency,
    test_clock: row.testClockPublicId,
    created: toUnix(row.createdAt),
  };
}

/** What `DELETE /v1/customers/:id` and an expanded tombstone answer. */
export function toDeletedCustomerDTO(row: CustomerRow): DeletedCustomer {
  return { id: row.publicId, object: 'customer', deleted: true };
}

/** A payment method on the wire (ADR 0016) — the provider's id never appears. */
export function toPaymentMethodDTO(row: PaymentMethodRow): PaymentMethod {
  return {
    id: row.publicId,
    object: 'payment_method',
    livemode: row.livemode,
    type: row.type,
    card: row.card,
    billing_details: row.billingDetails,
    customer: row.customerPublicId,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}

/**
 * A SetupIntent on the wire (ADR 0016). `client_secret` is PEABLE's capability
 * over the SetupIntent; the provider's confirmation credential is never here —
 * the payer's client fetches it through `POST …/client_action`.
 */
export function toSetupIntentDTO(row: SetupIntentRow): SetupIntent {
  return {
    id: row.publicId,
    object: 'setup_intent',
    livemode: row.livemode,
    status: row.status,
    usage: row.usage,
    payment_method_types: ['card'],
    customer: row.customerPublicId,
    payment_method: row.paymentMethodPublicId,
    client_secret: row.clientSecret,
    next_action: row.status === 'requires_action' ? { type: 'use_peable_sdk' } : null,
    last_setup_error: row.lastSetupError,
    cancellation_reason: row.cancellationReason,
    description: row.description,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
  };
}
