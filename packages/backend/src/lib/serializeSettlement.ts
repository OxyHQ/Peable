/**
 * The wire shapes for connected accounts and transfers.
 *
 * Separate from `serialize.ts` because these two carry a rule the others do not
 * and which is easy to lose in a long file: **the provider's own ids never
 * reach the wire.** ADR 0001 D3 — a merchant integrates against Peable and does
 * not learn which acquirer sat behind their seller, because the day that
 * changes should be a Peable deploy and not a merchant migration.
 *
 * These DTOs used to be DECLARED here, with a comment saying they stayed out of
 * `@peable.to/shared-types` "for as long as they are unstable". The caution was
 * right and it had a growing cost: Mercaria's adapter declared its own partial
 * interfaces for the same responses, so one wire format had two descriptions in
 * two repositories with nothing comparing them — and a field renamed here was a
 * runtime failure there, discovered by a settlement that did not happen. The
 * shapes are published now (`shared-types/settlement.ts`); what stays here is
 * the mapping from a ROW to one of them, which is the half that is nobody
 * else's business.
 */
import type {
  Account,
  AccountBusinessProfile,
  AccountRequirements,
  AccountSettings,
  ConnectedAccount,
  ConnectedAccountFaircoin,
  ConnectedAccountRail,
  Transfer,
  TransferReversal,
} from '@peable.to/shared-types';
import {
  faircoinStatusOf,
  hasCardHalf,
  type CardConnectedAccountRow,
  type ConnectedAccountRow,
} from '../db/accounts/connectedAccountRepository';
import type { TransferRow } from '../db/transfers/transferRepository';
import type { TransferReversalRow } from '../db/transfers/transferReversalRepository';
import { toUnix, toUnixOrNull } from './time';
import { FAIRCOIN_KEY_REQUIREMENT } from '@peable.to/contracts/vocabulary';
import { sellerHasFaircoinKey } from '../services/faircoinAccount';

/**
 * Serialize a connected account.
 *
 * `providerAccountId` and `provider` are absent, and that is the point of the
 * file. A reviewer checking this should be able to see it by what is NOT here.
 * So is the seller's FairCoin `xpub` (ADR 0012 D6) — the row type does not even
 * carry it.
 */
