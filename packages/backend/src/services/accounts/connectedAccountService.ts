/**
 * Onboarding a seller, and keeping what the gateway knows about them true.
 *
 * The whole service is shaped around one fact: **an account at a provider
 * cannot be deleted.** Open two for one seller and the seller has two forever,
 * one of which nobody uses and which will keep generating requirement emails.
 * So every path here converges rather than creates, and the convergence is a
 * database constraint rather than a check — a check loses the race that
 * produces the second account.
 */
import type { MerchantEnvironment } from "@peable.to/shared-types";
import {
  applyAccountSnapshot,
  findAccountByExternalRef,
  insertConnectedAccount,
  type AccountSnapshot,
  type ConnectedAccountRow,
} from "../../db/accounts/connectedAccountRepository";
import { getDb } from "../../db/postgres";
import { newId } from "../../lib/ids";
import { toConnectedAccountDTO } from "../../lib/serializeSettlement";
import { enqueueConnectedAccountWebhook } from "../intentTransition";
import { assertEnvironmentMatchesProvider } from "../providers/environmentGuard";
import {
  isAccountHoldingProvider,
  type AccountHoldingProvider,
  type PaymentProvider,
  type ProviderAccountSnapshot,
} from "../providers/provider";
import { resolveCardProvider, resolveProvider } from "../providers/registry";

/** The card rail is off, or its provider cannot hold accounts. */
export class AccountsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountsUnavailableError";
  }
}

/** The provider refused the country, or this deployment does not serve it. */
export class UnsupportedCountryError extends Error {
  constructor(country: string) {
    super(`the country '${country}' is not supported for seller accounts`);
    this.name = "UnsupportedCountryError";
  }
}

/**
 * Turn the port's snapshot into the columns the table stores.
 *
 * `disabledReason` is singular on the wire and plural in the row: a provider
 * reports one summary reason, and the column holds a list because a future
 * provider may report several. Wrapping the one is honest; inventing more is
 * not.
 */
export function toAccountSnapshot(snapshot: ProviderAccountSnapshot): AccountSnapshot {
  return {
    payoutsEnabled: snapshot.payoutsEnabled,
    chargesEnabled: snapshot.chargesEnabled,
    transfersCapability: snapshot.transfersCapability,
    cardPaymentsCapability: snapshot.cardPaymentsCapability,
    currentlyDue: snapshot.currentlyDue,
    eventuallyDue: snapshot.eventuallyDue,
    pastDue: snapshot.pastDue,
    pendingVerification: snapshot.pendingVerification,
    disabledReasonCodes: snapshot.disabledReason ? [snapshot.disabledReason] : [],
    defaultCurrency: snapshot.defaultCurrency ?? null,
  };
}

/**
 * The adapter that can act on an EXISTING account — the one that opened it.
 *
 * Read from the row rather than from `resolveCardProvider()`, which is what
 * this used to do everywhere. That answered correctly for as long as there was
 * exactly one fiat provider and would have started answering wrongly on the day
 * there were two: a refresh or an onboarding link for a seller onboarded at
 * provider A would have been sent to provider B, which does not know that
 * account. The failure is a `No such account` from the wrong acquirer, which
 * reads as the seller's onboarding being broken.
 *
 * `connected_accounts.provider` has recorded the answer since the table
 * existed; nothing was reading it.
 */
function requireProviderFor(account: ConnectedAccountRow): AccountHoldingProvider {
  return requireAccountProvider(resolveProvider(account.provider), account.provider);
}

/**
 * The adapter for a NEW account, which has no row to read a provider off yet.
 *
 * This is the one place `resolveCardProvider()` is still right: choosing which
 * provider a new seller is onboarded at is a deployment decision, and the
 * registry is where that decision lives (it is also where a per-merchant or
 * per-country choice would go when there is a second one).
 */
function requireDefaultAccountProvider(): AccountHoldingProvider {
  return requireAccountProvider(resolveCardProvider(), "card");
}

