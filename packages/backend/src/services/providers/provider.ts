/**
 * `PaymentProvider` — the seam every fiat rail plugs into (ADR 0001 D2).
 *
 * Deliberately shaped after the port Mercaria already proved
 * (`services/payments/provider.ts` there): that interface has a contract test
 * suite behind it and a rail that passed it, and copying its SHAPE is what lets
 * the adapter on Mercaria's side stay thin — the gateway's merchant API is this
 * interface expressed over HTTP.
 *
 * ## What this interface deliberately does NOT do
 *
 * It does not decide anything. It converts a gateway request into a provider
 * call and a provider answer back into the gateway's own vocabulary.
 * Persistence, status transitions, the outbox and every merchant-visible
 * consequence belong to the gateway, never to an adapter — so "what happens
 * when a payment succeeds" is written ONCE and cannot drift between providers.
 *
 * ## Idempotency comes IN, it is never invented here
 *
 * Every mutating method takes an `idempotencyKey` derived from a durable
 * gateway id. An adapter that minted its own would make a retry a second
 * charge, which is the entire failure this shape exists to prevent — so the key
 * is a required parameter rather than an option.
 *
 * ## `verifyEvent` is the trust boundary
 *
 * The ONLY method that takes untrusted input. It either returns a verified
 * envelope or throws. A payment is never marked settled from anything else: a
 * client callback is UX and a request body without a verified signature is a
 * stranger's opinion.
 */

import type { CurrencyCode, DisputeEvidence } from "@peable.to/shared-types";

/** The providers this gateway can route a fiat payment through. */
export type ProviderId = "stripe";

/**
 * The stages a payment can fail at — used by diagnostics and by the contract
 * suite's failure injection, which walks every one of them.
 */
export type ProviderStage =
  | "createPayment"
  | "capture"
  | "cancel"
  | "refund"
  | "transfer"
  | "getStatus"
  | "verifyEvent"
  | "account"
  // Reading what a payment came to. Its own stage because a failure here is
  // the one on this list that is not a money movement at all: it degrades a
  // reconciliation read to `unknown`, and nothing is left half-done.
  | "settlement"
  // Answering a dispute. Its own stage rather than reusing `account`, because
  // the operator question it raises is different: a failure here means a
  // merchant's response did not reach the network before a deadline, which is
  // the one failure on this surface that cannot be retried later.
  | "dispute";

/**
 * A failure from a payment provider.
 *
 * `retryable` means exactly one thing: could this same request, unchanged, ever
 * succeed? A network blip is retryable; a declined card and a malformed request
 * are not, because no number of attempts turns them into a payment. Anything
 * that is NOT a `ProviderError` is treated as retryable, since assuming an
 * unknown defect is permanent is how a recoverable outage becomes an abandoned
 * payment — the same direction `attemptDelivery` takes in the outbox, and for
 * the same reason.
 */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly stage: ProviderStage;
  readonly retryable: boolean;
  /** The provider's own machine-readable code, when it gave one. */
  readonly code?: string;

  constructor(input: {
    provider: ProviderId;
    stage: ProviderStage;
    message: string;
    retryable: boolean;
    code?: string;
  }) {
    super(input.message);
    this.name = "ProviderError";
    this.provider = input.provider;
    this.stage = input.stage;
    this.retryable = input.retryable;
    if (input.code !== undefined) this.code = input.code;
    Object.setPrototypeOf(this, ProviderError.prototype);
  }
}

/** Whether trying the same request again could ever work. */
export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  return true;
}

/**
 * An amount in a currency's smallest unit.
 *
 * A `string` rather than a `number`, matching `payment_intents.amount` and the
 * wire contract: the application works in JS `bigint`, which is unbounded,
 * and a `number` here would be a silent precision ceiling on a money value.
 * Adapters convert to whatever their SDK wants at the boundary and nowhere
 * else.
 */
