/**
 * The customer portal (ADR 0018 §9): Orbit-hosted, at
 * `checkout.peable.to/portal/<token>`, configured per merchant by
 * `billing_portal.configurations` and opened by a short-lived
 * `billing_portal.sessions` URL the merchant's server mints for ONE customer.
 *
 * The URL's token is the customer's bearer credential for an hour; only its
 * SHA-256 is stored. Everything the portal does goes through the same engine
 * functions the API uses — a plan change is `updateSubscription` with the
 * configuration's proration behaviour, a cancellation `cancel_at_period_end`
 * or a cancel now — so the portal cannot do anything the API would refuse.
 *
 * Routes are `/v1/billing_portal/*` (Stripe's), apart from the Stripe-Billing
 * proxy's `/v1/billing/portal_sessions`.
 */
import { createHash } from 'node:crypto';
import type {
  BillingPortalConfiguration,
  BillingPortalFeatures,
  BillingPortalSession,
  PublicPortalSession,
} from '@peable.to/shared-types';
import { config } from '../../config';
import { findPricesByRowIds, findPricesByPublicIds } from '../../db/catalog/priceRepository';
import { findProductsByIds, findProductsByPublicIds } from '../../db/catalog/productRepository';
import {
  findCustomerById,
  findLiveCustomerForMerchant,
  type CustomerRow,
} from '../../db/customers/customerRepository';
import { findPaymentMethodById } from '../../db/customers/paymentMethodRepository';
import { findSetupIntentForMerchant } from '../../db/customers/setupIntentRepository';
import { findMerchantById, type MerchantRow } from '../../db/merchants/merchantRepository';
import type { MetadataPatch } from '../../db/metadata';
import { listCustomerInvoices } from '../../db/billingEngine/invoiceRepository';
import {
  findDefaultPortalConfiguration,
  findLivePortalSession,
  findPortalConfigurationById,
  findPortalConfigurationForMerchant,
  insertPortalConfiguration,
  insertPortalSession,
  updatePortalConfiguration,
  type PortalConfigurationRow,
  type PortalSessionRow,
} from '../../db/billingEngine/portalRepository';
import {
  findSubscriptionForMerchant,
  listCustomerSubscriptions,
  listLiveItemsFor,
  lockSubscription,
} from '../../db/billingEngine/subscriptionRepository';
import { getDb } from '../../db/postgres';
import { newBearerToken, newId } from '../../lib/ids';
import { hostedInvoiceUrl, invoicePdfUrl } from '../../lib/serializeBilling';
import { toUnix, toUnixOrNull } from '../../lib/time';
import { resolveMerchantDisplay } from '../merchantDisplay';
import { createSetupIntent, reconcileSetupIntent } from '../customers/setupIntentService';
import { updateCustomerFields } from '../customers/customerService';
import { kickWebhookOutbox } from '../webhookOutbox';
import { BillingEngineError, invalid, missing } from './errors';
import { railOf } from './collect';
import { cancelSubscriptionNow, updateSubscription } from './subscriptions';
import { patchSubscription, recordBillingEvent } from './transitions';

const SESSION_LIFETIME_MS = 3600_000;

