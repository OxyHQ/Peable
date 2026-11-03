// The payments vocabulary (ADR 0014 D5): the closed value sets the payment
// intent, charge, refund, dispute, setup intent, social and test-helper
// contracts are built from. Zod-free, so the wallet and the shared types read
// them without bundling a schema.

/**
 * Which rail moves the money (ADR 0001 D1). On the INTENT, not on the merchant:
 * one merchant takes both, and the rail decides which fields mean anything.
 */
export const PAYMENT_INTENT_RAILS = ['faircoin', 'card'] as const;
export type PaymentIntentRail = (typeof PAYMENT_INTENT_RAILS)[number];

/**
 * Stripe's seven statuses, and no others (ADR 0019). The FairCoin rail walks
 * four of them (`requires_action` → `processing` → `succeeded` | `canceled`); a
 * card walks all seven. The order is the lifecycle table's
 * (`@peable.to/shared-types`), which the database CHECK is rendered from.
 */
export const PAYMENT_INTENT_STATUSES = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'succeeded',
  'canceled',
] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/**
 * Why an intent was cancelled — Stripe's reasons, plus `underpaid` (FairCoin
 * only: a transaction paid less than the amount).
 */
export const PAYMENT_INTENT_CANCELLATION_REASONS = [
  'abandoned',
  'automatic',
  'duplicate',
  'fraudulent',
  'requested_by_customer',
  'underpaid',
] as const;
export type PaymentIntentCancellationReason = (typeof PAYMENT_INTENT_CANCELLATION_REASONS)[number];

/** The reasons a MERCHANT may give `POST /v1/payment_intents/:id/cancel`. */
export const MERCHANT_CANCELLATION_REASONS = [
  'abandoned',
  'duplicate',
  'fraudulent',
  'requested_by_customer',
] as const satisfies readonly PaymentIntentCancellationReason[];
export type MerchantCancellationReason = (typeof MERCHANT_CANCELLATION_REASONS)[number];

/** When a card is captured: at confirmation, or by `POST …/capture` (card only). */
export const PAYMENT_INTENT_CAPTURE_METHODS = ['automatic', 'manual'] as const;
export type PaymentIntentCaptureMethod = (typeof PAYMENT_INTENT_CAPTURE_METHODS)[number];

/** Card only: keep the payment method on the customer for later (ADR 0016). */
export const PAYMENT_INTENT_SETUP_FUTURE_USAGES = ['on_session', 'off_session'] as const;
export type PaymentIntentSetupFutureUsage = (typeof PAYMENT_INTENT_SETUP_FUTURE_USAGES)[number];

/** The card-rail types a PaymentIntent can carry in `payment_method_types`. */
export const CARD_RAIL_PAYMENT_METHOD_TYPES = [
  'card',
  'sepa_debit',
  'ideal',
  'bancontact',
  'eps',
] as const;
export type CardRailPaymentMethodType = (typeof CARD_RAIL_PAYMENT_METHOD_TYPES)[number];

/**
 * Every payment method type a PaymentIntent can carry: `faircoin` on the chain
 * rail, the card rail's otherwise. Wallets (Apple Pay, Google Pay) are `card`.
 */
export const PAYMENT_METHOD_TYPES = ['faircoin', ...CARD_RAIL_PAYMENT_METHOD_TYPES] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

/** The kinds of `last_payment_error` (and a SetupIntent's `last_setup_error`). */
export const PAYMENT_ERROR_TYPES = ['card_error', 'payment_error', 'api_error'] as const;
export type PaymentErrorType = (typeof PAYMENT_ERROR_TYPES)[number];

