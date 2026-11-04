/**
 * Moving each Stripe-Billing proxy subscription onto a native one (ADR 0018
 * §7), one subscription at a time, idempotently and resumably.
 *
 * ## The order, and what a crash between two steps leaves
 *
 * 1. **Plan** (reads only): the binding, Stripe's subscription, customer,
 *    price, invoices and card, the Orbit price it maps to, Peable Tax
 *    readiness. Anything that cannot be moved exactly is `blocked` with its
 *    reason and left alone — never guessed.
 * 2. **Adopt** (one transaction): the Orbit customer bound to the SAME Stripe
 *    customer (found by its binding, else created with it — no new provider
 *    customer), the SAME Stripe card registered as its `pm_…`, the native
 *    subscription in its current state with no invoice (`adoptSubscription`)
 *    and this record, `adopted`. The native subscription is HELD: Stripe still
 *    holds renewal authority and the engine does nothing with it. Access is
 *    native from this commit (its entitlements are active).
 *    *Crash before the commit:* nothing was written; the next run plans again.
 *    *Crash after it:* Stripe still renews and the engine cannot — one biller,
 *    access unchanged. The next run resumes from step 3.
 * 3. **Release at Stripe**: `cancel_at_period_end: true`, collection paused
 *    with `void` (so even a subscriber who later undoes the cancellation in a
 *    Stripe portal session opened before the migration is never charged
 *    again), `proration_behavior: none` (no refund, no charge) and the native
 *    id in metadata — under an idempotency key derived from this record and
 *    the period. If Stripe renewed while the record waited (a crash left it
 *    past the period end), the held subscription is first realigned onto the
 *    period Stripe billed; if Stripe ended it without this release, the record
 *    stays `adopted` as an anomaly for an operator.
 *    *Crash after Stripe answered:* the next run reads the release back from
 *    Stripe (the flags and the marker) and continues at step 4.
 * 4. **Release natively** (one transaction): the hold is cleared and the
 *    record moves to `released` (compare-and-swap). The engine renews at the
 *    period end, off-session against the adopted card; a period end that
 *    passed while the release waited renews at the next pass — late, never
 *    twice, never missed.
 *
 * A `released` record is re-verified on every run until Stripe's period has
 * ended: a release that was undone at Stripe is reported and re-asserted.
 *
 * A dry run is the same planner over a READ-ONLY transaction and a provider
 * that holds only reads: it cannot write either side.
 */
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Address } from '@peable.to/shared-types';
import type { CustomerRow } from '../../db/customers/customerRepository';
import {
  findCustomerByProviderBinding,
  insertCustomer,
  insertCustomerBinding,
  updateCustomer,
} from '../../db/customers/customerRepository';
import { findPriceForMerchant, type PriceRow } from '../../db/catalog/priceRepository';
import { findMerchantById, type MerchantRow } from '../../db/merchants/merchantRepository';
import { findBillingTaxCheckoutSnapshot } from '../../db/billing/billingRepository';
import {
  findProxyMigrationForBinding,
  insertProxyMigration,
  listProxySubscriptionBindings,
  markProxyMigrationReleased,
  merchantTaxActive,
  type ProxyMigrationRow,
  type ProxySubscriptionBinding,
} from '../../db/billing/proxyMigrationRepository';
import { findSubscriptionById } from '../../db/billingEngine/subscriptionRepository';
import type { Database, DatabaseOrTransaction } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toCustomerDTO } from '../../lib/serialize';
import { fromUnix, toUnix } from '../../lib/time';
import {
  adoptSubscription,
  realignHeldPeriod,
  releaseProviderHandoff,
} from '../billingEngine/adoption';
import { nextBoundaryAfter } from '../billingEngine/periods';
import { engineNow } from '../billingEngine/runtime';
import { registerProviderPaymentMethod } from '../customers/paymentMethodService';
import { recordCustomerObjectEvent } from '../intentTransition';
import type { ProviderPaymentMethodSnapshot } from '../providers/provider';
import { kickWebhookOutbox } from '../webhookOutbox';

/** A subscription whose period ends sooner than this is left for after Stripe's renewal. */
export const DEFAULT_PROXY_MIGRATION_LEAD_MS = 48 * 3600_000;

