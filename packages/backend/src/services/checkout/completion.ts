/**
 * A Checkout Session follows its payment (Orbit Phase 3).
 *
 * Completion is never a client's word: it happens HERE, in the transaction
 * that moved the session's PaymentIntent (or SetupIntent), called from the one
 * place every intent transition records its events (`recordIntentEvent`) —
 * so the payment's status, the session's, its events, its redemption and its
 * receipt commit together or not at all (ADR 0001 D7).
 *
 * | Payment                                   | Session                                            |
 * |-------------------------------------------|----------------------------------------------------|
 * | `succeeded`                               | `complete`, `paid` — or, already complete unpaid, `paid` + `async_payment_succeeded` |
 * | `requires_capture` (manual capture)       | `complete`, `unpaid`                               |
 * | FairCoin `processing` (broadcast, confirming) | `complete`, `unpaid`; the chain decides later  |
 * | `canceled`                                | open → `expired` (a quoted FairCoin payment: open, unlinked); complete-unpaid FairCoin → `async_payment_failed` |
 *
 * On completion: the discount's redemption is counted (one guarded statement
 * each, `redeemCoupon` / `redeemPromotionCode`), a payment link's completed
 * sessions counted (deactivating it at its limit), a customer created when
 * `customer_creation: always`, and the checkout confirmation email queued.
 * When the session becomes PAID, its Peable Tax calculation becomes a committed
 * tax transaction.
 */
import { redeemCoupon } from '../../db/catalog/couponRepository';
import { redeemPromotionCode } from '../../db/catalog/promotionCodeRepository';
import { insertCustomer } from '../../db/customers/customerRepository';
import type { SetupIntentRow } from '../../db/customers/setupIntentRepository';
import {
  type CheckoutSessionRow,
  completeSession,
  expireSessionRow,
  findSessionByIntentId,
  findSessionBySetupIntentId,
  lockSession,
  markSessionPaid,
  setSessionCustomer,
  unlinkSessionPayment,
} from '../../db/payments/checkoutSessionRepository';
import type { PaymentIntentRow } from '../../db/payments/paymentIntentRepository';
import { countLinkCompletion } from '../../db/payments/paymentLinkRepository';
import { type DatabaseOrTransaction, getDb, type Transaction } from '../../db/postgres';
import type { DiscountRefusal } from '../catalog/pricing';
import { newId } from '../../lib/ids';
import { toCustomerDTO } from '../../lib/serialize';
import { toCheckoutSessionDTO } from '../../lib/serializeCheckout';
import { enqueueCheckoutConfirmation } from '../email/outbox';
import { recordEvent } from '../events';
import { commitTaxTransaction } from '../tax/taxService';
import { kickWebhookOutbox } from '../webhookOutbox';
import { recordLinkUpdated } from './linkService';
import { subscriptionCheckoutFulfiller } from './subscriptionFulfiller';

type CheckoutEventType =
  | 'checkout.session.completed'
  | 'checkout.session.expired'
  | 'checkout.session.async_payment_succeeded'
  | 'checkout.session.async_payment_failed';

async function recordSessionEvent(
  tx: DatabaseOrTransaction,
  row: CheckoutSessionRow,
  type: CheckoutEventType,
  previousAttributes?: Record<string, unknown>,
): Promise<void> {
  await recordEvent(tx, {
    merchantId: row.merchantId,
    type,
    object: toCheckoutSessionDTO(row),
    previousAttributes,
    account: row.connectedAccountPublicId,
    // Not `paymentIntentId`: a checkout event is the merchant's
    // (`WEBHOOK_EVENT_SCOPES`), even once the order has a payment.
  });
}

/**
 * Commit the session's Peable Tax calculation — it is a sale now. `rail` is the
 * PAYMENT's: a fiat order paid in FairCoin (ADR 0021) is a FairCoin sale.
 */
async function commitSessionTax(
  tx: DatabaseOrTransaction,
  row: CheckoutSessionRow,
  rail: CheckoutSessionRow['rail'],
): Promise<void> {
  if (row.taxCalculationId === null) return;
  await commitTaxTransaction(tx, {
    calculationPublicId: row.taxCalculationId,
    reference: row.publicId,
    rail,
    committedAt: new Date(),
    ...(row.paymentIntentPublicId && rail === 'card'
      ? { providerPaymentRef: row.paymentIntentPublicId }
      : {}),
  });
}

