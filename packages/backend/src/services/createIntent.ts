import { randomUUID } from 'node:crypto';
import type { NetworkType } from '@fairco.in/core';
import type { CurrencyCode, PaymentIntentRail } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import type { MerchantRow } from '../db/merchants/merchantRepository';
import {
  faircoinStatusOf,
  findAccountByPublicId,
  type ConnectedAccountRow,
} from '../db/accounts/connectedAccountRepository';
import {
  findIntentByIdempotencyKey,
  insertPaymentIntent,
  linkProviderObject,
} from '../db/payments/paymentIntentRepository';
import type { PaymentIntentRow } from '../db/payments/paymentIntentRepository';
import type { Database } from '../db/postgres';
import type { PaymentProvider, ProviderClientAction } from './providers/provider';
import { assertEnvironmentMatchesProvider } from './providers/environmentGuard';
import { resolveCardProvider, resolveProvider } from './providers/registry';
import { reserveNextAccountAddress, reserveNextAddress } from './reserveAddress';
import { newId, clientSecretFor } from '../lib/ids';

const DEFAULT_EXPIRY_SECONDS = 15 * 60;
const MS_PER_SECOND = 1000;

/**
 * Thrown when a caller's `network` doesn't match the merchant's configured
 * network — the data-integrity firewall (F2.0 task 1a) that keeps a
 * `PaymentIntent.network` label truthful about the network its watch-only
 * `address` actually encodes. Routes translate this into a 422.
 */
export class NetworkMismatchError extends Error {
  constructor(
    requested: NetworkType,
    configured: NetworkType,
    whose: 'merchant' | 'connected account' = 'merchant',
  ) {
    super(
      `network '${requested}' does not match the ${whose}'s configured network '${configured}'`,
    );
    this.name = 'NetworkMismatchError';
  }
}

/**
 * Thrown when the rail and the rest of the request do not describe one payment
 * — a FairCoin intent with no network, a card intent claiming one, or either
 * rail with a currency it cannot settle in.
 *
 * A separate error from `NetworkMismatchError` because it is a DIFFERENT
 * mistake: that one is a caller naming the wrong chain, this one is a caller
 * naming a combination that is not a payment at all. Routes translate both into
 * a 422, and the message is what tells the integrator which they made.
 */
export class RailMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailMismatchError';
  }
}

/**
 * The FairCoin rail settles in FAIR and nothing else.
 *
 * A FAIR-denominated card charge and a EUR-denominated chain payment are both
 * expressible in the type system and neither is a thing this gateway can do:
 * the second would need an FX conversion at settlement time that nothing here
 * performs. `payment_intents_rail_currency_agrees_check` says the same in the
 * database. Widening it later is a migration with a decision behind it.
 */
function assertRailCurrency(rail: PaymentIntentRail, currency: CurrencyCode): void {
  if (rail === 'faircoin' && currency !== 'FAIR') {
    throw new RailMismatchError(`the faircoin rail settles in FAIR, not '${currency}'`);
  }
  if (rail === 'card' && currency === 'FAIR') {
    throw new RailMismatchError('the card rail cannot settle in FAIR; name a fiat currency');
  }
}

/**
 * The `connectedAccount` named no seller of THIS merchant. A 404, worded like
 * one for an account that does not exist at all, so a `ca_…` belonging to
 * another platform is never confirmed.
 */
export class ConnectedAccountNotFoundError extends Error {
  constructor() {
    super('connected account not found');
    this.name = 'ConnectedAccountNotFoundError';
  }
}

/**
 * The seller cannot be paid in FairCoin yet — no FairCoin half, or one whose
 * key the seller has not registered (ADR 0012 D5). A 409 with code
 * `account_not_ready`: the request is right and the account is not, and the
 * platform fixes it by onboarding the seller, not by editing the request.
 */
export class AccountNotReadyError extends Error {
  readonly code = 'account_not_ready';
  constructor(message: string) {
    super(message);
    this.name = 'AccountNotReadyError';
  }
}

/**
 * Find the seller a request names, scoped to the merchant, and refuse one that
 * cannot take a FairCoin payment. Exported for the routes that resolve a seller
 * BEFORE minting (the checkout session needs the same answer).
 *
 * @throws {ConnectedAccountNotFoundError}
 * @throws {AccountNotReadyError}
 */
