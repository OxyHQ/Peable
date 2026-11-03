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

import type Stripe from 'stripe';
import {
  type BillingDetails,
  type CurrencyCode,
  DISPUTE_TEXT_EVIDENCE_FIELDS,
  type DisputeFileEvidenceField,
  type DisputeTextEvidenceField,
  type PaymentMethodConfigurationType,
} from '@peable.to/shared-types';
import { config } from '../../../config';
import {
  cancelStripePaymentIntent,
  captureStripePaymentIntent,
  cancelStripeSetupIntent,
  confirmStripePaymentIntent,
  constructStripeEvent,
  createStripeSetupIntent,
  detachStripePaymentMethod,
  retrieveStripePaymentMethod,
  retrieveStripeSetupIntent,
  createStripeCustomer,
  createStripeAccountLink,
  createStripeConnectedAccountV2,
  createStripePaymentIntent,
  createStripeRefund,
  createStripeTransfer,
  createStripeTransferReversal,
  retrieveStripeAccount,
  retrieveStripeCharge,
  retrieveStripeChargeWithBalance,
  retrieveStripePaymentIntent,
  retrieveStripeTransfer,
  updateStripeDispute,
  retrieveStripeDispute,
  closeStripeDispute,
  createStripeDisputeFile,
  createStripePaymentMethodConfiguration,
  updateStripePaymentMethodConfiguration,
  createStripePaymentMethodDomain,
  updateStripePaymentMethodDomain,
  validateStripePaymentMethodDomain,
  cancelStripePayout,
  cancelStripeRefund,
  createStripePayout,
  listStripeBalanceTransactions,
  listStripePayouts,
  retrieveStripeApplicationFee,
  retrieveStripeChargeWithLedger,
  retrieveStripePayout,
  updateStripeAccount,
} from './client';
import { toDisputeStatus } from '../disputeStatus';
import {
  toAccountSettings,
  toBusinessProfile,
  toProviderApplicationFee,
  toProviderBalanceTransaction,
  toProviderPayout,
  toStripeAccountUpdate,
} from './money';
import {
  ProviderError,
  type AccountConfiguringProvider,
  type CancelPaymentRequest,
  type CapturePaymentRequest,
  type ChargeReadingProvider,
  type ConfirmPaymentRequest,
  type CreateProviderCustomerRequest,
  type CreateSetupRequest,
  type ProviderPaymentMethodSnapshot,
  type ProviderSetupResult,
  type SetupHoldingProvider,
  type CustomerHoldingProvider,
  type DisputeHandlingProvider,
  type DomainRegisteringProvider,
  type PaymentMethodConfiguringProvider,
  type ProviderDisputeEvidence,
  type ProviderDisputeSnapshot,
  type ProviderPaymentMethodDomain,
  type ProviderWalletStanding,
  type SavePaymentMethodConfigurationRequest,
  type UpdateDisputeEvidenceRequest,
  type UploadDisputeEvidenceFileRequest,
  type ProviderSettlement,
  UNKNOWN_SETTLEMENT,
  type SettlementReportingProvider,
  type AccountLinkRequest,
  type CreateAccountRequest,
  type CreatePaymentRequest,
  type CreateTransferRequest,
  type ProviderChargeSnapshot,
  type ProviderMode,
  type ProviderAccountSnapshot,
  type ProviderCapabilityStatus,
  type ProviderEventEnvelope,
  type ProviderEventInput,
  type ProviderPaymentResult,
  type ProviderRefundResult,
  type ProviderTransferResult,
  type ProviderTransferReversalResult,
  type RefundRequest,
  type ReverseTransferRequest,
  type SettlingPaymentProvider,
  type ListBalanceTransactionsRequest,
  type MoneyMirroringProvider,
  type ProviderAccountUpdate,
  type ProviderApplicationFee,
  type ProviderBalanceTransaction,
  type ProviderPayout,
} from '../provider';
import { mapPaymentIntentStatus, toProviderEventEnvelope } from './verify';
import { fromUnix } from '../../../lib/time';

