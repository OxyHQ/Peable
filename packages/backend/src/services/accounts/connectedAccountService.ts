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
import type { MerchantEnvironment } from '@peable.to/shared-types';
import type { NetworkType } from '@fairco.in/core';
import {
  applyAccountSnapshot,
  attachCardHalf,
  enableFaircoinHalf,
  findAccountByExternalRef,
  hasCardHalf,
  insertConnectedAccount,
  type AccountSnapshot,
  type CardConnectedAccountRow,
  type ConnectedAccountRow,
  type SnapshotWrittenField,
} from '../../db/accounts/connectedAccountRepository';
import { getDb } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toConnectedAccountDTO } from '../../lib/serializeSettlement';
import { enqueueConnectedAccountWebhook } from '../intentTransition';
import { assertEnvironmentMatchesProvider } from '../providers/environmentGuard';
import {
  isAccountHoldingProvider,
  type AccountHoldingProvider,
  type PaymentProvider,
  type ProviderAccountSnapshot,
} from '../providers/provider';
import { resolveCardProvider, resolveProvider } from '../providers/registry';

/** The card rail is off, or its provider cannot hold accounts. */
export class AccountsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountsUnavailableError';
  }
}

/**
 * The seller's account does not have the half this operation needs — a card
 * onboarding link or a transfer for a FairCoin-only seller, or a FairCoin
 * operation for a card-only one (ADR 0012 D1). A 409: the account exists and
 * is in a state that cannot do this, which the caller fixes by opening the
 * half, not by editing the request.
 */
export class AccountRailMissingError extends Error {
  constructor(readonly rail: 'card' | 'faircoin') {
    super(
      rail === 'card'
        ? 'this seller has no card account; open one by creating the account with country and businessType'
        : 'this seller has no FairCoin account; open one by creating the account with faircoin.network and faircoin.oxyUserId',
    );
    this.name = 'AccountRailMissingError';
  }
}

/**
 * A repeated create asked for a FairCoin half that disagrees with the one
 * already open — another network or another seller identity. Both are fixed
 * once set (ADR 0012 D2), so this is a 409 and nothing changes.
 */
export class AccountConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountConflictError';
  }
}

/**
 * A non-production platform asked for a mainnet FairCoin half — the merchants'
 * test/live firewall, applied to sellers (ADR 0012 D8). 422.
 */
export class FaircoinNetworkRefusedError extends Error {
  constructor(environment: MerchantEnvironment) {
    super(`a '${environment}' environment cannot open a mainnet FairCoin account`);
    this.name = 'FaircoinNetworkRefusedError';
  }
}