/** What the planner reads at Stripe. No method here changes anything. */
export interface ProxyMigrationReader {
  readonly livemode: boolean;
  account(): Promise<unknown>;
  retrieveSubscription(ref: string): Promise<unknown>;
  retrieveCustomer(ref: string): Promise<unknown>;
  retrievePrice(ref: string): Promise<unknown>;
  listSubscriptionInvoices(ref: string, startingAfter?: string): Promise<unknown>;
  /** The card provider's own snapshot of a saved card (never its number). */
  readPaymentMethod(ref: string): Promise<ProviderPaymentMethodSnapshot>;
}

/** The executor's provider: the reads, and the ONE write — releasing a subscription. */
export interface ProxyMigrationProvider extends ProxyMigrationReader {
  updateSubscription(
    ref: string,
    params: Stripe.SubscriptionUpdateParams,
    key: string,
  ): Promise<unknown>;
}

/** The reads of a provider and nothing else: what a dry run is given. */
export function readsOnly(provider: ProxyMigrationReader): ProxyMigrationReader {
  return {
    livemode: provider.livemode,
    account: () => provider.account(),
    retrieveSubscription: (ref) => provider.retrieveSubscription(ref),
    retrieveCustomer: (ref) => provider.retrieveCustomer(ref),
    retrievePrice: (ref) => provider.retrievePrice(ref),
    listSubscriptionInvoices: (ref, after) => provider.listSubscriptionInvoices(ref, after),
    readPaymentMethod: (ref) => provider.readPaymentMethod(ref),
  };
}