export async function resolveConnectedAccountForPayment(
  merchant: MerchantRow,
  publicId: string,
): Promise<ConnectedAccountRow> {
  const account = await findAccountByPublicId(getDb(), merchant.id, publicId);
  if (!account) throw new ConnectedAccountNotFoundError();
  const status = faircoinStatusOf(account);
  if (status === null) {
    throw new AccountNotReadyError('this seller has no FairCoin account');
  }
  if (status === 'pending') {
    throw new AccountNotReadyError(
      'this seller has not registered their FairCoin key yet; send them an onboarding link',
    );
  }
  return account;
}

export interface CreateIntentInput {
  paymentLinkId?: string;
  merchant: MerchantRow;
  /**
   * Pay this seller rather than the merchant (ADR 0012 D5) — its PUBLIC `ca_…`.
   * The address derives from the seller's own key; the merchant still owns the
   * intent. FairCoin only.
   */
  connectedAccount?: string;
  amount: string;
  /** Defaults to `faircoin` — the rail this gateway shipped with (ADR 0001 D1). */
  rail?: PaymentIntentRail;
  /** Required on the faircoin rail; must be absent on the card rail. */
  network?: NetworkType;
  /** Defaults to `FAIR` on the faircoin rail; required on the card rail. */
  currency?: CurrencyCode;
  metadata?: Record<string, string>;
  expiresInSeconds?: number;
  /**
   * A caller-supplied `Idempotency-Key` enables the fast-path replay lookup
   * and race-path recovery below. Payment links and checkout sessions mint
   * without one (they manage reuse at their own layer) — a synthetic key is
   * generated for them so the required schema field is always satisfied,
   * but no replay lookup is ever done against a key nobody can present again.
   */
  idempotencyKey?: string;
}

export interface CreateIntentResult {
  intent: PaymentIntentRow;
  reused: boolean;
  /**
   * What the PAYER's client has to do next, on a rail that needs it.
   *
   * `undefined` on the FairCoin rail, where the next step is "send coins to
   * `address`" and the intent already says so. On the card rail this carries
   * the provider's own client secret, which Stripe.js needs to confirm the
   * payment in the browser.
   *
   * Deliberately NOT a column and NOT on the DTO. It is a fact about this
   * response, not about the payment: re-reading an intent tomorrow must not
   * hand out a confirmation credential, and a merchant listing their intents
   * must not receive one per row.
   */
  clientAction?: ProviderClientAction;
}

/**
 * The card rail is configured off, or half-configured, on this deployment.
 *
 * Separate from `RailMismatchError` because it is not the caller's fault and
 * they cannot fix it by sending different fields — it is a 503, not a 422. A
 * merchant seeing "the card rail requires an explicit currency" for a
 * deployment that simply has no Stripe key would spend the afternoon editing
 * their request.
 */
export class RailUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailUnavailableError';
  }
}

/**
 * Mint (or, for a replayed `Idempotency-Key`, return the existing) intent.
 * The single code path every intent-creating route — `POST /v1/payment_intents`,
 * payment links, checkout sessions — must go through, so the idempotency and
 * derivation logic can never fork between them.
 */
/** What a caller asked for, once the rail's defaults and rules have been applied. */
export interface ResolvedRail {
  readonly rail: PaymentIntentRail;
  readonly currency: CurrencyCode;
  /** The merchant's network on the faircoin rail; `null` on the card rail. */
  readonly network: NetworkType | null;
}

/**
 * Turn a caller's partial rail description into a coherent one, or refuse it.
 *
 * ONE owner, THREE callers: `createIntent` below, and the payment-link and
 * checkout-session routes, which have to apply the identical defaults to the
 * values they persist. A link that stored a rail its minted intents would then
 * be refused for is a price a payer can see and can never pay — and the two
 * rows are in different tables, so no constraint can catch the disagreement.
 *
 * @throws {RailMismatchError} when the combination is not a payment.
 * @throws {NetworkMismatchError} when a faircoin caller named the wrong chain.
 */