/** Which endpoint a delivery arrived on. The two carry different secrets. */
export type StripeWebhookScope = 'platform' | 'connect';

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
function toStripeAmount(
  amount: string,
  stage: 'createPayment' | 'capture' | 'refund' | 'transfer' | 'payout',
): number {
  const value = Number(amount);
  if (!Number.isSafeInteger(value)) {
    throw new ProviderError({
      provider: 'stripe',
      stage,
      message: `amount ${amount} cannot be represented exactly as a Stripe amount`,
      retryable: false,
      code: 'amount_not_representable',
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
/** Stripe's billing details in Peable's shape — the same on a payment method and a charge. */
function toBillingDetails(
  billing: Stripe.PaymentMethod.BillingDetails | Stripe.Charge.BillingDetails | null | undefined,
): BillingDetails {
  return {
    address: billing?.address
      ? {
          line1: billing.address.line1 ?? null,
          line2: billing.address.line2 ?? null,
          city: billing.address.city ?? null,
          state: billing.address.state ?? null,
          postal_code: billing.address.postal_code ?? null,
          country: billing.address.country ?? null,
        }
      : null,
    email: billing?.email ?? null,
    name: billing?.name ?? null,
    phone: billing?.phone ?? null,
  };
}

function readChargeId(latestCharge: Stripe.PaymentIntent['latest_charge']): string | undefined {
  if (typeof latestCharge === 'string') return latestCharge;
  if (typeof latestCharge === 'object' && latestCharge !== null) return latestCharge.id;
  return undefined;
}

/**
 * The gateway's evidence field names in Stripe's spelling — text and file.
 *
 * Written out rather than passed through: a field Stripe renames (or one the
 * gateway names differently) is a compile-time edit here instead of a silently
 * dropped piece of a merchant's defence. TOTAL over the wire contract's field
 * sets: a field added there and not here is a field a merchant sends, the
 * gateway accepts, and the network never sees — as a `Record` it fails to
 * compile instead.
 */
const STRIPE_EVIDENCE_FIELDS: Record<
  DisputeTextEvidenceField | DisputeFileEvidenceField,
  keyof Stripe.DisputeUpdateParams.Evidence
> = {
  access_activity_log: 'access_activity_log',
  billing_address: 'billing_address',
  cancellation_policy_disclosure: 'cancellation_policy_disclosure',
  cancellation_rebuttal: 'cancellation_rebuttal',
  customer_email_address: 'customer_email_address',
  customer_name: 'customer_name',
  customer_purchase_ip: 'customer_purchase_ip',
  duplicate_charge_explanation: 'duplicate_charge_explanation',
  product_description: 'product_description',
  refund_policy_disclosure: 'refund_policy_disclosure',
  refund_refusal_explanation: 'refund_refusal_explanation',
  service_date: 'service_date',
  shipping_address: 'shipping_address',
  shipping_carrier: 'shipping_carrier',
  shipping_date: 'shipping_date',
  shipping_tracking_number: 'shipping_tracking_number',
  uncategorized_text: 'uncategorized_text',
  cancellation_policy: 'cancellation_policy',
  customer_communication: 'customer_communication',
  customer_signature: 'customer_signature',
  duplicate_charge_documentation: 'duplicate_charge_documentation',
  receipt: 'receipt',
  refund_policy: 'refund_policy',
  service_documentation: 'service_documentation',
  shipping_documentation: 'shipping_documentation',
  uncategorized_file: 'uncategorized_file',
};

/**
 * An omitted key is omitted from the request too — sending `undefined` would
 * clear a field the merchant had already staged. `""` is sent as itself: it is
 * how a merchant unsets a field.
 */
function toStripeEvidence(evidence: ProviderDisputeEvidence): Stripe.DisputeUpdateParams.Evidence {
  const out: Record<string, string> = {};
  for (const [ours, theirs] of Object.entries(STRIPE_EVIDENCE_FIELDS)) {
    const value = evidence[ours as keyof ProviderDisputeEvidence];
    if (value !== undefined) out[theirs] = value;
  }
  return out;
}

/** What a Stripe dispute says, in the port's vocabulary: no prose, no file ids. */
function toDisputeSnapshot(dispute: Stripe.Dispute): ProviderDisputeSnapshot {
  const evidence = dispute.evidence as unknown as Record<string, unknown> | null;
  const text = Object.fromEntries(
    DISPUTE_TEXT_EVIDENCE_FIELDS.map((field) => {
      const value = evidence?.[STRIPE_EVIDENCE_FIELDS[field]];
      return [field, typeof value === 'string' && value.length > 0 ? value : null];
    }),
  ) as Record<DisputeTextEvidenceField, string | null>;
  return {
    status: toDisputeStatus(dispute.status),
    hasEvidence: dispute.evidence_details?.has_evidence === true,
    submissionCount: dispute.evidence_details?.submission_count ?? 0,
    isChargeRefundable: dispute.is_charge_refundable === true,
    evidence: text,
  };
}

/**
 * Stripe's configuration keys for Orbit's methods. Methods Orbit does not
 * offer are switched OFF explicitly on every save (`STRIPE_METHODS_ORBIT_OMITS`):
 * a configuration created without them inherits the account's defaults, and a
 * payer would be offered a method the merchant never saw a toggle for.
 */
const STRIPE_METHOD_KEYS = {
  card: 'card',
  apple_pay: 'apple_pay',
  google_pay: 'google_pay',
  sepa_debit: 'sepa_debit',
  ideal: 'ideal',
  bancontact: 'bancontact',
  eps: 'eps',
} as const satisfies Partial<
  Record<PaymentMethodConfigurationType, keyof Stripe.PaymentMethodConfigurationCreateParams>
>;

const STRIPE_METHODS_ORBIT_OMITS = [
  'link',
  'klarna',
  'affirm',
  'afterpay_clearpay',
  'cashapp',
  'amazon_pay',
  'paypal',
  'revolut_pay',
  'mobilepay',
  'twint',
  'p24',
  'blik',
  'multibanco',
  'alipay',
  'wechat_pay',
  'giropay',
] as const satisfies readonly (keyof Stripe.PaymentMethodConfigurationCreateParams)[];

function toStripeConfigurationParams(
  methods: Readonly<Partial<Record<PaymentMethodConfigurationType, 'on' | 'off'>>>,
): Stripe.PaymentMethodConfigurationCreateParams {
  const params: Record<string, { display_preference: { preference: 'on' | 'off' } }> = {};
  for (const key of STRIPE_METHODS_ORBIT_OMITS) {
    params[key] = { display_preference: { preference: 'off' } };
  }
  for (const [ours, theirs] of Object.entries(STRIPE_METHOD_KEYS)) {
    const value = methods[ours as keyof typeof STRIPE_METHOD_KEYS];
    if (value !== undefined) params[theirs] = { display_preference: { preference: value } };
  }
  return params as Stripe.PaymentMethodConfigurationCreateParams;
}

/** A wallet's standing on a Stripe domain, in Peable's words. */
function toWalletStanding(
  wallet: { status: string } | undefined,
  name: 'Apple Pay' | 'Google Pay',
): ProviderWalletStanding {
  if (wallet?.status === 'active') return { status: 'active', error: null };
  return {
    status: 'inactive',
    error: `${name} has not verified this domain yet. Serve the domain association file it requires, then validate the domain again.`,
  };
}

function toDomainSnapshot(domain: Stripe.PaymentMethodDomain): ProviderPaymentMethodDomain {
  return {
    providerObjectId: domain.id,
    enabled: domain.enabled,
    applePay: toWalletStanding(domain.apple_pay, 'Apple Pay'),
    googlePay: toWalletStanding(domain.google_pay, 'Google Pay'),
  };
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
  if (value === 'active' || value === 'pending' || value === 'inactive') return value;
  return null;
}

export interface StripePaymentProviderOptions {
  /**
   * The mode this adapter acts in (ADR 0017), fixed for its life. Every call it
   * makes goes through that mode's client, and every delivery it verifies is
   * checked against that mode's endpoint secrets.
   */
  readonly mode: ProviderMode;
  readonly paymentMethodConfiguration?: string;
  /** An explicit integration capability; absent keeps account-configured dynamic methods. */
  readonly allowedPaymentMethodTypes?: readonly Stripe.PaymentIntentCreateParams.AllowedPaymentMethodType[];
}

export class StripePaymentProvider
  implements
    SettlingPaymentProvider,
    AccountConfiguringProvider,
    DisputeHandlingProvider,
    SettlementReportingProvider,
    ChargeReadingProvider,
    CustomerHoldingProvider,
    SetupHoldingProvider,
    PaymentMethodConfiguringProvider,
    DomainRegisteringProvider,
    MoneyMirroringProvider
{
  readonly id = 'stripe' as const;
  readonly mode: ProviderMode;
  private readonly paymentMethodConfiguration?: string;
  private readonly allowedPaymentMethodTypes?: readonly Stripe.PaymentIntentCreateParams.AllowedPaymentMethodType[];

  constructor(options: StripePaymentProviderOptions) {
    this.mode = options.mode;
    if (options.allowedPaymentMethodTypes && options.paymentMethodConfiguration)
      throw new Error('Choose either a payment method allowlist or a configuration');
    if (
      options.paymentMethodConfiguration &&
      !/^pmc_[A-Za-z0-9]+$/.test(options.paymentMethodConfiguration)
    )
      throw new Error('Invalid payment method configuration');
    this.paymentMethodConfiguration = options.paymentMethodConfiguration;
    if (options.allowedPaymentMethodTypes) {
      if (!options.allowedPaymentMethodTypes.length) throw new Error('Empty payment method policy');
      this.allowedPaymentMethodTypes = Object.freeze([...options.allowedPaymentMethodTypes]);
    }
  }

  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    const params: Stripe.PaymentIntentCreateParams = {
      amount: toStripeAmount(request.amount.amount, 'createPayment'),
      currency: toStripeCurrency(request.amount.currency),
      // `automatic_payment_methods` rather than a hand-listed set: the methods a
      // payment can offer are a dashboard decision an operator changes without a
      // deploy, and hard-coding them here would make that dashboard lie. A
      // saved card being charged names its own type.
      //
      // Precedence, most specific first: a saved card charges as a card; types
      // the merchant NAMED are exactly those; otherwise the merchant's
      // configuration (its binding) decides, with the provider filtering by
      // currency; the adapter-wide options are what remains for an operator
      // script that names neither.
      ...(request.paymentMethodObjectId !== undefined
        ? { payment_method_types: ['card'] }
        : request.paymentMethodTypes !== undefined
          ? { payment_method_types: [...request.paymentMethodTypes] }
          : request.paymentMethodConfigurationObjectId !== undefined
            ? {
                automatic_payment_methods: { enabled: true },
                payment_method_configuration: request.paymentMethodConfigurationObjectId,
              }
            : this.allowedPaymentMethodTypes
              ? { allowed_payment_method_types: [...this.allowedPaymentMethodTypes] }
              : {
                  automatic_payment_methods: { enabled: true },
                  ...(this.paymentMethodConfiguration
                    ? { payment_method_configuration: this.paymentMethodConfiguration }
                    : {}),
                }),
      metadata: { ...request.metadata, peable_intent_id: request.intentId },
      // Ties every movement of one checkout together at Stripe, so a support
      // conversation can find the charge and its transfers from one id.
      transfer_group: request.intentId,
      ...(request.onBehalfOf !== undefined ? { on_behalf_of: request.onBehalfOf } : {}),
      // A destination charge (ADR 0015 §2): the funds go to the merchant's own
      // account and Orbit's fee stays with the platform.
      ...(request.transferDestination !== undefined
        ? {
            transfer_data: {
              destination: request.transferDestination,
              ...(request.transferAmount !== undefined
                ? { amount: toStripeAmount(request.transferAmount, 'createPayment') }
                : {}),
            },
          }
        : {}),
      ...(request.applicationFeeAmount !== undefined
        ? { application_fee_amount: toStripeAmount(request.applicationFeeAmount, 'createPayment') }
        : {}),
      ...(request.captureMethod === 'manual' ? { capture_method: 'manual' as const } : {}),
      ...(request.customerObjectId !== undefined ? { customer: request.customerObjectId } : {}),
      ...(request.paymentMethodObjectId !== undefined
        ? { payment_method: request.paymentMethodObjectId }
        : {}),
      ...(request.setupFutureUsage !== undefined
        ? { setup_future_usage: request.setupFutureUsage }
        : {}),
      ...(request.statementDescriptorSuffix !== undefined
        ? { statement_descriptor_suffix: request.statementDescriptorSuffix }
        : {}),
      ...(request.confirm
        ? {
            confirm: true,
            ...(request.offSession ? { off_session: true } : {}),
            ...(request.returnUrl !== undefined ? { return_url: request.returnUrl } : {}),
          }
        : {}),
    };
    const intent = await createStripePaymentIntent(this.mode, params, request.idempotencyKey);
    return this.toResult(intent);
  }

  async confirm(request: ConfirmPaymentRequest): Promise<ProviderPaymentResult> {
    const intent = await confirmStripePaymentIntent(
      this.mode,
      request.providerObjectId,
      {
        payment_method: request.paymentMethodObjectId,
        ...(request.offSession ? { off_session: true } : {}),
        ...(request.setupFutureUsage !== undefined
          ? { setup_future_usage: request.setupFutureUsage }
          : {}),
        ...(request.returnUrl !== undefined ? { return_url: request.returnUrl } : {}),
      },
      request.idempotencyKey,
    );
    return this.toResult(intent);
  }

  /**
   * Capture a held authorization.
   *
   * On a payment that was not held (`requires_capture`) there is nothing to
   * capture, so this READS the payment back rather than pretending to act:
   * calling `paymentIntents.capture` on an already-captured intent is an error,
   * not a no-op.
   */
  async capture(request: CapturePaymentRequest): Promise<ProviderPaymentResult> {
    const current = await retrieveStripePaymentIntent(this.mode, request.providerObjectId);
    if (current.status !== 'requires_capture') return this.toResult(current);
    const captured = await captureStripePaymentIntent(
      this.mode,
      request.providerObjectId,
      request.amountToCapture !== undefined
        ? { amount_to_capture: toStripeAmount(request.amountToCapture, 'capture') }
        : {},
      request.idempotencyKey,
    );
    return this.toResult(captured);
  }

  async cancel(request: CancelPaymentRequest): Promise<ProviderPaymentResult> {
    const canceled = await cancelStripePaymentIntent(
      this.mode,
      request.providerObjectId,
      request.cancellationReason !== undefined
        ? { cancellation_reason: request.cancellationReason }
        : {},
      request.idempotencyKey,
    );
    return this.toResult(canceled);
  }

  async refund(request: RefundRequest): Promise<ProviderRefundResult> {
    const refund = await createStripeRefund(
      this.mode,
      {
        payment_intent: request.providerObjectId,
        amount: toStripeAmount(request.amount.amount, 'refund'),
        metadata: { ...request.metadata, peable_refund_id: request.refundId },
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
        ...(request.refundApplicationFee ? { refund_application_fee: true } : {}),
        ...(request.reverseTransfer ? { reverse_transfer: true } : {}),
      },
      request.idempotencyKey,
    );
    return toRefundResult(refund);
  }

  async cancelRefund(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderRefundResult> {
    return toRefundResult(
      await cancelStripeRefund(this.mode, request.providerObjectId, request.idempotencyKey),
    );
  }

  // -------------------------------------------------------------------------
  // Orbit money (ADR 0015): balance transactions, payouts, application fees
  // -------------------------------------------------------------------------

  async listBalanceTransactions(
    request: ListBalanceTransactionsRequest,
  ): Promise<{ data: ProviderBalanceTransaction[]; hasMore: boolean }> {
    const created: Stripe.RangeQueryParam = {};
    if (request.createdGte) created.gte = Math.floor(request.createdGte.getTime() / 1000);
    if (request.createdLt) created.lt = Math.floor(request.createdLt.getTime() / 1000);
    const page = await listStripeBalanceTransactions(this.mode, request.account, {
      limit: request.limit,
      ...(Object.keys(created).length > 0 ? { created } : {}),
      ...(request.payout !== undefined ? { payout: request.payout } : {}),
      ...(request.startingAfter !== undefined ? { starting_after: request.startingAfter } : {}),
    });
    return { data: page.data.map(toProviderBalanceTransaction), hasMore: page.has_more };
  }

  async getChargeBalanceTransactions(
    chargeObjectId: string,
  ): Promise<ProviderBalanceTransaction[]> {
    const charge = await retrieveStripeChargeWithLedger(this.mode, chargeObjectId);
    const out: ProviderBalanceTransaction[] = [];
    if (typeof charge.balance_transaction === 'object' && charge.balance_transaction !== null) {
      out.push(toProviderBalanceTransaction(charge.balance_transaction));
    }
    for (const refund of charge.refunds?.data ?? []) {
      if (typeof refund.balance_transaction === 'object' && refund.balance_transaction !== null) {
        out.push(toProviderBalanceTransaction(refund.balance_transaction));
      }
    }
    return out;
  }

  async getPayout(account: string, providerObjectId: string): Promise<ProviderPayout> {
    return toProviderPayout(await retrieveStripePayout(this.mode, account, providerObjectId));
  }

  async listPayouts(request: {
    readonly account: string;
    readonly createdGte?: Date;
    readonly startingAfter?: string;
    readonly limit: number;
  }): Promise<{ data: ProviderPayout[]; hasMore: boolean }> {
    const page = await listStripePayouts(this.mode, request.account, {
      limit: request.limit,
      ...(request.createdGte
        ? { created: { gte: Math.floor(request.createdGte.getTime() / 1000) } }
        : {}),
      ...(request.startingAfter !== undefined ? { starting_after: request.startingAfter } : {}),
    });
    return { data: page.data.map(toProviderPayout), hasMore: page.has_more };
  }

  async createPayout(request: {
    readonly account: string;
    readonly payoutId: string;
    readonly amount: string;
    readonly currency: string;
    readonly method: 'standard' | 'instant';
    readonly description?: string;
    readonly statementDescriptor?: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderPayout> {
    const payout = await createStripePayout(
      this.mode,
      request.account,
      {
        amount: toStripeAmount(request.amount, 'payout'),
        currency: toStripeCurrency(request.currency),
        method: request.method,
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.statementDescriptor !== undefined
          ? { statement_descriptor: request.statementDescriptor }
          : {}),
        metadata: { peable_payout_id: request.payoutId },
      },
      request.idempotencyKey,
    );
    return toProviderPayout(payout);
  }

  async cancelPayout(request: {
    readonly account: string;
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderPayout> {
    return toProviderPayout(
      await cancelStripePayout(
        this.mode,
        request.account,
        request.providerObjectId,
        request.idempotencyKey,
      ),
    );
  }

  async getApplicationFee(providerObjectId: string): Promise<ProviderApplicationFee> {
    return toProviderApplicationFee(
      await retrieveStripeApplicationFee(this.mode, providerObjectId),
    );
  }

  async getStatus(providerObjectId: string): Promise<ProviderPaymentResult> {
    return this.toResult(await retrieveStripePaymentIntent(this.mode, providerObjectId));
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
    return this.verifyEventForScope(input, 'platform');
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
    const mode = config.stripe[this.mode];
    const secrets = (
      scope === 'platform'
        ? [mode?.webhookSecret, mode?.webhookSecretPrevious]
        : [mode?.connectWebhookSecret, mode?.connectWebhookSecretPrevious]
    ).filter((secret): secret is string => secret !== undefined);

    if (secrets.length === 0) {
      throw new ProviderError({
        provider: 'stripe',
        stage: 'verifyEvent',
        message: `no ${this.mode} ${scope} webhook secret is configured`,
        retryable: false,
        code: 'webhook_secret_missing',
      });
    }

    const event = await constructStripeEvent(this.mode, input.payload, input.signature, secrets);
    return toProviderEventEnvelope(event);
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  async createTransfer(request: CreateTransferRequest): Promise<ProviderTransferResult> {
    const transfer = await createStripeTransfer(
      this.mode,
      {
        amount: toStripeAmount(request.amount.amount, 'transfer'),
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
      status: transfer.reversed ? 'reversed' : 'paid',
    };
  }

  async reverseTransfer(request: ReverseTransferRequest): Promise<ProviderTransferReversalResult> {
    const reversal = await createStripeTransferReversal(
      this.mode,
      request.transferObjectId,
      {
        amount: toStripeAmount(request.amount.amount, 'transfer'),
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
    if (typeof expanded === 'object' && expanded !== null && 'amount_reversed' in expanded) {
      return { providerObjectId: reversal.id, totalReversed: String(expanded.amount_reversed) };
    }

    const transfer = await retrieveStripeTransfer(this.mode, request.transferObjectId);
    return {
      providerObjectId: reversal.id,
      totalReversed: String(transfer.amount_reversed),
    };
  }

  // -------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------

  /**
   * Stage or submit evidence — Stripe's `disputes.update`, whose `submit` flag
   * is the whole difference and is one-way. The draft lives at Stripe; the
   * answer is read back so the caller learns `has_evidence` without storing
   * a word of it.
   */
  async updateDisputeEvidence(
    request: UpdateDisputeEvidenceRequest,
  ): Promise<ProviderDisputeSnapshot> {
    const dispute = await updateStripeDispute(
      this.mode,
      request.providerObjectId,
      { evidence: toStripeEvidence(request.evidence), submit: request.submit },
      request.idempotencyKey,
    );
    return toDisputeSnapshot(dispute);
  }

  async getDispute(providerObjectId: string): Promise<ProviderDisputeSnapshot> {
    return toDisputeSnapshot(await retrieveStripeDispute(this.mode, providerObjectId));
  }

  async closeDispute(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderDisputeSnapshot> {
    return toDisputeSnapshot(
      await closeStripeDispute(this.mode, request.providerObjectId, request.idempotencyKey),
    );
  }

  async uploadDisputeEvidenceFile(
    request: UploadDisputeEvidenceFileRequest,
  ): Promise<{ readonly providerFileId: string }> {
    const file = await createStripeDisputeFile(
      this.mode,
      { data: request.bytes, name: request.filename, type: request.mime },
      request.idempotencyKey,
    );
    return { providerFileId: file.id };
  }

  // -------------------------------------------------------------------------
  // Payment method configurations and wallet domains
  // -------------------------------------------------------------------------

  async savePaymentMethodConfiguration(
    request: SavePaymentMethodConfigurationRequest,
  ): Promise<{ readonly providerObjectId: string }> {
    const params = toStripeConfigurationParams(request.methods);
    if (request.providerObjectId === undefined) {
      const created = await createStripePaymentMethodConfiguration(
        this.mode,
        { ...params, name: request.configurationId },
        request.idempotencyKey,
      );
      return { providerObjectId: created.id };
    }
    const updated = await updateStripePaymentMethodConfiguration(
      this.mode,
      request.providerObjectId,
      params as Stripe.PaymentMethodConfigurationUpdateParams,
    );
    return { providerObjectId: updated.id };
  }

  async createPaymentMethodDomain(request: {
    readonly domainName: string;
    readonly enabled: boolean;
    readonly idempotencyKey: string;
  }): Promise<ProviderPaymentMethodDomain> {
    return toDomainSnapshot(
      await createStripePaymentMethodDomain(
        this.mode,
        { domain_name: request.domainName, enabled: request.enabled },
        request.idempotencyKey,
      ),
    );
  }

  async updatePaymentMethodDomain(request: {
    readonly providerObjectId: string;
    readonly enabled: boolean;
  }): Promise<ProviderPaymentMethodDomain> {
    return toDomainSnapshot(
      await updateStripePaymentMethodDomain(this.mode, request.providerObjectId, {
        enabled: request.enabled,
      }),
    );
  }

  async validatePaymentMethodDomain(
    providerObjectId: string,
  ): Promise<ProviderPaymentMethodDomain> {
    return toDomainSnapshot(await validateStripePaymentMethodDomain(this.mode, providerObjectId));
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
    const charge = await retrieveStripeChargeWithBalance(this.mode, chargeObjectId);
    const balance = charge.balance_transaction;

    if (typeof balance !== 'object' || balance === null) {
      // Either an unexpanded id — which cannot happen, this asked for the
      // expansion — or no transaction at all, which is an uncaptured or
      // not-yet-settled charge. Neither is "the fee was nothing".
      return UNKNOWN_SETTLEMENT;
    }

    return {
      status: balance.status === 'available' ? 'available' : 'pending',
      gross: String(balance.amount),
      fee: String(balance.fee),
      net: String(balance.net),
      currency: balance.currency.toUpperCase() as CurrencyCode,
      // Seconds since the epoch, like every Stripe timestamp.
      availableOn: fromUnix(balance.available_on),
      // Only when the settlement currency differs from the charge's. `null`
      // rather than `1` for a same-currency settlement: a rate of one is a
      // conversion that happened, and none happened.
      exchangeRate: balance.exchange_rate ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  /** A provider customer carrying only Peable's correlation id (ADR 0016). */
  async createCustomer(
    request: CreateProviderCustomerRequest,
  ): Promise<{ providerObjectId: string }> {
    const customer = await createStripeCustomer(
      this.mode,
      { metadata: { peable_customer_id: request.customerId } },
      request.idempotencyKey,
    );
    return { providerObjectId: customer.id };
  }

  // -------------------------------------------------------------------------
  // SetupIntents and payment methods (ADR 0016)
  // -------------------------------------------------------------------------

  async createSetup(request: CreateSetupRequest): Promise<ProviderSetupResult> {
    const setup = await createStripeSetupIntent(
      this.mode,
      {
        customer: request.customerObjectId,
        usage: request.usage,
        payment_method_types: ['card'],
        metadata: { peable_setup_intent_id: request.setupIntentId },
      },
      request.idempotencyKey,
    );
    return toSetupResult(setup);
  }

  async getSetup(providerObjectId: string): Promise<ProviderSetupResult> {
    return toSetupResult(await retrieveStripeSetupIntent(this.mode, providerObjectId));
  }

  async cancelSetup(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
    readonly cancellationReason?: 'abandoned' | 'duplicate' | 'requested_by_customer';
  }): Promise<ProviderSetupResult> {
    const setup = await cancelStripeSetupIntent(
      this.mode,
      request.providerObjectId,
      request.cancellationReason !== undefined
        ? { cancellation_reason: request.cancellationReason }
        : {},
      request.idempotencyKey,
    );
    return toSetupResult(setup);
  }

  /** The card's safe fields and the billing details — never the number. */
  async getPaymentMethod(providerObjectId: string): Promise<ProviderPaymentMethodSnapshot> {
    const method = await retrieveStripePaymentMethod(this.mode, providerObjectId);
    const card = method.card;
    const billing = method.billing_details;
    const customer =
      typeof method.customer === 'string'
        ? method.customer
        : method.customer && typeof method.customer === 'object'
          ? method.customer.id
          : undefined;
    return {
      providerObjectId: method.id,
      card: {
        brand: card?.brand ?? null,
        last4: card?.last4 ?? null,
        exp_month: card?.exp_month ?? null,
        exp_year: card?.exp_year ?? null,
        country: card?.country ?? null,
        funding: card?.funding ?? null,
      },
      billingDetails: toBillingDetails(billing),
      ...(customer !== undefined ? { customerObjectId: customer } : {}),
    };
  }

  async detachPaymentMethod(request: {
    readonly providerObjectId: string;
    readonly idempotencyKey: string;
  }): Promise<void> {
    await detachStripePaymentMethod(this.mode, request.providerObjectId, request.idempotencyKey);
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  /**
   * The outcome and card of one charge — codes and safe card fields only. The
   * provider's `seller_message` and `receipt_url` are NOT read: both carry the
   * provider's prose or brand, which never reach Orbit's wire (ADR 0001 D3).
   */
  async getChargeSnapshot(chargeObjectId: string): Promise<ProviderChargeSnapshot> {
    const charge = await retrieveStripeCharge(this.mode, chargeObjectId);
    const outcome = charge.outcome;
    const card = charge.payment_method_details?.card;
    return {
      billingDetails: toBillingDetails(charge.billing_details),
      outcome: outcome
        ? {
            networkStatus: outcome.network_status ?? null,
            riskLevel: outcome.risk_level ?? null,
            type: outcome.type ?? null,
          }
        : null,
      paymentMethodDetails: card
        ? {
            type: 'card',
            card: {
              brand: card.brand ?? null,
              last4: card.last4 ?? null,
              exp_month: card.exp_month ?? null,
              exp_year: card.exp_year ?? null,
              country: card.country ?? null,
              funding: card.funding ?? null,
            },
          }
        : null,
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
      this.mode,
      {
        // Derived, not sent: a v2 account created this way reads back through
        // the v1 API carrying `requirement_collection: stripe` — the property
        // that keeps identity documents out of this database, obtained by
        // construction rather than by assertion.
        // A marketplace seller keeps the express dashboard it always had; a
        // merchant's OWN account has none — Orbit is the only dashboard the
        // merchant sees (ADR 0015 §1).
        dashboard: request.role === 'merchant' ? 'none' : 'express',
        identity: { country: request.country, entity_type: request.businessType },
        defaults: {
          responsibilities: {
            losses_collector: 'application',
            fees_collector: 'application',
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

    if (typeof created.id !== 'string') {
      throw new ProviderError({
        provider: 'stripe',
        stage: 'account',
        message: 'Stripe returned no account id',
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
    const link = await createStripeAccountLink(this.mode, {
      account: request.providerAccountId,
      refresh_url: request.refreshUrl,
      return_url: request.returnUrl,
      type: request.type ?? 'account_onboarding',
      // Collect what will EVENTUALLY be due, not only what is due now.
      // Otherwise a seller completes onboarding, starts selling, and has payouts
      // interrupted weeks later by a requirement that was always coming.
      collection_options: { fields: 'eventually_due' },
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  async getAccount(providerAccountId: string): Promise<ProviderAccountSnapshot> {
    const account = await retrieveStripeAccount(this.mode, providerAccountId);
    const requirements = account.requirements;
    const transfers = account.capabilities?.transfers;
    const cardPayments = account.capabilities?.card_payments;

    return {
      providerAccountId: account.id,
      payoutsEnabled: account.payouts_enabled === true,
      chargesEnabled: account.charges_enabled === true,
      transfersCapability: toCapabilityStatus(transfers) ?? 'inactive',
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
      ...(requirements?.disabled_reason ? { disabledReason: requirements.disabled_reason } : {}),
      ...(account.default_currency
        ? {
            defaultCurrency:
              account.default_currency.toUpperCase() as ProviderAccountSnapshot['defaultCurrency'],
          }
        : {}),
      businessProfile: toBusinessProfile(account),
      settings: toAccountSettings(account),
    };
  }

  async updateAccount(
    providerAccountId: string,
    update: ProviderAccountUpdate,
    idempotencyKey: string,
  ): Promise<ProviderAccountSnapshot> {
    await updateStripeAccount(
      this.mode,
      providerAccountId,
      toStripeAccountUpdate(update),
      idempotencyKey,
    );
    // Read back through the same v1 read every snapshot comes from.
    return this.getAccount(providerAccountId);
  }

  // -------------------------------------------------------------------------

  protected toResult(intent: Stripe.PaymentIntent): ProviderPaymentResult {
    const status = mapPaymentIntentStatus(intent.status);
    const chargeObjectId = readChargeId(intent.latest_charge);
    const error = intent.last_payment_error;
    return {
      providerObjectId: intent.id,
      status,
      // Handed to the payer in the same response and never stored, so it cannot
      // become a credential sitting in a database.
      ...(intent.client_secret
        ? { clientAction: { kind: 'client_secret' as const, value: intent.client_secret } }
        : {}),
      // The CHARGE, which is a different object from the payment and is what a
      // transfer's `source_transaction` names. Absent while the payment has not
      // produced one.
      ...(chargeObjectId !== undefined ? { chargeObjectId } : {}),
      ...(readObjectId(intent.payment_method) !== undefined
        ? { paymentMethodObjectId: readObjectId(intent.payment_method) }
        : {}),
      // Codes only — the provider's `message` stays behind (ADR 0019).
      ...(status === 'requires_payment_method' && error
        ? {
            lastPaymentError: {
              type: error.type === 'card_error' ? ('card_error' as const) : ('api_error' as const),
              ...(error.code ? { code: error.code } : {}),
              ...(error.decline_code ? { declineCode: error.decline_code } : {}),
            },
          }
        : {}),
    };
  }
}

/** A Stripe refund in the gateway's vocabulary — the refund's own state, codes only. */
function toRefundResult(refund: Stripe.Refund): ProviderRefundResult {
  return {
    providerObjectId: refund.id,
    state:
      refund.status === 'succeeded'
        ? 'succeeded'
        : refund.status === 'failed'
          ? 'failed'
          : refund.status === 'canceled'
            ? 'canceled'
            : 'pending',
    ...(refund.failure_reason !== undefined && refund.failure_reason !== null
      ? { failureCode: refund.failure_reason }
      : {}),
  };
}

/** An expandable Stripe reference's id, whichever shape it arrived in. */
function readObjectId(value: string | { id: string } | null | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return value.id;
  return undefined;
}

/** A Stripe SetupIntent in the gateway's vocabulary — codes only, never prose. */
function toSetupResult(setup: Stripe.SetupIntent): ProviderSetupResult {
  const error = setup.last_setup_error;
  const paymentMethodObjectId = readObjectId(setup.payment_method);
  return {
    providerObjectId: setup.id,
    status: setup.status,
    ...(setup.client_secret
      ? { clientAction: { kind: 'client_secret' as const, value: setup.client_secret } }
      : {}),
    ...(paymentMethodObjectId !== undefined ? { paymentMethodObjectId } : {}),
    ...(setup.status === 'requires_payment_method' && error
      ? {
          lastSetupError: {
            type: error.type === 'card_error' ? ('card_error' as const) : ('api_error' as const),
            ...(error.code ? { code: error.code } : {}),
            ...(error.decline_code ? { declineCode: error.decline_code } : {}),
          },
        }
      : {}),
  };
}
