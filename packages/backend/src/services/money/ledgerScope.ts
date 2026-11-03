import { getDb } from '../../db/postgres';
import {
  findMerchantAccount,
  hasCardHalf,
  type CardConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import type { LedgerScope } from '../../db/money/ledgerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';

/** Whose money a merchant's own read sees: the account, and the ledger scope it mirrors. */
export interface MerchantLedger {
  /** `null` for an Oxy first-party merchant with no account of its own. */
  readonly account: CardConnectedAccountRow | null;
  readonly scope: LedgerScope;
}

/**
 * The ledger a merchant reads as ITSELF (no `Peable-Account`): its own
 * account's when it has one with a card half; an Oxy first-party merchant
 * without one reads its platform-attributed ledger when `firstPartyLedger`
 * allows; anyone else has none — `null`, which the caller answers as
 * `account_missing`, never as zeros (ADR 0015).
 *
 * One rule for the balance routes (`routes/money.ts`) and the ledger reports
 * (`services/reporting`), so a report never reads a different ledger than the
 * balance it summarizes.
 */
export async function merchantLedger(
  merchant: MerchantRow,
  options: { readonly firstPartyLedger: boolean },
): Promise<MerchantLedger | null> {
  const own = await findMerchantAccount(getDb(), merchant.id);
  if (own && hasCardHalf(own)) {
    return { account: own, scope: { merchantId: merchant.id, connectedAccountId: own.id } };
  }
  if (options.firstPartyLedger && merchant.firstParty) {
    return { account: null, scope: { merchantId: merchant.id, connectedAccountId: null } };
  }
  return null;
}
