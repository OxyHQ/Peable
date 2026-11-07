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

import type {
  Address,
  AccountBusinessProfile,
  AccountSettings,
  BalanceTransactionType,
  PayoutStatus,
  RefundReason,
  BillingDetails,
  CardDetails,
  CardRailPaymentMethodType,
  CurrencyCode,
  DisputeFileEvidenceField,
  DisputeStatus,
  DisputeTextEvidenceField,
  PaymentMethodConfigurationType,
  PaymentIntentCaptureMethod,
  PaymentIntentSetupFutureUsage,
  SetupIntentCancellationReason,
  SetupIntentStatus,
  SetupIntentUsage,
  TerminalReaderActionStatus,
  TerminalReaderStatus,
  VerificationCheckStatus,
  VerificationDocumentType,
  VerificationErrorCode,
  VerificationIdNumberType,
  VerificationRedactionStatus,
  VerificationSessionStatus,
  VerificationSessionType,
} from '@peable.to/shared-types';

/** The providers this gateway can route a fiat payment through. */
export type ProviderId = 'stripe';

/**
 * The provider's two worlds (ADR 0017). One deployment holds both; every
 * provider object, stored row and inbound event belongs to exactly one, and an
 * operation on it is sent through that mode's credential and no other.
 */
export type ProviderMode = 'test' | 'live';

export const PROVIDER_MODES: readonly ProviderMode[] = ['test', 'live'];

/** A stored `livemode` (a row's, an event's) as the mode that acts on it. */
export function providerModeOf(livemode: boolean): ProviderMode {
  return livemode ? 'live' : 'test';
}

/**
 * The stages a payment can fail at — used by diagnostics and by the contract
 * suite's failure injection, which walks every one of them.
 */
export type ProviderStage =
  | 'createPayment'
  | 'confirm'
  | 'capture'
  | 'cancel'
  | 'refund'
  | 'transfer'
  | 'getStatus'
  | 'verifyEvent'
  | 'account'
  // Reading what a payment came to. Its own stage because a failure here is
  // the one on this list that is not a money movement at all: it degrades a
  // reconciliation read to `unknown`, and nothing is left half-done.
  | 'settlement'
  // Answering a dispute. Its own stage rather than reusing `account`, because
  // the operator question it raises is different: a failure here means a
  // merchant's response did not reach the network before a deadline, which is
  // the one failure on this surface that cannot be retried later.
  | 'dispute'
  // Uploading an evidence file to the provider, before a submission.
  | 'file'
  // A payment method configuration or a wallet domain.
  | 'paymentMethodConfiguration'
  | 'paymentMethodDomain'
  // Customers, saved payment methods and SetupIntents (ADR 0016).
  | 'customer'
  | 'paymentMethod'
  | 'setup'
  // Orbit money (ADR 0015): reading balance transactions, payouts and fees —
  // `balance` degrades a mirror read and moves nothing; `payout` instructs one.
  | 'balance'
  | 'payout'
  // Identity verification (ADR 0023): a session or a report. Moves no money.
  | 'identity'
  // Terminal (ADR 0024): locations, readers and their actions. A reader's
  // collection is an instruction to the device; the money moves on the
  // PaymentIntent, through its own stages.
  | 'terminal';

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
    this.name = 'ProviderError';
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
  readonly kind: 'client_secret' | 'redirect';
  readonly value: string;
}

/**
 * Where a payment stands at the provider — Stripe's seven, which since ADR 0019
 * are also the gateway's. The adapter still only REPORTS: which transition that
 * means for the intent is `applyEvent`'s decision (`intentReconciliation.ts`).
 */
export type ProviderPaymentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'succeeded'
  | 'canceled';

/**
 * Why the last attempt failed, as machine-readable codes only. The provider's
 * prose never crosses: the gateway writes its own message (ADR 0019), so a
 * provider's wording — or its name — never reaches the wire.
 */
export interface ProviderPaymentError {
  readonly type: 'card_error' | 'api_error';
  readonly code?: string;
  readonly declineCode?: string;
}

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
  /** Card: hold the authorization for `capture` (ADR 0019). Defaults to automatic. */
  readonly captureMethod?: PaymentIntentCaptureMethod;
  /** The provider customer a saved method belongs to — a binding, never a Peable id. */
  readonly customerObjectId?: string;
  /** The provider payment method to charge — a binding of a Peable `pm_…`. */
  readonly paymentMethodObjectId?: string;
  /** Confirm in the same call (needs `paymentMethodObjectId`). */
  readonly confirm?: boolean;
  /** With `confirm`: the customer is not present. */
  readonly offSession?: boolean;
  readonly setupFutureUsage?: PaymentIntentSetupFutureUsage;
  /** Shown on the cardholder's statement after the account's prefix. */
  readonly statementDescriptorSuffix?: string;
  /** With `confirm`: where a redirect-based challenge returns the payer. */
  readonly returnUrl?: string;
  /** Exactly these methods — the merchant named them. Exclusive with the configuration. */
  readonly paymentMethodTypes?: readonly CardRailPaymentMethodType[];
  /** The provider configuration (a binding of a `pmc_…`) whose methods to offer. */
  readonly paymentMethodConfigurationObjectId?: string;
  /**
   * A DESTINATION charge (ADR 0015 §2): the provider account the funds go to,
   * the amount transferred (absent: the whole amount less the fee), and
   * Orbit's fee, kept by the platform out of the destination's funds.
   * `onBehalfOf` above makes the destination the merchant of record.
   */
  readonly transferDestination?: string;
  readonly transferAmount?: string;
  readonly applicationFeeAmount?: string;
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
  /** Present when the last attempt failed (`requires_payment_method` after a decline). */
  readonly lastPaymentError?: ProviderPaymentError;
  /**
   * The provider payment method the payment was made with, when it has one —
   * what a payment that saves its card (`setup_future_usage`) registers as a
   * Peable `pm_…` once it succeeds (ADR 0016).
   */
  readonly paymentMethodObjectId?: string;
}