export function resolveRail(
  merchant: MerchantRow,
  input: { rail?: PaymentIntentRail; currency?: CurrencyCode; network?: NetworkType },
  /**
   * The seller an on-behalf payment pays (ADR 0012 D5), already resolved and
   * ready. Its network — not the merchant's — is the one the address encodes,
   * so it is the one the request must name. The merchant needs no FairCoin
   * account of its own for this.
   */
  account?: ConnectedAccountRow,
): ResolvedRail {
  const rail = input.rail ?? 'faircoin';
  if (account !== undefined) {
    // On-behalf CARD charges are ADR 0009's open merchant-of-record decision.
    // Refused by name rather than by the CHECK one layer down, which would
    // answer a 500.
    if (rail !== 'faircoin') {
      throw new RailMismatchError('a connectedAccount payment is FairCoin only');
    }
    const currency = input.currency ?? 'FAIR';
    assertRailCurrency(rail, currency);
    if (input.network === undefined) {
      throw new RailMismatchError('the faircoin rail requires a network');
    }
    if (account.network === null) {
      throw new AccountNotReadyError('this seller has no FairCoin account');
    }
    if (input.network !== account.network) {
      throw new NetworkMismatchError(input.network, account.network, 'connected account');
    }
    return { rail, currency, network: input.network };
  }
  const currency = input.currency ?? (rail === 'faircoin' ? 'FAIR' : undefined);

  if (currency === undefined) {
    throw new RailMismatchError('the card rail requires an explicit currency');
  }
  assertRailCurrency(rail, currency);

  if (rail === 'faircoin') {
    // The network firewall, unchanged. A `network` label that disagrees with the
    // network the `address` actually encodes sends a payer's funds to an address
    // nobody is watching.
    if (input.network === undefined) {
      throw new RailMismatchError('the faircoin rail requires a network');
    }
    if (merchant.network === null) {
      // A CARD-ONLY merchant. There is no xpub to derive a receive address
      // from, so this is refused here with a message naming what is missing —
      // rather than reaching `reserveNextAddress`, which would have burned a
      // derivation index before discovering the same thing.
      throw new RailMismatchError(
        'this merchant has not registered a FairCoin account; register a network and xpub to accept it',
      );
    }
    if (input.network !== merchant.network) {
      throw new NetworkMismatchError(input.network, merchant.network);
    }
    return { rail, currency, network: input.network };
  }

  if (input.network !== undefined) {
    // Not pedantry: a card intent carrying a network makes the composite
    // reference to `merchants (id, network)` BIND, tying a card charge to a
    // chain — and `payment_intents_card_has_no_chain_fields_check` refuses it
    // one layer down anyway, as a 500 instead of this 422.
    throw new RailMismatchError('the card rail has no network');
  }
  return { rail, currency, network: null };
}

/**
 * Create the payment at the provider and link it to the row we already wrote.
 *
 * The idempotency key is derived from the intent's PUBLIC id and nothing else,
 * which is what makes recovery safe: a retry after a timeout, a crash, or a
 * redeployment presents the same key and Stripe returns the object it already
 * made instead of charging the payer twice. A random key here would turn every
 * lost response into a second charge.
 */
async function attachProviderPayment(
  db: Database,
  intent: PaymentIntentRow,
  provider: PaymentProvider,
): Promise<ProviderClientAction | undefined> {
  const result = await provider.createPayment({
    intentId: intent.publicId,
    amount: { amount: intent.amount, currency: intent.currency },
    idempotencyKey: `pay:${intent.publicId}`,
    // The merchant's own metadata is deliberately NOT forwarded: it is the
    // merchant's, it can contain anything, and a provider's metadata is
    // readable by everyone with dashboard access. The adapter adds the one
    // correlation key that has to survive — `peable_intent_id`.
    metadata: {},
  });

  await linkProviderObject(db, intent.id, provider.id, result.providerObjectId);
  return result.clientAction;
}

