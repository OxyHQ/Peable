/**
 * Who a FairCoin payment of an ORDER pays (ADR 0021 D6): the merchant's owner,
 * the session's one seller, or — when the lines name their sellers — every
 * seller of the order, each weighted by its lines' subtotal. A single-payee
 * order is the one-recipient case of the same answer.
 */
import { getNetwork, type NetworkType } from '@fairco.in/core';
import type { CurrencyCode, FaircoinUnavailableReason } from '@peable.to/shared-types';
import {
  faircoinStatusOf,
  findAccountById,
  type ConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import type {
  CheckoutLineItemRow,
  CheckoutSessionRow,
} from '../../db/payments/checkoutSessionRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { DatabaseOrTransaction } from '../../db/postgres';
import type { FaircoinSplitEntry } from '../createIntent';
import { faircoinAvailability, faircoinRecipientOf } from './recipient';
import { splitFaircoinAmount } from './split';

export interface OrderRecipient {
  /** The seller; `null` for the merchant's own sale. */
  readonly account: ConnectedAccountRow | null;
  /** The sum of its lines' `amount_subtotal` (before discount and tax). */
  readonly weight: bigint;
}

/** One seller's share of the order is below what the network relays. */
export class FaircoinAmountTooSmallError extends Error {
  constructor() {
    super(
      "one seller's share of this order is below the smallest amount the FairCoin network relays",
    );
    this.name = 'FaircoinAmountTooSmallError';
  }
}

/** The order's recipients, in first-line order. */
export async function orderRecipients(
  db: DatabaseOrTransaction,
  session: Pick<CheckoutSessionRow, 'merchantId' | 'connectedAccountId'>,
  lines: readonly Pick<CheckoutLineItemRow, 'connectedAccountId' | 'amountSubtotal'>[],
): Promise<OrderRecipient[]> {
  const weights = new Map<string | null, bigint>();
  for (const line of lines) {
    const key = session.connectedAccountId ?? line.connectedAccountId ?? null;
    weights.set(key, (weights.get(key) ?? 0n) + BigInt(line.amountSubtotal));
  }
  if (weights.size === 0) weights.set(session.connectedAccountId ?? null, 0n);
  const recipients: OrderRecipient[] = [];
  for (const [id, weight] of weights) {
    const account = id === null ? null : await findAccountById(db, session.merchantId, id);
    if (id !== null && !account) throw new Error(`order names an unreadable seller ${id}`);
    recipients.push({ account, weight });
  }
  return recipients;
}

/**
 * Whether the payer can choose FairCoin on the order now: every recipient must
 * be payable — a seller ready for FairCoin on the order's network, with a
 * Peable wallet. The first reason that holds is the order's.
 */
export async function orderFaircoinAvailability(
  merchant: MerchantRow,
  order: { readonly network: NetworkType | null; readonly currency: CurrencyCode },
  recipients: readonly OrderRecipient[],
): Promise<{ available: boolean; unavailable_reason: FaircoinUnavailableReason | null }> {
  const answers = await Promise.all(
    recipients.map(({ account }) => {
      if (
        account &&
        (faircoinStatusOf(account) !== 'active' || account.network !== order.network)
      ) {
        return {
          available: false,
          unavailable_reason: 'faircoin_wallet_missing' as FaircoinUnavailableReason | null,
        };
      }
      return faircoinAvailability({
        network: order.network,
        currency: order.currency,
        recipientAccountId: faircoinRecipientOf(merchant, account),
      });
    }),
  );
  return (
    answers.find((answer) => !answer.available) ??
    answers[0] ?? {
      available: false,
      unavailable_reason: 'faircoin_wallet_missing',
    }
  );
}

/**
 * The outputs of the order's FairCoin payment for `total` FAIR base units
 * (`services/faircoin/split.ts`). A share below the network's dust threshold is
 * refused rather than moved to another recipient.
 *
 * @throws {FaircoinAmountTooSmallError}
 */
export function splitOrderPayment(
  total: bigint,
  recipients: readonly OrderRecipient[],
  network: NetworkType,
): FaircoinSplitEntry[] {
  const shares = splitFaircoinAmount(
    total,
    recipients.map((recipient) => ({ key: recipient.account, weight: recipient.weight })),
  );
  if (shares.length > 1) {
    const dust = getNetwork(network).minRelayFee;
    if (shares.some((share) => share.amount <= dust)) throw new FaircoinAmountTooSmallError();
  }
  return shares.map((share) => ({
    connectedAccount: share.key?.publicId ?? null,
    amount: share.amount.toString(),
  }));
}