/** Act on a payment the provider already knows about. */
export interface PaymentOperationRequest {
  readonly intentId: string;
  readonly providerObjectId: string;
  readonly idempotencyKey: string;
}

/** Confirm a payment server-side with a saved method (ADR 0019). */
export interface ConfirmPaymentRequest extends PaymentOperationRequest {
  readonly paymentMethodObjectId: string;
  readonly customerObjectId?: string;
  readonly offSession?: boolean;
  readonly setupFutureUsage?: PaymentIntentSetupFutureUsage;
  readonly returnUrl?: string;
}

/** Capture a held authorization, in full or in part. */
export interface CapturePaymentRequest extends PaymentOperationRequest {
  /** Base units; defaults to all of it. */
  readonly amountToCapture?: string;
}

/** Cancel a payment, optionally saying why (Stripe's own reasons). */
export interface CancelPaymentRequest extends PaymentOperationRequest {
  readonly cancellationReason?: 'duplicate' | 'fraudulent' | 'requested_by_customer' | 'abandoned';
}

export interface RefundRequest {
  readonly intentId: string;
  readonly providerObjectId: string;
  /** The gateway's refund id — what the idempotency key is derived from. */
  readonly refundId: string;
  readonly amount: ProviderAmount;
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly reason?: RefundReason;
  /** Destination charges: refund Orbit's fee in proportion. */
  readonly refundApplicationFee?: boolean;
  /** Destination charges: pull the funds back from the destination in proportion. */
  readonly reverseTransfer?: boolean;
}

export interface ProviderRefundResult {
  /** The provider's id for the REFUND, not for the payment. */
  readonly providerObjectId: string;
  /**
   * Where the REFUND stands — the money's own lifecycle. The payment's status
   * does not move with a refund (ADR 0019); `amount_refunded` is the sum of the
   * succeeded rows.
   */
  readonly state: 'pending' | 'succeeded' | 'failed' | 'canceled';
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
  readonly paymentStatus?: ProviderPaymentStatus | 'failed';
  readonly payload: unknown;
}

/** One fiat rail. Every mutating method is idempotent given the same key. */
export interface PaymentProvider {
  readonly id: ProviderId;
  createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult>;
  /**
   * Confirm a payment server-side with a saved method. A DECLINE is an answer,
   * not an error: it resolves with `requires_payment_method` and
   * `lastPaymentError`, the way the provider leaves the payment.
   */
  confirm(request: ConfirmPaymentRequest): Promise<ProviderPaymentResult>;
  /**
   * Capture a held authorization (`requires_capture`). On a payment that was
   * captured automatically this READS the payment back rather than pretending
   * to act.
   */
  capture(request: CapturePaymentRequest): Promise<ProviderPaymentResult>;
  cancel(request: CancelPaymentRequest): Promise<ProviderPaymentResult>;
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
  readonly status: 'pending' | 'paid' | 'failed' | 'reversed';
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
  reverseTransfer(request: ReverseTransferRequest): Promise<ProviderTransferReversalResult>;
}

/** A capability's state as the provider reports it. */
export type ProviderCapabilityStatus = 'active' | 'pending' | 'inactive';

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
  /** The account's business profile and settings as the provider holds them (ADR 0015 §1). */
  readonly businessProfile: AccountBusinessProfile;
  readonly settings: AccountSettings;
}

/**
 * The settings Orbit writes to a merchant's account. Every field optional;
 * an omitted one is left as the provider holds it.
 */
export interface ProviderAccountUpdate {
  readonly businessProfile?: Partial<AccountBusinessProfile>;
  readonly payoutSchedule?: {
    readonly interval: 'manual' | 'daily' | 'weekly' | 'monthly';
    readonly delayDays?: number;
    readonly weeklyAnchor?: string;
    readonly monthlyAnchor?: number;
  };
  readonly payoutStatementDescriptor?: string;
  readonly paymentsStatementDescriptor?: string;
  readonly brandingPrimaryColor?: string;
  readonly brandingSecondaryColor?: string;
}

export interface CreateAccountRequest {
  /** The gateway's account id — the basis of the idempotency key. */
  readonly accountId: string;
  /** ISO 3166-1 alpha-2. Constrained by the provider's own transfer region. */
  readonly country: string;
  readonly businessType: 'individual' | 'company';
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * A marketplace `seller` (express dashboard, as before) or the merchant's
   * OWN account (ADR 0015 §1: no provider dashboard — Orbit is the only one
   * the merchant sees).
   */
  readonly role: 'seller' | 'merchant';
}

