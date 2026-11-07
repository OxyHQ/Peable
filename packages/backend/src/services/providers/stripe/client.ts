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

import Stripe from 'stripe';
import { selectStripeApiVersion } from './apiVersion';
import { config } from '../../../config';
import {
  IDENTITY_UNAVAILABLE_CODE,
  ProviderError,
  TERMINAL_READER_BUSY_CODE,
  TERMINAL_READER_OFFLINE_CODE,
  TERMINAL_UNAVAILABLE_CODE,
  type ProviderMode,
  type ProviderStage,
} from '../provider';

/**
 * The Stripe API release train this integration is written against.
 *
 * Carried over from Mercaria's pin so both sides of the port speak the same
 * shapes while the migration is in flight. Changing it means re-verifying every
 * event fixture, deliberately.
 */
export const STRIPE_API_VERSION = selectStripeApiVersion(process.env);

const clients: Partial<Record<ProviderMode, Stripe>> = {};

/**
 * The Stripe client of ONE mode (ADR 0017).
 *
 * Two clients, never one with a swappable key: a client is bound to the key it
 * was built with for its whole life, so the mode a call reaches is decided by
 * which client it was handed, and a caller that holds the test client cannot
 * reach a live object through it.
 *
 * @throws when that mode has no key. Callers reach this only through
 *   `resolveProvider`, which answers `undefined` for a mode this deployment has
 *   not configured — so this throw is a programming error, not an operator one.
 */
export function getStripeClient(mode: ProviderMode): Stripe {
  const existing = clients[mode];
  if (existing) return existing;
  const secretKey = config.stripe[mode]?.secretKey;
  if (!secretKey) {
    throw new Error(
      `Stripe ${mode} mode is not configured: STRIPE_SECRET_KEY_${mode.toUpperCase()} is ` +
        'absent. This is reachable only by bypassing `resolveProvider`, which returns ' +
        'undefined for a mode this deployment has not enabled.',
    );
  }
  const client = new Stripe(secretKey, {
    // The SDK types name its default release. The only alternate release is
    // explicitly reviewed and restricted to the isolated TEST runtime; readers,
    // bindings and signed-event validation share this same version value.
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    // Named so a Stripe support conversation can identify this integration in
    // their request logs without the operator guessing.
    appInfo: { name: 'Peable Gateway', url: 'https://peable.to' },
  });
  clients[mode] = client;
  return client;
}

/** Drop both clients. Test support — a suite must not inherit another's key. */
export function resetStripeClient(): void {
  delete clients.test;
  delete clients.live;
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
      provider: 'stripe',
      stage,
      message: error.message,
      retryable: !permanent,
      ...(error.code !== undefined ? { code: error.code } : {}),
    });
  }

  return new ProviderError({
    provider: 'stripe',
    stage,
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });
}