export interface ProviderAmount {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

/**
 * What a payer's client must do next, when the provider needs it to do
 * anything.
 *
 * Opaque on purpose: `value` is whatever the provider's own SDK consumes (a
 * client secret, a redirect URL). The gateway never interprets it and never
 * stores it — it is handed to the payer in the same response and forgotten, so
 * it cannot become a credential sitting in a database.
 */
export interface ProviderClientAction {
  readonly kind: "client_secret" | "redirect";
  readonly value: string;
}

/**
 * Where a payment stands, in the GATEWAY's vocabulary.
 *
 * A deliberately smaller set than `PaymentIntentStatus`: an adapter reports
 * what the provider says about the money, and the gateway's state machine
 * decides what that means for the intent. Mapping straight onto
 * `PaymentIntentStatus` would put `applyEvent`'s job inside every adapter.
 */
export type ProviderPaymentStatus =
  | "created"
  | "requires_action"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded"
  | "partially_refunded";

export interface CreatePaymentRequest {
  /** The intent's PUBLIC id — the basis of the provider idempotency key. */
  readonly intentId: string;
  readonly amount: ProviderAmount;
  readonly idempotencyKey: string;
  /**
   * Minimal, stable ids for event correlation.
   *
   * Never an email, a phone number or a payer token: a provider's metadata is
   * readable by everyone with dashboard access, and a raw contact value there
   * is a disclosure with no audit trail.
   */
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * The connected account this payment will eventually settle to, when the
   * merchant is a marketplace paying ONE seller. Absent for a payment the
   * merchant settles itself, and absent for a multi-seller payment — those
   * settle through `createTransfer` after the charge, because one charge
   * cannot fund two destinations.
   */
  readonly onBehalfOf?: string;
}

export interface ProviderPaymentResult {
  /** The provider's own id for the payment. Never a gateway primary key. */
  readonly providerObjectId: string;
  readonly status: ProviderPaymentStatus;
  readonly clientAction?: ProviderClientAction;
  /**
   * The provider's id for the CHARGE this payment produced, when it has one.
   *
   * A payment and the charge it produces are DIFFERENT objects with different
   * ids, and the difference is not cosmetic: a transfer's `source_transaction`
   * must name the CHARGE. Passing the payment's id there was the bug this field
   * exists to make unrepeatable — Stripe answers `No such charge: 'pi_…'`, so
   * the transfer fails and a seller is not paid, intermittently and only for
   * payments whose funds had not yet landed.
   *
   * Absent until the payment produces one: a `requires_action` or `processing`
   * payment has no charge yet, and inventing one would be a claim about money.
   */
  readonly chargeObjectId?: string;
}

/** Act on a payment the provider already knows about. */
export interface PaymentOperationRequest {
  readonly intentId: string;
  readonly providerObjectId: string;
  readonly idempotencyKey: string;
}

export interface RefundRequest {
  readonly intentId: string;
  readonly providerObjectId: string;
  /** The gateway's refund id — what the idempotency key is derived from. */
  readonly refundId: string;
  readonly amount: ProviderAmount;
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ProviderRefundResult {
  /** The provider's id for the REFUND, not for the payment. */
  readonly providerObjectId: string;
  /** Where the PAYMENT stands after it. */
  readonly status: ProviderPaymentStatus;
  /** Where the REFUND itself stands — the money's own lifecycle. */
  readonly state: "pending" | "succeeded" | "failed";
  readonly failureCode?: string;
}

/** A signed, untrusted delivery from a provider, exactly as it arrived. */
export interface ProviderEventInput {
  /** The RAW body. Never a parsed object: a signature covers bytes, not a re-serialization. */
  readonly payload: string;
  readonly signature: string;
}

/** A verified inbound event, normalized. */
export interface ProviderEventEnvelope {
  readonly provider: ProviderId;
  /** The connected account the event is scoped to; absent for platform scope. */
  readonly providerAccountId?: string;
  readonly providerEventId: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly apiVersion?: string;
  /** The provider object ids this event refers to, keyed by the provider's own names. */
  readonly objectIds: Readonly<Record<string, string>>;
  /**
   * What this event says about the payment, already mapped. `undefined` when
   * the event is about something else (a payout, an account) — the envelope is
   * still stored, because an event the gateway cannot act on is evidence rather
   * than noise.
   */
  readonly paymentStatus?: ProviderPaymentStatus;
  readonly payload: unknown;
}

/** One fiat rail. Every mutating method is idempotent given the same key. */
export interface PaymentProvider {
  readonly id: ProviderId;
  createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult>;
  /**
   * Move a created payment toward capture.
   *
   * For a card rail that captures immediately this collapses into re-reading
   * the payment. It stays a method because a rail that genuinely holds funds
   * needs it, and discovering that after the interface froze would be
   * expensive.
   */
  capture(request: PaymentOperationRequest): Promise<ProviderPaymentResult>;
  cancel(request: PaymentOperationRequest): Promise<ProviderPaymentResult>;
  refund(request: RefundRequest): Promise<ProviderRefundResult>;
  /** Read the provider's current view. The only method with no idempotency key. */
  getStatus(providerObjectId: string): Promise<ProviderPaymentResult>;
  /**
   * @throws {ProviderError} with `retryable: false` when the signature does not
   *   verify. A bad signature is never transient, and retrying one is how a
   *   forged event eventually gets a lucky window.
   */
  verifyEvent(input: ProviderEventInput): Promise<ProviderEventEnvelope>;
}

// ---------------------------------------------------------------------------
// Optional capabilities
// ---------------------------------------------------------------------------

export interface CreateTransferRequest {
  readonly intentId: string;
  /** The gateway's transfer id — the basis of the idempotency key. */
  readonly transferId: string;
  /**
   * The provider's id for the CHARGE the funds come from — never the payment's.
   *
   * Renamed from `sourcePaymentObjectId`, which is what it used to be called
   * AND what it used to be given: `transferService` passed
   * `intent.providerObjectId` (a `pi_…`) and the adapter assigned it to
   * Stripe's `source_transaction`, which takes a `ch_…`. The name is now the
   * type's own documentation, so the next caller cannot make the same
   * substitution silently.
   */
  readonly sourceChargeObjectId: string;
  /** The seller's account AT THE PROVIDER. */
  readonly destinationAccountId: string;
  readonly amount: ProviderAmount;
  /** Ties every movement of one checkout together at the provider. */
  readonly groupRef: string;
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ProviderTransferResult {
  readonly providerObjectId: string;
  readonly status: "pending" | "paid" | "failed" | "reversed";
}

export interface ReverseTransferRequest {
  readonly transferId: string;
  /** The provider's own id for the transfer being reversed. */
  readonly transferObjectId: string;
  readonly amount: ProviderAmount;
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ProviderTransferReversalResult {
  readonly providerObjectId: string;
  /** What the transfer has now had reversed in TOTAL — cumulative, not this leg. */
  readonly totalReversed: string;
}

/**
 * A provider that can settle a sub-merchant out of a funded payment.
 *
 * OPTIONAL rather than part of `PaymentProvider`, because it is not a property
 * every rail has and pretending otherwise would force a lie. The FairCoin rail
 * implements neither half and that is the TRUTH about it rather than a gap: the
 * gateway never holds those funds, so it has nothing to move and nothing to
 * take back.
 *
 * The two halves are one capability. A rail that could settle and not reverse
 * would refund buyers with no way to make the seller bear it.
 */
export interface SettlingPaymentProvider extends PaymentProvider {
  createTransfer(request: CreateTransferRequest): Promise<ProviderTransferResult>;
  reverseTransfer(
    request: ReverseTransferRequest,
  ): Promise<ProviderTransferReversalResult>;
}

/** A capability's state as the provider reports it. */
export type ProviderCapabilityStatus = "active" | "pending" | "inactive";

/** How a sub-merchant's onboarding stands, in the gateway's vocabulary. */
export interface ProviderAccountSnapshot {
  readonly providerAccountId: string;
  /** Whether this account can currently RECEIVE a settlement. */
  readonly payoutsEnabled: boolean;
  /**
   * Whether the account may itself charge cards.
   *
   * Recorded because the provider reports it and an operator will ask, and
   * deliberately part of NO readiness answer: under separate charges and
   * transfers this account never charges anything, so `false` here does not
   * stop a seller selling.
   */
  readonly chargesEnabled: boolean;
  readonly transfersCapability: ProviderCapabilityStatus;
  /**
   * The `card_payments` capability, and it is here for a specific reason.
   *
   * It is requested alongside transfers not because this account charges
   * anything, but because Stripe refuses the pair otherwise outside the US AND
   * because a recipient-only account emits no `account.updated` — the only
   * readiness trigger there is (Mercaria's ADR 0008 D2-C and D2-D, one
   * decision). Recording its state is what makes "readiness will never fire on
   * this account" an answerable question rather than a six-hour mystery.
   */
  readonly cardPaymentsCapability: ProviderCapabilityStatus | null;
  /** Requirement identifiers the provider is waiting on. Never the values. */
  readonly currentlyDue: readonly string[];
  /**
   * Requirements coming eventually. Collected up front so a seller's payouts
   * are not interrupted weeks later by something that was always coming.
   */
  readonly eventuallyDue: readonly string[];
  readonly pastDue: readonly string[];
  /** Submitted and being checked — nothing for the seller to do. */
  readonly pendingVerification: readonly string[];
  readonly disabledReason?: string;
  readonly defaultCurrency?: CurrencyCode;
}

export interface CreateAccountRequest {
  /** The gateway's account id — the basis of the idempotency key. */
  readonly accountId: string;
  /** ISO 3166-1 alpha-2. Constrained by the provider's own transfer region. */
  readonly country: string;
  readonly businessType: "individual" | "company";
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface AccountLinkRequest {
  readonly providerAccountId: string;
  /** Where the provider sends a payer whose link expired mid-flow. */
  readonly refreshUrl: string;
  readonly returnUrl: string;
}

/**
 * A provider that holds sub-merchant accounts.
 *
 * Also optional, and for the same reason: FairCoin sellers are identities with
 * their own keys, not accounts this gateway creates.
 *
 * `accountLink` returns a SINGLE-USE, short-lived URL that must never be sent
 * over email or chat, and a `returnUrl` redirect proves NOTHING — only the
 * provider's own account events and a reconciliation read do.
 */
export interface AccountHoldingProvider extends PaymentProvider {
  createAccount(request: CreateAccountRequest): Promise<ProviderAccountSnapshot>;
  accountLink(request: AccountLinkRequest): Promise<{ url: string; expiresAt: Date }>;
  getAccount(providerAccountId: string): Promise<ProviderAccountSnapshot>;
}

/**
 * A merchant's response to a dispute — TEXT ONLY, and passed straight through.
 *
 * Every field is the merchant's own words or their own record, in the
 * provider's vocabulary, because these end up in front of a card network that
 * has its own field names and a gateway paraphrase would be the words the
 * merchant quotes while the acquirer holds different ones.
 *
 * **None of it is stored.** It contains exactly what evidence contains — a
 * customer's name, their email, a billing address, correspondence — and
 * `provider_events`' whole redaction posture exists because this gateway does
 * not keep that. It is forwarded and forgotten; what is recorded is THAT a
 * response was submitted and when.
 *
 * FILE attachments are deliberately absent. They need the provider's upload
 * API, a size and type policy, and somewhere for the bytes to live on the way
 * through — a different piece of work, and offering half of it would let a
 * merchant submit a response missing the receipt it depends on.
 */
/**
 * Re-exported from the wire contract, which is where the set is declared.
 *
 * The port used to carry its own copy of these seventeen fields, and so did the
 * route's schema, the Stripe adapter's name map and the SDK. A field added to
 * three of the four is one a merchant sends, the gateway accepts, and the
 * network never sees — they find out when the dispute is decided against them.
 */
export type { DisputeEvidence };

export interface SubmitDisputeEvidenceRequest {
  /** The provider's own id for the dispute. */
  readonly providerObjectId: string;
  readonly evidence: DisputeEvidence;
  readonly idempotencyKey: string;
}

/**
 * A provider whose disputes can be RESPONDED to.
 *
 * Optional, like settling and account-holding, and for the same reason: the
 * FairCoin rail has no card network behind it and therefore no dispute to
 * answer. A method every rail had to implement would make that a lie.
 *
 * One method and not two. A "save a draft" step exists at the provider, and
 * exposing it would need a durable identity per draft so a retry does not
 * become a second one — and the merchant-facing value is small next to the
 * cost of getting that wrong. Responding is a one-shot act here: it submits.
 */
export interface DisputeHandlingProvider extends PaymentProvider {
  /**
   * Returns NOTHING, deliberately.
   *
   * It returned the provider's dispute id and status, and no caller read
   * either — nor could one usefully: the status a provider reports immediately
   * after a submission is `under_review`, which is not news, and the outcome
   * arrives later as a `charge.dispute.closed` event that goes through
   * `handleDisputeEvent` like every other network-initiated fact. A return
   * value here would be a second, earlier, less reliable source for something
   * this system already has one path for.
   *
   * What the caller needs is whether the submission REACHED the network, and
   * that is carried by resolving rather than throwing.
   */
  submitDisputeEvidence(request: SubmitDisputeEvidenceRequest): Promise<void>;
}

/** Whether this rail can answer a dispute. */
export function isDisputeHandlingProvider(
  provider: PaymentProvider,
): provider is DisputeHandlingProvider {
  const candidate = provider as Partial<DisputeHandlingProvider>;
  return typeof candidate.submitDisputeEvidence === "function";
}

/**
 * What a payment's money actually came to, as the PROVIDER reports it.
 *
 * Every field is nullable and `status` says why, because the difference between
 * "the fee was zero" and "the fee is not known yet" is the whole point of this
 * type. A settlement report that renders an unknown as `0` is a report a
 * merchant reconciles against and cannot explain — and zero is a number
 * somebody will subtract.
 *
 * `gross` is not the payment's amount: a partial capture, a refund or a
 * currency conversion all make them differ, which is why it is read rather than
 * copied from the intent.
 */
export interface ProviderSettlement {
  /**
   *  - `available` — the provider has settled it and these figures are final.
   *  - `pending`   — it exists and the figures are not final yet.
   *  - `unknown`   — the provider has no settlement record at all. Not zero.
   */
  readonly status: "available" | "pending" | "unknown";
  readonly gross: string | null;
  readonly fee: string | null;
  readonly net: string | null;
  /** The currency the figures above are in — the SETTLEMENT currency. */
  readonly currency: CurrencyCode | null;
  /** When the funds become available, ISO-8601. */
  readonly availableOn: string | null;
  /** Present only when the settlement currency differs from the charge's. */
  readonly exchangeRate: number | null;
}

/**
 * Nothing is known: every figure `null`, and `status` says why it is not zero.
 *
 * Shared rather than written out per caller, because it is an ANSWER and not a
 * default — the Stripe adapter returns it for a charge with no balance
 * transaction, and `reportSettlement` returns it for a rail that takes no fee,
 * a payment with no charge, and a provider it cannot reach. Two identical
 * copies of it invite one of them growing a zero.
 */
export const UNKNOWN_SETTLEMENT: ProviderSettlement = {
  status: "unknown",
  gross: null,
  fee: null,
  net: null,
  currency: null,
  availableOn: null,
  exchangeRate: null,
};

/**
 * A provider that can report what a payment settled to.
 *
 * Optional for the same reason the others are: the FairCoin rail takes no fee
 * and holds no balance, so there is nothing to report and a method returning
 * zeros would be inventing an answer.
 */
export interface SettlementReportingProvider extends PaymentProvider {
  /** @param chargeObjectId the CHARGE, not the payment — fees attach to it. */
  getSettlement(chargeObjectId: string): Promise<ProviderSettlement>;
}

/** Whether this rail can report a payment's fees and net. */
export function isSettlementReportingProvider(
  provider: PaymentProvider,
): provider is SettlementReportingProvider {
  const candidate = provider as Partial<SettlementReportingProvider>;
  return typeof candidate.getSettlement === "function";
}

/** Whether this rail can settle sub-merchants. Both halves, never one. */
export function isSettlingProvider(
  provider: PaymentProvider,
): provider is SettlingPaymentProvider {
  const candidate = provider as Partial<SettlingPaymentProvider>;
  return (
    typeof candidate.createTransfer === "function" &&
    typeof candidate.reverseTransfer === "function"
  );
}

/** Whether this rail holds sub-merchant accounts. */
export function isAccountHoldingProvider(
  provider: PaymentProvider,
): provider is AccountHoldingProvider {
  const candidate = provider as Partial<AccountHoldingProvider>;
  return (
    typeof candidate.createAccount === "function" &&
    typeof candidate.accountLink === "function" &&
    typeof candidate.getAccount === "function"
  );
}
