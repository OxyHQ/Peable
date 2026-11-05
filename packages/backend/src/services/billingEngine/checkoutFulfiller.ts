/**
 * Checkout's `mode: 'subscription'` (Orbit Phase 3), fulfilled by the native
 * billing engine (ADR 0018) — registered at boot with
 * `registerSubscriptionCheckoutFulfiller`.
 *
 * The session designs the order; the engine makes what it becomes:
 *
 * - **validate** (session create): every line is a stored, active, LICENSED
 *   recurring price, all in one currency on one interval — what a subscription
 *   can hold — and the first invoice charges something (a free start is a
 *   trial, made through the subscriptions API).
 * - **start** (payer confirms): the subscription is created
 *   `default_incomplete` for the session's customer, with the session's items,
 *   tax setting and discount (the session redeems that discount itself when it
 *   completes, so the engine does not count it twice), and its first invoice is
 *   finalized — Peable Tax before finalization, fail closed. The session wraps
 *   the invoice's PaymentIntent exactly like a one-time payment; a card payment
 *   saves its card (`setup_future_usage: off_session`) for the renewals, a
 *   FairCoin one is paid from the payer's wallet. The invoice must ask for
 *   EXACTLY what the session showed; if it does not, nothing is charged and
 *   the subscription is expired.
 * - **complete** (in the completion's transaction): nothing left to do — the
 *   payment hook (`onInvoicePaymentTransition`) in that same transaction has
 *   paid the invoice and activated the subscription.
 */
import { findPricesByRowIds } from '../../db/catalog/priceRepository';
import {
  findInvoiceById,
  findInvoiceByPaymentIntent,
} from '../../db/billingEngine/invoiceRepository';
import { getDb } from '../../db/postgres';
import { CheckoutError } from '../checkout/errors';
import type { SubscriptionCheckoutFulfiller } from '../checkout/subscriptionFulfiller';
import { payerIntentForInvoice } from './collect';
import { BillingEngineError } from './errors';
import { cancelSubscriptionNow, createSubscription } from './subscriptions';

function refuse(message: string, param: string): never {
  throw new CheckoutError(400, 'subscription_line_invalid', message, param);
}

/** A billing engine refusal as checkout answers it. */
function asCheckoutError(error: unknown): unknown {
  if (!(error instanceof BillingEngineError)) return error;
  return new CheckoutError(
    error.status === 503 ? 503 : error.status === 409 ? 409 : 400,
    error.code,
    error.message,
    error.param,
  );
}

export const billingEngineCheckoutFulfiller: SubscriptionCheckoutFulfiller = {
  async validate(_merchant, lines) {
    const prices = await findPricesByRowIds(
      getDb(),
      lines.flatMap((line) => (line.priceId ? [line.priceId] : [])),
    );
    let first: { currency: string; interval: string | null; count: number | null } | null = null;
    let total = 0n;
    for (const [index, line] of lines.entries()) {
      const param = `line_items[${index}][price]`;
      const price = line.priceId ? prices.find((row) => row.id === line.priceId) : undefined;
      if (!price)
        refuse('a subscription line names a stored recurring price, not price_data', param);
      if (price.type !== 'recurring') refuse('every subscription line is a recurring price', param);
      if (price.recurringUsageType === 'metered') {
        refuse('a metered price is billed by its meter, not sold through checkout', param);
      }
      const shape = {
        currency: price.currency,
        interval: price.recurringInterval,
        count: price.recurringIntervalCount,
      };
      if (first === null) first = shape;
      else if (
        first.currency !== shape.currency ||
        first.interval !== shape.interval ||
        first.count !== shape.count
      ) {
        refuse('every subscription line bills in one currency on one interval', param);
      }
      total += BigInt(line.amountTotal);
    }
    if (total === 0n) {
      refuse(
        'a subscription checkout charges its first invoice; start a free period as a trial through the subscriptions API',
        'line_items',
      );
    }
  },

  async start({ merchant, session, lines, customer, paymentMethodType }) {
    const prices = await findPricesByRowIds(
      getDb(),
      lines.flatMap((line) => (line.priceId ? [line.priceId] : [])),
    );
    const items = lines
      .filter((line) => line.quantity > 0)
      .map((line) => {
        const price = prices.find((row) => row.id === line.priceId);
        if (!price) throw new Error(`checkout line ${line.publicId} lost its price`);
        return { price: price.publicId, quantity: line.quantity };
      });
    let subscription: Awaited<ReturnType<typeof createSubscription>>;
    try {
      subscription = await createSubscription(merchant, {
        customer: customer.publicId,
        items,
        paymentBehavior: 'default_incomplete',
        automaticTax: session.automaticTax,
        ...(session.couponId
          ? {
              checkoutDiscount: {
                couponId: session.couponId,
                promotionCodeId: session.promotionCodeId,
              },
            }
          : {}),
        metadata: { checkout_session: session.publicId },
      });
    } catch (error) {
      if (error instanceof BillingEngineError) {
        throw new CheckoutError(
          error.status === 503 || error.status === 409 ? error.status : 400,
          error.code,
          error.message,
          error.param,
        );
      }
      throw error;
    }
    const invoice = subscription.latestInvoiceId
      ? await findInvoiceById(getDb(), subscription.latestInvoiceId)
      : null;
    if (!invoice || (invoice.status !== 'open' && invoice.status !== 'uncollectible')) {
      await cancelSubscriptionNow(merchant, subscription.publicId, {});
      throw new CheckoutError(
        409,
        'checkout_session_changed',
        'this checkout changed; reload and try again',
      );
    }
    let intent: Awaited<ReturnType<typeof payerIntentForInvoice>>;
    try {
      intent = await payerIntentForInvoice(invoice, paymentMethodType);
    } catch (error) {
      // Nothing can be paid (FairCoin unpriceable, say): charge nothing.
      await cancelSubscriptionNow(merchant, subscription.publicId, {});
      throw asCheckoutError(error);
    }
    const quote = intent.faircoinQuote;
    const orderAmount = quote?.amount ?? intent.amount;
    const orderCurrency = quote?.currency ?? intent.currency;
    if (orderAmount !== session.amount || orderCurrency !== session.currency) {
      // The order the payer saw is not what the invoice asks for (a price,
      // a balance or the tax moved): charge nothing.
      await cancelSubscriptionNow(merchant, subscription.publicId, {});
      throw new CheckoutError(
        409,
        'checkout_session_changed',
        'this checkout changed; reload and try again',
      );
    }
    return { paymentIntentId: intent.id };
  },

  async repay({ session, paymentMethodType }) {
    const db = getDb();
    const invoice = session.paymentIntentId
      ? await findInvoiceByPaymentIntent(db, session.paymentIntentId)
      : null;
    if (!invoice) {
      throw new CheckoutError(
        409,
        'checkout_session_changed',
        'this checkout changed; reload and try again',
      );
    }
    try {
      const intent = await payerIntentForInvoice(invoice, paymentMethodType);
      return { paymentIntentId: intent.id };
    } catch (error) {
      throw asCheckoutError(error);
    }
  },

  async complete() {
    // The invoice's payment hook, in this same transaction, paid the first
    // invoice and activated the subscription (`collect.ts`).
  },
};