/**
 * The client action for an intent we are RETURNING rather than creating — the
 * idempotent replay paths.
 *
 * Read from the provider rather than remembered, because a client secret is a
 * confirmation credential and storing one would put it in every backup and
 * every support query.
 *
 * ## It RESUMES an interrupted create, and that is the point
 *
 * This used to answer `undefined` for an intent with a provider and no object,
 * with a comment calling that honest. It was honest and it was a dead end: the
 * two-step create writes the row FIRST precisely so a crash between the two
 * leaves something recovery can finish, and nothing finished it. The retry
 * found the row, got no client action, and the payer was handed a payment they
 * could not pay — permanently, because every subsequent retry took the same
 * branch. The comment said the caller "reports honestly instead of pretending
 * the payer can proceed"; what the caller actually reported was a 200 with no
 * way forward.
 *
 * Resuming is safe for exactly the reason the row is written first: the
 * provider idempotency key is derived from the intent's own public id, so the
 * call either creates the payment or returns the one it already made. It is
 * never a second charge.
 *
 * `undefined` still means what it always meant for the rails that have no
 * client action at all — FairCoin, and a deployment whose card rail is off.
 */
async function clientActionFor(
  intent: PaymentIntentRow,
): Promise<ProviderClientAction | undefined> {
  if (!intent.provider) return undefined;
  const provider = resolveProvider(intent.provider);
  if (!provider) return undefined;

  if (!intent.providerObjectId) {
    return attachProviderPayment(getDb(), intent, provider);
  }

  const result = await provider.getStatus(intent.providerObjectId);
  return result.clientAction;
}

/**
 * Why a replayed key does not describe the same operation — or `null` when it
 * does.
 *
 * An `Idempotency-Key` addresses ONE operation. A second request presenting it
 * with a different amount, currency or rail is a different operation, and
 * answering 200 with the stored intent tells the caller their new payment was
 * created when nothing happened — the caller then waits for money that will
 * never arrive, against an intent for an amount they did not ask for.
 *
 * `metadata` and `expiresInSeconds` are deliberately NOT compared: neither
 * moves money, and a merchant whose retry carries a slightly different note
 * should get their payment rather than a conflict.
 */
function replayConflict(
  existing: PaymentIntentRow,
  requested: {
    amount: string;
    rail: PaymentIntentRail;
    currency: CurrencyCode;
    /** The seller's INTERNAL id, or `null` for a payment to the merchant. */
    connectedAccountId: string | null;
  },
): string | null {
  // WHO is paid is part of the operation (ADR 0012 D5). Answering a replay that
  // names another seller with the stored intent would hand the platform an
  // address on the wrong seller's key.
  if ((existing.connectedAccountId ?? null) !== requested.connectedAccountId) {
    return existing.connectedAccountPublicId
      ? `this Idempotency-Key already names a payment on behalf of ${existing.connectedAccountPublicId}`
      : 'this Idempotency-Key already names a payment to the merchant itself';
  }
  if (existing.amount !== requested.amount) {
    return `this Idempotency-Key already names a payment of ${existing.amount}`;
  }
  if (existing.currency !== requested.currency) {
    return `this Idempotency-Key already names a payment in ${existing.currency}`;
  }
  if (existing.rail !== requested.rail) {
    return `this Idempotency-Key already names a payment on the ${existing.rail} rail`;
  }
  return null;
}

/**
 * A replayed `Idempotency-Key` presented with different content.
 *
 * Its own error type so routes can answer 409 — the key IS in use, which is
 * neither a bad request nor a success.
 */
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * Refuse a rail this deployment cannot serve, before anything is STORED.
 *
 * `createIntent` makes this check itself, so a mint is covered. This export is
 * for the surfaces that persist a rail WITHOUT minting — a payment link is the
 * one that matters: it is a URL a merchant sends to customers, and one created
 * for a rail with no provider is a price a payer can see and can never pay,
 * discovered by them rather than by the merchant.
 *
 * @throws {RailUnavailableError}
 */
export function assertRailAvailable(rail: PaymentIntentRail): void {
  if (rail === 'card' && !resolveCardProvider()) {
    throw new RailUnavailableError('the card rail is not configured on this deployment');
  }
}

