import { localInvoiceQuote, type LocalInvoiceQuote } from './stripeTestInvoiceQuote';
import { voidUnpaidInitialInvoice } from './stripeTestInvoiceCancellation';
import { verifySecret } from '@oxy.so/core/server';
import { getDb } from '../db/postgres';
import { findMerchantById } from '../db/merchants/merchantRepository';
import {
  findIntentByPublicId,
  type PaymentIntentRow,
} from '../db/payments/paymentIntentRepository';
import { findBillingCustomerForStore } from '../db/billing/billingRepository';
import { configureBillingRuntime } from '../services/billing/configuredBilling';
import { createVerifiedBillingBindings } from '../services/billing/verifiedBindings';
import { getStripeClient, stripeBillingClient } from '../services/providers/stripe/client';
import { StripePaymentProvider } from '../services/providers/stripe/stripeProvider';
import type { CreatePaymentRequest, PaymentOperationRequest } from '../services/providers/provider';
import { assertLocalStripeTestEnvironment } from './stripeTestGuard';
import {
  LOCAL_TEST_PRICES,
  LOCAL_TEST_PRODUCT,
  localTestBillingConfiguration,
} from './stripeTestBilling';

export const EMBEDDED_TEST_PURPOSE = 'local-test-subscription';
const ref = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : value?.id;

async function context(intent: PaymentIntentRow) {
  assertLocalStripeTestEnvironment(process.env);
  const interval = intent.metadata.interval;
  if (
    intent.metadata.purpose !== EMBEDDED_TEST_PURPOSE ||
    (interval !== 'month' && interval !== 'year')
  )
    throw new Error('Not a local subscription');
  const selected = LOCAL_TEST_PRICES[interval];
  if (
    intent.amount !== String(selected.amount) ||
    intent.currency !== 'USD' ||
    intent.rail !== 'card'
  )
    throw new Error('Subscription quote mismatch');
  const db = getDb();
  const merchant = await findMerchantById(db, intent.merchantId);
  if (!merchant || merchant.network !== null || merchant.xpub !== null)
    throw new Error('Missing or invalid local merchant');
  const client = getStripeClient();
  const account = await client.accounts.retrieve(null);
  if (
    account.id !== 'acct_1USWGhAofUef123L' ||
    account.id !== process.env.PEABLE_TEST_STRIPE_ACCOUNT
  )
    throw new Error('Unexpected test account');
  const configuration = localTestBillingConfiguration(merchant, account.id);
  const cohort = configuration.cohorts[0];
  if (!cohort) throw new Error('Missing local owner');
  const { evidenceRef, ...owner } = cohort;
  const bindings = createVerifiedBillingBindings({
    db,
    client: stripeBillingClient(),
    deployment: configuration.deployment,
    cohorts: [{ ...cohort, ...configuration.deployment }],
  });
  return {
    db,
    client,
    interval: interval as 'month' | 'year',
    selected,
    configuration,
    owner,
    evidenceRef,
    bindings,
    storeId: `embedded-${intent.publicId}`,
  };
}

async function proof(intent: PaymentIntentRow) {
  const ctx = await context(intent);
  const customer = await findBillingCustomerForStore(
    ctx.db,
    ctx.configuration.deployment,
    ctx.owner,
    ctx.storeId,
  );
  if (!customer) throw new Error('Missing subscription customer binding');
  const subscriptions = await ctx.client.subscriptions.list({
    customer: customer.providerRef,
    status: 'all',
    limit: 2,
  });
  const subscription = subscriptions.data[0];
  if (
    subscriptions.has_more ||
    subscriptions.data.length !== 1 ||
    !subscription ||
    subscription.livemode ||
    subscription.metadata.peable_intent_id !== intent.publicId ||
    ref(subscription.customer) !== customer.providerRef ||
    subscription.items.data.length !== 1 ||
    subscription.items.data[0]?.price.id !== ctx.selected.id ||
    subscription.items.data[0]?.quantity !== 1
  )
    throw new Error('Subscription identity mismatch');
  // The first invoice remains the payment being authorized even after a renewal exists.
  const invoices = await ctx.client.invoices.list({ subscription: subscription.id, limit: 100 });
  const initial = invoices.data.filter(
    (invoice) => invoice.billing_reason === 'subscription_create',
  );
  const invoice = initial[0];
  if (
    invoices.has_more ||
    initial.length !== 1 ||
    !invoice ||
    invoice.livemode ||
    ref(invoice.customer) !== customer.providerRef ||
    ref(invoice.parent?.subscription_details?.subscription) !== subscription.id ||
    invoice.currency !== 'usd' ||
    invoice.total !== ctx.selected.amount ||
    invoice.amount_due !== ctx.selected.amount
  )
    throw new Error('First invoice quote mismatch');
  const payments = await ctx.client.invoicePayments.list({ invoice: invoice.id, limit: 2 });
  const payment = payments.data[0];
  const paymentId = ref(payment?.payment.payment_intent);
  if (
    payments.has_more ||
    payments.data.length !== 1 ||
    !payment ||
    payment.livemode ||
    !payment.is_default ||
    ref(payment.invoice) !== invoice.id ||
    payment.amount_requested !== ctx.selected.amount ||
    !paymentId
  )
    throw new Error('Invoice payment binding mismatch');
  const pi = await ctx.client.paymentIntents.retrieve(paymentId);
  if (
    pi.livemode ||
    pi.amount !== ctx.selected.amount ||
    pi.currency !== 'usd' ||
    ref(pi.customer) !== customer.providerRef ||
    (intent.providerObjectId && intent.providerObjectId !== pi.id)
  )
    throw new Error('First invoice payment mismatch');
  await ctx.bindings.importSubscription(ctx.owner, {
    providerSubscriptionId: subscription.id,
    providerCustomerId: customer.providerRef,
    providerPriceId: ctx.selected.id,
    evidenceRef: ctx.evidenceRef,
  });
  return { ...ctx, subscription, invoice, pi };
}