function requireAccountProvider(
  provider: PaymentProvider | undefined,
  named: string,
): AccountHoldingProvider {
  if (!provider) {
    throw new AccountsUnavailableError(
      `the ${named} rail is not configured on this deployment`,
    );
  }
  if (!isAccountHoldingProvider(provider)) {
    // A rail that moves money but cannot hold sub-merchant accounts is a real
    // shape — the FairCoin rail is exactly that — so this is a capability
    // question, not an error to assume away.
    throw new AccountsUnavailableError(
      `the ${provider.id} rail cannot hold seller accounts`,
    );
  }
  return provider;
}

export interface EnsureAccountInput {
  readonly merchantId: string;
  /** The asking credential's environment — checked against the provider's mode. */
  readonly environment: MerchantEnvironment;
  /** The MERCHANT's own id for this seller. The address, and the idempotency. */
  readonly externalRef: string;
  /** ISO-3166-1 alpha-2. Upper-cased here; the CHECK insists on it. */
  readonly country: string;
  readonly businessType: "individual" | "company";
}

export interface EnsureAccountResult {
  readonly account: ConnectedAccountRow;
  /** `false` when the seller already had an account. */
  readonly created: boolean;
}

/**
 * Get the account for a seller, opening one at the provider if there is none.
 *
 * The order is: read, then create at the provider, then insert. That is the
 * opposite of the two-step used for payments and transfers, and the reason is
 * that the thing being created here is not reversible and not idempotent by
 * amount: a row written before the provider call would name an account that may
 * never exist, and the row's `provider_account_id` is NOT NULL because a seller
 * account with no account behind it is not a state anything downstream can act
 * on.
 *
 * What protects against the double-create is the provider's OWN idempotency
 * key, derived from `(merchantId, externalRef)` — the same input on a retry
 * returns the same account rather than opening a second — plus the unique
 * constraint, which decides the winner if two calls still race past the read.
 * The loser's account is then the same account, because the key was the same.
 */
export async function ensureConnectedAccount(
  input: EnsureAccountInput,
): Promise<EnsureAccountResult> {
  // A connected account opened under the wrong mode is the least recoverable
  // mistake on this surface: the object cannot be deleted, so a development
  // credential that opened a LIVE Express account leaves a real one behind,
  // generating real requirement emails to a real person, forever.
  assertEnvironmentMatchesProvider(input.environment);
  const provider = requireDefaultAccountProvider();
  const db = getDb();
  const country = input.country.toUpperCase();

  const existing = await findAccountByExternalRef(db, input.merchantId, input.externalRef);
  if (existing) return { account: existing, created: false };

  // Derived from the merchant and their own seller id, never random: a retry
  // after a timeout presents the same key and the provider hands back the
  // account it already opened. A random key here opens a second real account
  // that cannot be deleted.
  const idempotencyKey = `acct:${input.merchantId}:${input.externalRef}`;
  const snapshot = await provider.createAccount({
    accountId: `${input.merchantId}:${input.externalRef}`,
    country,
    businessType: input.businessType,
    idempotencyKey,
    // The merchant's seller id, and nothing else. A provider's metadata is
    // readable by everyone with dashboard access.
    metadata: { peable_merchant_id: input.merchantId },
  });

  const inserted = await insertConnectedAccount(db, {
    publicId: newId("ca"),
    merchantId: input.merchantId,
    externalRef: input.externalRef,
    provider: provider.id,
    providerAccountId: snapshot.providerAccountId,
    country,
  });

  if (!inserted) {
    // A concurrent call won the constraint. Its account is the SAME account —
    // both calls presented the same idempotency key — so re-reading is correct
    // rather than merely convenient.
    const winner = await findAccountByExternalRef(db, input.merchantId, input.externalRef);
    if (!winner) {
      throw new Error(
        `connected account for ${input.externalRef} neither inserted nor found`,
      );
    }
    return { account: winner, created: false };
  }

  const withSnapshot = await applyAccountSnapshot(db, inserted.id, toAccountSnapshot(snapshot));
  return { account: withSnapshot ?? inserted, created: true };
}