export async function createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
  const { merchant, amount, metadata, expiresInSeconds, idempotencyKey } = input;
  // The seller first: an unknown or unready one is refused before anything —
  // a reservation, a row, a provider call — happens.
  const account =
    input.connectedAccount !== undefined
      ? await resolveConnectedAccountForPayment(merchant, input.connectedAccount)
      : undefined;
  const { rail, currency, network } = resolveRail(merchant, input, account);
  const connectedAccountId = account?.id ?? null;

  // BEFORE the idempotency lookup, not just before the insert, because the
  // replay path calls the provider too (`clientActionFor` re-reads the payment).
  // A refused environment has to leave nothing behind and send nothing: an
  // intent written and then abandoned would sit in `created` until the sweeper
  // expired it, and a merchant debugging a rejected credential would find
  // payments they never made.
  if (rail === 'card') assertEnvironmentMatchesProvider(merchant.environment);

  const db = getDb();

  // Idempotency (fast path): a prior intent for this key wins as-is. Only
  // meaningful when the caller supplied a key.
  if (idempotencyKey) {
    const existing = await findIntentByIdempotencyKey(db, merchant.id, idempotencyKey);
    if (existing) {
      const conflict = replayConflict(existing, { amount, rail, currency, connectedAccountId });
      if (conflict) throw new IdempotencyConflictError(conflict);
      return { intent: existing, reused: true, clientAction: await clientActionFor(existing) };
    }
  }

  // A card payment reserves NO derivation index. Reserving one anyway would
  // burn an index on a payment that can never receive coins, and every FairCoin
  // payer after it would be handed a different address than the counter implies.
  //
  // An on-behalf payment reserves on the SELLER's counter and derives from the
  // SELLER's key (ADR 0012 D5): the coins go straight to their wallet.
  const address =
    rail !== 'faircoin'
      ? null
      : account
        ? (await reserveNextAccountAddress(merchant.id, account.id)).address
        : (await reserveNextAddress(merchant.id)).address;
  const publicId = newId('pi');
  const clientSecret = clientSecretFor(publicId);
  const expiresAt = new Date(
    Date.now() + (expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS) * MS_PER_SECOND,
  );
  const key = idempotencyKey ?? randomUUID();

  // Which provider will move this money, decided ONCE and stored. Resolved
  // before the insert because `payment_intents_card_requires_provider_check`
  // refuses a card intent without one — a rail that is off must fail here,
  // where nothing has been written, rather than after a row exists that no
  // adapter can ever act on.
  const cardProvider = rail === 'card' ? resolveCardProvider() : undefined;
  if (rail === 'card' && !cardProvider) {
    throw new RailUnavailableError('the card rail is not configured on this deployment');
  }

  // Explicit field whitelist — never spread a caller body (mass-assignment
  // would be an IDOR). `status`, `currency` and `confirmations` take their
  // column defaults inside the repository: a caller does not get to mint an
  // intent that is already settled.
  const intent = await insertPaymentIntent(db, {
    publicId,
    paymentLinkId: input.paymentLinkId,
    merchantId: merchant.id,
    connectedAccountId,
    rail,
    amount,
    currency,
    network,
    address,
    provider: cardProvider?.id ?? null,
    clientSecret,
    idempotencyKey: key,
    metadata: metadata ?? {},
    expiresAt,
  });

  if (intent) {
    // The row exists; now make the payment exist at the provider. This ORDER is
    // the decision (see `payment_intents.provider_object_id`): a crash between
    // the two leaves a row with no object, which recovery can finish by
    // re-calling with the same idempotency key. The reverse leaves a real
    // charge with no row, which nothing can find.
    if (cardProvider) {
      const clientAction = await attachProviderPayment(db, intent, cardProvider);
      return { intent, reused: false, clientAction };
    }
    return { intent, reused: false };
  }

  // Idempotency (race path): a concurrent create with the same key lost the
  // unique-index bet — return the winner rather than erroring. `insertPaymentIntent`
  // converges on `(merchant_id, idempotency_key)` and answers `null` rather
  // than raising, so this is a branch and no longer a caught duplicate-key
  // error. Only reachable when the caller supplied a key to race on: without
  // one the key is a fresh uuid nothing else can collide with.
  if (idempotencyKey) {
    const winner = await findIntentByIdempotencyKey(db, merchant.id, idempotencyKey);
    if (winner) {
      const conflict = replayConflict(winner, { amount, rail, currency, connectedAccountId });
      if (conflict) throw new IdempotencyConflictError(conflict);
      return { intent: winner, reused: true, clientAction: await clientActionFor(winner) };
    }
  }

  throw new Error(`payment intent insert converged on no row for merchant ${merchant.id}`);
}