export interface AccountLinkRequest {
  readonly providerAccountId: string;
  /** Defaults to `account_onboarding`. */
  readonly type?: 'account_onboarding' | 'account_update';
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
 * A provider whose accounts' settings Orbit can write (ADR 0015 §1: payout
 * schedule, statement descriptors, business profile, branding). Its own
 * capability: a rail can hold accounts without letting the platform configure
 * them.
 */
export interface AccountConfiguringProvider extends AccountHoldingProvider {
  /** Write settings to the account and read it back. */
  updateAccount(
    providerAccountId: string,
    update: ProviderAccountUpdate,
    idempotencyKey: string,
  ): Promise<ProviderAccountSnapshot>;
}

export function isAccountConfiguringProvider(
  provider: PaymentProvider,
): provider is AccountConfiguringProvider {
  return (
    isAccountHoldingProvider(provider) &&
    typeof (provider as Partial<AccountConfiguringProvider>).updateAccount === 'function'
  );
}

// ---------------------------------------------------------------------------
// Orbit money (ADR 0015): the provider's balance, payouts and fees, mirrored
// ---------------------------------------------------------------------------

/** One provider balance transaction, in Orbit's vocabulary. Every figure verbatim. */
export interface ProviderBalanceTransaction {
  readonly providerObjectId: string;
  readonly amount: string;
  readonly fee: string;
  readonly net: string;
  /** Upper-case. */
  readonly currency: string;
  readonly type: BalanceTransactionType;
  readonly reportingCategory: string;
  readonly status: 'available' | 'pending';
  readonly availableOn: Date | null;
  readonly created: Date;
  readonly description: string | null;
  readonly exchangeRate: string | null;
  readonly feeDetails: readonly {
    readonly amount: string;
    readonly currency: string;
    readonly type: 'application_fee' | 'processing_fee' | 'tax' | 'other';
  }[];
  /** The provider object that caused it, and what kind of object that is. */
  readonly sourceObjectId: string | null;
  readonly sourceKind:
    | 'charge'
    | 'refund'
    | 'payout'
    | 'application_fee'
    | 'application_fee_refund'
    | 'transfer'
    | 'dispute'
    | null;
  /**
   * For a destination charge's funds on the destination account: the PLATFORM
   * charge they came from, which is the one Orbit holds.
   */
  readonly originatingChargeObjectId: string | null;
}

export interface ProviderPayout {
  readonly providerObjectId: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: PayoutStatus;
  readonly method: 'standard' | 'instant';
  readonly type: 'bank_account' | 'card';
  readonly automatic: boolean;
  readonly arrivalDate: Date | null;
  readonly description: string | null;
  readonly statementDescriptor: string | null;
  readonly failureCode: string | null;
  readonly created: Date;
}

export interface ProviderApplicationFee {
  readonly providerObjectId: string;
  readonly amount: string;
  readonly currency: string;
  /** The PLATFORM charge it was taken on (the one a payment intent names). */
  readonly chargeObjectId: string | null;
  /** The provider account it was taken from. */
  readonly accountObjectId: string | null;
  readonly refunds: readonly {
    readonly providerObjectId: string;
    readonly amount: string;
    readonly currency: string;
    readonly created: Date;
  }[];
  readonly created: Date;
}

export interface ListBalanceTransactionsRequest {
  /** The provider account; `null` for the platform's own. */
  readonly account: string | null;
  readonly createdGte?: Date;
  readonly createdLt?: Date;
  /** Only those this provider payout paid out. */
  readonly payout?: string;
  readonly startingAfter?: string;
  readonly limit: number;
}

/**
 * A provider whose balance, payouts and fees Orbit can mirror (ADR 0015 §4–§5).
 * Optional like every capability: the FairCoin rail holds no balance.
 */
