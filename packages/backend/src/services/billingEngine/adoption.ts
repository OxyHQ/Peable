/**
 * Adopting a subscription another provider has been billing (ADR 0018 §7):
 * the engine's ONE entry point for the Stripe-Billing proxy migration.
 *
 * `POST /v1/subscriptions` cannot do this: it prices, invoices and collects a
 * first period, and an adopted subscription's current period is already paid
 * at the previous provider. So an adoption inserts the subscription in its
 * CURRENT state — status, period, anchor, trial — with NO invoice, and two
 * facts the rest of the engine reads:
 *
 * - `provider_billed_until`: the previous provider billed the current period
 *   through this instant. No engine line covers it, so nothing before it can
 *   be credited by a proration (`updateSubscription` refuses a prorating item
 *   change until then, rather than charge a new price's remaining time
 *   without the credit).
 * - `provider_handoff_pending`: the previous provider still holds renewal
 *   authority. While it is set the subscription is inert — no scheduled step
 *   (`nextActionAt` is null), no renewal, no trial end, no merchant change —
 *   so exactly one system bills the next period. The migration clears it with
 *   {@link releaseProviderHandoff} only once the provider has stopped renewing.
 *
 * Access starts at adoption: the subscription is `active`/`trialing`, so its
 * product's features are active entitlements in the same transaction.
 */
