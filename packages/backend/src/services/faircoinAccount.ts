import {
  faircoinStatusOf,
  type ConnectedAccountRow,
} from '../db/accounts/connectedAccountRepository';
import type { MerchantRow } from '../db/merchants/merchantRepository';

/**
 * FairCoin is always offered to a payer, and a FairCoin payment pays the
 * merchant's OWN watch-only key (ADR 0021 D5): so a live merchant without one
 * cannot take payments at all. Refusing here is what keeps a keyless merchant
 * from quietly selling card-only, which ADR 0021 D1 forbids.
 *
 * Test mode is never gated: an integration is built before the key exists.
 */
export const FAIRCOIN_ACCOUNT_REQUIRED_MESSAGE =
  'you cannot take live payments until you register your FairCoin receiving key: ' +
  'register your watch-only xpub once in Orbit (Settings › FairCoin receiving key) ' +
  'or with POST /v1/merchants/me/faircoin';

/**
 * A live merchant without a FairCoin key tried to take a payment. 409
 * `faircoin_account_required`: the request is right and the merchant is not
 * ready, so the fix is registering the key, not editing the request.
 */
export class FaircoinAccountRequiredError extends Error {
  readonly status = 409;
  readonly code = 'faircoin_account_required' as const;
  constructor() {
    super(FAIRCOIN_ACCOUNT_REQUIRED_MESSAGE);
    this.name = 'FaircoinAccountRequiredError';
  }
}

/** Whether this merchant may take a payment now: test mode, or a registered key. */
export function merchantCanTakePayments(merchant: Pick<MerchantRow, 'livemode' | 'xpub'>): boolean {
  return !merchant.livemode || merchant.xpub !== null;
}

/**
 * The ONE gate, called at every entry point that starts taking money: creating
 * a PaymentIntent, a Checkout Session (a merchant's or a payment link visit's)
 * or a Payment Link, creating a subscription, and finalizing an invoice.
 *
 * @throws {FaircoinAccountRequiredError}
 */
export function assertMerchantCanTakePayments(
  merchant: Pick<MerchantRow, 'livemode' | 'xpub'>,
): void {
  if (!merchantCanTakePayments(merchant)) throw new FaircoinAccountRequiredError();
}

/**
 * Why a seller without its own FairCoin key is refused (ADR 0021 D5). Only the
 * seller can register it, from their own Oxy session (ADR 0012 D3): the
 * platform opens the FairCoin half and sends an onboarding link.
 */
export const SELLER_FAIRCOIN_KEY_REQUIRED_MESSAGE =
  'this seller has not registered its own FairCoin receiving key, so it cannot be paid yet: ' +
  'open its FairCoin half (POST /v1/connected_accounts with faircoin) and send the seller an onboarding link';

/**
 * Whether a SELLER is ready: its own FairCoin key is registered (ADR 0021 D5).
 * The merchant's own account (`role = 'merchant'`) is not a seller and is never
 * judged by this.
 */
export function sellerHasFaircoinKey(account: ConnectedAccountRow): boolean {
  return faircoinStatusOf(account) === 'active';
}
