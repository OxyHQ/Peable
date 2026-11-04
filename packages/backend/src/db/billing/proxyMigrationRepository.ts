/**
 * Reads and writes for the Stripe-Billing proxy migration (ADR 0018 §7):
 * the proxied subscriptions to move, and `billing_proxy_migrations`, the
 * per-subscription record and marker.
 */
import { aliasedTable, and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import {
  billingObjectBindings,
  billingProxyMigrations,
  merchants,
  subscriptions,
  taxSettings,
} from '../schema';
import type { BillingProxyMigrationState } from '../schema/billing';

/** One proxied subscription, with the customer and price bindings it names. */
export interface ProxySubscriptionBinding {
  readonly id: string;
  readonly merchantId: string;
  readonly merchantPublicId: string;
  readonly oxyAppId: string;
  readonly environment: string;
  readonly platformAccountId: string;
  readonly livemode: boolean;
  /** The Stripe `sub_…`. */
  readonly providerRef: string;
  /** The consumer's store reference (a customer of its own namespace). */
  readonly storeRef: string;
  readonly planRef: string;
  /** The evidence the binding was made on — the checkout operation's id, for a completed checkout. */
  readonly bindingEvidenceRef: string;
  readonly customerBindingId: string;
  /** The Stripe `cus_…`. */
  readonly providerCustomerRef: string;
  /** The Stripe `price_…`. */
  readonly providerPriceRef: string;
}

const customerBinding = aliasedTable(billingObjectBindings, 'customer_binding');
const priceBinding = aliasedTable(billingObjectBindings, 'price_binding');

/** Every proxied Stripe subscription of one mode, oldest binding first. */
export async function listProxySubscriptionBindings(
  db: DatabaseOrTransaction,
  livemode: boolean,
): Promise<ProxySubscriptionBinding[]> {
  const rows = await db
    .select({
      id: billingObjectBindings.id,
      merchantId: billingObjectBindings.merchantId,
      merchantPublicId: merchants.publicId,
      oxyAppId: billingObjectBindings.oxyAppId,
      environment: billingObjectBindings.environment,
      platformAccountId: billingObjectBindings.platformAccountId,
      livemode: billingObjectBindings.livemode,
      providerRef: billingObjectBindings.providerRef,
      storeRef: billingObjectBindings.externalSubjectRef,
      planRef: billingObjectBindings.planRef,
      bindingEvidenceRef: billingObjectBindings.bindingEvidenceRef,
      customerBindingId: customerBinding.id,
      providerCustomerRef: customerBinding.providerRef,
      providerPriceRef: priceBinding.providerRef,
    })
    .from(billingObjectBindings)
    .innerJoin(merchants, eq(merchants.id, billingObjectBindings.merchantId))
    .innerJoin(customerBinding, eq(customerBinding.id, billingObjectBindings.customerBindingId))
    .innerJoin(priceBinding, eq(priceBinding.id, billingObjectBindings.priceBindingId))
    .where(
      and(
        eq(billingObjectBindings.kind, 'subscription'),
        eq(billingObjectBindings.livemode, livemode),
      ),
    )
    .orderBy(asc(billingObjectBindings.createdAt), asc(billingObjectBindings.id));
  // The shape CHECK makes a subscription binding carry both refs.
  return rows.map((row) => ({
    ...row,
    storeRef: row.storeRef ?? '',
    planRef: row.planRef ?? '',
  }));
}

export type ProxyMigrationRow = typeof billingProxyMigrations.$inferSelect & {
  readonly subscriptionPublicId: string;
};

const MIGRATION_COLUMNS = {
  id: billingProxyMigrations.id,
  merchantId: billingProxyMigrations.merchantId,
  livemode: billingProxyMigrations.livemode,
  subscriptionBindingId: billingProxyMigrations.subscriptionBindingId,
  customerBindingId: billingProxyMigrations.customerBindingId,
  providerSubscriptionRef: billingProxyMigrations.providerSubscriptionRef,
  customerId: billingProxyMigrations.customerId,
  paymentMethodId: billingProxyMigrations.paymentMethodId,
  priceId: billingProxyMigrations.priceId,
  subscriptionId: billingProxyMigrations.subscriptionId,
  state: billingProxyMigrations.state,
  adoptedAt: billingProxyMigrations.adoptedAt,
  releasedAt: billingProxyMigrations.releasedAt,
  createdAt: billingProxyMigrations.createdAt,
  updatedAt: billingProxyMigrations.updatedAt,
  subscriptionPublicId: subscriptions.publicId,
} as const;

/** The migration of one proxied subscription, if it has started. */
export async function findProxyMigrationForBinding(
  db: DatabaseOrTransaction,
  subscriptionBindingId: string,
): Promise<ProxyMigrationRow | null> {
  const [row] = await db
    .select(MIGRATION_COLUMNS)
    .from(billingProxyMigrations)
    .innerJoin(subscriptions, eq(subscriptions.id, billingProxyMigrations.subscriptionId))
    .where(eq(billingProxyMigrations.subscriptionBindingId, subscriptionBindingId));
  return row ?? null;
}

/** Write the record in the adoption's transaction (the binding is unique: a second run loses). */
export async function insertProxyMigration(
  tx: Transaction,
  values: Omit<
    typeof billingProxyMigrations.$inferInsert,
    'id' | 'state' | 'releasedAt' | 'createdAt' | 'updatedAt'
  >,
): Promise<string> {
  const [row] = await tx
    .insert(billingProxyMigrations)
    .values({ id: uuidv7(), ...values, state: 'adopted' })
    .returning({ id: billingProxyMigrations.id });
  if (!row) throw new Error('proxy migration insert returned no row');
  return row.id;
}

/** `adopted` → `released`, a compare-and-swap; false when another run released it first. */
export async function markProxyMigrationReleased(
  tx: Transaction,
  id: string,
  at: Date,
): Promise<boolean> {
  const rows = await tx
    .update(billingProxyMigrations)
    .set({ state: 'released' satisfies BillingProxyMigrationState, releasedAt: at })
    .where(and(eq(billingProxyMigrations.id, id), eq(billingProxyMigrations.state, 'adopted')))
    .returning({ id: billingProxyMigrations.id });
  return rows.length === 1;
}

/** Whether any subscription of this proxy customer has moved — the proxy then refuses its writes. */
export async function isProxyCustomerMigrated(
  db: DatabaseOrTransaction,
  customerBindingId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: billingProxyMigrations.id })
    .from(billingProxyMigrations)
    .where(eq(billingProxyMigrations.customerBindingId, customerBindingId))
    .limit(1);
  return row !== undefined;
}

/**
 * Whether the merchant's Peable Tax settings are approved — the condition
 * under which an automatically taxed renewal can finalize at all.
 */
export async function merchantTaxActive(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ status: taxSettings.status })
    .from(taxSettings)
    .where(eq(taxSettings.merchantId, merchantId));
  return row?.status === 'active';
}