import type { SubscriptionStatus } from '@peable.to/shared-types';
import type { PriceRow } from '../../db/catalog/priceRepository';
import type { CustomerRow } from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { claimCustomerCurrency } from '../../db/billingEngine/balanceRepository';
import {
  insertSubscription,
  insertSubscriptionItem,
  lockSubscription,
  updateSubscription as writeSubscription,
  type SubscriptionRow,
} from '../../db/billingEngine/subscriptionRepository';
import type { Transaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { renderSubscription } from '../../lib/serializeBilling';
import { previousAttributes } from '../catalog/catalogService';
import { refreshEntitlementSummary } from './entitlements';
import { BillingEngineError, invalid } from './errors';
import { nextBoundaryAfter } from './periods';
import { engineNow } from './runtime';
import { nextActionAt } from './subscriptionSchedule';
import { recordBillingEvent, transitionSubscription } from './transitions';

export interface AdoptSubscriptionInput {
  readonly merchant: MerchantRow;
  readonly customer: CustomerRow;
  /** The ONE licensed recurring price it bills, quantity 1. */
  readonly price: PriceRow;
  /** One of the customer's own methods (internal id), charged from the next period. */
  readonly defaultPaymentMethodId: string;
  readonly status: Extract<SubscriptionStatus, 'active' | 'trialing'>;
  readonly startDate: Date;
  readonly billingCycleAnchor: Date;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialStart: Date | null;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly automaticTax: boolean;
  readonly metadata: Record<string, string>;
}

/**
 * Insert an adopted subscription in the CALLER's transaction (the migration
 * writes its own record beside it), held for the previous provider's release.
 * Records `customer.subscription.created` and refreshes the customer's
 * entitlements; writes no invoice and charges nothing.
 */
export async function adoptSubscription(
  tx: Transaction,
  input: AdoptSubscriptionInput,
): Promise<SubscriptionRow> {
  const { merchant, customer, price } = input;
  if (customer.merchantId !== merchant.id || price.merchantId !== merchant.id) {
    throw new Error('an adoption across merchants');
  }
  if (customer.deletedAt !== null) throw invalid('the customer is deleted', 'customer');
  if (
    price.type !== 'recurring' ||
    price.recurringUsageType !== 'licensed' ||
    price.recurringInterval === null ||
    price.recurringIntervalCount === null
  ) {
    throw invalid('an adopted subscription bills one licensed recurring price', 'price');
  }
  if (price.currency === 'FAIR') {
    throw new BillingEngineError(
      'faircoin_cannot_debit',
      'a FairCoin subscription is renewed by its payer; there is nothing to adopt',
      'price',
    );
  }
  const now = await engineNow(tx, customer.testClockId);
  const start = input.currentPeriodStart;
  const end = input.currentPeriodEnd;
  if (!(start.getTime() <= now.getTime() && now.getTime() < end.getTime())) {
    throw invalid('only a subscription inside its current period can be adopted', 'current_period');
  }
  if ((input.trialStart === null) !== (input.trialEnd === null)) {
    throw invalid('a trial has a start and an end', 'trial_end');
  }
  if (input.status === 'trialing') {
    if (input.trialEnd?.getTime() !== end.getTime()) {
      throw invalid('a trialing subscription is in its trial period', 'trial_end');
    }
  } else {
    // The engine counts periods from the anchor (`periods.ts`): the adopted
    // period must be the one it would compute, or the next renewal would
    // start a period the payer was not billed for.
    const recurrence = {
      interval: price.recurringInterval,
      intervalCount: price.recurringIntervalCount,
    };
    if (
      nextBoundaryAfter(input.billingCycleAnchor, recurrence, start).getTime() !== end.getTime()
    ) {
      throw invalid(
        "the current period is not the price's interval from the billing cycle anchor",
        'billing_cycle_anchor',
      );
    }
  }
  if (!(await claimCustomerCurrency(tx, customer.id, price.currency))) {
    throw new BillingEngineError(
      'customer_currency_mismatch',
      `this customer bills in ${customer.currency}; a ${price.currency} subscription needs another customer`,
      'price',
    );
  }
  const subscription = await insertSubscription(tx, {
    publicId: newId('sub'),
    merchantId: merchant.id,
    customerId: customer.id,
    testClockId: customer.testClockId,
    status: input.status,
    currency: price.currency,
    collectionMethod: 'charge_automatically',
    daysUntilDue: null,
    defaultPaymentMethodId: input.defaultPaymentMethodId,
    description: null,
    billingCycleAnchor: input.billingCycleAnchor,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    startDate: input.startDate,
    trialStart: input.trialStart,
    trialEnd: input.trialEnd,
    trialEndBehavior: 'create_invoice',
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    cancelAt: null,
    automaticTax: input.automaticTax,
    discountCouponId: null,
    discountPromotionCodeId: null,
    discountStart: null,
    discountEnd: null,
    metadata: input.metadata,
    providerBilledUntil: end,
    providerHandoffPending: true,
    nextActionAt: null,
  });
  const item = await insertSubscriptionItem(tx, {
    publicId: newId('si'),
    merchantId: merchant.id,
    subscriptionId: subscription.id,
    priceId: price.id,
    quantity: 1,
    metadata: {},
  });
  if (item === 'price_taken') throw new Error('a new subscription already had this price');
  await recordBillingEvent(
    tx,
    merchant.id,
    'customer.subscription.created',
    await renderSubscription(tx, subscription),
  );
  await refreshEntitlementSummary(tx, merchant.id, customer.id);
  return subscription;
}

/**
 * The previous provider renewed while the handoff was held (the migration
 * stopped between adoption and release, past the period end): move the held
 * subscription onto the period the provider billed, so the engine's first
 * renewal is the period after it. Legal ONLY while held — afterwards the
 * engine alone moves periods.
 */
export async function realignHeldPeriod(
  tx: Transaction,
  subscriptionId: string,
  period: {
    readonly status: Extract<SubscriptionStatus, 'active' | 'trialing'>;
    readonly currentPeriodStart: Date;
    readonly currentPeriodEnd: Date;
  },
): Promise<SubscriptionRow> {
  const held = await lockSubscription(tx, subscriptionId);
  if (!held?.providerHandoffPending) {
    throw new Error('only a subscription held for its previous provider is realigned');
  }
  if (period.currentPeriodStart.getTime() < held.currentPeriodStart.getTime()) {
    throw new Error("a provider's period does not move backwards");
  }
  const before = await renderSubscription(tx, held);
  const patch = {
    currentPeriodStart: period.currentPeriodStart,
    currentPeriodEnd: period.currentPeriodEnd,
    providerBilledUntil: period.currentPeriodEnd,
    upcomingNoticeSentAt: null,
  };
  let row: SubscriptionRow;
  if (period.status !== held.status) {
    // Only trialing → active: the provider ended the trial and billed.
    row = await transitionSubscription(tx, held, period.status, patch);
  } else {
    const written = await writeSubscription(tx, held.id, patch);
    if (written === 'limit_exceeded') throw new Error('unreachable: no metadata in a realign');
    row = written;
    const after = await renderSubscription(tx, row);
    const previous = previousAttributes(before, after);
    if (previous) {
      await recordBillingEvent(
        tx,
        row.merchantId,
        'customer.subscription.updated',
        after,
        previous,
      );
    }
  }
  return row;
}

/**
 * The previous provider no longer renews this subscription: the engine takes
 * renewal authority, and its schedule is recomputed from the row — a period
 * end already past renews at the scheduler's next pass.
 */
export async function releaseProviderHandoff(
  tx: Transaction,
  subscriptionId: string,
): Promise<SubscriptionRow> {
  const held = await lockSubscription(tx, subscriptionId);
  if (!held) throw new Error('released subscription vanished');
  if (!held.providerHandoffPending) return held;
  const released = { ...held, providerHandoffPending: false };
  const written = await writeSubscription(tx, held.id, {
    providerHandoffPending: false,
    nextActionAt: nextActionAt(released),
  });
  if (written === 'limit_exceeded') throw new Error('unreachable: no metadata in a release');
  return written;
}