/** Run a Stripe call, mapping every failure into the gateway's vocabulary. */
async function call<T>(
  mode: ProviderMode,
  stage: ProviderStage,
  fn: (stripe: Stripe) => Promise<T>,
): Promise<T> {
  try {
    return await fn(getStripeClient(mode));
  } catch (error) {
    throw toProviderError(error, stage);
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function createStripePaymentIntent(
  mode: ProviderMode,
  params: Stripe.PaymentIntentCreateParams,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  try {
    return await getStripeClient(mode).paymentIntents.create(params, { idempotencyKey });
  } catch (error) {
    // `confirm: true` at create: a decline is an answer, as in
    // `confirmStripePaymentIntent` below.
    if (params.confirm && error instanceof Stripe.errors.StripeCardError && error.payment_intent) {
      return error.payment_intent;
    }
    throw toProviderError(error, 'createPayment');
  }
}

export function retrieveStripePaymentIntent(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.PaymentIntent> {
  return call(mode, 'getStatus', (stripe) => stripe.paymentIntents.retrieve(id));
}

export function cancelStripePaymentIntent(
  mode: ProviderMode,
  id: string,
  params: Stripe.PaymentIntentCancelParams,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  // The idempotency key is a REQUEST OPTION (third argument), not a body
  // parameter. Passing it as the second argument type-checks in some SDK
  // versions and silently sends it as a field Stripe ignores — so the retry
  // that this key exists to make safe would create a second effect.
  return call(mode, 'cancel', (stripe) =>
    stripe.paymentIntents.cancel(id, params, { idempotencyKey }),
  );
}

export function captureStripePaymentIntent(
  mode: ProviderMode,
  id: string,
  params: Stripe.PaymentIntentCaptureParams,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  return call(mode, 'capture', (stripe) =>
    stripe.paymentIntents.capture(id, params, { idempotencyKey }),
  );
}

/**
 * Confirm server-side. A DECLINE is the provider's answer, not a failure: Stripe
 * throws a card error carrying the PaymentIntent it left in
 * `requires_payment_method` with `last_payment_error`, and that object is what
 * is returned — so the caller records the decline instead of a 5xx.
 */
export async function confirmStripePaymentIntent(
  mode: ProviderMode,
  id: string,
  params: Stripe.PaymentIntentConfirmParams,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent> {
  try {
    return await getStripeClient(mode).paymentIntents.confirm(id, params, { idempotencyKey });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeCardError && error.payment_intent) {
      return error.payment_intent;
    }
    throw toProviderError(error, 'confirm');
  }
}

/** A charge, for its outcome and card details — the `ch_…` snapshot (ADR 0019). */
export function retrieveStripeCharge(mode: ProviderMode, id: string): Promise<Stripe.Charge> {
  return call(mode, 'getStatus', (stripe) => stripe.charges.retrieve(id));
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export function createStripeCustomer(
  mode: ProviderMode,
  params: Stripe.CustomerCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Customer> {
  return call(mode, 'customer', (stripe) => stripe.customers.create(params, { idempotencyKey }));
}

// ---------------------------------------------------------------------------
// SetupIntents and payment methods (ADR 0016)
// ---------------------------------------------------------------------------

export function createStripeSetupIntent(
  mode: ProviderMode,
  params: Stripe.SetupIntentCreateParams,
  idempotencyKey: string,
): Promise<Stripe.SetupIntent> {
  return call(mode, 'setup', (stripe) => stripe.setupIntents.create(params, { idempotencyKey }));
}

export function retrieveStripeSetupIntent(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.SetupIntent> {
  return call(mode, 'setup', (stripe) => stripe.setupIntents.retrieve(id));
}

export function cancelStripeSetupIntent(
  mode: ProviderMode,
  id: string,
  params: Stripe.SetupIntentCancelParams,
  idempotencyKey: string,
): Promise<Stripe.SetupIntent> {
  return call(mode, 'setup', (stripe) =>
    stripe.setupIntents.cancel(id, params, { idempotencyKey }),
  );
}

export function retrieveStripePaymentMethod(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.PaymentMethod> {
  return call(mode, 'paymentMethod', (stripe) => stripe.paymentMethods.retrieve(id));
}

export function detachStripePaymentMethod(
  mode: ProviderMode,
  id: string,
  idempotencyKey: string,
): Promise<Stripe.PaymentMethod> {
  return call(mode, 'paymentMethod', (stripe) =>
    stripe.paymentMethods.detach(id, {}, { idempotencyKey }),
  );
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export function createStripeRefund(
  mode: ProviderMode,
  params: Stripe.RefundCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Refund> {
  return call(mode, 'refund', (stripe) => stripe.refunds.create(params, { idempotencyKey }));
}

export function retrieveStripeRefund(mode: ProviderMode, id: string): Promise<Stripe.Refund> {
  return call(mode, 'refund', (stripe) => stripe.refunds.retrieve(id));
}

export function cancelStripeRefund(
  mode: ProviderMode,
  id: string,
  idempotencyKey: string,
): Promise<Stripe.Refund> {
  return call(mode, 'refund', (stripe) => stripe.refunds.cancel(id, {}, { idempotencyKey }));
}

// ---------------------------------------------------------------------------
// Orbit money (ADR 0015): balance transactions, payouts, application fees
// ---------------------------------------------------------------------------

/**
 * The request option that scopes a call to a connected account — Stripe's
 * `Stripe-Account` header. `null` is the platform's own account. Built here
 * and nowhere else, so which account a money read reaches is one decision.
 */
function onAccount(
  account: string | null,
  extra: Stripe.RequestOptions = {},
): Stripe.RequestOptions {
  return account === null ? extra : { ...extra, stripeAccount: account };
}

/**
 * One page of an account's balance transactions, oldest-to-newest ordering is
 * Stripe's (newest first). `data.source.source_transfer` is expanded so a
 * destination charge's funds on the destination account name the platform
 * charge they came from.
 */
export function listStripeBalanceTransactions(
  mode: ProviderMode,
  account: string | null,
  params: Stripe.BalanceTransactionListParams,
): Promise<Stripe.ApiList<Stripe.BalanceTransaction>> {
  return call(mode, 'balance', (stripe) =>
    stripe.balanceTransactions.list(
      { ...params, expand: ['data.source.source_transfer'] },
      onAccount(account),
    ),
  );
}

/** A platform charge with its own and its refunds' balance transactions expanded. */
export function retrieveStripeChargeWithLedger(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.Charge> {
  return call(mode, 'balance', (stripe) =>
    stripe.charges.retrieve(id, {
      expand: ['balance_transaction', 'refunds.data.balance_transaction'],
    }),
  );
}

export function retrieveStripePayout(
  mode: ProviderMode,
  account: string,
  id: string,
): Promise<Stripe.Payout> {
  return call(mode, 'payout', (stripe) => stripe.payouts.retrieve(id, {}, onAccount(account)));
}

export function listStripePayouts(
  mode: ProviderMode,
  account: string,
  params: Stripe.PayoutListParams,
): Promise<Stripe.ApiList<Stripe.Payout>> {
  return call(mode, 'payout', (stripe) => stripe.payouts.list(params, onAccount(account)));
}

export function createStripePayout(
  mode: ProviderMode,
  account: string,
  params: Stripe.PayoutCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Payout> {
  return call(mode, 'payout', (stripe) =>
    stripe.payouts.create(params, onAccount(account, { idempotencyKey })),
  );
}

export function cancelStripePayout(
  mode: ProviderMode,
  account: string,
  id: string,
  idempotencyKey: string,
): Promise<Stripe.Payout> {
  return call(mode, 'payout', (stripe) =>
    stripe.payouts.cancel(id, {}, onAccount(account, { idempotencyKey })),
  );
}

export function retrieveStripeApplicationFee(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.ApplicationFee> {
  return call(mode, 'balance', (stripe) => stripe.applicationFees.retrieve(id));
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export function createStripeTransfer(
  mode: ProviderMode,
  params: Stripe.TransferCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Transfer> {
  return call(mode, 'transfer', (stripe) => stripe.transfers.create(params, { idempotencyKey }));
}

export function createStripeTransferReversal(
  mode: ProviderMode,
  transferId: string,
  params: Stripe.TransferCreateReversalParams,
  idempotencyKey: string,
): Promise<Stripe.TransferReversal> {
  return call(mode, 'transfer', (stripe) =>
    stripe.transfers.createReversal(transferId, params, { idempotencyKey }),
  );
}

export function retrieveStripeTransfer(mode: ProviderMode, id: string): Promise<Stripe.Transfer> {
  return call(mode, 'transfer', (stripe) => stripe.transfers.retrieve(id));
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

/**
 * Submit a merchant's response to a dispute.
 *
 * `disputes.update` is the same call for staging a draft and for submitting;
 * the difference is `submit`, and it is one-way — which is why this signature
 * takes the whole body rather than hiding the flag. A draft carries no
 * idempotency key (setting fields is naturally idempotent); a submission does.
 */
export function updateStripeDispute(
  mode: ProviderMode,
  id: string,
  params: Stripe.DisputeUpdateParams,
  idempotencyKey?: string,
): Promise<Stripe.Dispute> {
  return call(mode, 'dispute', (stripe) =>
    stripe.disputes.update(id, params, idempotencyKey ? { idempotencyKey } : {}),
  );
}

/** Read a dispute — the staged evidence text with it. */
export function retrieveStripeDispute(mode: ProviderMode, id: string): Promise<Stripe.Dispute> {
  return call(mode, 'dispute', (stripe) => stripe.disputes.retrieve(id));
}

/** Accept a dispute (Stripe's `close`): it is lost, one-way. */
export function closeStripeDispute(
  mode: ProviderMode,
  id: string,
  idempotencyKey: string,
): Promise<Stripe.Dispute> {
  return call(mode, 'dispute', (stripe) => stripe.disputes.close(id, {}, { idempotencyKey }));
}

/**
 * Upload one dispute evidence file. The bytes are in memory for the length of
 * this call and are never logged; the returned id is used in the submission
 * and not kept.
 */
export function createStripeDisputeFile(
  mode: ProviderMode,
  file: { readonly data: Uint8Array; readonly name: string; readonly type: string },
  idempotencyKey: string,
): Promise<Stripe.File> {
  return call(mode, 'file', (stripe) =>
    stripe.files.create(
      {
        purpose: 'dispute_evidence',
        file: { data: Buffer.from(file.data), name: file.name, type: file.type },
      },
      { idempotencyKey },
    ),
  );
}

// ---------------------------------------------------------------------------
// Payment method configurations and domains
// ---------------------------------------------------------------------------

export function createStripePaymentMethodConfiguration(
  mode: ProviderMode,
  params: Stripe.PaymentMethodConfigurationCreateParams,
  idempotencyKey: string,
): Promise<Stripe.PaymentMethodConfiguration> {
  return call(mode, 'paymentMethodConfiguration', (stripe) =>
    stripe.paymentMethodConfigurations.create(params, { idempotencyKey }),
  );
}

export function updateStripePaymentMethodConfiguration(
  mode: ProviderMode,
  id: string,
  params: Stripe.PaymentMethodConfigurationUpdateParams,
): Promise<Stripe.PaymentMethodConfiguration> {
  return call(mode, 'paymentMethodConfiguration', (stripe) =>
    stripe.paymentMethodConfigurations.update(id, params),
  );
}

export function createStripePaymentMethodDomain(
  mode: ProviderMode,
  params: Stripe.PaymentMethodDomainCreateParams,
  idempotencyKey: string,
): Promise<Stripe.PaymentMethodDomain> {
  return call(mode, 'paymentMethodDomain', (stripe) =>
    stripe.paymentMethodDomains.create(params, { idempotencyKey }),
  );
}

export function updateStripePaymentMethodDomain(
  mode: ProviderMode,
  id: string,
  params: Stripe.PaymentMethodDomainUpdateParams,
): Promise<Stripe.PaymentMethodDomain> {
  return call(mode, 'paymentMethodDomain', (stripe) =>
    stripe.paymentMethodDomains.update(id, params),
  );
}

export function validateStripePaymentMethodDomain(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.PaymentMethodDomain> {
  return call(mode, 'paymentMethodDomain', (stripe) => stripe.paymentMethodDomains.validate(id));
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
export function retrieveStripeChargeWithBalance(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.Charge> {
  return call(mode, 'settlement', (stripe) =>
    stripe.charges.retrieve(id, { expand: ['balance_transaction'] }),
  );
}

/**
 * A refund with its BALANCE TRANSACTION expanded — what it took off the
 * settlement balance, in one consistent read for the reason the charge's is.
 * `balance_transaction` is null while Stripe has not debited it.
 */
export function retrieveStripeRefundWithBalance(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.Refund> {
  return call(mode, 'settlement', (stripe) =>
    stripe.refunds.retrieve(id, { expand: ['balance_transaction'] }),
  );
}

/**
 * A dispute with its BALANCE TRANSACTIONS expanded: the withdrawal (principal
 * plus dispute fee) and, after a won dispute, the reinstatement. An inquiry
 * has none.
 */
export function retrieveStripeDisputeWithBalances(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.Dispute> {
  return call(mode, 'settlement', (stripe) =>
    stripe.disputes.retrieve(id, { expand: ['balance_transactions'] }),
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
  mode: ProviderMode,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  return call(mode, 'account', (stripe) =>
    stripe.rawRequest('POST', '/v2/core/accounts', body, {
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
export function retrieveStripeAccount(mode: ProviderMode, id: string): Promise<Stripe.Account> {
  return call(mode, 'account', (stripe) => stripe.accounts.retrieve(id));
}

/**
 * Write an account's settings through v1 (`business_profile`,
 * `settings.payouts.schedule`, statement descriptors, branding) — the v1 read
 * above is where they are read back, so the write is made where it is read.
 */
export function updateStripeAccount(
  mode: ProviderMode,
  id: string,
  params: Stripe.AccountUpdateParams,
  idempotencyKey: string,
): Promise<Stripe.Account> {
  return call(mode, 'account', (stripe) => stripe.accounts.update(id, params, { idempotencyKey }));
}

export function createStripeAccountLink(
  mode: ProviderMode,
  params: Stripe.AccountLinkCreateParams,
): Promise<Stripe.AccountLink> {
  return call(mode, 'account', (stripe) => stripe.accountLinks.create(params));
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
  mode: ProviderMode,
  payload: string,
  signature: string,
  secrets: readonly string[],
): Promise<Stripe.Event> {
  const stripe = getStripeClient(mode);
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return await stripe.webhooks.constructEventAsync(payload, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProviderError({
    provider: 'stripe',
    stage: 'verifyEvent',
    message:
      lastError instanceof Error ? lastError.message : 'webhook signature verification failed',
    // NEVER retryable. A bad signature is not a transient condition, and
    // retrying one is how a forged event eventually gets a lucky window.
    retryable: false,
    code: 'invalid_signature',
  });
}

// ---------------------------------------------------------------------------
// Identity verification (ADR 0023)
// ---------------------------------------------------------------------------

/**
 * Whether a Stripe refusal means "this account cannot use Identity" — not
 * activated, not approved, or a restricted key without the permission. No
 * retry changes it, and the merchant cannot fix it: the gateway answers 503
 * `identity_unavailable`, never Stripe's prose.
 */
export function isIdentityUnavailableError(error: unknown): boolean {
  if (error instanceof Stripe.errors.StripePermissionError) return true;
  if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('identity') &&
    /(not (yet )?(been )?(enabled|activated|available|set up)|activate|onboard|apply for|application)/.test(
      message,
    )
  );
}

async function identityCall<T>(mode: ProviderMode, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  try {
    return await fn(getStripeClient(mode));
  } catch (error) {
    if (isIdentityUnavailableError(error)) {
      throw new ProviderError({
        provider: 'stripe',
        stage: 'identity',
        message: 'identity verification is not enabled on the provider account',
        retryable: false,
        code: IDENTITY_UNAVAILABLE_CODE,
      });
    }
    throw toProviderError(error, 'identity');
  }
}

/** The session with its newest report expanded — one read answers both. */
const VERIFICATION_SESSION_EXPAND = ['last_verification_report'];

export function createStripeVerificationSession(
  mode: ProviderMode,
  params: Stripe.Identity.VerificationSessionCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Identity.VerificationSession> {
  return identityCall(mode, (stripe) =>
    stripe.identity.verificationSessions.create(
      { ...params, expand: VERIFICATION_SESSION_EXPAND },
      { idempotencyKey },
    ),
  );
}

export function retrieveStripeVerificationSession(
  mode: ProviderMode,
  id: string,
  expand: readonly string[] = VERIFICATION_SESSION_EXPAND,
): Promise<Stripe.Identity.VerificationSession> {
  return identityCall(mode, (stripe) =>
    stripe.identity.verificationSessions.retrieve(id, { expand: [...expand] }),
  );
}

export function updateStripeVerificationSession(
  mode: ProviderMode,
  id: string,
  params: Stripe.Identity.VerificationSessionUpdateParams,
  idempotencyKey: string,
): Promise<Stripe.Identity.VerificationSession> {
  return identityCall(mode, (stripe) =>
    stripe.identity.verificationSessions.update(
      id,
      { ...params, expand: VERIFICATION_SESSION_EXPAND },
      { idempotencyKey },
    ),
  );
}

export function cancelStripeVerificationSession(
  mode: ProviderMode,
  id: string,
  idempotencyKey: string,
): Promise<Stripe.Identity.VerificationSession> {
  return identityCall(mode, (stripe) =>
    stripe.identity.verificationSessions.cancel(
      id,
      { expand: VERIFICATION_SESSION_EXPAND },
      { idempotencyKey },
    ),
  );
}

export function redactStripeVerificationSession(
  mode: ProviderMode,
  id: string,
  idempotencyKey: string,
): Promise<Stripe.Identity.VerificationSession> {
  return identityCall(mode, (stripe) =>
    stripe.identity.verificationSessions.redact(
      id,
      { expand: VERIFICATION_SESSION_EXPAND },
      { idempotencyKey },
    ),
  );
}

// ---------------------------------------------------------------------------
// Terminal (ADR 0024)
// ---------------------------------------------------------------------------

/**
 * Whether a Stripe refusal means "this account cannot use Terminal" — not
 * activated, or a restricted key without the permission. The gateway answers
 * 503 `terminal_unavailable`, never Stripe's prose.
 */
export function isTerminalUnavailableError(error: unknown): boolean {
  if (error instanceof Stripe.errors.StripePermissionError) return true;
  if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('terminal') &&
    /(not (yet )?(been )?(enabled|activated|available|set up)|activate|onboard|apply for)/.test(
      message,
    )
  );
}

/** Stripe's reader codes the gateway answers by name; everything else is a plain refusal. */
const TERMINAL_READER_CODES: Readonly<Record<string, string>> = {
  terminal_reader_busy: TERMINAL_READER_BUSY_CODE,
  terminal_reader_offline: TERMINAL_READER_OFFLINE_CODE,
};

async function terminalCall<T>(mode: ProviderMode, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  try {
    return await fn(getStripeClient(mode));
  } catch (error) {
    if (isTerminalUnavailableError(error)) {
      throw new ProviderError({
        provider: 'stripe',
        stage: 'terminal',
        message: 'Terminal is not enabled on the provider account',
        retryable: false,
        code: TERMINAL_UNAVAILABLE_CODE,
      });
    }
    const readerCode =
      error instanceof Stripe.errors.StripeError && error.code !== undefined
        ? TERMINAL_READER_CODES[error.code]
        : undefined;
    if (readerCode !== undefined) {
      throw new ProviderError({
        provider: 'stripe',
        stage: 'terminal',
        message:
          readerCode === TERMINAL_READER_BUSY_CODE
            ? 'the reader is busy with another action'
            : 'the reader is offline',
        retryable: false,
        code: readerCode,
      });
    }
    throw toProviderError(error, 'terminal');
  }
}

/** Whether Stripe answered "no such object" — a delete of something already gone. */
function isResourceMissing(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && error.code === 'resource_missing';
}

export function createStripeTerminalLocation(
  mode: ProviderMode,
  params: Stripe.Terminal.LocationCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Terminal.Location> {
  return terminalCall(mode, (stripe) =>
    stripe.terminal.locations.create(params, { idempotencyKey }),
  );
}

export function updateStripeTerminalLocation(
  mode: ProviderMode,
  id: string,
  params: Stripe.Terminal.LocationUpdateParams,
  idempotencyKey: string,
): Promise<Stripe.Terminal.Location | Stripe.Terminal.DeletedLocation> {
  return terminalCall(mode, (stripe) =>
    stripe.terminal.locations.update(id, params, { idempotencyKey }),
  );
}

export async function deleteStripeTerminalLocation(
  mode: ProviderMode,
  id: string,
  idempotencyKey: string,
): Promise<void> {
  await terminalCall(mode, async (stripe) => {
    try {
      await stripe.terminal.locations.del(id, {}, { idempotencyKey });
    } catch (error) {
      if (!isResourceMissing(error)) throw error;
    }
  });
}

export function createStripeTerminalReader(
  mode: ProviderMode,
  params: Stripe.Terminal.ReaderCreateParams,
  idempotencyKey: string,
): Promise<Stripe.Terminal.Reader> {
  return terminalCall(mode, (stripe) => stripe.terminal.readers.create(params, { idempotencyKey }));
}

export async function retrieveStripeTerminalReader(
  mode: ProviderMode,
  id: string,
): Promise<Stripe.Terminal.Reader | Stripe.Terminal.DeletedReader | null> {
  return terminalCall(mode, async (stripe) => {
    try {
      return await stripe.terminal.readers.retrieve(id);
    } catch (error) {
      if (isResourceMissing(error)) return null;
      throw error;
    }
  });
}

export function updateStripeTerminalReader(
  mode: ProviderMode,
  id: string,
  params: Stripe.Terminal.ReaderUpdateParams,
  idempotencyKey: string,
): Promise<Stripe.Terminal.Reader | Stripe.Terminal.DeletedReader> {
  return terminalCall(mode, (stripe) =>
    stripe.terminal.readers.update(id, params, { idempotencyKey }),
  );
}

export async function deleteStripeTerminalReader(
  mode: ProviderMode,
  id: string,
  idempotencyKey: string,
): Promise<void> {
  await terminalCall(mode, async (stripe) => {
    try {
      await stripe.terminal.readers.del(id, {}, { idempotencyKey });
    } catch (error) {
      if (!isResourceMissing(error)) throw error;
    }
  });
}

export function processStripeTerminalPayment(
  mode: ProviderMode,
  readerId: string,
  params: Stripe.Terminal.ReaderProcessPaymentIntentParams,
  idempotencyKey: string,
): Promise<Stripe.Terminal.Reader> {
  return terminalCall(mode, (stripe) =>
    stripe.terminal.readers.processPaymentIntent(readerId, params, { idempotencyKey }),
  );
}

export function cancelStripeTerminalReaderAction(
  mode: ProviderMode,
  readerId: string,
  idempotencyKey: string,
): Promise<Stripe.Terminal.Reader | Stripe.Terminal.DeletedReader> {
  return terminalCall(mode, (stripe) =>
    stripe.terminal.readers.cancelAction(readerId, {}, { idempotencyKey }),
  );
}

export function createStripeTerminalConnectionToken(
  mode: ProviderMode,
  params: Stripe.Terminal.ConnectionTokenCreateParams,
): Promise<Stripe.Terminal.ConnectionToken> {
  return terminalCall(mode, (stripe) => stripe.terminal.connectionTokens.create(params));
}

export function presentStripeTerminalPaymentMethod(
  mode: ProviderMode,
  readerId: string,
  idempotencyKey: string,
): Promise<Stripe.Terminal.Reader> {
  return terminalCall(mode, (stripe) =>
    stripe.testHelpers.terminal.readers.presentPaymentMethod(
      readerId,
      { type: 'card_present' },
      { idempotencyKey },
    ),
  );
}
