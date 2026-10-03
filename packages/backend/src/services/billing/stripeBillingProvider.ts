import type Stripe from 'stripe';
import { z } from 'zod';
import { BILLING_SUBSCRIPTION_STATUSES } from '@peable.to/shared-types';
import { STRIPE_API_VERSION, stripeBillingClient } from '../providers/stripe/client';
import { BillingError, billingDeploymentSchema, billingReturnUrl, type BillingDeployment } from './contracts';
import type { BillingProvider, ProviderBillingSubscription } from './provider';

/** Unknown responses are projected with a whitelist; no raw provider payload persists. */
export interface StripeBillingClient {
  scope: 'platform'; apiVersion: typeof STRIPE_API_VERSION; livemode: boolean;
  account(): Promise<unknown>;
  createCustomer(params: Stripe.CustomerCreateParams, key: string): Promise<unknown>;
  createCheckout(params: Stripe.Checkout.SessionCreateParams, key: string): Promise<unknown>;
  createPortal(params: Stripe.BillingPortal.SessionCreateParams, key: string): Promise<unknown>;
  retrieveSubscription(ref: string): Promise<unknown>;
  updateSubscription(ref: string, params: Stripe.SubscriptionUpdateParams, key: string): Promise<unknown>;
  retrieveCustomer(ref: string): Promise<unknown>;
  retrievePrice(ref: string): Promise<unknown>;
  retrieveCheckout(ref: string): Promise<unknown>;
  listCheckoutsForSubscription(ref: string): Promise<unknown>;
  retrievePortalConfiguration(ref: string): Promise<unknown>;
}
const ref = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9]+$`)).max(128);
const seconds = z.number().int().nonnegative().max(8_640_000_000_000);
const subscription = z.object({ id: ref('sub_'), customer: ref('cus_'), livemode: z.boolean(), status: z.enum(BILLING_SUBSCRIPTION_STATUSES),
  cancel_at_period_end: z.boolean(), trial_end: seconds.nullable(), cancel_at: seconds.nullable(), canceled_at: seconds.nullable(),
  items: z.object({ has_more: z.literal(false), data: z.array(z.object({
    current_period_start: seconds, current_period_end: seconds,
    price: z.object({ id: ref('price_'), recurring: z.object({ interval: z.enum(['month', 'year']), interval_count: z.literal(1) }) }),
    quantity: z.literal(1),
  })).length(1) }),
});
function iso(value: number | null) { return value === null ? null : new Date(value * 1000).toISOString(); }
export function normalizeBillingSubscription(raw: unknown): ProviderBillingSubscription {
  const parsed = subscription.parse(raw); const item = parsed.items.data[0];
  if (!item || item.current_period_end <= item.current_period_start) throw new BillingError('invalid_provider_response', 502);
  return { providerSubscriptionId: parsed.id, providerCustomerId: parsed.customer, providerPriceId: item.price.id, livemode: parsed.livemode,
    status: parsed.status, interval: item.price.recurring.interval, cancelAtPeriodEnd: parsed.cancel_at_period_end,
    currentPeriodStart: new Date(item.current_period_start * 1000).toISOString(), currentPeriodEnd: new Date(item.current_period_end * 1000).toISOString(),
    trialEndsAt: iso(parsed.trial_end), cancelAt: iso(parsed.cancel_at), cancelledAt: iso(parsed.canceled_at) };
}
export function createStripeBillingProvider(deploymentInput: BillingDeployment, client: StripeBillingClient = stripeBillingClient(), options: { portalConfigurationRef: string; now?: () => Date }): BillingProvider {
  const deployment = billingDeploymentSchema.parse(deploymentInput);
  const now = options.now ?? (() => new Date());
  const portalConfigurationRef = ref('bpc_').parse(options.portalConfigurationRef);
  async function verifyPortalConfiguration() {
    const value = z.object({ id: ref('bpc_'), active: z.literal(true), livemode: z.boolean(),
      features: z.object({ subscription_update: z.object({ enabled: z.literal(false) }),
        subscription_cancel: z.object({ enabled: z.boolean(), mode: z.enum(['immediately', 'at_period_end']) }) })
    }).safeParse(await client.retrievePortalConfiguration(portalConfigurationRef));
    if (!value.success) throw new BillingError('identity_conflict');
    const configuration = value.data;
    if (configuration.id !== portalConfigurationRef || configuration.livemode !== deployment.livemode
      || configuration.features.subscription_cancel.enabled && configuration.features.subscription_cancel.mode !== 'at_period_end') throw new BillingError('identity_conflict');
  }
  if (client.scope !== 'platform' || client.apiVersion !== STRIPE_API_VERSION || client.livemode !== deployment.livemode) throw new BillingError('identity_conflict');
  return {
    deployment,
    verifyPortalConfiguration,
    async verifyDeployment() {
      const account = z.object({ id: ref('acct_') }).parse(await client.account());
      if (account.id !== deployment.platformAccountId) throw new BillingError('identity_conflict');
    },
    async ensureCustomer(input, key) {
      const customer = z.object({ id: ref('cus_'), livemode: z.boolean(), deleted: z.literal(false).optional() }).parse(await client.createCustomer({ name: input.storeName }, key));
      return { providerCustomerId: customer.id, livemode: customer.livemode };
    },
    async createCheckoutSession(input, key) {
      const successUrl = new URL(input.returnUrl); successUrl.searchParams.set('billing', 'complete');
      const cancelUrl = new URL(input.returnUrl); cancelUrl.searchParams.set('billing', 'cancelled');
      const session = z.object({ id: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/).max(128), customer: ref('cus_'), mode: z.literal('subscription'), livemode: z.boolean(), url: billingReturnUrl, expires_at: seconds }).parse(await client.createCheckout({
        mode: 'subscription', customer: input.providerCustomerId, line_items: [{ price: input.providerPriceId, quantity: 1 }],
        ...(input.trialDays > 0 ? { subscription_data: { trial_period_days: input.trialDays } } : {}),
        success_url: successUrl.toString(), cancel_url: cancelUrl.toString(),
      }, key));
      if (session.id.startsWith('cs_live_') !== session.livemode) throw new BillingError('identity_conflict');
      return { providerObjectRef: session.id, providerCustomerId: session.customer, livemode: session.livemode, url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString() };
    },
    async createPortalSession(input, key) {
      await verifyPortalConfiguration();
      const session = z.object({ id: ref('bps_'), customer: ref('cus_'), configuration: z.literal(portalConfigurationRef), on_behalf_of: z.null(), livemode: z.boolean(), url: billingReturnUrl }).parse(await client.createPortal({ customer: input.providerCustomerId, return_url: input.returnUrl, configuration: portalConfigurationRef }, key));
      await verifyPortalConfiguration();
      // Stripe does not expose portal expiry. This is a gateway handoff/replay
      // deadline, not a promise that the provider URL remains valid until then.
      return { providerObjectRef: session.id, providerCustomerId: session.customer, livemode: session.livemode, url: session.url, expiresAt: new Date(now().getTime() + 60_000).toISOString() };
    },
    async retrieveSubscription(id) { return normalizeBillingSubscription(await client.retrieveSubscription(id)); },
    async cancelAtPeriodEnd(id, key) { return normalizeBillingSubscription(await client.updateSubscription(id, { cancel_at_period_end: true }, key)); },
  };
}
