/**
 * Checkout's `mode: 'subscription'` seam (Orbit Phase 3 ↔ the native billing
 * engine, ADR 0018).
 *
 * A subscription session is designed and validated here — recurring lines,
 * one interval across them, a customer — but what it becomes (a `sub_…`, its
 * first invoice, the payment that invoice needs) is the billing engine's. The
 * engine registers ONE implementation of this interface at boot; until it
 * does, a subscription session is refused with a clear 400 naming `mode`, and
 * nothing pretends to have started a subscription.
 */
import type { DatabaseOrTransaction } from '../../db/postgres';
import type {
  CheckoutLineItemRow,
  CheckoutSessionRow,
} from '../../db/payments/checkoutSessionRepository';
import type { CustomerRow } from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { NewLineItem } from '../../db/payments/checkoutSessionRepository';

export interface SubscriptionCheckoutFulfiller {
  /**
   * At session create: refuse what the engine cannot bill (throw a
   * `CheckoutError` naming the line). The lines are priced and recurring.
   */
  validate(merchant: MerchantRow, lines: readonly NewLineItem[]): Promise<void>;
  /**
   * At confirm: create the subscription (incomplete) and the payment its first
   * invoice needs. Returns the INTERNAL id of that PaymentIntent, which the
   * session wraps exactly like a one-time payment; completion follows it.
   */
  start(input: {
    readonly merchant: MerchantRow;
    readonly session: CheckoutSessionRow;
    readonly lines: readonly CheckoutLineItemRow[];
    readonly customer: CustomerRow;
    /** How the payer pays the first invoice (ADR 0021 D3). */
    readonly paymentMethodType: 'card' | 'faircoin';
  }): Promise<{ readonly paymentIntentId: string }>;
  /**
   * The payer of a confirmed session chose the other method: replace the first
   * invoice's unpaid payment (relinking the session in the same transaction).
   */
  repay(input: {
    readonly merchant: MerchantRow;
    readonly session: CheckoutSessionRow;
    readonly paymentMethodType: 'card' | 'faircoin';
  }): Promise<{ readonly paymentIntentId: string }>;
  /** In the completion's transaction: activate what `start` created. */
  complete(tx: DatabaseOrTransaction, session: CheckoutSessionRow): Promise<void>;
}

let registered: SubscriptionCheckoutFulfiller | null = null;

/** The billing engine's registration — once, at boot. */
export function registerSubscriptionCheckoutFulfiller(
  fulfiller: SubscriptionCheckoutFulfiller | null,
): void {
  registered = fulfiller;
}

export function subscriptionCheckoutFulfiller(): SubscriptionCheckoutFulfiller | null {
  return registered;
}
