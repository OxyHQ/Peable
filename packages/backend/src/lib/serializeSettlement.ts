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
import type { ConnectedAccount, Transfer } from '@peable.to/shared-types';
import type { ConnectedAccountRow } from '../db/accounts/connectedAccountRepository';
import type { TransferRow } from '../db/transfers/transferRepository';

/** @deprecated Prefer `ConnectedAccount` from `@peable.to/shared-types`. */
export type ConnectedAccountDTO = ConnectedAccount;

/**
 * Serialize a connected account.
 *
 * `providerAccountId` and `provider` are absent, and that is the point of the
 * file. A reviewer checking this should be able to see it by what is NOT here.
 */
export function toConnectedAccountDTO(row: ConnectedAccountRow): ConnectedAccountDTO {
  return {
    id: row.publicId,
    object: 'connected_account',
    externalRef: row.externalRef,
    country: row.country,
    defaultCurrency: row.defaultCurrency,
    // Both halves, and `transfers` is the one that actually gates a settlement:
    // an account with payouts enabled but no transfers capability cannot
    // receive one, and the reverse cannot pay it out.
    payable: row.payoutsEnabled && row.transfersCapability === 'active',
    payoutsEnabled: row.payoutsEnabled,
    chargesEnabled: row.chargesEnabled,
    transfersCapability: row.transfersCapability,
    cardPaymentsCapability: row.cardPaymentsCapability,
    requirements: {
      currentlyDue: row.requirementsCurrentlyDue,
      eventuallyDue: row.requirementsEventuallyDue,
      pastDue: row.requirementsPastDue,
      pendingVerification: row.requirementsPendingVerification,
    },
    disabledReasonCodes: row.disabledReasonCodes,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** @deprecated Prefer `Transfer` from `@peable.to/shared-types`. */
export type TransferDTO = Transfer;

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
  paymentIntentPublicId: string
): TransferDTO {
  return {
    id: row.publicId,
    object: 'transfer',
    externalRef: row.externalRef,
    connectedAccountId: connectedAccountPublicId,
    paymentIntentId: paymentIntentPublicId,
    amount: row.amount,
    currency: row.currency,
    amountReversed: row.amountReversed,
    status: row.status,
    failureMessage: row.failureMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