/** Per merchant (`merch_…`): each bound Stripe price → the Orbit `price_…` of the same offer. */
export const proxyMigrationPlanSchema = z
  .object({
    cohorts: z.record(
      z.string().regex(/^merch_[A-Za-z0-9]+$/),
      z
        .object({
          prices: z.record(
            z.string().regex(/^price_[A-Za-z0-9]+$/),
            z.string().regex(/^price_[A-Za-z0-9]+$/),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type ProxyMigrationPlan = z.infer<typeof proxyMigrationPlanSchema>;

// ---- Stripe's answers, read with a whitelist ---------------------------------------

const seconds = z.number().int().nonnegative();
const ref = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_]+$`));
const stripeSubscriptionSchema = z.object({
  id: ref('sub_'),
  customer: ref('cus_'),
  livemode: z.boolean(),
  status: z.string(),
  cancel_at_period_end: z.boolean(),
  cancel_at: seconds.nullable(),
  ended_at: seconds.nullable().optional(),
  start_date: seconds,
  billing_cycle_anchor: seconds,
  trial_start: seconds.nullable(),
  trial_end: seconds.nullable(),
  default_payment_method: z.string().nullable(),
  discounts: z.array(z.unknown()).optional(),
  pause_collection: z.object({ behavior: z.string() }).nullable().optional(),
  automatic_tax: z.object({ enabled: z.boolean() }).optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  items: z.object({
    has_more: z.boolean(),
    data: z.array(
      z.object({
        price: z.object({ id: ref('price_') }),
        quantity: z.number().int().optional(),
        current_period_start: seconds,
        current_period_end: seconds,
      }),
    ),
  }),
});
type StripeSubscription = z.infer<typeof stripeSubscriptionSchema>;
const stripeCustomerSchema = z.object({
  id: ref('cus_'),
  deleted: z.literal(true).optional(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  address: z
    .object({
      line1: z.string().nullable(),
      line2: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      postal_code: z.string().nullable(),
      country: z.string().nullable(),
    })
    .nullable()
    .optional(),
  invoice_settings: z.object({ default_payment_method: z.string().nullable() }).optional(),
});
type StripeCustomer = z.infer<typeof stripeCustomerSchema>;
const stripePriceSchema = z.object({
  id: ref('price_'),
  currency: z.string(),
  unit_amount: z.number().int().nonnegative().nullable(),
  billing_scheme: z.string(),
  type: z.string(),
  tax_behavior: z.string().nullable().optional(),
  recurring: z
    .object({ interval: z.string(), interval_count: z.number().int(), usage_type: z.string() })
    .nullable(),
});
const stripeInvoicePageSchema = z.object({
  has_more: z.boolean(),
  data: z.array(z.object({ id: z.string(), status: z.string().nullable() })),
});

/** The marker the release writes into the Stripe subscription's metadata. */
export const RELEASE_MARKER = 'orbit_subscription';

function releasedAtStripe(sub: StripeSubscription, nativePublicId: string): boolean {
  return (
    sub.cancel_at_period_end &&
    sub.pause_collection?.behavior === 'void' &&
    sub.metadata[RELEASE_MARKER] === nativePublicId
  );
}

function onlyItem(sub: StripeSubscription) {
  if (sub.items.has_more || sub.items.data.length !== 1) return null;
  return sub.items.data[0] ?? null;
}

// ---- The plan -----------------------------------------------------------------------

export type ProxyMigrationAction = 'migrate' | 'resume' | 'released' | 'skip' | 'blocked';

/** What the adoption of one subscription will write — decided by the planner. */
interface Adoption {
  readonly merchant: MerchantRow;
  readonly stripe: StripeSubscription;
  readonly stripeCustomer: StripeCustomer;
  readonly card: ProviderPaymentMethodSnapshot;
  readonly price: PriceRow;
  readonly customer: CustomerRow | null;
  readonly automaticTax: boolean;
  readonly status: 'active' | 'trialing';
  readonly periodStart: number;
  readonly periodEnd: number;
}

export interface PlannedSubscription {
  readonly binding: ProxySubscriptionBinding;
  readonly action: ProxyMigrationAction;
  readonly reason?: string;
  readonly migration?: ProxyMigrationRow;
  readonly adoption?: Adoption;
}

/** One line of the report — public ids and Stripe's subscription id; no personal data. */
export interface ProxyMigrationReportLine {
  readonly binding: string;
  readonly provider_subscription: string;
  readonly plan_id: string;
  readonly action: ProxyMigrationAction;
  readonly reason?: string;
  readonly customer?: string;
  readonly price?: string;
  readonly subscription?: string;
  readonly status?: string;
  readonly current_period_end?: number;
  readonly automatic_tax?: boolean;
  readonly outcome?: string;
}

export interface ProxyMigrationCohortReport {
  readonly merchant: string;
  readonly environment: string;
  readonly livemode: boolean;
  readonly counts: Record<ProxyMigrationAction, number>;
  readonly blocked: Record<string, number>;
  readonly subscriptions: ProxyMigrationReportLine[];
}

export interface ProxyMigrationOptions {
  readonly db: Database;
  readonly livemode: boolean;
  /** Absent when this mode has no Stripe key: every subscription is then blocked. */
  readonly provider?: ProxyMigrationReader | undefined;
  readonly plan: ProxyMigrationPlan;
  /** Only this cohort (`merch_…`). */
  readonly cohort?: string | undefined;
  readonly leadMs?: number;
  /** The wall clock (a test passes one); a clocked customer's own clock still wins. */
  readonly now?: () => Date;
}

const blocked = (binding: ProxySubscriptionBinding, reason: string): PlannedSubscription => ({
  binding,
  action: 'blocked',
  reason,
});

async function readStripe<T>(schema: z.ZodType<T>, read: () => Promise<unknown>): Promise<T> {
  return schema.parse(await read());
}

/**
 * Plan every proxied subscription of the mode. `db` may be a read-only
 * transaction: the planner only reads.
 */
export async function planProxyMigration(
  db: DatabaseOrTransaction,
  options: Omit<ProxyMigrationOptions, 'db'>,
): Promise<PlannedSubscription[]> {
  const leadMs = options.leadMs ?? DEFAULT_PROXY_MIGRATION_LEAD_MS;
  const wall = options.now ?? (() => new Date());
  const bindings = (await listProxySubscriptionBindings(db, options.livemode)).filter(
    (binding) => options.cohort === undefined || binding.merchantPublicId === options.cohort,
  );
  // The platform account the key reaches, read once per run.
  let accountId: Promise<string | null> | undefined;
  const account = (provider: ProxyMigrationReader) => {
    accountId ??= provider.account().then(
      (raw) => z.object({ id: z.string() }).parse(raw).id,
      () => null,
    );
    return accountId;
  };
  const planned: PlannedSubscription[] = [];
  for (const binding of bindings) {
    planned.push(await planOne(db, options, binding, { leadMs, wall, account }));
  }
  return planned;
}

async function planOne(
  db: DatabaseOrTransaction,
  options: Omit<ProxyMigrationOptions, 'db'>,
  binding: ProxySubscriptionBinding,
  context: {
    leadMs: number;
    wall: () => Date;
    account: (provider: ProxyMigrationReader) => Promise<string | null>;
  },
): Promise<PlannedSubscription> {
  const migration = await findProxyMigrationForBinding(db, binding.id);
  if (migration) {
    return {
      binding,
      action: migration.state === 'adopted' ? 'resume' : 'released',
      migration,
    };
  }
  const provider = options.provider;
  if (!provider) return blocked(binding, 'provider_key_missing');
  if (provider.livemode !== binding.livemode) return blocked(binding, 'mode_mismatch');
  if ((await context.account(provider)) !== binding.platformAccountId)
    return blocked(binding, 'platform_account_mismatch');
  const merchant = await findMerchantById(db, binding.merchantId);
  if (!merchant || merchant.livemode !== binding.livemode)
    return blocked(binding, 'merchant_mismatch');

  let stripe: StripeSubscription;
  try {
    stripe = await readStripe(stripeSubscriptionSchema, () =>
      provider.retrieveSubscription(binding.providerRef),
    );
  } catch {
    return blocked(binding, 'provider_subscription_unreadable');
  }
  if (stripe.livemode !== binding.livemode || stripe.customer !== binding.providerCustomerRef)
    return blocked(binding, 'identity_conflict');
  if (stripe.status === 'canceled' || stripe.status === 'incomplete_expired')
    return { binding, action: 'skip', reason: 'ended' };
  if (stripe.status !== 'active' && stripe.status !== 'trialing')
    return blocked(binding, `status_${stripe.status}`);
  const item = onlyItem(stripe);
  if (!item || (item.quantity ?? 1) !== 1) return blocked(binding, 'items');
  if (item.price.id !== binding.providerPriceRef) return blocked(binding, 'price_changed');
  if ((stripe.discounts?.length ?? 0) > 0) return blocked(binding, 'discount');
  if (stripe.pause_collection) return blocked(binding, 'collection_paused');
  if (stripe.cancel_at !== null && !stripe.cancel_at_period_end)
    return blocked(binding, 'cancel_at');

  // A renewal in progress (a held ADR 0013 draft, an unpaid invoice) is
  // resolved at Stripe first.
  try {
    const page = await readStripe(stripeInvoicePageSchema, () =>
      provider.listSubscriptionInvoices(binding.providerRef),
    );
    if (
      page.data.some((invoice) => ['draft', 'open', 'uncollectible'].includes(invoice.status ?? ''))
    )
      return blocked(binding, 'open_invoice');
  } catch {
    return blocked(binding, 'provider_invoices_unreadable');
  }

  let stripeCustomer: StripeCustomer;
  try {
    stripeCustomer = await readStripe(stripeCustomerSchema, () =>
      provider.retrieveCustomer(binding.providerCustomerRef),
    );
  } catch {
    return blocked(binding, 'provider_customer_unreadable');
  }
  if (stripeCustomer.deleted) return blocked(binding, 'provider_customer_deleted');
  const cardRef =
    stripe.default_payment_method ??
    stripeCustomer.invoice_settings?.default_payment_method ??
    null;
  if (!cardRef) return blocked(binding, 'no_payment_method');
  let card: ProviderPaymentMethodSnapshot;
  try {
    card = await provider.readPaymentMethod(cardRef);
  } catch {
    return blocked(binding, 'card_rail_unavailable');
  }
  if (card.customerObjectId !== binding.providerCustomerRef)
    return blocked(binding, 'payment_method_not_attached');

  // The Orbit price of the same offer, exactly.
  const target = options.plan.cohorts[binding.merchantPublicId]?.prices[binding.providerPriceRef];
  if (!target) return blocked(binding, 'price_unmapped');
  const price = await findPriceForMerchant(db, target, merchant.id);
  if (!price) return blocked(binding, 'price_missing');
  let stripePrice: z.infer<typeof stripePriceSchema>;
  try {
    stripePrice = await readStripe(stripePriceSchema, () =>
      provider.retrievePrice(binding.providerPriceRef),
    );
  } catch {
    return blocked(binding, 'provider_price_unreadable');
  }
  const mismatch = priceMismatch(stripePrice, price);
  if (mismatch) return blocked(binding, `price_mismatch_${mismatch}`);

  // The customer: the one bound to this Stripe customer, or a new one.
  const customer = await findCustomerByProviderBinding(db, 'stripe', binding.providerCustomerRef);
  if (customer && customer.merchantId !== merchant.id) return blocked(binding, 'customer_conflict');
  if (customer?.deletedAt) return blocked(binding, 'customer_deleted');
  if (customer?.currency && customer.currency !== price.currency)
    return blocked(binding, 'customer_currency_mismatch');

  // Tax: a subscription Peable Tax priced keeps being priced by it, which
  // needs approved settings and the payer's billing address as evidence.
  let quoted: boolean;
  try {
    quoted =
      (await findBillingTaxCheckoutSnapshot(
        db,
        {
          provider: 'stripe',
          platformAccountId: binding.platformAccountId,
          livemode: binding.livemode,
        },
        {
          merchantId: binding.merchantId,
          oxyAppId: binding.oxyAppId,
          environment: merchant.environment,
        },
        binding.bindingEvidenceRef,
      )) !== null;
  } catch {
    return blocked(binding, 'tax_evidence_conflict');
  }
  const automaticTax = quoted || stripe.automatic_tax?.enabled === true;
  if (automaticTax && !(await merchantTaxActive(db, merchant.id)))
    return blocked(binding, 'tax_settings_not_active');
  if (automaticTax && !(customer?.address?.country ?? stripeCustomer.address?.country))
    return blocked(binding, 'tax_location_missing');

  // The period the engine would compute is the one Stripe billed.
  const status = stripe.status as 'active' | 'trialing';
  const periodStart = item.current_period_start;
  const periodEnd = item.current_period_end;
  // Too close to Stripe's renewal: left for after it, so a crash cannot strand
  // the hold across a period end.
  const now = customer ? await engineNow(db, customer.testClockId) : context.wall();
  if (periodEnd * 1000 - now.getTime() < context.leadMs)
    return blocked(binding, 'period_ends_soon');
  if (periodStart * 1000 > now.getTime()) return blocked(binding, 'period_not_started');
  if (status === 'trialing' && stripe.trial_end !== periodEnd)
    return blocked(binding, 'trial_period');
  if (
    status === 'active' &&
    price.recurringInterval !== null &&
    price.recurringIntervalCount !== null &&
    toUnix(
      nextBoundaryAfter(
        fromUnix(stripe.billing_cycle_anchor),
        { interval: price.recurringInterval, intervalCount: price.recurringIntervalCount },
        fromUnix(periodStart),
      ),
    ) !== periodEnd
  )
    return blocked(binding, 'period_mismatch');

  return {
    binding,
    action: 'migrate',
    adoption: {
      merchant,
      stripe,
      stripeCustomer,
      card,
      price,
      customer,
      automaticTax,
      status,
      periodStart,
      periodEnd,
    },
  };
}

/** The first field where the Orbit price would not charge what the Stripe price charged. */
function priceMismatch(stripe: z.infer<typeof stripePriceSchema>, price: PriceRow): string | null {
  if (stripe.type !== 'recurring' || price.type !== 'recurring') return 'type';
  if (stripe.currency.toUpperCase() !== price.currency) return 'currency';
  if (stripe.billing_scheme !== 'per_unit' || price.billingScheme !== 'per_unit')
    return 'billing_scheme';
  if (stripe.unit_amount === null || String(stripe.unit_amount) !== price.unitAmount)
    return 'unit_amount';
  if (
    stripe.recurring?.interval !== price.recurringInterval ||
    stripe.recurring?.interval_count !== price.recurringIntervalCount
  )
    return 'interval';
  if (stripe.recurring?.usage_type !== 'licensed' || price.recurringUsageType !== 'licensed')
    return 'usage_type';
  if ((stripe.tax_behavior ?? 'unspecified') !== price.taxBehavior) return 'tax_behavior';
  if (price.transformQuantityDivideBy !== null) return 'transform_quantity';
  return null;
}

// ---- Executing ----------------------------------------------------------------------

function addressOf(customer: StripeCustomer): Address | null {
  const a = customer.address;
  if (!a?.country) return null;
  return {
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    postal_code: a.postal_code,
    country: a.country,
  };
}

/** Step 2: the customer, its card, the held native subscription and the record — one transaction. */
async function adopt(db: Database, planned: PlannedSubscription): Promise<ProxyMigrationRow> {
  const { binding } = planned;
  const a = planned.adoption;
  if (!a) throw new Error('adopting an unplanned subscription');
  await db.transaction(async (tx) => {
    let customer = await findCustomerByProviderBinding(tx, 'stripe', binding.providerCustomerRef);
    if (!customer) {
      customer = await insertCustomer(tx, {
        publicId: newId('cus'),
        merchantId: a.merchant.id,
        email: a.stripeCustomer.email ?? null,
        name: a.stripeCustomer.name ?? null,
        address: addressOf(a.stripeCustomer),
        // The consumer's own reference, so it can find the customer that
        // replaced its proxy customer (`metadata['store_id']` search).
        metadata: { store_id: binding.storeRef },
      });
      await insertCustomerBinding(tx, {
        customerId: customer.id,
        provider: 'stripe',
        providerObjectId: binding.providerCustomerRef,
      });
      await recordCustomerObjectEvent(
        tx,
        a.merchant.id,
        'customer.created',
        toCustomerDTO(customer),
      );
    } else if (customer.merchantId !== a.merchant.id) {
      throw new Error('the Stripe customer is bound to another merchant');
    }
    const { row: method } = await registerProviderPaymentMethod(tx, {
      merchantId: a.merchant.id,
      customerId: customer.id,
      provider: 'stripe',
      snapshot: a.card,
    });
    if (method.customerId !== customer.id) {
      throw new Error('the Stripe card is registered to another customer');
    }
    if (customer.defaultPaymentMethodId === null) {
      const updated = await updateCustomer(tx, customer.publicId, a.merchant.id, {
        defaultPaymentMethodId: method.id,
      });
      if (typeof updated === 'string') throw new Error('the adopted customer vanished');
      customer = updated;
      await recordCustomerObjectEvent(
        tx,
        a.merchant.id,
        'customer.updated',
        toCustomerDTO(customer),
      );
    }
    const subscription = await adoptSubscription(tx, {
      merchant: a.merchant,
      customer,
      price: a.price,
      defaultPaymentMethodId: method.id,
      status: a.status,
      startDate: fromUnix(a.stripe.start_date),
      billingCycleAnchor: fromUnix(a.stripe.billing_cycle_anchor),
      currentPeriodStart: fromUnix(a.periodStart),
      currentPeriodEnd: fromUnix(a.periodEnd),
      trialStart: a.stripe.trial_start === null ? null : fromUnix(a.stripe.trial_start),
      trialEnd: a.stripe.trial_end === null ? null : fromUnix(a.stripe.trial_end),
      cancelAtPeriodEnd: a.stripe.cancel_at_period_end,
      automaticTax: a.automaticTax,
      metadata: { store_id: binding.storeRef, plan_id: binding.planRef },
    });
    await insertProxyMigration(tx, {
      merchantId: a.merchant.id,
      livemode: binding.livemode,
      subscriptionBindingId: binding.id,
      customerBindingId: binding.customerBindingId,
      providerSubscriptionRef: binding.providerRef,
      customerId: customer.id,
      paymentMethodId: method.id,
      priceId: a.price.id,
      subscriptionId: subscription.id,
      adoptedAt: await engineNow(tx, customer.testClockId),
    });
  });
  kickWebhookOutbox();
  const migration = await findProxyMigrationForBinding(db, binding.id);
  if (!migration) throw new Error('the adoption committed no record');
  return migration;
}

function releaseKey(migration: ProxyMigrationRow, periodStart: number, attempt: string): string {
  const digest = createHash('sha256')
    .update(`${migration.id}:${periodStart}:${attempt}`)
    .digest('hex')
    .slice(0, 32);
  return `orbit-adoption-${digest}`;
}

const RELEASE_PARAMS = (nativePublicId: string): Stripe.SubscriptionUpdateParams => ({
  cancel_at_period_end: true,
  pause_collection: { behavior: 'void' },
  proration_behavior: 'none',
  metadata: { [RELEASE_MARKER]: nativePublicId },
});

export class ProxyMigrationAnomaly extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ProxyMigrationAnomaly';
  }
}

/** Steps 3 and 4 for an `adopted` record. */
async function release(
  db: Database,
  provider: ProxyMigrationProvider,
  migration: ProxyMigrationRow,
): Promise<'released' | 'realigned_and_released'> {
  const native = await findSubscriptionById(db, migration.subscriptionId);
  if (!native) throw new Error('the adopted subscription vanished');
  let stripe = stripeSubscriptionSchema.parse(
    await provider.retrieveSubscription(migration.providerSubscriptionRef),
  );
  let realign: { status: 'active' | 'trialing'; start: number; end: number } | null = null;
  if (stripe.status === 'canceled' || stripe.status === 'incomplete_expired') {
    // Our release ended it at the period end; anything earlier is someone else's.
    const endedAt = stripe.ended_at ?? 0;
    if (
      !(
        stripe.metadata[RELEASE_MARKER] === native.publicId &&
        endedAt >= toUnix(native.currentPeriodEnd)
      )
    )
      throw new ProxyMigrationAnomaly('provider_ended_early');
  } else {
    if (stripe.status !== 'active' && stripe.status !== 'trialing')
      throw new ProxyMigrationAnomaly(`provider_status_${stripe.status}`);
    const item = onlyItem(stripe);
    if (!item) throw new ProxyMigrationAnomaly('items');
    if (item.current_period_start > toUnix(native.currentPeriodStart)) {
      realign = {
        status: stripe.status,
        start: item.current_period_start,
        end: item.current_period_end,
      };
    }
    if (!releasedAtStripe(stripe, native.publicId)) {
      stripe = stripeSubscriptionSchema.parse(
        await provider.updateSubscription(
          migration.providerSubscriptionRef,
          RELEASE_PARAMS(native.publicId),
          releaseKey(migration, item.current_period_start, 'release'),
        ),
      );
      const after = onlyItem(stripe);
      if (
        !releasedAtStripe(stripe, native.publicId) ||
        after?.current_period_start !== item.current_period_start ||
        after.current_period_end !== item.current_period_end
      )
        throw new ProxyMigrationAnomaly('provider_release_unconfirmed');
    }
  }
  await db.transaction(async (tx) => {
    if (realign) {
      await realignHeldPeriod(tx, native.id, {
        status: realign.status,
        currentPeriodStart: fromUnix(realign.start),
        currentPeriodEnd: fromUnix(realign.end),
      });
    }
    await releaseProviderHandoff(tx, native.id);
    const at = await engineNow(tx, native.testClockId);
    if (!(await markProxyMigrationReleased(tx, migration.id, at))) {
      throw new Error('another run released this migration');
    }
  });
  kickWebhookOutbox();
  return realign ? 'realigned_and_released' : 'released';
}

/**
 * A `released` record: Stripe must still be set not to renew until its
 * period has ended. `reassert` (the executor) puts the release back.
 */
async function verify(
  db: DatabaseOrTransaction,
  provider: ProxyMigrationReader | ProxyMigrationProvider,
  migration: ProxyMigrationRow,
  reassert: boolean,
  now: Date,
): Promise<string> {
  const native = await findSubscriptionById(db, migration.subscriptionId);
  if (!native) return 'native_missing';
  const stripe = stripeSubscriptionSchema.parse(
    await provider.retrieveSubscription(migration.providerSubscriptionRef),
  );
  if (stripe.status === 'canceled' || stripe.status === 'incomplete_expired')
    return 'provider_ended';
  if (releasedAtStripe(stripe, native.publicId)) return 'verified';
  const item = onlyItem(stripe);
  if (!reassert || !('updateSubscription' in provider) || !item) return 'provider_release_reverted';
  await provider.updateSubscription(
    migration.providerSubscriptionRef,
    RELEASE_PARAMS(native.publicId),
    releaseKey(
      migration,
      item.current_period_start,
      `reassert:${Math.floor(now.getTime() / 3600_000)}`,
    ),
  );
  return 'reasserted';
}

// ---- The run ------------------------------------------------------------------------

export interface ProxyMigrationRun {
  readonly mode: 'live' | 'test';
  readonly dry_run: boolean;
  readonly cohorts: ProxyMigrationCohortReport[];
}

const EMPTY_COUNTS = (): Record<ProxyMigrationAction, number> => ({
  migrate: 0,
  resume: 0,
  released: 0,
  skip: 0,
  blocked: 0,
});

function lineOf(planned: PlannedSubscription): ProxyMigrationReportLine {
  const a = planned.adoption;
  return {
    binding: planned.binding.id,
    provider_subscription: planned.binding.providerRef,
    plan_id: planned.binding.planRef,
    action: planned.action,
    ...(planned.reason ? { reason: planned.reason } : {}),
    ...(a
      ? {
          customer: a.customer?.publicId ?? 'new',
          price: a.price.publicId,
          status: a.status,
          current_period_end: a.periodEnd,
          automatic_tax: a.automaticTax,
        }
      : {}),
    ...(planned.migration ? { subscription: planned.migration.subscriptionPublicId } : {}),
  };
}

/**
 * Plan (and, unless `dryRun`, execute) the migration of one mode. A dry run
 * plans inside a READ-ONLY transaction over a provider holding only reads.
 * Execution resumes `adopted` records first, then migrates what is planned,
 * up to `limit` new adoptions; every subscription stands alone — one failure
 * is reported on its line and the run continues.
 */
export async function runProxyMigration(
  options: ProxyMigrationOptions &
    ({ dryRun: true } | { dryRun: false; provider: ProxyMigrationProvider }) & {
      limit?: number;
    },
): Promise<ProxyMigrationRun> {
  const { db } = options;
  const wall = options.now ?? (() => new Date());
  let lines: { planned: PlannedSubscription; line: ProxyMigrationReportLine }[];
  if (options.dryRun) {
    const reader = options.provider ? readsOnly(options.provider) : undefined;
    lines = await db.transaction(async (tx) => {
      // The database itself refuses any write the planner might attempt.
      await tx.execute(sql`set transaction read only`);
      const planned = await planProxyMigration(tx, { ...options, provider: reader });
      const out: { planned: PlannedSubscription; line: ProxyMigrationReportLine }[] = [];
      for (const p of planned) {
        let line = lineOf(p);
        if (p.action === 'released' && p.migration && reader) {
          line = {
            ...line,
            outcome: await safely(() => verify(tx, reader, must(p.migration), false, wall())),
          };
        }
        out.push({ planned: p, line });
      }
      return out;
    });
  } else {
    const provider = options.provider;
    const planned = await planProxyMigration(db, options);
    lines = [];
    let adopted = 0;
    // Resumes first: a held subscription is the one state that must not wait.
    const ordered = [
      ...planned.filter((p) => p.action === 'resume'),
      ...planned.filter((p) => p.action !== 'resume'),
    ];
    for (const p of ordered) {
      let line = lineOf(p);
      if (p.action === 'resume' && p.migration) {
        const migration = p.migration;
        line = { ...line, outcome: await safely(() => release(db, provider, migration)) };
      } else if (p.action === 'released' && p.migration) {
        const migration = p.migration;
        line = {
          ...line,
          outcome: await safely(() => verify(db, provider, migration, true, wall())),
        };
      } else if (p.action === 'migrate') {
        if (options.limit !== undefined && adopted >= options.limit) {
          line = { ...line, outcome: 'deferred_by_limit' };
        } else {
          adopted += 1;
          line = {
            ...line,
            outcome: await safely(async () => {
              // The proxy refuses this customer's writes from the commit on.
              const migration = await adopt(db, p);
              const outcome = await release(db, provider, migration);
              return outcome === 'released' ? 'migrated' : 'migrated_realigned';
            }),
          };
          const migration = await findProxyMigrationForBinding(db, p.binding.id);
          if (migration) line = { ...line, subscription: migration.subscriptionPublicId };
        }
      }
      lines.push({ planned: p, line });
    }
  }
  const byCohort = new Map<string, ProxyMigrationCohortReport>();
  for (const { planned, line } of lines) {
    const key = planned.binding.merchantPublicId;
    let cohort = byCohort.get(key);
    if (!cohort) {
      cohort = {
        merchant: key,
        environment: planned.binding.environment,
        livemode: planned.binding.livemode,
        counts: EMPTY_COUNTS(),
        blocked: {},
        subscriptions: [],
      };
      byCohort.set(key, cohort);
    }
    cohort.counts[planned.action] += 1;
    if (planned.action === 'blocked' && planned.reason)
      cohort.blocked[planned.reason] = (cohort.blocked[planned.reason] ?? 0) + 1;
    cohort.subscriptions.push(line);
  }
  return {
    mode: options.livemode ? 'live' : 'test',
    dry_run: options.dryRun,
    cohorts: [...byCohort.values()],
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('unreachable');
  return value;
}

/** A step's outcome, or the reason it failed — never a provider message. */
async function safely(step: () => Promise<string>): Promise<string> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof ProxyMigrationAnomaly) return `anomaly:${error.reason}`;
    // A provider's message can carry customer details; our own cannot.
    if (!(error instanceof Error) || error.name.startsWith('Stripe'))
      return `failed:${error instanceof Error ? error.name : 'error'}`;
    return `failed:${error.name}:${error.message.slice(0, 200)}`;
  }
}