/** What a configuration created with no features enables — the safe, common portal. */
export const DEFAULT_PORTAL_FEATURES: BillingPortalFeatures = {
  customer_update: { enabled: true, allowed_updates: ['email', 'name', 'address'] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
  subscription_update: {
    enabled: false,
    default_allowed_updates: ['price'],
    proration_behavior: 'create_prorations',
    products: [],
  },
};

type FeaturesInput = {
  [K in keyof BillingPortalFeatures]?: Partial<BillingPortalFeatures[K]>;
};

function mergeFeatures(
  base: BillingPortalFeatures,
  input: FeaturesInput | undefined,
): BillingPortalFeatures {
  if (!input) return base;
  return {
    customer_update: { ...base.customer_update, ...input.customer_update },
    invoice_history: { ...base.invoice_history, ...input.invoice_history },
    payment_method_update: { ...base.payment_method_update, ...input.payment_method_update },
    subscription_cancel: { ...base.subscription_cancel, ...input.subscription_cancel },
    subscription_update: { ...base.subscription_update, ...input.subscription_update },
  };
}

/** Every product and price a plan-change list names must be the merchant's (and the price the product's). */
async function assertPlans(merchant: MerchantRow, features: BillingPortalFeatures): Promise<void> {
  const plans = features.subscription_update.products;
  if (plans.length === 0) {
    if (features.subscription_update.enabled) {
      throw invalid(
        'a plan change needs the products and prices it may switch between',
        'features[subscription_update][products]',
      );
    }
    return;
  }
  const db = getDb();
  const products = await findProductsByPublicIds(
    db,
    merchant.id,
    plans.map((plan) => plan.product),
  );
  const prices = await findPricesByPublicIds(
    db,
    merchant.id,
    plans.flatMap((plan) => plan.prices),
  );
  for (const [i, plan] of plans.entries()) {
    const product = products.find((row) => row.publicId === plan.product);
    if (!product)
      throw new BillingEngineError(
        'resource_missing',
        `no such product: '${plan.product}'`,
        `features[subscription_update][products][${i}][product]`,
      );
    for (const id of plan.prices) {
      const price = prices.find((row) => row.publicId === id);
      if (!price || price.productId !== product.id || price.type !== 'recurring') {
        throw new BillingEngineError(
          'resource_missing',
          `no recurring price '${id}' of ${plan.product}`,
          `features[subscription_update][products][${i}][prices]`,
        );
      }
    }
  }
}

export function toPortalConfigurationDTO(row: PortalConfigurationRow): BillingPortalConfiguration {
  return {
    id: row.publicId,
    object: 'billing_portal.configuration',
    livemode: row.livemode,
    active: row.active,
    is_default: row.isDefault,
    business_profile: row.businessProfile,
    default_return_url: row.defaultReturnUrl,
    features: row.features,
    metadata: row.metadata,
    created: toUnix(row.createdAt),
    updated: toUnix(row.updatedAt),
  };
}

export async function createPortalConfiguration(
  merchant: MerchantRow,
  input: {
    businessProfile?: Partial<BillingPortalConfiguration['business_profile']>;
    defaultReturnUrl?: string;
    features?: FeaturesInput;
    metadata: Record<string, string>;
    isDefault?: boolean;
  },
): Promise<PortalConfigurationRow> {
  const features = mergeFeatures(DEFAULT_PORTAL_FEATURES, input.features);
  await assertPlans(merchant, features);
  const db = getDb();
  const isDefault =
    input.isDefault ?? (await findDefaultPortalConfiguration(db, merchant.id)) === null;
  const row = await insertPortalConfiguration(db, {
    publicId: newId('bpc'),
    merchantId: merchant.id,
    isDefault,
    businessProfile: {
      headline: input.businessProfile?.headline ?? null,
      privacy_policy_url: input.businessProfile?.privacy_policy_url ?? null,
      terms_of_service_url: input.businessProfile?.terms_of_service_url ?? null,
    },
    defaultReturnUrl: input.defaultReturnUrl ?? null,
    features,
    metadata: input.metadata,
  });
  if (!row) {
    // Another configuration became the default concurrently; this one is not.
    return createPortalConfiguration(merchant, { ...input, isDefault: false });
  }
  await recordBillingEvent(
    db,
    merchant.id,
    'billing_portal.configuration.created',
    toPortalConfigurationDTO(row),
  );
  kickWebhookOutbox();
  return row;
}

export async function changePortalConfiguration(
  merchant: MerchantRow,
  publicId: string,
  input: {
    active?: boolean;
    businessProfile?: Partial<BillingPortalConfiguration['business_profile']>;
    defaultReturnUrl?: string | null;
    features?: FeaturesInput;
    metadata?: MetadataPatch;
  },
): Promise<PortalConfigurationRow> {
  const db = getDb();
  const found = await findPortalConfigurationForMerchant(db, publicId, merchant.id);
  if (!found) throw missing('portal configuration');
  if (input.active === false && found.isDefault) {
    throw invalid('the default configuration cannot be deactivated', 'active');
  }
  const features = input.features ? mergeFeatures(found.features, input.features) : undefined;
  if (features) await assertPlans(merchant, features);
  const row = await db.transaction(async (tx) => {
    const written = await updatePortalConfiguration(tx, found.id, {
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.businessProfile
        ? { businessProfile: { ...found.businessProfile, ...input.businessProfile } }
        : {}),
      ...(input.defaultReturnUrl !== undefined ? { defaultReturnUrl: input.defaultReturnUrl } : {}),
      ...(features ? { features } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    if (written === 'limit_exceeded') throw invalid('metadata limit exceeded', 'metadata');
    await recordBillingEvent(
      tx,
      merchant.id,
      'billing_portal.configuration.updated',
      toPortalConfigurationDTO(written),
    );
    return written;
  });
  kickWebhookOutbox();
  return row;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function portalUrl(token: string): string {
  return `${config.checkoutBaseUrl}/portal/${token}`;
}

export function toPortalSessionDTO(row: PortalSessionRow, url: string): BillingPortalSession {
  return {
    id: row.publicId,
    object: 'billing_portal.session',
    livemode: row.livemode,
    customer: row.customerPublicId,
    configuration: row.configurationPublicId,
    return_url: row.returnUrl,
    url,
    expires_at: toUnix(row.expiresAt),
    created: toUnix(row.createdAt),
  };
}

/** `POST /v1/billing_portal/sessions`. The URL is answered once and never stored. */
export async function createPortalSession(
  merchant: MerchantRow,
  input: { customer: string; configuration?: string; returnUrl?: string },
): Promise<BillingPortalSession> {
  const db = getDb();
  const customer = await findLiveCustomerForMerchant(db, input.customer, merchant.id);
  if (!customer) throw missing('customer', 'customer');
  let configuration = input.configuration
    ? await findPortalConfigurationForMerchant(db, input.configuration, merchant.id)
    : await findDefaultPortalConfiguration(db, merchant.id);
  if (input.configuration && !configuration?.active) {
    throw new BillingEngineError(
      'resource_missing',
      'no such active portal configuration',
      'configuration',
    );
  }
  configuration ??= await createPortalConfiguration(merchant, { metadata: {}, isDefault: true });
  const token = newBearerToken('bps');
  const row = await insertPortalSession(db, {
    publicId: newId('bps'),
    merchantId: merchant.id,
    customerId: customer.id,
    configurationId: configuration.id,
    tokenHash: tokenHash(token),
    returnUrl: input.returnUrl ?? configuration.defaultReturnUrl,
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
  });
  const dto = toPortalSessionDTO(row, portalUrl(token));
  // The event carries the session WITHOUT its URL: a bearer credential is
  // never stored, and an event is.
  await recordBillingEvent(db, merchant.id, 'billing_portal.session.created', { ...dto, url: '' });
  kickWebhookOutbox();
  return dto;
}

// ---- The hosted portal (payer-facing) -------------------------------------------------

interface PortalContext {
  readonly session: PortalSessionRow;
  readonly merchant: MerchantRow;
  readonly customer: CustomerRow;
  readonly configuration: PortalConfigurationRow;
}

export async function openPortal(token: string): Promise<PortalContext> {
  const db = getDb();
  const session = await findLivePortalSession(db, tokenHash(token));
  if (!session) {
    throw new BillingEngineError(
      'portal_session_expired',
      'this portal link has expired; ask for a new one',
      undefined,
      404,
    );
  }
  const merchant = await findMerchantById(db, session.merchantId);
  const customer = await findCustomerById(db, session.customerId);
  const configuration = await findPortalConfigurationById(db, session.configurationId);
  if (!merchant || !customer || customer.deletedAt || !configuration) {
    throw new BillingEngineError(
      'portal_session_expired',
      'this portal link no longer works',
      undefined,
      404,
    );
  }
  return { session, merchant, customer, configuration };
}

function requireFeature(enabled: boolean, what: string): void {
  if (!enabled)
    throw new BillingEngineError(
      'portal_feature_disabled',
      `${what} is not available in this portal`,
      undefined,
      400,
    );
}

export async function portalView(token: string): Promise<PublicPortalSession> {
  const context = await openPortal(token);
  const { merchant, customer, configuration, session } = context;
  const db = getDb();
  const display = await resolveMerchantDisplay(merchant);
  const subscriptions = (await listCustomerSubscriptions(db, customer.id)).filter(
    (row) => !['canceled', 'incomplete_expired'].includes(row.status),
  );
  const items = await listLiveItemsFor(
    db,
    subscriptions.map((row) => row.id),
  );
  const prices = await findPricesByRowIds(
    db,
    items.map((item) => item.priceId),
  );
  const plans = configuration.features.subscription_update.products;
  const planPrices = await findPricesByPublicIds(
    db,
    merchant.id,
    plans.flatMap((plan) => plan.prices),
  );
  const products = await findProductsByIds(db, [
    ...prices.map((price) => price.productId),
    ...planPrices.map((price) => price.productId),
  ]);
  const method = customer.defaultPaymentMethodId
    ? await findPaymentMethodById(db, customer.defaultPaymentMethodId)
    : null;
  const invoices = configuration.features.invoice_history.enabled
    ? await listCustomerInvoices(db, customer.id, 24)
    : [];
  const fair = customer.currency !== null && railOf(customer.currency) === 'faircoin';
  return {
    object: 'billing_portal.public_session',
    livemode: merchant.livemode,
    merchant: { name: display.name ?? null, avatar_url: display.avatar_url ?? null },
    business_profile: configuration.businessProfile,
    features: {
      ...configuration.features,
      // A FairCoin payer has no saved method to update (ADR 0016 §4).
      payment_method_update: {
        enabled: configuration.features.payment_method_update.enabled && !fair,
      },
    },
    return_url: session.returnUrl,
    expires_at: toUnix(session.expiresAt),
    customer: {
      id: customer.publicId,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      default_payment_method: method
        ? {
            id: method.publicId,
            card:
              method.card.brand &&
              method.card.last4 &&
              method.card.exp_month &&
              method.card.exp_year
                ? {
                    brand: method.card.brand,
                    last4: method.card.last4,
                    exp_month: method.card.exp_month,
                    exp_year: method.card.exp_year,
                  }
                : null,
          }
        : null,
    },
    subscriptions: subscriptions.map((row) => ({
      id: row.publicId,
      status: row.status,
      currency: row.currency,
      current_period_end: toUnix(row.currentPeriodEnd),
      cancel_at_period_end: row.cancelAtPeriodEnd,
      cancel_at: toUnixOrNull(row.cancelAt),
      trial_end: toUnixOrNull(row.trialEnd),
      collection_method: row.collectionMethod,
      items: items
        .filter((item) => item.subscriptionId === row.id)
        .map((item) => {
          const price = prices.find((candidate) => candidate.id === item.priceId);
          const product = products.find((candidate) => candidate.id === price?.productId);
          return {
            id: item.publicId,
            price: price?.publicId ?? '',
            product: product?.publicId ?? '',
            product_name: product?.name ?? '',
            quantity: item.quantity,
            unit_amount: price?.unitAmount ?? null,
            interval: price?.recurringInterval ?? null,
          };
        }),
    })),
    invoices: invoices.map((row) => ({
      id: row.publicId,
      number: row.number,
      status: row.status,
      currency: row.currency,
      total: row.total,
      amount_due: row.amountDue,
      created: toUnix(row.createdAt),
      hosted_invoice_url: row.hostedToken ? hostedInvoiceUrl(row.hostedToken) : null,
      invoice_pdf: row.hostedToken ? invoicePdfUrl(row.hostedToken) : null,
    })),
    plans: configuration.features.subscription_update.enabled
      ? plans.map((plan) => {
          const product = products.find((candidate) => candidate.publicId === plan.product);
          return {
            product: plan.product,
            product_name: product?.name ?? '',
            prices: planPrices
              .filter((price) => plan.prices.includes(price.publicId) && price.active)
              .map((price) => ({
                id: price.publicId,
                unit_amount: price.unitAmount,
                currency: price.currency,
                interval: price.recurringInterval,
                interval_count: price.recurringIntervalCount,
              })),
          };
        })
      : [],
  };
}

async function ownSubscription(context: PortalContext, publicId: string) {
  const subscription = await findSubscriptionForMerchant(getDb(), publicId, context.merchant.id);
  if (!subscription || subscription.customerId !== context.customer.id)
    throw missing('subscription', 'subscription');
  return subscription;
}

/** Cancel as the configuration says: at period end (undoable) or now. */
export async function portalCancel(token: string, subscriptionId: string): Promise<void> {
  const context = await openPortal(token);
  const { subscription_cancel: cancel } = context.configuration.features;
  requireFeature(cancel.enabled, 'cancelling');
  const subscription = await ownSubscription(context, subscriptionId);
  if (cancel.mode === 'immediately') {
    await cancelSubscriptionNow(context.merchant, subscription.publicId, {
      prorate: cancel.proration_behavior === 'create_prorations',
    });
    return;
  }
  await updateSubscription(context.merchant, subscription.publicId, { cancelAtPeriodEnd: true });
}

/** Undo a cancellation at period end. */
export async function portalRenew(token: string, subscriptionId: string): Promise<void> {
  const context = await openPortal(token);
  requireFeature(context.configuration.features.subscription_cancel.enabled, 'cancelling');
  const subscription = await ownSubscription(context, subscriptionId);
  await updateSubscription(context.merchant, subscription.publicId, { cancelAtPeriodEnd: false });
}

/** Switch a subscription's (single) item to one of the configuration's plans, or change its quantity. */
export async function portalChangePlan(
  token: string,
  input: { subscription: string; price?: string; quantity?: number },
): Promise<void> {
  const context = await openPortal(token);
  const update = context.configuration.features.subscription_update;
  requireFeature(update.enabled, 'changing plans');
  const subscription = await ownSubscription(context, input.subscription);
  const [item, ...others] = await listLiveItemsFor(getDb(), [subscription.id]);
  if (!item || others.length > 0) {
    throw new BillingEngineError(
      'portal_feature_disabled',
      'a subscription with several items changes plan through the merchant',
      'subscription',
    );
  }
  if (input.price !== undefined) {
    requireFeature(update.default_allowed_updates.includes('price'), 'changing price');
    if (!update.products.some((plan) => plan.prices.includes(input.price as string))) {
      throw invalid('this plan is not offered here', 'price');
    }
  }
  if (input.quantity !== undefined)
    requireFeature(update.default_allowed_updates.includes('quantity'), 'changing quantity');
  await updateSubscription(context.merchant, subscription.publicId, {
    items: [
      {
        id: item.publicId,
        ...(input.price ? { price: input.price } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      },
    ],
    prorationBehavior: update.proration_behavior,
  });
}

export async function portalUpdateCustomer(
  token: string,
  input: { email?: string; name?: string; phone?: string; address?: CustomerRow['address'] },
): Promise<void> {
  const context = await openPortal(token);
  const update = context.configuration.features.customer_update;
  requireFeature(update.enabled, 'editing billing details');
  for (const field of Object.keys(input) as (keyof typeof input)[]) {
    if (input[field] !== undefined && !update.allowed_updates.includes(field)) {
      throw new BillingEngineError(
        'portal_feature_disabled',
        `${field} cannot be changed here`,
        field,
      );
    }
  }
  const result = await updateCustomerFields(context.merchant, context.customer, {
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
  });
  if (result === 'missing') throw missing('customer');
}

/**
 * Begin a card update: a SetupIntent for the customer, which the portal page
 * confirms with the provider's own fields (`/v1/setup_intents/:id/client_action`
 * with the returned client secret).
 */
export async function portalStartPaymentMethodUpdate(
  token: string,
): Promise<{ setup_intent: string; client_secret: string }> {
  const context = await openPortal(token);
  const fair =
    context.customer.currency !== null && railOf(context.customer.currency) === 'faircoin';
  requireFeature(
    context.configuration.features.payment_method_update.enabled && !fair,
    'updating the payment method',
  );
  const { row } = await createSetupIntent(context.merchant, context.customer, {
    usage: 'off_session',
    description: 'Payment method update from the customer portal',
    metadata: {},
  });
  return { setup_intent: row.publicId, client_secret: row.clientSecret };
}

/**
 * Finish a card update: once the SetupIntent succeeded, its method becomes
 * the customer's default and every live subscription's.
 */
export async function portalFinishPaymentMethodUpdate(
  token: string,
  setupIntent: string,
): Promise<'succeeded' | 'pending'> {
  const context = await openPortal(token);
  requireFeature(
    context.configuration.features.payment_method_update.enabled,
    'updating the payment method',
  );
  const db = getDb();
  const found = await findSetupIntentForMerchant(db, setupIntent, context.merchant.id);
  if (!found || found.customerId !== context.customer.id)
    throw missing('setup intent', 'setup_intent');
  const row = await reconcileSetupIntent(found);
  if (row.status !== 'succeeded' || row.paymentMethodId === null) return 'pending';
  const method = await findPaymentMethodById(db, row.paymentMethodId);
  if (!method) return 'pending';
  const result = await updateCustomerFields(context.merchant, context.customer, {
    defaultPaymentMethod: method.publicId,
  });
  if (result === 'missing') throw missing('customer');
  await db.transaction(async (tx) => {
    for (const subscription of await listCustomerSubscriptions(tx, context.customer.id)) {
      if (['canceled', 'incomplete_expired'].includes(subscription.status)) continue;
      if (subscription.collectionMethod !== 'charge_automatically') continue;
      const locked = await lockSubscription(tx, subscription.id);
      if (locked) await patchSubscription(tx, locked, { defaultPaymentMethodId: method.id });
    }
  });
  kickWebhookOutbox();
  return 'succeeded';
}