/** The provider refused the country, or this deployment does not serve it. */
export class UnsupportedCountryError extends Error {
  constructor(country: string) {
    super(`the country '${country}' is not supported for seller accounts`);
    this.name = 'UnsupportedCountryError';
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
function requireProviderFor(account: CardConnectedAccountRow): AccountHoldingProvider {
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
  return requireAccountProvider(resolveCardProvider(), 'card');
}

function requireAccountProvider(
  provider: PaymentProvider | undefined,
  named: string,
): AccountHoldingProvider {
  if (!provider) {
    throw new AccountsUnavailableError(`the ${named} rail is not configured on this deployment`);
  }
  if (!isAccountHoldingProvider(provider)) {
    // A rail that moves money but cannot hold sub-merchant accounts is a real
    // shape — the FairCoin rail is exactly that — so this is a capability
    // question, not an error to assume away.
    throw new AccountsUnavailableError(`the ${provider.id} rail cannot hold seller accounts`);
  }
  return provider;
}

/** The card half a platform asks for — opened at the provider. */
export interface CardHalfRequest {
  /** ISO-3166-1 alpha-2. Upper-cased here; the CHECK insists on it. */
  readonly country: string;
  readonly businessType: 'individual' | 'company';
}

/** The FairCoin half a platform asks for — no provider, no key yet (ADR 0012 D2). */
export interface FaircoinHalfRequest {
  readonly network: NetworkType;
  /** The seller's Oxy user id: the only person who may register the key. */
  readonly oxyUserId: string;
}

export type EnsureAccountInput = {
  readonly merchantId: string;
  /** The asking credential's environment — checked against the provider's mode. */
  readonly environment: MerchantEnvironment;
  /** The MERCHANT's own id for this seller. The address, and the idempotency. */
  readonly externalRef: string;
} & (
  | { readonly card: CardHalfRequest; readonly faircoin?: FaircoinHalfRequest }
  | { readonly card?: undefined; readonly faircoin: FaircoinHalfRequest }
);

export interface EnsureAccountResult {
  readonly account: ConnectedAccountRow;
  /** `false` when the seller already had an account. */
  readonly created: boolean;
}

/**
 * Get the account for a seller, opening whichever halves it asks for that the
 * seller does not have yet.
 *
 * ## The card half
 *
 * The order is: read, then create at the provider, then write. That is the
 * opposite of the two-step used for payments and transfers, and the reason is
 * that the thing being created here is not reversible and not idempotent by
 * amount: a row written before the provider call would name an account that may
 * never exist.
 *
 * What protects against the double-create is the provider's OWN idempotency
 * key, derived from `(merchantId, externalRef)` — the same input on a retry
 * returns the same account rather than opening a second — plus the unique
 * constraint (or, for a seller who already has a FairCoin half, the
 * `WHERE provider IS NULL` of `attachCardHalf`), which decides the winner if two
 * calls still race past the read. The loser's account is then the same
 * account, because the key was the same.
 *
 * ## The FairCoin half (ADR 0012 D2)
 *
 * No provider is involved: opening it records the network and the seller's Oxy
 * identity, and nothing else. The KEY arrives later, from the seller's own
 * session, never from here. A FairCoin-only seller therefore never reaches the
 * acquirer and is never asked for KYC.
 *
 * ## Converging
 *
 * An existing seller is returned with `created: false`, after adding a half it
 * lacked. A FairCoin half that is already open must AGREE with the request —
 * network and Oxy user are fixed once set — or the call is a 409.
 */
export async function ensureConnectedAccount(
  input: EnsureAccountInput,
): Promise<EnsureAccountResult> {
  // A connected account opened under the wrong mode is the least recoverable
  // mistake on this surface: the object cannot be deleted, so a development
  // credential that opened a LIVE Express account leaves a real one behind,
  // generating real requirement emails to a real person, forever. Only the
  // CARD half reaches a provider, so only it is checked against the key mode.
  if (input.card) assertEnvironmentMatchesProvider(input.environment);
  // The merchants' test/live firewall, applied to sellers: a leaked test
  // credential can never point a seller's payments at mainnet.
  if (
    input.faircoin &&
    input.environment !== 'production' &&
    input.faircoin.network === 'mainnet'
  ) {
    throw new FaircoinNetworkRefusedError(input.environment);
  }

  const db = getDb();
  const existing = await findAccountByExternalRef(db, input.merchantId, input.externalRef);
  if (existing) return { account: await completeHalves(existing, input), created: false };

  const card = input.card ? await openCardHalf(input, input.card) : undefined;
  const faircoin = input.faircoin
    ? { network: input.faircoin.network, oxyUserId: input.faircoin.oxyUserId }
    : undefined;
  const base = {
    publicId: newId('ca'),
    merchantId: input.merchantId,
    externalRef: input.externalRef,
  };
  const inserted = card
    ? await insertConnectedAccount(db, {
        ...base,
        provider: card.provider,
        providerAccountId: card.snapshot.providerAccountId,
        country: card.country,
        ...(faircoin ? { faircoin } : {}),
      })
    : faircoin
      ? await insertConnectedAccount(db, { ...base, faircoin })
      : null;

  if (!inserted) {
    // A concurrent call won the constraint. For the card half its account is
    // the SAME account — both calls presented the same idempotency key — so
    // converging on the winner is correct rather than merely convenient.
    const winner = await findAccountByExternalRef(db, input.merchantId, input.externalRef);
    if (!winner) {
      throw new Error(`connected account for ${input.externalRef} neither inserted nor found`);
    }
    return { account: await completeHalves(winner, input), created: false };
  }

  if (!card) return { account: inserted, created: true };
  const withSnapshot = await applyAccountSnapshot(
    db,
    inserted.id,
    toAccountSnapshot(card.snapshot),
  );
  return { account: withSnapshot ?? inserted, created: true };
}

/** Open the provider account for a seller. Never writes a row. */
async function openCardHalf(
  input: { readonly merchantId: string; readonly externalRef: string },
  card: CardHalfRequest,
): Promise<{
  provider: AccountHoldingProvider['id'];
  country: string;
  snapshot: ProviderAccountSnapshot;
}> {
  const provider = requireDefaultAccountProvider();
  const country = card.country.toUpperCase();
  // Derived from the merchant and their own seller id, never random: a retry
  // after a timeout presents the same key and the provider hands back the
  // account it already opened. A random key here opens a second real account
  // that cannot be deleted.
  const idempotencyKey = `acct:${input.merchantId}:${input.externalRef}`;
  const snapshot = await provider.createAccount({
    accountId: `${input.merchantId}:${input.externalRef}`,
    country,
    businessType: card.businessType,
    idempotencyKey,
    // The merchant's seller id, and nothing else. A provider's metadata is
    // readable by everyone with dashboard access.
    metadata: { peable_merchant_id: input.merchantId },
  });
  return { provider: provider.id, country, snapshot };
}

/**
 * Add to an EXISTING seller whichever requested half it lacks, and check that a
 * FairCoin half already open agrees with the request.
 */
async function completeHalves(
  existing: ConnectedAccountRow,
  input: EnsureAccountInput,
): Promise<ConnectedAccountRow> {
  const db = getDb();
  let account = existing;

  if (input.faircoin) {
    if (account.network === null) {
      account =
        (await enableFaircoinHalf(db, account.id, input.faircoin)) ??
        (await rereadAccount(account));
    }
    if (account.network !== input.faircoin.network) {
      throw new AccountConflictError(
        `this seller's FairCoin account is on ${String(account.network)}, which cannot change`,
      );
    }
    if (account.faircoinOxyUserId !== input.faircoin.oxyUserId) {
      throw new AccountConflictError(
        "this seller's FairCoin account names a different Oxy user, which cannot change",
      );
    }
  }

  // A card half is opened only when it was asked for and is missing — a card
  // seller converging is EXACTLY the pre-ADR-0012 path: returned unchanged.
  if (input.card && !hasCardHalf(account)) {
    assertEnvironmentMatchesProvider(input.environment);
    const card = await openCardHalf(input, input.card);
    const attached = await attachCardHalf(db, account.id, {
      provider: card.provider,
      providerAccountId: card.snapshot.providerAccountId,
      country: card.country,
    });
    if (attached) {
      account =
        (await applyAccountSnapshot(db, attached.id, toAccountSnapshot(card.snapshot))) ?? attached;
    } else {
      account = await rereadAccount(account);
    }
  }
  return account;
}

async function rereadAccount(account: ConnectedAccountRow): Promise<ConnectedAccountRow> {
  const fresh = await findAccountByExternalRef(getDb(), account.merchantId, account.externalRef);
  if (!fresh) throw new Error(`connected account ${account.publicId} disappeared`);
  return fresh;
}

/**
 * For each field a provider snapshot writes, whether a merchant is told.
 *
 * A `Record` over `SnapshotWrittenField` rather than a list of comparisons, and
 * that is the whole point: it is TOTAL, so a column added to
 * `applyAccountSnapshot` does not compile until someone decides whether its
 * changing is news. The list it replaced had already fallen one behind —
 * `defaultCurrency` was written and never compared, so an account whose payout
 * currency changed updated silently and the marketplace settling into it would
 * have found out from a transfer in the wrong currency.
 *
 * `lastSyncedAt` is the one deliberate `false`. It moves on every sweep, so
 * including it would fire on every pass and produce a stream a merchant learns
 * to ignore — which is the same as no notification at all.
 *
 * Everything else is here because it changes a merchant's behaviour: whether
 * the seller can be paid, what the provider says about each capability, how
 * much is still owed, why the account is disabled, and what currency they are
 * paid in. A requirement COUNT rising is worth an event even when payability
 * did not change — it is the difference between "on track" and "this seller has
 * to do something".
 */
const NOTIFIES_MERCHANT = {
  payoutsEnabled: true,
  chargesEnabled: true,
  transfersCapability: true,
  cardPaymentsCapability: true,
  requirementsCurrentlyDue: true,
  requirementsEventuallyDue: true,
  requirementsPastDue: true,
  requirementsPendingVerification: true,
  disabledReasonCodes: true,
  defaultCurrency: true,
  lastSyncedAt: false,
} satisfies Record<SnapshotWrittenField, boolean>;

/** Whether anything a MERCHANT acts on has changed. */
function readinessChanged(before: ConnectedAccountRow, after: ConnectedAccountRow): boolean {
  return Object.entries(NOTIFIES_MERCHANT).some(([field, notifies]) => {
    if (!notifies) return false;
    const key = field as SnapshotWrittenField;
    return !sameValue(before[key], after[key]);
  });
}

/** `disabledReasonCodes` is an array; everything else compares by identity. */
function sameValue(before: unknown, after: unknown): boolean {
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.length === after.length && before.every((item, i) => item === after[i]);
  }
  return before === after;
}

/**
 * Re-read an account from the provider and store what it says.
 *
 * The only way readiness fields ever change. Called by the sync sweep, by an
 * `account.updated` event, and by a merchant asking directly — all three land
 * here so there is one definition of "what the provider currently says".
 */
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
  // A FairCoin-only seller has nothing at a provider to read: its readiness is
  // the key it registered, which is already the row. Returned as it is.
  if (!hasCardHalf(account)) return account;
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
      await enqueueConnectedAccountWebhook(tx, updated.merchantId, toConnectedAccountDTO(updated));
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
  if (!hasCardHalf(input.account)) throw new AccountRailMissingError('card');
  assertEnvironmentMatchesProvider(input.environment);
  const provider = requireProviderFor(input.account);
  return provider.accountLink({
    providerAccountId: input.account.providerAccountId,
    refreshUrl: input.refreshUrl,
    returnUrl: input.returnUrl,
  });
}