/** Everything a completion carries, after `open → complete` was written. */
async function finalizeCompletion(
  tx: DatabaseOrTransaction,
  completed: CheckoutSessionRow,
  rail: CheckoutSessionRow['rail'] = completed.rail,
): Promise<CheckoutSessionRow> {
  let row = completed;
  if (row.couponId !== null && !(await redeemCoupon(tx, row.couponId))) {
    process.emitWarning(`checkout: coupon redemption for ${row.publicId} exceeded its bound`);
  }
  if (row.promotionCodeId !== null && !(await redeemPromotionCode(tx, row.promotionCodeId))) {
    process.emitWarning(
      `checkout: promotion code redemption for ${row.publicId} exceeded its bound`,
    );
  }
  if (row.paymentLinkId !== null) {
    const counted = await countLinkCompletion(tx, row.paymentLinkId);
    if (counted?.deactivated) await recordLinkUpdated(tx, counted.row, { active: true });
  }
  if (row.customerId === null && row.customerCreation === 'always') {
    const email = row.customerEmail ?? row.customerDetails?.email ?? null;
    const customer = await insertCustomer(tx, {
      publicId: newId('cus'),
      merchantId: row.merchantId,
      metadata: {},
      email,
      name: row.customerDetails?.name ?? null,
      phone: row.customerDetails?.phone ?? null,
      address: row.customerDetails?.address ?? null,
    });
    await recordEvent(tx, {
      merchantId: row.merchantId,
      type: 'customer.created',
      object: toCustomerDTO(customer),
    });
    row = (await setSessionCustomer(tx, row.id, customer.id)) ?? row;
  }
  if (row.mode === 'subscription') {
    await subscriptionCheckoutFulfiller()?.complete(tx, row);
  }
  if (row.paymentStatus === 'paid') await commitSessionTax(tx, row, rail);
  await recordSessionEvent(tx, row, 'checkout.session.completed', { status: 'open' });
  await enqueueCheckoutConfirmation(tx, row);
  return row;
}

/**
 * The session wrapping this payment follows where the payment now stands.
 * In the caller's transaction (the transition's). Idempotent: every write is a
 * compare-and-swap, so a re-recorded event changes nothing twice.
 */
export async function followIntentForCheckout(
  tx: DatabaseOrTransaction,
  intent: PaymentIntentRow,
): Promise<void> {
  const found = await findSessionByIntentId(tx, intent.id);
  if (!found) return;
  const session = await lockSession(tx, found.id);
  if (!session) return;

  switch (intent.status) {
    case 'succeeded': {
      if (session.status === 'open') {
        const completed = await completeSession(tx, session.id, 'paid');
        if (completed) await finalizeCompletion(tx, completed, intent.rail);
      } else if (session.status === 'complete' && session.paymentStatus === 'unpaid') {
        const paid = await markSessionPaid(tx, session.id);
        if (paid) {
          await commitSessionTax(tx, paid, intent.rail);
          if (intent.rail === 'faircoin') {
            await recordSessionEvent(tx, paid, 'checkout.session.async_payment_succeeded', {
              payment_status: 'unpaid',
            });
          }
        }
      }
      return;
    }
    case 'requires_capture': {
      if (session.status !== 'open') return;
      const completed = await completeSession(tx, session.id, 'unpaid');
      if (completed) await finalizeCompletion(tx, completed, intent.rail);
      return;
    }
    case 'processing': {
      // A card is processing for seconds and may still decline; a FairCoin
      // payment is broadcast — the payer has paid, the chain is confirming.
      if (intent.rail !== 'faircoin' || session.status !== 'open') return;
      const completed = await completeSession(tx, session.id, 'unpaid');
      if (completed) await finalizeCompletion(tx, completed, intent.rail);
      return;
    }
    case 'canceled': {
      // A QUOTED FairCoin payment ends on its quote's clock, not the order's
      // (ADR 0021 D3): the open order forgets it and waits for a fresh quote.
      if (session.status === 'open' && intent.faircoinQuote !== null) {
        await unlinkSessionPayment(tx, session.id, intent.id);
        return;
      }
      if (session.status === 'open') {
        const expired = await expireSessionRow(tx, session.id);
        if (expired)
          await recordSessionEvent(tx, expired, 'checkout.session.expired', { status: 'open' });
      } else if (
        session.status === 'complete' &&
        session.paymentStatus === 'unpaid' &&
        intent.rail === 'faircoin'
      ) {
        await recordSessionEvent(tx, session, 'checkout.session.async_payment_failed');
      }
      return;
    }
    default:
      return;
  }
}

/** A setup session follows its SetupIntent, in the transaction that moved it. */
export async function followSetupIntentForCheckout(
  tx: DatabaseOrTransaction,
  setup: SetupIntentRow,
): Promise<void> {
  const found = await findSessionBySetupIntentId(tx, setup.id);
  if (!found) return;
  const session = await lockSession(tx, found.id);
  if (session?.status !== 'open') return;
  if (setup.status === 'succeeded') {
    const completed = await completeSession(tx, session.id, 'no_payment_required');
    if (completed) await finalizeCompletion(tx, completed);
  } else if (setup.status === 'canceled') {
    const expired = await expireSessionRow(tx, session.id);
    if (expired)
      await recordSessionEvent(tx, expired, 'checkout.session.expired', { status: 'open' });
  }
}

/**
 * A priced order a discount took to zero: nothing to pay, so it completes on
 * confirm (`no_payment_required`), its redemption reserved and counted under
 * the code's lock in one transaction.
 */
export async function completeZeroAmountSession(
  session: CheckoutSessionRow,
  reserve: (tx: Transaction, row: CheckoutSessionRow) => Promise<DiscountRefusal | null>,
): Promise<CheckoutSessionRow | 'refused'> {
  const outcome = await getDb().transaction(async (tx) => {
    const locked = await lockSession(tx, session.id);
    if (locked?.status !== 'open') return locked ?? session;
    if ((await reserve(tx, locked)) !== null) return 'refused' as const;
    const completed = await completeSession(tx, locked.id, 'no_payment_required');
    return completed ? finalizeCompletion(tx, completed) : locked;
  });
  kickWebhookOutbox();
  return outcome;
}