/**
 * Re-read an account from the provider and store what it says.
 *
 * The only way readiness fields ever change. Called by the sync sweep, by an
 * `account.updated` event, and by a merchant asking directly — all three land
 * here so there is one definition of "what the provider currently says".
 */
/**
 * Whether anything a MERCHANT acts on has changed.
 *
 * The fields are chosen, not diffed wholesale, and the two omissions are the
 * decision: `lastSyncedAt` moves on every sweep, and `updatedAt` moves whenever
 * the row is written — so a whole-row comparison would fire on every pass and
 * produce a stream a merchant learns to ignore, which is the same as no
 * notification at all.
 *
 * What is here is what changes a merchant's behaviour: whether the seller can
 * be paid, what the provider says about each capability, how much is still
 * owed, and why the account is disabled. A requirement COUNT rising is worth an
 * event even when payability did not change — it is the difference between "on
 * track" and "this seller has to do something".
 */
function readinessChanged(
  before: ConnectedAccountRow,
  after: ConnectedAccountRow,
): boolean {
  return (
    before.payoutsEnabled !== after.payoutsEnabled ||
    before.chargesEnabled !== after.chargesEnabled ||
    before.transfersCapability !== after.transfersCapability ||
    before.cardPaymentsCapability !== after.cardPaymentsCapability ||
    before.requirementsCurrentlyDue !== after.requirementsCurrentlyDue ||
    before.requirementsEventuallyDue !== after.requirementsEventuallyDue ||
    before.requirementsPastDue !== after.requirementsPastDue ||
    before.requirementsPendingVerification !== after.requirementsPendingVerification ||
    before.disabledReasonCodes.join() !== after.disabledReasonCodes.join()
  );
}

export async function refreshConnectedAccount(
  account: ConnectedAccountRow,
  environment?: MerchantEnvironment,
): Promise<ConnectedAccountRow> {
  // OPTIONAL, and that is a decision rather than an oversight. A merchant-
  // initiated refresh passes the credential's environment and is checked; the
  // event drain and the staleness sweep reach this with an account row and no
  // credential at all, and refusing them would stop readiness ever arriving on
  // a correctly-configured deployment. Reading an account moves no money, which
  // is what makes the asymmetry safe — `ensureConnectedAccount` and
  // `createAccountLink`, which do, both require it.
  if (environment !== undefined) assertEnvironmentMatchesProvider(environment);
  const provider = requireProviderFor(account);
  const snapshot = await provider.getAccount(account.providerAccountId);

  /**
   * The snapshot and the merchant's notification commit TOGETHER (ADR 0001 D7).
   *
   * That ordering matters more here than it looks, because the notification is
   * gated on a CHANGE: a crash between the two would store the new readiness
   * and lose the event, and the next refresh would compare against the
   * already-updated row, see no change, and never enqueue it. The merchant
   * would be permanently one event behind, with nothing anywhere recording it.
   */
  return getDb().transaction(async (tx) => {
    const updated = await applyAccountSnapshot(tx, account.id, toAccountSnapshot(snapshot));
    if (!updated) return account;
    if (readinessChanged(account, updated)) {
      await enqueueConnectedAccountWebhook(
        tx,
        updated.merchantId,
        toConnectedAccountDTO(updated),
      );
    }
    return updated;
  });
}

export interface AccountLinkInput {
  /** The asking credential's environment — checked against the provider's mode. */
  readonly environment: MerchantEnvironment;
  readonly account: ConnectedAccountRow;
  readonly refreshUrl: string;
  readonly returnUrl: string;
}

/**
 * A hosted onboarding link for a seller.
 *
 * Short-lived and single-use at the provider, which is why it is minted on
 * demand and never stored: a stored link is one that has already expired by the
 * time anyone follows it, and the failure looks like the seller's fault.
 */
export async function createAccountLink(
  input: AccountLinkInput,
): Promise<{ url: string; expiresAt: Date }> {
  assertEnvironmentMatchesProvider(input.environment);
  const provider = requireProviderFor(input.account);
  return provider.accountLink({
    providerAccountId: input.account.providerAccountId,
    refreshUrl: input.refreshUrl,
    returnUrl: input.returnUrl,
  });
}