export interface MoneyMirroringProvider extends PaymentProvider {
  listBalanceTransactions(
    request: ListBalanceTransactionsRequest,
  ): Promise<{ data: ProviderBalanceTransaction[]; hasMore: boolean }>;
  /**
   * The balance transactions of ONE platform charge — the charge's own and its
   * refunds' — for a first-party merchant, whose money is on the platform
   * account and is attributed charge by charge.
   */
  getChargeBalanceTransactions(chargeObjectId: string): Promise<ProviderBalanceTransaction[]>;
  getPayout(account: string, providerObjectId: string): Promise<ProviderPayout>;
  listPayouts(request: {
    readonly account: string;
    readonly createdGte?: Date;
    readonly startingAfter?: string;
    readonly limit: number;
  }): Promise<{ data: ProviderPayout[]; hasMore: boolean }>;
  /** An instruction: the provider executes it from the account's available balance. */
  createPayout(request: {
    readonly account: string;
    readonly payoutId: string;
    readonly amount: string;
    readonly currency: string;
    readonly method: 'standard' | 'instant';
    readonly description?: string;
    readonly statementDescriptor?: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderPayout>;
  cancelPayout(request: {
    readonly account: string;
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderPayout>;
  getApplicationFee(providerObjectId: string): Promise<ProviderApplicationFee>;
  /** Cancel a refund the provider still holds (`requires_action`); otherwise a permanent error. */
  cancelRefund(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderRefundResult>;
}

export function isMoneyMirroringProvider(
  provider: PaymentProvider,
): provider is MoneyMirroringProvider {
  const candidate = provider as Partial<MoneyMirroringProvider>;
  return (
    typeof candidate.listBalanceTransactions === 'function' &&
    typeof candidate.getChargeBalanceTransactions === 'function' &&
    typeof candidate.getPayout === 'function' &&
    typeof candidate.listPayouts === 'function' &&
    typeof candidate.createPayout === 'function' &&
    typeof candidate.cancelPayout === 'function' &&
    typeof candidate.getApplicationFee === 'function' &&
    typeof candidate.cancelRefund === 'function'
  );
}

/**
 * A merchant's evidence as it crosses to the provider: the text fields in the
 * merchant's own words, and the file fields as the PROVIDER's file ids — the
 * bytes uploaded with `uploadDisputeEvidenceFile` at submission time. An empty
 * string unsets a field at the provider.
 *
 * **None of it is stored here.** The text carries a customer's name, email,
 * address and correspondence; it is forwarded and forgotten, and a draft lives
 * at the provider (`submit: false`), which is the store of a response in
 * progress. What Peable records is THAT evidence was staged
 * (`disputes.has_evidence`) and when it was submitted.
 */
export type ProviderDisputeEvidence = Partial<
  Record<DisputeTextEvidenceField | DisputeFileEvidenceField, string>
>;

/** What the provider says about a dispute after an operation on it — never prose. */
export interface ProviderDisputeSnapshot {
  /** Mapped onto Orbit's four; `null` when the provider said nothing readable. */
  readonly status: DisputeStatus | null;
  readonly hasEvidence: boolean;
  readonly submissionCount: number;
  readonly isChargeRefundable: boolean;
  /** The staged or submitted TEXT, read back from the provider — the draft's one home. */
  readonly evidence: Readonly<Record<DisputeTextEvidenceField, string | null>>;
}

export interface UpdateDisputeEvidenceRequest {
  /** The provider's own id for the dispute. */
  readonly providerObjectId: string;
  readonly evidence: ProviderDisputeEvidence;
  /** `true` submits — one-way at the network. */
  readonly submit: boolean;
  /** Required with `submit`, derived from the dispute: a retry is the same submission. */
  readonly idempotencyKey?: string;
}

export interface UploadDisputeEvidenceFileRequest {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mime: string;
  /** Derived from the dispute, the field and the File: a retry uploads once. */
  readonly idempotencyKey: string;
}

/**
 * A provider whose disputes can be answered: drafts, files, one submission,
 * and acceptance.
 *
 * Optional, like settling and account-holding, and for the same reason: the
 * FairCoin rail has no card network behind it and therefore no dispute.
 */
export interface DisputeHandlingProvider extends PaymentProvider {
  /** Stage (`submit: false`) or submit evidence. */
  updateDisputeEvidence(request: UpdateDisputeEvidenceRequest): Promise<ProviderDisputeSnapshot>;
  /** Read the dispute — the staged text included. No idempotency key. */
  getDispute(providerObjectId: string): Promise<ProviderDisputeSnapshot>;
  /** Accept the dispute: it is lost, and nothing more can be submitted. */
  closeDispute(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderDisputeSnapshot>;
  /** Upload one evidence file; returns the provider's file id, used once and not kept. */
  uploadDisputeEvidenceFile(
    request: UploadDisputeEvidenceFileRequest,
  ): Promise<{ readonly providerFileId: string }>;
}

/** Whether this rail can answer a dispute. */
export function isDisputeHandlingProvider(
  provider: PaymentProvider,
): provider is DisputeHandlingProvider {
  const candidate = provider as Partial<DisputeHandlingProvider>;
  return (
    typeof candidate.updateDisputeEvidence === 'function' &&
    typeof candidate.getDispute === 'function' &&
    typeof candidate.closeDispute === 'function' &&
    typeof candidate.uploadDisputeEvidenceFile === 'function'
  );
}

// ---------------------------------------------------------------------------
// Payment method breadth: configurations and wallet domains
// ---------------------------------------------------------------------------

/**
 * The configuration methods a card provider can process: every one but
 * `faircoin`, the chain rail, which no provider is ever told about (ADR 0021 D2).
 */
export type ProviderPaymentMethodType = Exclude<PaymentMethodConfigurationType, 'faircoin'>;

/**
 * The methods each provider can offer at all. A configuration's
 * `unavailable_reason: 'provider_unsupported'` is read from here, so the
 * merchant is told the truth instead of a toggle that does nothing.
 */
export const PROVIDER_PAYMENT_METHODS: Readonly<
  Record<ProviderId, readonly ProviderPaymentMethodType[]>
> = Object.freeze({
  stripe: ['card', 'apple_pay', 'google_pay', 'sepa_debit', 'ideal', 'bancontact', 'eps'],
});

export interface SavePaymentMethodConfigurationRequest {
  /** The binding, when the provider already holds one; absent creates it. */
  readonly providerObjectId?: string;
  /** Orbit's `pmc_…` — the provider-side name and the idempotency basis. */
  readonly configurationId: string;
  /** Every method this provider supports, on or off. */
  readonly methods: Readonly<Partial<Record<ProviderPaymentMethodType, 'on' | 'off'>>>;
  readonly idempotencyKey: string;
}

/** A provider that holds payment method configurations (ADR 0016 binding). */
export interface PaymentMethodConfiguringProvider extends PaymentProvider {
  savePaymentMethodConfiguration(
    request: SavePaymentMethodConfigurationRequest,
  ): Promise<{ readonly providerObjectId: string }>;
}

export function isPaymentMethodConfiguringProvider(
  provider: PaymentProvider,
): provider is PaymentMethodConfiguringProvider {
  return (
    typeof (provider as Partial<PaymentMethodConfiguringProvider>)
      .savePaymentMethodConfiguration === 'function'
  );
}

/** A wallet's standing on a domain, in Peable's words. */
export interface ProviderWalletStanding {
  readonly status: 'active' | 'inactive';
  /** Peable's explanation while inactive; `null` when active or nothing was said. */
  readonly error: string | null;
}

export interface ProviderPaymentMethodDomain {
  readonly providerObjectId: string;
  readonly enabled: boolean;
  readonly applePay: ProviderWalletStanding;
  readonly googlePay: ProviderWalletStanding;
}

/** A provider that registers web domains for its wallets. */
export interface DomainRegisteringProvider extends PaymentProvider {
  createPaymentMethodDomain(request: {
    readonly domainName: string;
    readonly enabled: boolean;
    readonly idempotencyKey: string;
  }): Promise<ProviderPaymentMethodDomain>;
  updatePaymentMethodDomain(request: {
    readonly providerObjectId: string;
    readonly enabled: boolean;
  }): Promise<ProviderPaymentMethodDomain>;
  /** Ask the wallets to verify the domain again, and read the result. */
  validatePaymentMethodDomain(providerObjectId: string): Promise<ProviderPaymentMethodDomain>;
}

export function isDomainRegisteringProvider(
  provider: PaymentProvider,
): provider is DomainRegisteringProvider {
  const candidate = provider as Partial<DomainRegisteringProvider>;
  return (
    typeof candidate.createPaymentMethodDomain === 'function' &&
    typeof candidate.updatePaymentMethodDomain === 'function' &&
    typeof candidate.validatePaymentMethodDomain === 'function'
  );
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
 *
 * ## One movement of the settlement balance, and its signs
 *
 * The same shape answers for a payment, a refund and a dispute: each is ONE
 * movement of the platform's settlement balance at the provider (Stripe's
 * balance transaction), in the SETTLEMENT currency.
 *
 *  - `gross` — the MAGNITUDE of the movement's principal, never negative: what
 *    the payment brought in, what the refund took out, what the dispute
 *    withdrew.
 *  - `fee`   — the provider's fee on THIS movement, signed as the provider signs
 *    it: positive is a fee charged to the balance (a payment's processing fee,
 *    a dispute fee), negative a fee returned to it (part of the original fee on
 *    some refunds). A refund's is usually `0`.
 *  - `net`   — the SIGNED effect on the balance: positive for a payment,
 *    negative for a refund or a dispute withdrawal.
 *
 * so that, always, `net = ±gross − fee`, with `+` for a payment and `−` for a
 * refund or a dispute. Payment `10000`, fee `204` → net `9796`; refund `1000`,
 * fee `0` → net `-1000`; dispute `1000`, fee `1500` → net `-2500`.
 */
export interface ProviderSettlement {
  /**
   *  - `available` — the provider has settled it and these figures are final.
   *  - `pending`   — it exists and the figures are not final yet.
   *  - `unknown`   — the provider has no settlement record at all. Not zero.
   */
  readonly status: 'available' | 'pending' | 'unknown';
  readonly gross: string | null;
  readonly fee: string | null;
  readonly net: string | null;
  /** The currency the figures above are in — the SETTLEMENT currency. */
  readonly currency: CurrencyCode | null;
  /** When the funds become available. */
  readonly availableOn: Date | null;
  /** Present only when the settlement currency differs from the presentment currency. */
  readonly exchangeRate: number | null;
}

/**
 * Nothing is known: every figure `null`, and `status` says why it is not zero.
 *
 * Shared rather than written out per caller, because it is an ANSWER and not a
 * default — the Stripe adapter returns it for a charge with no balance
 * transaction (and a refund or dispute with none), and `settlementReport.ts`
 * returns it for a rail that takes no fee, an object with no provider id, and a
 * provider it cannot reach. Two identical
 * copies of it invite one of them growing a zero.
 */
export const UNKNOWN_SETTLEMENT: ProviderSettlement = {
  status: 'unknown',
  gross: null,
  fee: null,
  net: null,
  currency: null,
  availableOn: null,
  exchangeRate: null,
};

/**
 * A provider that can report what a payment, a refund or a dispute did to the
 * settlement balance — each one movement, in {@link ProviderSettlement}'s signs.
 *
 * Optional for the same reason the others are: the FairCoin rail takes no fee
 * and holds no balance, so there is nothing to report and a method returning
 * zeros would be inventing an answer. Each read answers
 * {@link UNKNOWN_SETTLEMENT} when the provider has no balance movement for the
 * object — never zeros.
 */
export interface SettlementReportingProvider extends PaymentProvider {
  /** @param chargeObjectId the CHARGE, not the payment — fees attach to it. */
  getSettlement(chargeObjectId: string): Promise<ProviderSettlement>;
  /**
   * What a refund took off the balance: its own balance transaction. A refund
   * that failed or was canceled took nothing in the end and answers `unknown`.
   *
   * @param refundObjectId the provider's refund id (`refunds.provider_object_id`).
   */
  getRefundSettlement(refundObjectId: string): Promise<ProviderSettlement>;
  /**
   * What a dispute WITHDREW from the balance: the principal and the dispute fee.
   * An inquiry moves no money and answers `unknown`; a reinstatement after a
   * won dispute is a later, separate movement this does not report.
   *
   * @param disputeObjectId the provider's dispute id (`disputes.provider_object_id`).
   */
  getDisputeSettlement(disputeObjectId: string): Promise<ProviderSettlement>;
}

/** Whether this rail can report a payment's, refund's and dispute's balance movements. */
export function isSettlementReportingProvider(
  provider: PaymentProvider,
): provider is SettlementReportingProvider {
  const candidate = provider as Partial<SettlementReportingProvider>;
  return (
    typeof candidate.getSettlement === 'function' &&
    typeof candidate.getRefundSettlement === 'function' &&
    typeof candidate.getDisputeSettlement === 'function'
  );
}

/** What the provider says about one charge: the outcome and the card, never prose. */
export interface ProviderChargeSnapshot {
  readonly outcome: {
    readonly networkStatus: string | null;
    readonly riskLevel: string | null;
    readonly riskScore: number | null;
    readonly reason: string | null;
    readonly type: string | null;
  } | null;
  readonly paymentMethodDetails: { readonly type: 'card'; readonly card: CardDetails } | null;
  /** The charge's billing details, or `null` when the provider reported none. */
  readonly billingDetails: BillingDetails | null;
}

/** A provider whose charges can be read for a `ch_…` snapshot (ADR 0019). */
export interface ChargeReadingProvider extends PaymentProvider {
  /** @param chargeObjectId the CHARGE, not the payment. */
  getChargeSnapshot(chargeObjectId: string): Promise<ProviderChargeSnapshot>;
}

export function isChargeReadingProvider(
  provider: PaymentProvider,
): provider is ChargeReadingProvider {
  const candidate = provider as Partial<ChargeReadingProvider>;
  return typeof candidate.getChargeSnapshot === 'function';
}

export interface CreateProviderCustomerRequest {
  /** The Peable customer's `cus_…` — the basis of the idempotency key and the correlation. */
  readonly customerId: string;
  readonly idempotencyKey: string;
}

/**
 * A provider that holds customers — the binding a saved card belongs to
 * (ADR 0016). Nothing about the customer is sent beyond the correlation id: the
 * customer's name, email and address are Orbit's, not the provider's.
 */
export interface CustomerHoldingProvider extends PaymentProvider {
  createCustomer(request: CreateProviderCustomerRequest): Promise<{ providerObjectId: string }>;
}

export function isCustomerHoldingProvider(
  provider: PaymentProvider,
): provider is CustomerHoldingProvider {
  const candidate = provider as Partial<CustomerHoldingProvider>;
  return typeof candidate.createCustomer === 'function';
}

/** Whether this rail can settle sub-merchants. Both halves, never one. */
export function isSettlingProvider(provider: PaymentProvider): provider is SettlingPaymentProvider {
  const candidate = provider as Partial<SettlingPaymentProvider>;
  return (
    typeof candidate.createTransfer === 'function' &&
    typeof candidate.reverseTransfer === 'function'
  );
}

/** Whether this rail holds sub-merchant accounts. */
export function isAccountHoldingProvider(
  provider: PaymentProvider,
): provider is AccountHoldingProvider {
  const candidate = provider as Partial<AccountHoldingProvider>;
  return (
    typeof candidate.createAccount === 'function' &&
    typeof candidate.accountLink === 'function' &&
    typeof candidate.getAccount === 'function'
  );
}

// ---------------------------------------------------------------------------
// Saved payment methods and SetupIntents (ADR 0016)
// ---------------------------------------------------------------------------

/**
 * What a provider says about one of its payment methods — the safe card fields
 * and the billing details, never the number. The source of a Peable `pm_…`.
 */
export interface ProviderPaymentMethodSnapshot {
  readonly providerObjectId: string;
  readonly card: CardDetails;
  readonly billingDetails: BillingDetails;
  /** The provider customer it is attached to, if any. */
  readonly customerObjectId?: string;
}

/** A provider SetupIntent, in Stripe's six statuses (which are also Orbit's). */
export interface ProviderSetupResult {
  readonly providerObjectId: string;
  readonly status: SetupIntentStatus;
  /** The payer's confirmation credential (Stripe.js `confirmSetup`). Never stored. */
  readonly clientAction?: ProviderClientAction;
  /** The provider payment method it saved, once `succeeded`. */
  readonly paymentMethodObjectId?: string;
  /** Present after a failed attempt (`requires_payment_method` again). */
  readonly lastSetupError?: ProviderPaymentError;
}

export interface CreateSetupRequest {
  /** The SetupIntent's public `seti_…` — correlation and idempotency basis. */
  readonly setupIntentId: string;
  readonly customerObjectId: string;
  readonly usage: SetupIntentUsage;
  readonly idempotencyKey: string;
}

/**
 * A provider that can save a card for later: SetupIntents, and the payment
 * methods they produce. Optional, like every capability here — the FairCoin
 * rail has no stored payment method (ADR 0016 D4).
 */
export interface SetupHoldingProvider extends PaymentProvider {
  createSetup(request: CreateSetupRequest): Promise<ProviderSetupResult>;
  /** Read the provider's view. No idempotency key. */
  getSetup(providerObjectId: string): Promise<ProviderSetupResult>;
  cancelSetup(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
    readonly cancellationReason?: SetupIntentCancellationReason;
  }): Promise<ProviderSetupResult>;
  getPaymentMethod(providerObjectId: string): Promise<ProviderPaymentMethodSnapshot>;
  /** Detach at the provider: the method can never be charged again. */
  detachPaymentMethod(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

export function isSetupHoldingProvider(
  provider: PaymentProvider,
): provider is SetupHoldingProvider {
  const candidate = provider as Partial<SetupHoldingProvider>;
  return (
    typeof candidate.createSetup === 'function' &&
    typeof candidate.getSetup === 'function' &&
    typeof candidate.cancelSetup === 'function' &&
    typeof candidate.getPaymentMethod === 'function' &&
    typeof candidate.detachPaymentMethod === 'function'
  );
}

// ---------------------------------------------------------------------------
// Identity verification (ADR 0023)
// ---------------------------------------------------------------------------

/**
 * The `ProviderError.code` an adapter answers when identity verification is
 * not enabled on the provider account (or the credential may not use it): the
 * gateway answers 503 `identity_unavailable`, never the provider's prose.
 */
export const IDENTITY_UNAVAILABLE_CODE = 'identity_unavailable';

/** What a document check requires; absent fields are the provider's defaults. */
export interface ProviderVerificationOptions {
  readonly document?: {
    readonly allowedTypes?: readonly VerificationDocumentType[];
    readonly requireIdNumber?: boolean;
    readonly requireLiveCapture?: boolean;
    readonly requireMatchingSelfie?: boolean;
  };
}

/** One check's outcome on a report — never what the check read. */
export interface ProviderVerificationCheck {
  readonly status: VerificationCheckStatus;
  /** `null` when verified, or when the provider's code is one Orbit does not know. */
  readonly errorCode: VerificationErrorCode | null;
}

/**
 * A provider report as the gateway may see it: the outcome of each check and
 * nothing the person submitted. The adapter is the firewall — names, dates,
 * numbers, addresses and image ids never leave it.
 */
export interface ProviderVerificationReport {
  readonly providerObjectId: string;
  readonly type: VerificationSessionType;
  readonly document: ProviderVerificationCheck | null;
  readonly idNumber: ProviderVerificationCheck | null;
  readonly selfie: ProviderVerificationCheck | null;
}

/** A provider verification session, in the gateway's vocabulary. */
export interface ProviderVerificationSession {
  readonly providerObjectId: string;
  readonly status: VerificationSessionStatus;
  readonly type: VerificationSessionType;
  /** The last attempt failed: `errorCode` names why when Orbit knows the code. */
  readonly lastError: { readonly errorCode: VerificationErrorCode | null } | null;
  /** The person's single-use credentials — handed to the caller, never stored. */
  readonly clientSecret: string | null;
  readonly url: string | null;
  /** The newest report, already reduced to its outcomes. */
  readonly lastReport: ProviderVerificationReport | null;
  readonly redaction: VerificationRedactionStatus | null;
}

/** The person's verified data, read live for one answer and never stored. */
export interface ProviderVerifiedOutputs {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly country: string | null;
  } | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly idNumberType: VerificationIdNumberType | null;
  /** Only when asked for. */
  readonly dob?: {
    readonly day: number | null;
    readonly month: number | null;
    readonly year: number | null;
  } | null;
  /** Only when asked for. */
  readonly idNumber?: string | null;
}

export interface CreateVerificationSessionRequest {
  /** The public `vs_…` — correlation (provider metadata) and idempotency basis. */
  readonly verificationSessionId: string;
  readonly type: VerificationSessionType;
  readonly options: ProviderVerificationOptions;
  readonly returnUrl: string | null;
  readonly idempotencyKey: string;
}

/**
 * A provider that verifies people's identity documents (Stripe Identity).
 * Optional, like every capability: a provider without it answers 503
 * `identity_unavailable`. Every method throws a `ProviderError` with
 * {@link IDENTITY_UNAVAILABLE_CODE} when the account cannot use it.
 */
export interface IdentityVerifyingProvider extends PaymentProvider {
  createVerificationSession(
    request: CreateVerificationSessionRequest,
  ): Promise<ProviderVerificationSession>;
  /** Read the provider's view, with its newest report's outcomes. No idempotency key. */
  getVerificationSession(providerObjectId: string): Promise<ProviderVerificationSession>;
  updateVerificationSession(request: {
    readonly providerObjectId: string;
    readonly type?: VerificationSessionType;
    readonly options?: ProviderVerificationOptions;
    readonly idempotencyKey: string;
  }): Promise<ProviderVerificationSession>;
  cancelVerificationSession(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderVerificationSession>;
  redactVerificationSession(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderVerificationSession>;
  /** The verified data, live; `null` when the provider holds none. */
  getVerifiedOutputs(
    providerObjectId: string,
    include: { readonly dob: boolean; readonly idNumber: boolean },
  ): Promise<ProviderVerifiedOutputs | null>;
}

export function isIdentityVerifyingProvider(
  provider: PaymentProvider,
): provider is IdentityVerifyingProvider {
  const candidate = provider as Partial<IdentityVerifyingProvider>;
  return (
    typeof candidate.createVerificationSession === 'function' &&
    typeof candidate.getVerificationSession === 'function' &&
    typeof candidate.updateVerificationSession === 'function' &&
    typeof candidate.cancelVerificationSession === 'function' &&
    typeof candidate.redactVerificationSession === 'function' &&
    typeof candidate.getVerifiedOutputs === 'function'
  );
}

// ---------------------------------------------------------------------------
// Terminal (ADR 0024)
// ---------------------------------------------------------------------------

/**
 * The `ProviderError.code`s an adapter answers for Terminal: not enabled on
 * the provider account (503 `terminal_unavailable`), a reader that is already
 * doing something (409 `terminal_reader_busy`) or cannot be reached (409
 * `terminal_reader_offline`). Never the provider's prose.
 */
export const TERMINAL_UNAVAILABLE_CODE = 'terminal_unavailable';
export const TERMINAL_READER_BUSY_CODE = 'terminal_reader_busy';
export const TERMINAL_READER_OFFLINE_CODE = 'terminal_reader_offline';

export interface ProviderTerminalLocation {
  readonly providerObjectId: string;
  readonly displayName: string;
  readonly address: Address;
}

/**
 * The reader's action as the gateway may see it: which payment it collects
 * and how it ended, as CODES. `other` is an action Orbit did not start (a
 * cart display, a refund on the device) — reported so the gateway can tell it
 * apart, never followed.
 */
export interface ProviderTerminalReaderAction {
  readonly type: 'process_payment_intent' | 'other';
  readonly status: TerminalReaderActionStatus;
  /** The provider's PaymentIntent the action collects, for `process_payment_intent`. */
  readonly paymentObjectId: string | null;
  readonly failureCode: string | null;
}

export interface ProviderTerminalReader {
  readonly providerObjectId: string;
  readonly label: string;
  readonly deviceType: string;
  readonly serialNumber: string;
  readonly status: TerminalReaderStatus | null;
  readonly lastSeenAt: Date | null;
  readonly locationObjectId: string | null;
  readonly action: ProviderTerminalReaderAction | null;
}

/**
 * A provider with card readers (Stripe Terminal). Optional, like every
 * capability: a provider without it answers 503 `terminal_unavailable`.
 * Locations and readers belong to the PLATFORM account in the credential's
 * mode; a reader's collection confirms the gateway's own card PaymentIntent,
 * whose routing (platform or destination charge) was decided at its create.
 */
export interface TerminalProvider extends PaymentProvider {
  createTerminalLocation(request: {
    /** Orbit's `tml_…` — correlation and idempotency basis. */
    readonly locationId: string;
    readonly displayName: string;
    readonly address: Address;
    readonly idempotencyKey: string;
  }): Promise<ProviderTerminalLocation>;
  updateTerminalLocation(request: {
    readonly providerObjectId: string;
    readonly displayName?: string;
    readonly address?: Address;
    readonly idempotencyKey: string;
  }): Promise<ProviderTerminalLocation>;
  /** Already gone at the provider is success. */
  deleteTerminalLocation(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
  registerTerminalReader(request: {
    /** Orbit's `tmr_…` — correlation and idempotency basis. */
    readonly readerId: string;
    readonly registrationCode: string;
    readonly label?: string;
    readonly locationObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderTerminalReader>;
  /** The provider's view; `null` when the reader no longer exists there. */
  getTerminalReader(providerObjectId: string): Promise<ProviderTerminalReader | null>;
  updateTerminalReader(request: {
    readonly providerObjectId: string;
    readonly label: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderTerminalReader>;
  /** Already gone at the provider is success. */
  deleteTerminalReader(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
  /** Hand the reader a PaymentIntent to collect. Answers the reader as the provider took it. */
  processTerminalPayment(request: {
    readonly readerObjectId: string;
    readonly paymentObjectId: string;
    readonly enableCustomerCancellation: boolean;
    readonly idempotencyKey: string;
  }): Promise<ProviderTerminalReader>;
  cancelTerminalReaderAction(request: {
    readonly readerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderTerminalReader>;
  /**
   * A fresh SDK credential, handed through and never stored — always limited
   * to one location: readers are on the platform account every merchant shares.
   */
  createTerminalConnectionToken(request: {
    readonly locationObjectId: string;
  }): Promise<{ readonly secret: string }>;
  /** TEST MODE: a test card tapped on a simulated reader. */
  presentTerminalPaymentMethod(request: {
    readonly readerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderTerminalReader>;
}

export function isTerminalProvider(provider: PaymentProvider): provider is TerminalProvider {
  const candidate = provider as Partial<TerminalProvider>;
  return (
    typeof candidate.createTerminalLocation === 'function' &&
    typeof candidate.updateTerminalLocation === 'function' &&
    typeof candidate.deleteTerminalLocation === 'function' &&
    typeof candidate.registerTerminalReader === 'function' &&
    typeof candidate.getTerminalReader === 'function' &&
    typeof candidate.updateTerminalReader === 'function' &&
    typeof candidate.deleteTerminalReader === 'function' &&
    typeof candidate.processTerminalPayment === 'function' &&
    typeof candidate.cancelTerminalReaderAction === 'function' &&
    typeof candidate.createTerminalConnectionToken === 'function' &&
    typeof candidate.presentTerminalPaymentMethod === 'function'
  );
}