export function toConnectedAccountDTO(row: ConnectedAccountRow): ConnectedAccount {
  if (row.externalRef === null) {
    // The merchant's OWN account is an `account`, never a `connected_account`:
    // every seller read filters on the role, so reaching this is a defect.
    throw new Error(`account ${row.publicId} is the merchant's own, not a seller`);
  }
  const rails: ConnectedAccountRail[] = [];
  if (hasCardHalf(row)) rails.push('card');
  if (row.network !== null) rails.push('faircoin');
  return {
    id: row.publicId,
    object: 'connected_account',
    livemode: row.livemode,
    external_ref: row.externalRef,
    rails,
    faircoin: toFaircoinHalf(row),
    country: row.country,
    default_currency: row.defaultCurrency,
    // Both halves, and `transfers` is the one that actually gates a settlement:
    // an account with payouts enabled but no transfers capability cannot
    // receive one, and the reverse cannot pay it out. And the seller's own
    // FairCoin key (ADR 0021 D5): without it a seller takes no transfer.
    payable:
      row.payoutsEnabled && row.transfersCapability === 'active' && sellerHasFaircoinKey(row),
    payouts_enabled: row.payoutsEnabled,
    charges_enabled: row.chargesEnabled,
    transfers_capability: row.transfersCapability,
    card_payments_capability: row.cardPaymentsCapability,
    requirements: toRequirements(row),
    last_synced_at: toUnixOrNull(row.lastSyncedAt),
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/**
 * Stripe's requirements shape: identifiers, and the provider's one summary
 * reason. A SELLER without its own FairCoin key also owes
 * `faircoin.receiving_key` (ADR 0021 D5) — Peable's requirement, not the
 * provider's, and the only one the seller clears in their own Oxy session.
 */
function toRequirements(row: ConnectedAccountRow): AccountRequirements {
  const faircoinDue =
    row.role === 'seller' &&
    !sellerHasFaircoinKey(row) &&
    !row.currentlyDue.includes(FAIRCOIN_KEY_REQUIREMENT);
  return {
    currently_due: faircoinDue
      ? [...row.currentlyDue, FAIRCOIN_KEY_REQUIREMENT]
      : [...row.currentlyDue],
    eventually_due: [...row.eventuallyDue],
    past_due: [...row.pastDue],
    pending_verification: [...row.pendingVerification],
    disabled_reason: row.disabledReasonCodes[0] ?? null,
  };
}

const EMPTY_BUSINESS_PROFILE: AccountBusinessProfile = {
  name: null,
  url: null,
  support_email: null,
  support_url: null,
  product_description: null,
  mcc: null,
};

const EMPTY_SETTINGS: AccountSettings = {
  payouts: { schedule: null, statement_descriptor: null },
  payments: { statement_descriptor: null },
  branding: { primary_color: null, secondary_color: null },
};

/**
 * The `account` object (ADR 0015 §1) — the merchant's own account, or a seller's
 * read through `Peable-Account`. Card half only; the provider's `acct_…` never
 * crosses. Before the first provider read carried a profile or settings, they
 * are rendered empty (every field `null`), which is what is known.
 */
export function toAccountDTO(row: CardConnectedAccountRow): Account {
  return {
    id: row.publicId,
    object: 'account',
    livemode: row.livemode,
    type: row.role === 'merchant' ? 'merchant' : 'connected',
    country: row.country,
    default_currency: row.defaultCurrency,
    business_profile: row.businessProfile ?? EMPTY_BUSINESS_PROFILE,
    capabilities: {
      card_payments: row.cardPaymentsCapability,
      transfers: row.transfersCapability,
    },
    requirements: toRequirements(row),
    charges_enabled: row.chargesEnabled,
    payouts_enabled: row.payoutsEnabled,
    settings: row.settings ?? EMPTY_SETTINGS,
    last_synced_at: toUnixOrNull(row.lastSyncedAt),
    created: toUnix(row.createdAt),
  };
}

/** The FairCoin half, or `null` when the platform never opened one. */
function toFaircoinHalf(row: ConnectedAccountRow): ConnectedAccountFaircoin | null {
  const status = faircoinStatusOf(row);
  if (status === null || row.network === null || row.faircoinOxyUserId === null) return null;
  return {
    network: row.network,
    status,
    oxy_user_id: row.faircoinOxyUserId,
    registered_at: toUnixOrNull(row.faircoinRegisteredAt),
  };
}

/**
 * Serialize a transfer.
 *
 * The two ids it references are the PUBLIC ones, and both are parameters rather
 * than fields of the row: the row stores internal primary keys, and a
 * serializer that reached for them would emit uuids onto a contract that
 * promises `ca_…` and `pi_…`. Requiring them explicitly is what makes that a
 * compile error rather than a wrong response.
 */
export function toTransferDTO(
  row: TransferRow,
  connectedAccountPublicId: string,
  paymentIntentPublicId: string,
): Transfer {
  return {
    id: row.publicId,
    object: 'transfer',
    livemode: row.livemode,
    external_ref: row.externalRef,
    connected_account: connectedAccountPublicId,
    payment_intent: paymentIntentPublicId,
    amount: row.amount,
    currency: row.currency,
    amount_reversed: row.amountReversed,
    status: row.status,
    failure_message: row.failureMessage,
    created: toUnix(row.createdAt),
    updated_at: toUnix(row.updatedAt),
  };
}

/** Serialize one reversal of a settlement. The provider's own id for it stays here. */
export function toTransferReversalDTO(row: TransferReversalRow): TransferReversal {
  return {
    id: row.publicId,
    object: 'transfer_reversal',
    livemode: row.livemode,
    external_ref: row.externalRef,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    failure_message: row.failureMessage,
    created: toUnix(row.createdAt),
  };
}
