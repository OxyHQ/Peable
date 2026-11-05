/**
 * FairCoin onboarding: how a SELLER's watch-only key reaches their connected
 * account (ADR 0012 D3).
 *
 * Two parties, two halves, and they never meet:
 *
 * - the PLATFORM mints a link (`createFaircoinAccountLink`) with its service
 *   credential. It can name the seller's account and nothing else — it never
 *   supplies a key;
 * - the SELLER opens the link signed in with Oxy and registers the key
 *   (`describeOnboarding`, `registerFromOnboarding`). The link alone is not
 *   enough: the session must be the Oxy user the account names.
 *
 * Why the key never comes from the platform is the whole ADR: the key decides
 * who receives the money, and a platform-supplied key is indistinguishable from
 * the platform's own.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ConnectOnboarding } from '@peable.to/shared-types';
import { config } from '../../config';
import {
  consumeAccountLink,
  findLinkByTokenHash,
  insertAccountLink,
  type AccountLinkRow,
} from '../../db/accounts/accountLinkRepository';
import {
  faircoinStatusOf,
  findAccountForOnboarding,
  confirmFaircoinHalf,
  type ConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { getDb } from '../../db/postgres';
import { toConnectedAccountDTO } from '../../lib/serializeSettlement';
import { recordConnectedAccountEvent } from '../intentTransition';
import { resolveMerchantDisplay } from '../merchantDisplay';
import { resolveIdentityPublicKey } from '../socialReceive';
import { kickWebhookOutbox } from '../webhookOutbox';
import { AccountRailMissingError } from './connectedAccountService';
import { toUnix } from '../../lib/time';

/**
 * How long a link works. An hour, not Stripe's minutes, because the token alone
 * opens nothing — it must arrive with the seller's own Oxy session — and the
 * seller may have to install the wallet or create a pocket first.
 */
export const FAIRCOIN_LINK_TTL_MS = 60 * 60 * 1000;

/** 32 random bytes: a token nobody guesses, rendered URL-safe. */
const TOKEN_BYTES = 32;

/** Why an onboarding request was refused. Each maps to exactly one status. */
export type OnboardingRefusalCode =
  | 'link_not_found'
  | 'link_expired'
  | 'wrong_seller'
  | 'already_registered'
  | 'faircoin_wallet_missing'
  | 'no_faircoin_half';

const STATUS_FOR: Record<OnboardingRefusalCode, number> = {
  link_not_found: 404,
  // Gone, and the body carries the platform's `refresh_url` — Stripe's
  // `refresh_url` semantics: send the seller back to ask for a fresh link.
  link_expired: 410,
  // The link is real, the session is someone else's. Not consumed: the seller
  // can switch account and try again.
  wrong_seller: 403,
  already_registered: 409,
  faircoin_wallet_missing: 409,
  no_faircoin_half: 409,
};

const MESSAGE_FOR: Record<OnboardingRefusalCode, string> = {
  link_not_found: 'this onboarding link does not exist',
  link_expired: 'this onboarding link has expired or was already used; ask for a new one',
  wrong_seller:
    'this onboarding link is for a different Oxy account; sign in as the seller it names',
  already_registered: 'this seller already confirmed FairCoin payments',
  faircoin_wallet_missing:
    "your Peable wallet isn't set up yet: open Peable signed in with this account, then try again",
  no_faircoin_half: 'this account has no FairCoin half to confirm',
};

export class OnboardingRefusedError extends Error {
  readonly status: number;
  constructor(
    readonly code: OnboardingRefusalCode,
    /** Only on `link_expired`: where the seller goes to get a fresh link. */
    readonly refreshUrl?: string,
  ) {
    super(MESSAGE_FOR[code]);
    this.name = 'OnboardingRefusedError';
    this.status = STATUS_FOR[code];
  }
}

/** The platform asked for a link for a seller who has already registered. */
export class AccountAlreadyActiveError extends Error {
  constructor() {
    super("this seller's FairCoin key is already registered; there is nothing to onboard");
    this.name = 'AccountAlreadyActiveError';
  }
}

/** The ONE place a token becomes the form it is stored and looked up in. */
export function hashOnboardingToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface CreateFaircoinLinkInput {
  readonly account: ConnectedAccountRow;
  readonly returnUrl: string;
  readonly refreshUrl: string;
  readonly now?: Date;
}

/**
 * Mint a FairCoin onboarding link — the PLATFORM's half.
 *
 * The plaintext token is returned once, inside the URL, and stored only as its
 * hash. Minted on demand and not meant to be stored by the platform either.
 *
 * @throws {AccountRailMissingError} when the platform never opened a FairCoin half.
 * @throws {AccountAlreadyActiveError} when the seller already registered.
 */
