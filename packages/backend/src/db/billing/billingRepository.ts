import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { z } from 'zod';
import { findMerchantById } from '../merchants/merchantRepository';
import {
  BillingError,
  billingDeploymentSchema,
  billingOwnerSchema,
  billingReference,
  billingIdempotencyKey,
  BILLING_BINDING_KINDS,
  BILLING_OPERATIONS,
  parseBillingResult,
} from '../../services/billing/contracts';
import type { Database, DatabaseOrTransaction, Transaction } from '../postgres';
import type {
  BillingDeployment,
  BillingOwner,
  BillingOperationKind,
  BillingOperationResult,
} from '../../services/billing/contracts';
import { billingObjectBindings, billingOperations } from '../schema';
export type BillingBinding = typeof billingObjectBindings.$inferSelect;
export type BillingOperation = typeof billingOperations.$inferSelect;
export interface BindBillingInput {
  kind: 'customer' | 'price' | 'subscription';
  providerRef: string;
  externalSubjectRef?: string;
  planRef?: string;
  customerBindingId?: string;
  priceBindingId?: string;
  bindingEvidenceRef: string;
}
export interface ClaimBillingInput {
  operation: BillingOperationKind;
  idempotencyKey: string;
  requestDigest: string;
  subjectClaimRef?: string;
  customerBindingId?: string;
  priceBindingId?: string;
}
export type BillingClaim =
  | { kind: 'claimed'; operation: BillingOperation; leaseToken: string }
  | { kind: 'replay'; operation: BillingOperation; result: BillingOperationResult };
const bindingSchema = z
  .object({
    kind: z.enum(BILLING_BINDING_KINDS),
    providerRef: billingReference,
    externalSubjectRef: billingReference.optional(),
    planRef: billingReference.optional(),
    customerBindingId: billingReference.optional(),
    priceBindingId: billingReference.optional(),
    bindingEvidenceRef: billingReference,
  })
  .strict();
const claimSchema = z
  .object({
    operation: z.enum(BILLING_OPERATIONS),
    idempotencyKey: billingIdempotencyKey,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    subjectClaimRef: billingReference.optional(),
    customerBindingId: billingReference.optional(),
    priceBindingId: billingReference.optional(),
  })
  .strict()
  .refine(
    (value) => (value.operation === 'ensure_customer') === (value.subjectClaimRef !== undefined),
    'Customer claim requires store',
  )
  .refine(
    (value) =>
      value.operation === 'checkout'
        ? !!value.customerBindingId && !!value.priceBindingId
        : !value.customerBindingId && !value.priceBindingId,
    'Checkout requires exact customer and price bindings',
  );
