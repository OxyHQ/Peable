import { billingReturnUrl } from '@peable.to/contracts';
import type Stripe from 'stripe';
import { z } from 'zod';
import { BILLING_SUBSCRIPTION_STATUSES } from '@peable.to/shared-types';
import { STRIPE_API_VERSION } from '../providers/stripe/client';
import { BillingError, billingDeploymentSchema, type BillingDeployment } from './contracts';
import type { BillingProvider, ProviderBillingSubscription } from './provider';
import { toUnix } from '../../lib/time';

/** Unknown responses are projected with a whitelist; no raw provider payload persists. */
export interface StripeBillingClient {
  scope: 'platform';
  apiVersion: typeof STRIPE_API_VERSION;
  livemode: boolean;
  account(): Promise<unknown>;
  createCustomer(params: Stripe.CustomerCreateParams, key: string): Promise<unknown>;
  createCheckout(params: Stripe.Checkout.SessionCreateParams, key: string): Promise<unknown>;
  createPortal(params: Stripe.BillingPortal.SessionCreateParams, key: string): Promise<unknown>;
  retrieveSubscription(ref: string): Promise<unknown>;
  updateSubscription(
    ref: string,
    params: Stripe.SubscriptionUpdateParams,
    key: string,
  ): Promise<unknown>;
  retrieveCustomer(ref: string): Promise<unknown>;
  retrievePrice(ref: string): Promise<unknown>;
  retrieveCheckout(ref: string): Promise<unknown>;
  retrieveEmbeddedCheckout?(ref: string): Promise<unknown>;
  listCheckoutsForSubscription(ref: string): Promise<unknown>;
  retrieveTaxSettings?(): Promise<unknown>;
  listTaxRegistrations?(startingAfter?: string): Promise<unknown>;
  listSubscriptionInvoices?(ref: string, startingAfter?: string): Promise<unknown>;
  retrieveInvoice?(ref: string): Promise<unknown>;
  listInvoiceLines?(ref: string): Promise<unknown>;
  listInvoicePayments?(ref: string): Promise<unknown>;
  listChargeRefunds?(chargeRef: string, startingAfter?: string): Promise<unknown>;
  retrievePaidPaymentIntent?(ref: string): Promise<unknown>;
  retrievePortalConfiguration(ref: string): Promise<unknown>;
  /** Peable Tax on the card rail: a manual rate carrying the frozen tax. */
  createTaxRate?(params: Stripe.TaxRateCreateParams, key: string): Promise<unknown>;
  /** Ends a Checkout whose totals differ from the quote before anyone pays it. */
  expireCheckout?(ref: string): Promise<unknown>;
  /** Peable Tax renewals: hold or release a draft renewal invoice. */
  updateInvoice?(ref: string, params: Stripe.InvoiceUpdateParams, key: string): Promise<unknown>;
  /** Peable Tax renewals: put the fresh frozen tax on the draft's one line. */
  updateInvoiceLine?(
    invoiceRef: string,
    lineRef: string,
    params: Stripe.InvoiceUpdateLineItemParams,
    key: string,
  ): Promise<unknown>;
  /** Peable Tax renewals: the card's country is location evidence. */
  retrievePaymentMethod?(ref: string): Promise<unknown>;
  /** Peable Tax reversals: what was credited on a paid invoice. */
  listInvoiceCreditNotes?(invoiceRef: string, startingAfter?: string): Promise<unknown>;
  /** Peable Tax on the card rail: the endpoint must deliver the events it acts on. */
  retrieveWebhookEndpoint?(ref: string): Promise<unknown>;
}
const ref = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}[A-Za-z0-9]+$`))
    .max(128);
const seconds = z.number().int().nonnegative().max(8_640_000_000_000);
const subscription = z.object({
  latest_invoice: ref('in_').nullable().optional(),
  id: ref('sub_'),
  customer: ref('cus_'),
  livemode: z.boolean(),
  status: z.enum(BILLING_SUBSCRIPTION_STATUSES),
  cancel_at_period_end: z.boolean(),
  trial_end: seconds.nullable(),
  cancel_at: seconds.nullable(),
  canceled_at: seconds.nullable(),
  items: z.object({
    has_more: z.literal(false),
    data: z
      .array(
        z.object({
          current_period_start: seconds,
          current_period_end: seconds,
          price: z.object({
            id: ref('price_'),
            recurring: z.object({
              interval: z.enum(['month', 'year']),
              interval_count: z.literal(1),
            }),
          }),
          quantity: z.literal(1),
        }),
      )
      .length(1),
  }),
});
export function normalizeBillingSubscription(raw: unknown): ProviderBillingSubscription {
  const parsed = subscription.parse(raw);
  const item = parsed.items.data[0];
  if (!item || item.current_period_end <= item.current_period_start)
    throw new BillingError('invalid_provider_response', 502);
  return {
    latest_invoice_id: parsed.latest_invoice ?? null,
    provider_subscription_id: parsed.id,
    provider_customer_id: parsed.customer,
    provider_price_id: item.price.id,
    livemode: parsed.livemode,
    status: parsed.status,
    interval: item.price.recurring.interval,
    cancel_at_period_end: parsed.cancel_at_period_end,
    // Stripe already answers in Unix seconds, the wire's own unit.
    current_period_start: item.current_period_start,
    current_period_end: item.current_period_end,
    trial_ends_at: parsed.trial_end,
    cancel_at: parsed.cancel_at,
    cancelled_at: parsed.canceled_at,
  };
}
export function createStripeBillingProvider(
  deploymentInput: BillingDeployment,
  client: StripeBillingClient,
  options: { portalConfigurationRef: string; now?: () => Date; embeddedPublishableKey?: string },
): BillingProvider {
  const deployment = billingDeploymentSchema.parse(deploymentInput);
  const now = options.now ?? (() => new Date());
  const portalConfigurationRef = ref('bpc_').parse(options.portalConfigurationRef);
  async function verifyPortalConfiguration() {
    const value = z
      .object({
        id: ref('bpc_'),
        active: z.literal(true),
        livemode: z.boolean(),
        features: z.object({
          subscription_update: z.object({ enabled: z.literal(false) }),
          subscription_cancel: z.object({
            enabled: z.boolean(),
            mode: z.enum(['immediately', 'at_period_end']),
          }),
        }),
      })
      .safeParse(await client.retrievePortalConfiguration(portalConfigurationRef));
    if (!value.success) throw new BillingError('identity_conflict');
    const configuration = value.data;
    if (
      configuration.id !== portalConfigurationRef ||
      configuration.livemode !== deployment.livemode ||
      (configuration.features.subscription_cancel.enabled &&
        configuration.features.subscription_cancel.mode !== 'at_period_end')
    )
      throw new BillingError('identity_conflict');
  }
  if (
    client.scope !== 'platform' ||
    client.apiVersion !== STRIPE_API_VERSION ||
    client.livemode !== deployment.livemode
  )
    throw new BillingError('identity_conflict');
  return {
    deployment,
    verifyPortalConfiguration,
    async verifyDeployment() {
      const account = z.object({ id: ref('acct_') }).parse(await client.account());
      if (account.id !== deployment.platformAccountId) throw new BillingError('identity_conflict');
    },
    async embeddedConfiguration() {
      const publishableKey = options.embeddedPublishableKey;
      const prefix = deployment.livemode ? 'pk_live_' : 'pk_test_';
      if (!publishableKey?.startsWith(prefix)) throw new BillingError('not_found', 404);
      const account = z
        .object({
          id: z.literal(deployment.platformAccountId),
          charges_enabled: z.literal(true),
          capabilities: z.object({ card_payments: z.literal('active') }),
        })
        .parse(await client.account());
      if (!account.id) throw new BillingError('identity_conflict');
      return { publishableKey };
    },
    async retrieveEmbeddedAction(checkoutRef) {
      if (!client.retrieveEmbeddedCheckout) throw new BillingError('not_found', 404);
      const publishableKey = options.embeddedPublishableKey;
      if (!publishableKey?.startsWith(deployment.livemode ? 'pk_live_' : 'pk_test_'))
        throw new BillingError('not_found', 404);
      const session = z
        .object({
          id: z.literal(checkoutRef),
          livemode: z.literal(deployment.livemode),
          mode: z.literal('subscription'),
          ui_mode: z.enum(['custom', 'elements']),
          status: z.enum(['open', 'complete', 'expired']),
          client_secret: z.string().min(1).nullable(),
          customer: ref('cus_'),
          expires_at: seconds,
          amount_total: z.number().int().positive().safe(),
          currency: z.string().regex(/^[a-z]{3}$/),
          total_details: z.object({ amount_tax: z.number().int().nonnegative().safe() }),
          automatic_tax: z.object({ enabled: z.literal(false) }),
          line_items: z.object({
            has_more: z.literal(false),
            data: z
              .array(z.object({ quantity: z.literal(1), price: z.object({ id: ref('price_') }) }))
              .length(1),
          }),
        })
        .parse(await client.retrieveEmbeddedCheckout(checkoutRef));
      const price = session.line_items.data[0]?.price.id;
      if (
        !price ||
        (session.status === 'open' &&
          session.expires_at > toUnix(now()) &&
          !session.client_secret?.startsWith(`${checkoutRef}_secret_`))
      )
        throw new BillingError('result_expired');
      const status =
        session.status === 'open' && session.expires_at <= toUnix(now())
          ? 'expired'
          : session.status;
      return {
        status,
        amountMinorUnits: session.amount_total,
        currency: session.currency.toUpperCase(),
        action:
          status === 'open' && session.client_secret
            ? {
                kind: 'checkout_session' as const,
                provider: 'stripe' as const,
                session_id: checkoutRef,
                client_secret: session.client_secret,
                publishable_key: publishableKey,
                amount_minor_units: session.amount_total,
                currency: session.currency.toUpperCase(),
              }
            : null,
        providerCustomerId: session.customer,
        providerPriceId: price,
        livemode: session.livemode,
        expiresAt: session.expires_at,
        taxMinorUnits: session.total_details.amount_tax,
      };
    },
    async ensureCustomer(input, key) {
      const customer = z
        .object({ id: ref('cus_'), livemode: z.boolean(), deleted: z.literal(false).optional() })
        .parse(await client.createCustomer({ name: input.store_name }, key));
      return { providerCustomerId: customer.id, livemode: customer.livemode };
    },
    async createCheckoutSession(input, key) {
      if (input.tax_quote !== undefined) throw new BillingError('not_found', 404);
      const successUrl = new URL(input.return_url);
      successUrl.searchParams.set('billing', 'complete');
      const cancelUrl = new URL(input.return_url);
      cancelUrl.searchParams.set('billing', 'cancelled');
      const session = z
        .object({
          id: z
            .string()
            .regex(/^cs_(test|live)_[A-Za-z0-9]+$/)
            .max(128),
          customer: ref('cus_'),
          mode: z.literal('subscription'),
          livemode: z.boolean(),
          url: billingReturnUrl,
          expires_at: seconds,
        })
        .parse(
          await client.createCheckout(
            {
              mode: 'subscription',
              // Peable's bound price owns the settlement currency, not visitor location.
              adaptive_pricing: { enabled: false },
              customer: input.provider_customer_id,
              line_items: [{ price: input.provider_price_id, quantity: 1 }],
              ...(input.trial_days > 0
                ? { subscription_data: { trial_period_days: input.trial_days } }
                : {}),
              success_url: successUrl.toString(),
              cancel_url: cancelUrl.toString(),
            },
            key,
          ),
        );
      if (session.id.startsWith('cs_live_') !== session.livemode)
        throw new BillingError('identity_conflict');
      return {
        providerObjectRef: session.id,
        providerCustomerId: session.customer,
        livemode: session.livemode,
        url: session.url,
        expiresAt: session.expires_at,
      };
    },
    async createPortalSession(input, key) {
      await verifyPortalConfiguration();
      const session = z
        .object({
          id: ref('bps_'),
          customer: ref('cus_'),
          configuration: z.literal(portalConfigurationRef),
          on_behalf_of: z.null(),
          livemode: z.boolean(),
          url: billingReturnUrl,
        })
        .parse(
          await client.createPortal(
            {
              customer: input.provider_customer_id,
              return_url: input.return_url,
              configuration: portalConfigurationRef,
            },
            key,
          ),
        );
      await verifyPortalConfiguration();
      // Stripe does not expose portal expiry. This is a gateway handoff/replay
      // deadline, not a promise that the provider URL remains valid until then.
      return {
        providerObjectRef: session.id,
        providerCustomerId: session.customer,
        livemode: session.livemode,
        url: session.url,
        expiresAt: toUnix(new Date(now().getTime() + 60_000)),
      };
    },
    async retrieveSubscription(id) {
      return normalizeBillingSubscription(await client.retrieveSubscription(id));
    },
    async cancelAtPeriodEnd(id, key) {
      return normalizeBillingSubscription(
        await client.updateSubscription(id, { cancel_at_period_end: true }, key),
      );
    },
  };
}