/** Isolated runner adapter: a real first-invoice PI uses the ordinary Peable lifecycle. */
export class LocalSubscriptionStripeProvider extends StripePaymentProvider {
  override async createPayment(request: CreatePaymentRequest) {
    assertLocalStripeTestEnvironment(process.env);
    const intent = await findIntentByPublicId(getDb(), request.intentId);
    if (!intent || intent.metadata.purpose !== EMBEDDED_TEST_PURPOSE)
      return super.createPayment(request);
    const ctx = await context(intent);
    const price = await ctx.client.prices.retrieve(ctx.selected.id);
    if (
      price.livemode ||
      !price.active ||
      ref(price.product) !== LOCAL_TEST_PRODUCT ||
      price.currency !== 'usd' ||
      price.unit_amount !== ctx.selected.amount ||
      price.recurring?.interval !== ctx.interval ||
      price.recurring.interval_count !== 1 ||
      price.tax_behavior !== 'inclusive'
    )
      throw new Error('Unapproved subscription price');
    await ctx.bindings.importPrice(ctx.owner, {
      providerPriceId: price.id,
      planId: ctx.selected.plan,
      evidenceRef: ctx.evidenceRef,
    });
    const runtime = await configureBillingRuntime(ctx.db, JSON.stringify(ctx.configuration));
    if (!runtime) throw new Error('Local billing unavailable');
    const customer = await runtime.service.ensureCustomer(
      ctx.owner,
      { storeId: ctx.storeId, storeName: 'Local checkout', rail: 'stripe' },
      `embedded-customer-${intent.publicId}`,
    );
    // A retry after the provider idempotency retention window still reuses the unique customer's subscription.
    const existing = await ctx.client.subscriptions.list({
      customer: customer.providerCustomerId,
      status: 'all',
      limit: 2,
    });
    if (existing.has_more || existing.data.length > 1)
      throw new Error('Ambiguous local subscription');
    if (!existing.data.length)
      await ctx.client.subscriptions.create(
        {
          customer: customer.providerCustomerId,
          items: [{ price: price.id, quantity: 1 }],
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          metadata: { peable_intent_id: intent.publicId },
        },
        { idempotencyKey: `embedded-subscription-${intent.publicId}` },
      );
    const verified = await proof(intent);
    return super.getStatus(verified.pi.id);
  }

  override async cancel(request: PaymentOperationRequest) {
    assertLocalStripeTestEnvironment(process.env);
    const intent = await findIntentByPublicId(getDb(), request.intentId);
    if (!intent || intent.metadata.purpose !== EMBEDDED_TEST_PURPOSE) return super.cancel(request);
    const verified = await proof(intent);
    if (verified.pi.id !== request.providerObjectId)
      throw new Error('Cancellation identity mismatch');
    await voidUnpaidInitialInvoice(
      { invoiceStatus: verified.invoice.status, subscriptionStatus: verified.subscription.status },
      () =>
        verified.client.invoices.voidInvoice(
          verified.invoice.id,
          {},
          { idempotencyKey: `void-${request.idempotencyKey}` },
        ),
      async () => {
        const current = await proof(intent);
        return {
          invoiceStatus: current.invoice.status,
          subscriptionStatus: current.subscription.status,
        };
      },
    );
    // Voiding the initial invoice handles its incomplete subscription. Never cancel an active subscription.
    return super.getStatus(verified.pi.id);
  }
}

export interface LocalSubscriptionSnapshot {
  kind: 'subscription';
  environment: 'test';
  intentId: string;
  subscriptionId: string;
  interval: 'month' | 'year';
  amountMinorUnits: number;
  currency: 'USD';
  subscriptionStatus: string;
  invoiceStatus: string | null;
  paymentStatus: string;
  ready: boolean;
  tax?: LocalInvoiceQuote;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
}
export async function readLocalSubscription(
  intentId: string,
  capability?: string,
): Promise<LocalSubscriptionSnapshot> {
  assertLocalStripeTestEnvironment(process.env);
  const intent = await findIntentByPublicId(getDb(), intentId);
  if (!intent || (capability !== undefined && !verifySecret(capability, intent.clientSecret)))
    throw new Error('Subscription not found');
  const verified = await proof(intent);
  const item = verified.subscription.items.data[0];
  let ready = false;
  if (
    intent.status === 'settled' &&
    verified.subscription.status === 'active' &&
    verified.invoice.status === 'paid'
  ) {
    const paid = await verified.bindings.retrieveInvoiceState(
      verified.owner,
      verified.subscription.id,
      verified.invoice.id,
      true,
      AbortSignal.timeout(10_000),
    );
    ready =
      paid.state === 'paid' &&
      paid.amountPaid === String(verified.selected.amount) &&
      paid.paymentIntentId === verified.pi.id &&
      paid.currency === 'USD';
  }
  return {
    kind: 'subscription' as const,
    environment: 'test' as const,
    intentId: intent.publicId,
    subscriptionId: verified.subscription.id,
    interval: verified.interval,
    amountMinorUnits: verified.selected.amount,
    currency: 'USD' as const,
    tax: localInvoiceQuote(verified.invoice, item?.price.tax_behavior ?? 'unspecified'),
    subscriptionStatus: verified.subscription.status,
    invoiceStatus: verified.invoice.status,
    paymentStatus: intent.status,
    ready,
    currentPeriodStart: item ? new Date(item.current_period_start * 1000).toISOString() : undefined,
    currentPeriodEnd: item ? new Date(item.current_period_end * 1000).toISOString() : undefined,
  };
}