function sameOwner(
  row: { merchantId: string; oxyAppId: string; environment: string },
  owner: BillingOwner,
) {
  return (
    row.merchantId === owner.merchantId &&
    row.oxyAppId === owner.oxyAppId &&
    row.environment === owner.environment
  );
}
function sameDeployment(
  row: { provider: string; platformAccountId: string; livemode: boolean },
  deployment: BillingDeployment,
) {
  return (
    row.provider === deployment.provider &&
    row.platformAccountId === deployment.platformAccountId &&
    row.livemode === deployment.livemode
  );
}
async function validateOwner(
  db: DatabaseOrTransaction,
  deploymentInput: BillingDeployment,
  ownerInput: BillingOwner,
) {
  const deployment = billingDeploymentSchema.parse(deploymentInput);
  const owner = billingOwnerSchema.parse(ownerInput);
  const merchant = await findMerchantById(db, owner.merchantId);
  if (
    !merchant ||
    merchant.oxyAppId !== owner.oxyAppId ||
    merchant.environment !== owner.environment ||
    (owner.environment === 'production') !== deployment.livemode
  )
    throw new BillingError('identity_conflict');
  return { deployment, owner };
}
function bindingIdentity(deployment: BillingDeployment, kind: BillingBinding['kind'], ref: string) {
  return and(
    eq(billingObjectBindings.provider, deployment.provider),
    eq(billingObjectBindings.platformAccountId, deployment.platformAccountId),
    eq(billingObjectBindings.livemode, deployment.livemode),
    eq(billingObjectBindings.kind, kind),
    eq(billingObjectBindings.providerRef, ref),
  );
}
/** Internal verified importer/completion only. No public route accepts a binding or evidence. */
export async function bindBillingObject(
  db: DatabaseOrTransaction,
  deploymentInput: BillingDeployment,
  ownerInput: BillingOwner,
  input: BindBillingInput,
): Promise<BillingBinding> {
  const { deployment, owner } = await validateOwner(db, deploymentInput, ownerInput);
  const parsed = bindingSchema.parse(input);
  const prefix = { customer: 'cus_', price: 'price_', subscription: 'sub_' }[parsed.kind];
  if (!parsed.providerRef.startsWith(prefix)) throw new BillingError('identity_conflict');
  const externalSubjectRef = parsed.externalSubjectRef ?? null;
  const planRef = parsed.planRef ?? null;
  const customerBindingId = parsed.customerBindingId ?? null;
  const priceBindingId = parsed.priceBindingId ?? null;
  if (
    (parsed.kind === 'customer' &&
      (!externalSubjectRef || planRef || customerBindingId || priceBindingId)) ||
    (parsed.kind === 'price' &&
      (externalSubjectRef || !planRef || customerBindingId || priceBindingId))
  )
    throw new BillingError('identity_conflict');
  if (parsed.kind === 'subscription') {
    if (!externalSubjectRef || !planRef || !customerBindingId || !priceBindingId)
      throw new BillingError('identity_conflict');
    const [customer] = await db
      .select()
      .from(billingObjectBindings)
      .where(eq(billingObjectBindings.id, customerBindingId));
    const [price] = await db
      .select()
      .from(billingObjectBindings)
      .where(eq(billingObjectBindings.id, priceBindingId));
    if (
      !customer ||
      !price ||
      customer.kind !== 'customer' ||
      price.kind !== 'price' ||
      !sameOwner(customer, owner) ||
      !sameOwner(price, owner) ||
      !sameDeployment(customer, deployment) ||
      !sameDeployment(price, deployment) ||
      customer.externalSubjectRef !== externalSubjectRef ||
      price.planRef !== planRef
    )
      throw new BillingError('identity_conflict');
  }
  const identity = {
    ...deployment,
    ...owner,
    kind: parsed.kind,
    providerRef: parsed.providerRef,
    externalSubjectRef,
    planRef,
    customerBindingId,
    priceBindingId,
    bindingEvidenceRef: parsed.bindingEvidenceRef,
  };
  const [inserted] = await db
    .insert(billingObjectBindings)
    .values({ id: uuidv7(), ...identity })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(billingObjectBindings)
    .where(bindingIdentity(deployment, parsed.kind, parsed.providerRef));
  if (
    !existing ||
    Object.entries(identity).some(([key, value]) => existing[key as keyof BillingBinding] !== value)
  )
    throw new BillingError('identity_conflict');
  return existing;
}
export async function requireBillingBinding(
  db: DatabaseOrTransaction,
  deployment: BillingDeployment,
  owner: BillingOwner,
  kind: BillingBinding['kind'],
  ref: string,
): Promise<BillingBinding> {
  await validateOwner(db, deployment, owner);
  const [row] = await db
    .select()
    .from(billingObjectBindings)
    .where(bindingIdentity(deployment, kind, ref));
  if (!row || !sameOwner(row, owner)) throw new BillingError('not_found', 404);
  return row;
}
/** 23 hours is our conservative recovery budget, not a Stripe retention guarantee. */
const RECOVERY_WINDOW_MS = 23 * 3600_000;
// Account/config/create/config calls each have a 10s SDK timeout. Lease exceeds their total.
const LEASE_MS = 90_000;
export async function claimBillingOperation(
  db: Database,
  deploymentInput: BillingDeployment,
  ownerInput: BillingOwner,
  input: ClaimBillingInput,
  now = new Date(),
): Promise<BillingClaim> {
  const { deployment, owner } = await validateOwner(db, deploymentInput, ownerInput);
  const parsed = claimSchema.parse(input);
  return db.transaction(async (tx) => {
    if (parsed.operation === 'checkout') {
      // claimSchema's refine already requires both for a checkout; this only
      // narrows them for the compiler.
      const { customerBindingId, priceBindingId } = parsed;
      if (!customerBindingId || !priceBindingId)
        throw new Error('Checkout requires exact customer and price bindings');
      const [customer] = await tx
        .select()
        .from(billingObjectBindings)
        .where(eq(billingObjectBindings.id, customerBindingId));
      const [price] = await tx
        .select()
        .from(billingObjectBindings)
        .where(eq(billingObjectBindings.id, priceBindingId));
      if (
        !customer ||
        !price ||
        customer.kind !== 'customer' ||
        price.kind !== 'price' ||
        !sameOwner(customer, owner) ||
        !sameOwner(price, owner) ||
        !sameDeployment(customer, deployment) ||
        !sameDeployment(price, deployment)
      )
        throw new BillingError('identity_conflict');
    }
    const leaseToken = uuidv7();
    // No caller/merchant partition: a reused financial key is a conflict, not a new intent.
    const remoteIdempotencyKey = `peable-billing:${createHash('sha256')
      .update(
        JSON.stringify([
          deployment.provider,
          deployment.platformAccountId,
          deployment.livemode,
          parsed.idempotencyKey,
        ]),
      )
      .digest('hex')}`;
    const [inserted] = await tx
      .insert(billingOperations)
      .values({
        id: uuidv7(),
        ...deployment,
        ...owner,
        ...parsed,
        subjectClaimRef: parsed.subjectClaimRef ?? null,
        customerBindingId: parsed.customerBindingId ?? null,
        priceBindingId: parsed.priceBindingId ?? null,
        remoteIdempotencyKey,
        state: 'pending',
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        retryUntil: new Date(now.getTime() + RECOVERY_WINDOW_MS),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { kind: 'claimed', operation: inserted, leaseToken };
    const [existing] = await tx
      .select()
      .from(billingOperations)
      .where(
        and(
          eq(billingOperations.provider, deployment.provider),
          eq(billingOperations.platformAccountId, deployment.platformAccountId),
          eq(billingOperations.livemode, deployment.livemode),
          eq(billingOperations.idempotencyKey, parsed.idempotencyKey),
        ),
      )
      .for('update');
    // A different key for an existing customer claim also reaches this refusal.
    if (
      !existing ||
      !sameOwner(existing, owner) ||
      existing.operation !== parsed.operation ||
      (existing.requestDigest !== parsed.requestDigest &&
        !(existing.operation === 'ensure_customer' && existing.state === 'succeeded')) ||
      existing.subjectClaimRef !== (parsed.subjectClaimRef ?? null) ||
      existing.customerBindingId !== (parsed.customerBindingId ?? null) ||
      existing.priceBindingId !== (parsed.priceBindingId ?? null)
    )
      throw new BillingError('idempotency_conflict');
    if (existing.state === 'succeeded') {
      if (existing.resultExpiresAt && existing.resultExpiresAt <= now)
        throw new BillingError('result_expired');
      return {
        kind: 'replay',
        operation: existing,
        result: parseBillingResult(existing.operation, existing.result),
      };
    }
    if (existing.retryUntil <= now) throw new BillingError('reconciliation_required');
    if (existing.leaseExpiresAt && existing.leaseExpiresAt > now)
      throw new BillingError('in_progress');
    const [recovered] = await tx
      .update(billingOperations)
      .set({ state: 'pending', leaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) })
      .where(eq(billingOperations.id, existing.id))
      .returning();
    if (!recovered) throw new BillingError('reconciliation_required');
    return { kind: 'claimed', operation: recovered, leaseToken };
  });
}
/** Caller commits object binding and result together; a stale lease cannot finish either. */
export async function completeBillingOperation(
  tx: Transaction,
  operation: BillingOperation,
  leaseToken: string,
  input: unknown,
  providerObjectRef?: string,
  now = new Date(),
): Promise<void> {
  const result = parseBillingResult(operation.operation, input);
  const resultExpiresAt = 'expiresAt' in result ? new Date(result.expiresAt) : null;
  if (resultExpiresAt && resultExpiresAt <= now) throw new BillingError('result_expired');
  const [finished] = await tx
    .update(billingOperations)
    .set({
      state: 'succeeded',
      result,
      resultExpiresAt,
      providerObjectRef:
        providerObjectRef === undefined ? null : billingReference.parse(providerObjectRef),
      completedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(billingOperations.id, operation.id),
        eq(billingOperations.leaseToken, leaseToken),
        eq(billingOperations.state, 'pending'),
      ),
    )
    .returning({ id: billingOperations.id });
  if (!finished) throw new BillingError('in_progress');
}
export async function markBillingOperationIndeterminate(
  db: DatabaseOrTransaction,
  operation: BillingOperation,
  leaseToken: string,
): Promise<void> {
  // Clear only this attempt. A slow request must not overwrite a newer lease/result.
  await db
    .update(billingOperations)
    .set({ state: 'indeterminate', leaseToken: null, leaseExpiresAt: null })
    .where(
      and(
        eq(billingOperations.id, operation.id),
        eq(billingOperations.leaseToken, leaseToken),
        eq(billingOperations.state, 'pending'),
      ),
    );
}

/** A successful ensure is stable by app-owned store even when its display name changes. */
export async function findBillingCustomerForStore(
  db: DatabaseOrTransaction,
  deployment: BillingDeployment,
  owner: BillingOwner,
  storeId: string,
): Promise<BillingBinding | null> {
  await validateOwner(db, deployment, owner);
  const [row] = await db
    .select()
    .from(billingObjectBindings)
    .where(
      and(
        eq(billingObjectBindings.provider, deployment.provider),
        eq(billingObjectBindings.platformAccountId, deployment.platformAccountId),
        eq(billingObjectBindings.livemode, deployment.livemode),
        eq(billingObjectBindings.merchantId, owner.merchantId),
        eq(billingObjectBindings.kind, 'customer'),
        eq(billingObjectBindings.externalSubjectRef, storeId),
      ),
    );
  return row && sameOwner(row, owner) ? row : null;
}

/** Internal verified completion lookup. Unknown/historical checkouts cannot acquire an owner. */
export async function findBillingCheckoutOperation(
  db: DatabaseOrTransaction,
  deployment: BillingDeployment,
  ref: string,
): Promise<BillingOperation | null> {
  const [row] = await db
    .select()
    .from(billingOperations)
    .where(
      and(
        eq(billingOperations.provider, deployment.provider),
        eq(billingOperations.platformAccountId, deployment.platformAccountId),
        eq(billingOperations.livemode, deployment.livemode),
        eq(billingOperations.operation, 'checkout'),
        eq(billingOperations.state, 'succeeded'),
        eq(billingOperations.providerObjectRef, ref),
      ),
    );
  return row ?? null;
}
export async function requireBillingBindingById(
  db: DatabaseOrTransaction,
  deployment: BillingDeployment,
  owner: BillingOwner,
  kind: BillingBinding['kind'],
  id: string,
): Promise<BillingBinding> {
  const [row] = await db
    .select()
    .from(billingObjectBindings)
    .where(eq(billingObjectBindings.id, id));
  if (!row || row.kind !== kind || !sameOwner(row, owner) || !sameDeployment(row, deployment))
    throw new BillingError('identity_conflict');
  return row;
}