export async function createFaircoinAccountLink(
  input: CreateFaircoinLinkInput,
): Promise<{ url: string; expiresAt: Date }> {
  const status = faircoinStatusOf(input.account);
  if (status === null) throw new AccountRailMissingError('faircoin');
  if (status === 'active') throw new AccountAlreadyActiveError();

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date((input.now ?? new Date()).getTime() + FAIRCOIN_LINK_TTL_MS);
  await insertAccountLink(getDb(), {
    connectedAccountId: input.account.id,
    tokenHash: hashOnboardingToken(token),
    returnUrl: input.returnUrl,
    refreshUrl: input.refreshUrl,
    expiresAt,
  });
  return { url: `${config.connectOnboardingBaseUrl}/${token}`, expiresAt };
}

/**
 * Resolve a presented token to its link and account, refusing in the order
 * that leaks least: an unknown token says nothing; a stale one says only where
 * to get a fresh one; a wrong session learns the link exists and nothing about
 * whose it is.
 */
async function resolveLink(
  db: Parameters<typeof findLinkByTokenHash>[0],
  token: string,
  oxyUserId: string,
  now: Date,
  options: { readonly forUpdate?: boolean } = {},
): Promise<{ link: AccountLinkRow; account: ConnectedAccountRow }> {
  const link = await findLinkByTokenHash(db, hashOnboardingToken(token), options);
  if (!link) throw new OnboardingRefusedError('link_not_found');
  if (link.consumedAt !== null || link.expiresAt.getTime() <= now.getTime()) {
    throw new OnboardingRefusedError('link_expired', link.refreshUrl);
  }
  const account = await findAccountForOnboarding(db, link.connectedAccountId);
  if (!account || account.network === null || account.faircoinOxyUserId === null) {
    throw new OnboardingRefusedError('no_faircoin_half');
  }
  if (account.faircoinOxyUserId !== oxyUserId) throw new OnboardingRefusedError('wrong_seller');
  if (account.faircoinRegisteredAt !== null) throw new OnboardingRefusedError('already_registered');
  return { link, account };
}

/**
 * What the seller is being asked to do — read before they choose a pocket.
 *
 * Read-only: looking does not consume the link.
 */
export async function describeOnboarding(input: {
  readonly token: string;
  readonly oxyUserId: string;
  readonly now?: Date;
}): Promise<ConnectOnboarding> {
  const db = getDb();
  const { link, account } = await resolveLink(
    db,
    input.token,
    input.oxyUserId,
    input.now ?? new Date(),
  );
  const platform = await findMerchantById(db, account.merchantId);
  if (!platform) throw new Error(`platform merchant missing for account ${account.publicId}`);
  return {
    object: 'connect_onboarding',
    account_id: account.publicId,
    platform: await resolveMerchantDisplay(platform),
    // Narrowed by `resolveLink`, which refuses an account with no network.
    network: account.network as NonNullable<ConnectedAccountRow['network']>,
    expires_at: toUnix(link.expiresAt),
    return_url: link.returnUrl,
  };
}

/**
 * The SELLER confirms FairCoin payments into their own Peable wallet (ADR 0012
 * D3, ADR 0021 D5) — the only way a FairCoin half becomes payable. No key is
 * sent: payments derive from the public identity key of the seller's Oxy
 * account, so the account must have one (a Peable wallet).
 *
 * One transaction, in this order: lock the link; check it is live and this is
 * the seller it names; confirm the half (`confirmFaircoinHalf`); consume the
 * link; enqueue `connected_account.updated` to the PLATFORM (ADR 0001 D7).
 *
 * @throws {OnboardingRefusedError} for every refusal; nothing is written.
 */
export async function confirmFromOnboarding(input: {
  readonly token: string;
  readonly oxyUserId: string;
  readonly now?: Date;
}): Promise<{ account: ConnectedAccountRow; returnUrl: string }> {
  const now = input.now ?? new Date();
  // Outside the transaction: a DID read is a network call. The key it finds is
  // the seller's own; nothing of it is stored here (the cursor records it).
  if ((await resolveIdentityPublicKey(input.oxyUserId)) === null) {
    throw new OnboardingRefusedError('faircoin_wallet_missing');
  }
  const result = await getDb().transaction(async (tx) => {
    const { link, account } = await resolveLink(tx, input.token, input.oxyUserId, now, {
      forUpdate: true,
    });
    const confirmed = await confirmFaircoinHalf(tx, account.id, now);
    if (!confirmed.ok) throw new OnboardingRefusedError(confirmed.refusal);
    if (!(await consumeAccountLink(tx, link.id, now))) {
      throw new OnboardingRefusedError('link_expired', link.refreshUrl);
    }
    await recordConnectedAccountEvent(
      tx,
      confirmed.account.merchantId,
      toConnectedAccountDTO(confirmed.account),
    );
    return { account: confirmed.account, returnUrl: link.returnUrl };
  });
  // After the commit, for the reason `announceIntentChange` gives: the outbox
  // row is durable either way, this only saves the poll interval.
  kickWebhookOutbox();
  return result;
}