/** How the payer's client continues: a confirmation credential, or a redirect. */
export const CLIENT_ACTION_KINDS = ['client_secret', 'redirect'] as const;
export type ClientActionKind = (typeof CLIENT_ACTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Refunds and settlements
// ---------------------------------------------------------------------------

/**
 * Where one refund stands — the MONEY's own lifecycle, not the payment's.
 * `canceled` only through `POST /v1/refunds/:id/cancel`.
 */
export const REFUND_STATUSES = ['pending', 'succeeded', 'failed', 'canceled'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Stripe's refund reasons. */
export const REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/**
 * Who created a refund. `provider`: it appeared at the acquirer (a dashboard
 * refund, a dispute's resolution) and was imported, without an `external_ref`.
 */
export const REFUND_ORIGINS = ['merchant', 'provider'] as const;
export type RefundOrigin = (typeof REFUND_ORIGINS)[number];

/** Where a payment's settlement figures stand. `unknown` is not zero. */
export const SETTLEMENT_STATUSES = ['available', 'pending', 'unknown'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

/**
 * Where a dispute stands. `needs_response` and `under_review` are open; `won`
 * and `lost` are terminal. There is deliberately no `closed`.
 */
export const DISPUTE_STATUSES = ['needs_response', 'under_review', 'won', 'lost'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** Why the cardholder disputed — Stripe's enum; an unmapped network reason reads `general`. */
export const DISPUTE_REASONS = [
  'bank_cannot_process',
  'check_returned',
  'credit_not_processed',
  'customer_initiated',
  'debit_not_authorized',
  'duplicate',
  'fraudulent',
  'general',
  'incorrect_account_details',
  'insufficient_funds',
  'noncompliant',
  'product_not_received',
  'product_unacceptable',
  'subscription_canceled',
  'unrecognized',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/**
 * The TEXT evidence fields — the network's names, never a Peable paraphrase: a
 * merchant assembling a defence reads their acquirer's guidance, and renamed
 * fields would make it not apply. The Stripe adapter's name map is a total
 * `Record` over this set, so a field added here does not compile until it
 * carries it.
 */
export const DISPUTE_TEXT_EVIDENCE_FIELDS = [
  'access_activity_log',
  'billing_address',
  'cancellation_policy_disclosure',
  'cancellation_rebuttal',
  'customer_email_address',
  'customer_name',
  'customer_purchase_ip',
  'duplicate_charge_explanation',
  'product_description',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'service_date',
  'shipping_address',
  'shipping_carrier',
  'shipping_date',
  'shipping_tracking_number',
  'uncategorized_text',
] as const;
export type DisputeTextEvidenceField = (typeof DISPUTE_TEXT_EVIDENCE_FIELDS)[number];

/** The FILE evidence fields: each names a `file_…` of purpose `dispute_evidence`. */
export const DISPUTE_FILE_EVIDENCE_FIELDS = [
  'cancellation_policy',
  'customer_communication',
  'customer_signature',
  'duplicate_charge_documentation',
  'receipt',
  'refund_policy',
  'service_documentation',
  'shipping_documentation',
  'uncategorized_file',
] as const;
export type DisputeFileEvidenceField = (typeof DISPUTE_FILE_EVIDENCE_FIELDS)[number];

export type DisputeEvidenceField = DisputeTextEvidenceField | DisputeFileEvidenceField;

/** The provider's ceiling on one TEXT evidence field, restated where the request is parsed. */
export const DISPUTE_EVIDENCE_TEXT_MAX = 20_000;

// ---------------------------------------------------------------------------
// SetupIntents
// ---------------------------------------------------------------------------

export const SETUP_INTENT_STATUSES = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'canceled',
  'succeeded',
] as const;
export type SetupIntentStatus = (typeof SETUP_INTENT_STATUSES)[number];

export const SETUP_INTENT_USAGES = ['on_session', 'off_session'] as const;
export type SetupIntentUsage = (typeof SETUP_INTENT_USAGES)[number];

export const SETUP_INTENT_CANCELLATION_REASONS = [
  'abandoned',
  'duplicate',
  'requested_by_customer',
] as const;
export type SetupIntentCancellationReason = (typeof SETUP_INTENT_CANCELLATION_REASONS)[number];

// ---------------------------------------------------------------------------
// Social payments and enrichment
// ---------------------------------------------------------------------------

/**
 * Longest `source.app` of a social payment: an app slug, not a label. The
 * column CHECK reads the same bound.
 */
export const SOCIAL_SOURCE_APP_MAX_LENGTH = 32;

/**
 * Longest `source.ref` of a social payment. The bound is the whole defence: the
 * value is opaque, so nothing downstream would notice it growing.
 */
export const SOCIAL_SOURCE_REF_MAX_LENGTH = 128;

/** Which side of a social payment the caller was on. */
export const SOCIAL_PAYMENT_DIRECTIONS = ['sent', 'received'] as const;
export type SocialPaymentDirection = (typeof SOCIAL_PAYMENT_DIRECTIONS)[number];

/** Where a transaction's counterparty identity came from. */
export const ENRICHMENT_KINDS = ['merchant', 'user', 'unknown'] as const;
export type EnrichmentKind = (typeof ENRICHMENT_KINDS)[number];

/** How many addresses one `POST /v1/enrich` resolves (and one social history lists). */
export const ENRICH_MAX_ADDRESSES = 50;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * What `simulate_faircoin_payment` pretends the payer did: `settled` paid the
 * full amount (`processing` → `succeeded`); `underpaid` sent less
 * (`processing` → `canceled`, `cancellation_reason: 'underpaid'`).
 */
export const SIMULATED_FAIRCOIN_OUTCOMES = ['settled', 'underpaid'] as const;
export type SimulatedFaircoinOutcome = (typeof SIMULATED_FAIRCOIN_OUTCOMES)[number];
