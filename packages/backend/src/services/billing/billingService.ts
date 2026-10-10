import { createVerifiedBillingTaxQuote, type BillingTaxQuoteCalculator } from './tax-quote';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { verifyFinalInvoiceAuthority, type FinalInvoiceAuthorityReader } from './invoice-authority';
import { createHash, randomUUID } from 'node:crypto';
import type {
  BillingCustomer,
  BillingHostedSession,
  BillingCheckoutSession,
  BillingSubscription,
  CreateBillingTaxQuoteParams,
  CreateBillingCheckoutParams,
  CreateBillingPortalParams,
  EnsureBillingCustomerParams,
} from '@peable.to/shared-types';
import type { Database, Transaction } from '../../db/postgres';
import {
  findBillingCustomerForStore,
  bindBillingObject,
  claimBillingOperation,
  completeBillingOperation,
  markBillingOperationIndeterminate,
  requireBillingBinding,
  type BillingOperation,
  type BillingBinding,
} from '../../db/billing/billingRepository';
import {
  BillingError,
  billingCustomerSchema,
  billingHostedSessionSchema,
  billingCheckoutSessionSchema,
  billingSubscriptionSchema,
  billingOwnerSchema,
  billingDeploymentSchema,
  ensureCustomerSchema,
  checkoutSchema,
  portalSchema,
  type BillingOwner,
  type BillingOperationKind,
  type BillingDeployment,
} from './contracts';
import type { BillingProvider, ProviderBillingSubscription } from './provider';
import type { VerifiedBillingBindings } from './verifiedBindings';

/** Trusted deployment composition, never a request field. No cohort means no access. */
export interface BillingCohort extends BillingOwner, BillingDeployment {
  evidenceRef: string;
}
export interface BillingServiceOptions {
  db: Database;
  provider: BillingProvider;
  cohorts: readonly BillingCohort[];
  now?: () => Date;
  finalInvoiceAuthority?: FinalInvoiceAuthorityReader;
  taxQuoteCalculator?: BillingTaxQuoteCalculator;
  verifiedBindings?: Pick<
    VerifiedBillingBindings,
    | 'resolveCompletedSubscription'
    | 'retrieveCheckout'
    | 'retrievePaidInvoice'
    | 'retrieveInvoiceState'
  >;
}
/** The five-method recurring transport; no entitlement or settlement decisions. */
export function createBillingService(options: BillingServiceOptions) {
  const { db, provider } = options;
  const now = options.now ?? (() => new Date());
  const deployment = billingDeploymentSchema.parse(provider.deployment);
  const cohorts = options.cohorts.map((cohort) => ({
    ...billingOwnerSchema.parse({
      merchantId: cohort.merchantId,
      oxyAppId: cohort.oxyAppId,
      environment: cohort.environment,
    }),
    ...billingDeploymentSchema.parse({
      provider: cohort.provider,
      platformAccountId: cohort.platformAccountId,
      livemode: cohort.livemode,
    }),
    evidenceRef: cohort.evidenceRef,
  }));
  function authorize(owner: BillingOwner) {
    if (
      !cohorts.some(
        (cohort) =>
          cohort.merchantId === owner.merchantId &&
          cohort.oxyAppId === owner.oxyAppId &&
          cohort.environment === owner.environment &&
          cohort.provider === deployment.provider &&
          cohort.platformAccountId === deployment.platformAccountId &&
          cohort.livemode === deployment.livemode &&
          (owner.environment === 'production') === deployment.livemode &&
          cohort.evidenceRef.length > 0,
      )
    )
      throw new BillingError('not_found', 404);
  }
  async function perform<T>(
    owner: BillingOwner,
    operation: BillingOperationKind,
    idempotencyKey: string,
    input: object,
    effect: (remoteKey: string) => Promise<{ result: T; objectRef: string }>,
    complete?: (tx: Transaction, op: BillingOperation, value: T) => Promise<void>,
    subjectClaimRef?: string,
    checkoutBindings?: { customerBindingId: string; priceBindingId: string },
  ): Promise<T> {
    authorize(owner);
    const requestDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const claim = await claimBillingOperation(
      db,
      deployment,
      owner,
      {
        operation,
        idempotencyKey,
        requestDigest,
        ...(subjectClaimRef === undefined ? {} : { subjectClaimRef }),
        ...checkoutBindings,
      },
      now(),
    );
    if (claim.kind === 'replay')
      return (
        operation === 'checkout'
          ? billingCheckoutSessionSchema.parse({
              ...claim.result,
              id: claim.operation.providerObjectRef,
            })
          : claim.result
      ) as T;
    try {
      await provider.verifyDeployment();
      const value = await effect(claim.operation.remoteIdempotencyKey);
      await db.transaction(async (tx) => {
        if (complete) await complete(tx, claim.operation, value.result);
        await completeBillingOperation(
          tx,
          claim.operation,
          claim.leaseToken,
          value.result,
          value.objectRef,
          now(),
        );
      });
      return value.result;
    } catch (error) {
      await markBillingOperationIndeterminate(db, claim.operation, claim.leaseToken);
      // No raw provider payload/message, URL or request in this public error.
      throw error instanceof BillingError ? error : new BillingError('provider_unavailable', 503);
    }
  }
  async function ownedSubscription(owner: BillingOwner, ref: string) {
    authorize(owner);
    try {
      return await requireBillingBinding(db, deployment, owner, 'subscription', ref);
    } catch (error) {
      if (
        !(error instanceof BillingError) ||
        error.code !== 'not_found' ||
        !options.verifiedBindings
      )
        throw error;
      try {
        return await options.verifiedBindings.resolveCompletedSubscription(owner, ref);
      } catch (resolutionError) {
        if (
          resolutionError instanceof BillingError ||
          (resolutionError instanceof Error && resolutionError.name === 'ZodError')
        )
          throw new BillingError('not_found', 404);
        throw new BillingError('provider_unavailable', 503);
      }
    }
  }
  async function project(
    owner: BillingOwner,
    binding: BillingBinding,
    snapshot: ProviderBillingSubscription,
  ): Promise<BillingSubscription> {
    if (!binding.externalSubjectRef || !binding.planRef)
      throw new BillingError('identity_conflict');
    const parsed = billingSubscriptionSchema.parse({
      ...snapshot,
      storeId: binding.externalSubjectRef,
      planId: binding.planRef,
    });
    const customer = await requireBillingBinding(
      db,
      deployment,
      owner,
      'customer',
      parsed.providerCustomerId,
    );
    const price = await requireBillingBinding(
      db,
      deployment,
      owner,
      'price',
      parsed.providerPriceId,
    );
    if (
      parsed.providerSubscriptionId !== binding.providerRef ||
      parsed.livemode !== deployment.livemode ||
      binding.customerBindingId !== customer.id ||
      binding.priceBindingId !== price.id ||
      customer.externalSubjectRef !== binding.externalSubjectRef ||
      price.planRef !== binding.planRef
    )
      throw new BillingError('identity_conflict');
    return parsed;
  }
  return {
    async ensureCustomer(
      owner: BillingOwner,
      params: EnsureBillingCustomerParams,
      idempotencyKey: string,
    ): Promise<BillingCustomer> {
      const input = ensureCustomerSchema.parse(params);
      return perform(
        owner,
        'ensure_customer',
        idempotencyKey,
        input,
        async (key) => {
          const existing = await findBillingCustomerForStore(db, deployment, owner, input.storeId);
          if (existing)
            return {
              result: { providerCustomerId: existing.providerRef },
              objectRef: existing.providerRef,
            };
          const value = await provider.ensureCustomer(input, key);
          if (value.livemode !== deployment.livemode) throw new BillingError('identity_conflict');
          const result = billingCustomerSchema.parse({
            providerCustomerId: value.providerCustomerId,
          });
          return { result, objectRef: result.providerCustomerId };
        },
        async (tx, op, value) => {
          const existing = await findBillingCustomerForStore(tx, deployment, owner, input.storeId);
          if (existing) {
            if (existing.providerRef !== value.providerCustomerId)
              throw new BillingError('identity_conflict');
            return;
          }
          await bindBillingObject(tx, deployment, owner, {
            kind: 'customer',
            providerRef: value.providerCustomerId,
            externalSubjectRef: input.storeId,
            bindingEvidenceRef: op.id,
          });
        },
        input.storeId,
      );
    },
    async createCheckoutSession(
      owner: BillingOwner,
      params: CreateBillingCheckoutParams,
      idempotencyKey: string,
    ): Promise<BillingCheckoutSession> {
      authorize(owner);
      const input = checkoutSchema.parse(params);
      const customer = await requireBillingBinding(
        db,
        deployment,
        owner,
        'customer',
        input.providerCustomerId,
      );
      const price = await requireBillingBinding(
        db,
        deployment,
        owner,
        'price',
        input.providerPriceId,
      );
      if (customer.externalSubjectRef !== input.storeId || price.planRef !== input.planId)
        throw new BillingError('identity_conflict');
      return perform(
        owner,
        'checkout',
        idempotencyKey,
        input,
        async (key) => {
          const value = await provider.createCheckoutSession(input, key);
          if (
            value.livemode !== deployment.livemode ||
            value.providerCustomerId !== customer.providerRef
          )
            throw new BillingError('identity_conflict');
          return {
            result: billingCheckoutSessionSchema.parse({
              id: value.providerObjectRef,
              url: value.url,
              expiresAt: value.expiresAt,
            }),
            objectRef: value.providerObjectRef,
          };
        },
        undefined,
        undefined,
        { customerBindingId: customer.id, priceBindingId: price.id },
      );
    },
    async createPortalSession(
      owner: BillingOwner,
      params: CreateBillingPortalParams,
      idempotencyKey = `portal:${randomUUID()}`,
    ): Promise<BillingHostedSession> {
      authorize(owner);
      const input = portalSchema.parse(params);
      await requireBillingBinding(db, deployment, owner, 'customer', input.providerCustomerId);
      // Replay also needs the current safe Portal configuration.
      await provider.verifyDeployment();
      await provider.verifyPortalConfiguration();
      return perform(owner, 'portal', idempotencyKey, input, async (key) => {
        const value = await provider.createPortalSession(input, key);
        if (
          value.livemode !== deployment.livemode ||
          value.providerCustomerId !== input.providerCustomerId
        )
          throw new BillingError('identity_conflict');
        return {
          result: billingHostedSessionSchema.parse({ url: value.url, expiresAt: value.expiresAt }),
          objectRef: value.providerObjectRef,
        };
      });
    },
    async retrieveCheckout(owner: BillingOwner, ref: string) {
      authorize(owner);
      if (!options.verifiedBindings) throw new BillingError('not_found', 404);
      return options.verifiedBindings.retrieveCheckout(owner, ref);
    },
    async retrieveInvoiceState(owner: BillingOwner, subRef: string, invoiceRef: string) {
      authorize(owner);
      if (!options.verifiedBindings) throw new BillingError('not_found', 404);
      await ownedSubscription(owner, subRef);
      return options.verifiedBindings.retrieveInvoiceState(owner, subRef, invoiceRef);
    },
    async retrievePaidInvoice(owner: BillingOwner, subRef: string, invoiceRef: string) {
      authorize(owner);
      if (!options.verifiedBindings) throw new BillingError('not_found', 404);
      await ownedSubscription(owner, subRef);
      return options.verifiedBindings.retrievePaidInvoice(owner, subRef, invoiceRef);
    },
    async createTaxQuote(owner: BillingOwner, params: CreateBillingTaxQuoteParams) {
      authorize(owner);
      if (!options.taxQuoteCalculator) throw new BillingError('not_found', 404);
      const customer = await findBillingCustomerForStore(db, deployment, owner, params.storeId);
      const merchant = await findMerchantById(db, owner.merchantId);
      if (
        !customer ||
        !merchant ||
        merchant.oxyAppId !== owner.oxyAppId ||
        merchant.environment !== owner.environment
      )
        throw new BillingError('not_found', 404);
      return createVerifiedBillingTaxQuote(
        options.taxQuoteCalculator,
        owner,
        merchant.publicId,
        params,
        now,
      );
    },
    async retrieveFinalInvoiceAuthority(
      owner: BillingOwner,
      subscriptionRef: string,
      invoiceRef: string,
    ) {
      authorize(owner);
      if (!options.finalInvoiceAuthority || !options.verifiedBindings)
        throw new BillingError('not_found', 404);
      await ownedSubscription(owner, subscriptionRef);
      const invoice = await options.verifiedBindings.retrievePaidInvoice(
        owner,
        subscriptionRef,
        invoiceRef,
      );
      const merchant = await findMerchantById(db, owner.merchantId);
      if (
        !merchant ||
        merchant.oxyAppId !== owner.oxyAppId ||
        merchant.environment !== owner.environment
      )
        throw new BillingError('not_found', 404);
      const expected = { owner, merchantPublicId: merchant.publicId, invoice };
      const raw = await options.finalInvoiceAuthority.read(expected);
      return verifyFinalInvoiceAuthority(
        raw,
        expected,
        options.finalInvoiceAuthority.verificationKeys,
        now(),
      );
    },
    async retrieveSubscription(owner: BillingOwner, ref: string): Promise<BillingSubscription> {
      const binding = await ownedSubscription(owner, ref);
      await provider.verifyDeployment();
      return project(owner, binding, await provider.retrieveSubscription(ref));
    },
    async cancelAtPeriodEnd(
      owner: BillingOwner,
      ref: string,
      idempotencyKey = `cancel:${randomUUID()}`,
    ): Promise<BillingSubscription> {
      const binding = await ownedSubscription(owner, ref);
      const result = await perform(
        owner,
        'cancel_at_period_end',
        idempotencyKey,
        { ref },
        async (key) => {
          const current = await project(owner, binding, await provider.retrieveSubscription(ref));
          const result = current.cancelAtPeriodEnd
            ? current
            : await project(owner, binding, await provider.cancelAtPeriodEnd(ref, key));
          if (
            !result.cancelAtPeriodEnd ||
            result.currentPeriodStart !== current.currentPeriodStart ||
            result.currentPeriodEnd !== current.currentPeriodEnd
          )
            throw new BillingError('invalid_provider_response', 502);
          return { result, objectRef: ref };
        },
      );
      // A succeeded durable operation is historical evidence. External resume may
      // make it stale: same-action retry must reconcile, never report cached success.
      const fresh = await project(owner, binding, await provider.retrieveSubscription(ref));
      if (
        !fresh.cancelAtPeriodEnd ||
        fresh.currentPeriodStart !== result.currentPeriodStart ||
        fresh.currentPeriodEnd !== result.currentPeriodEnd
      )
        throw new BillingError('reconciliation_required');
      return fresh;
    },
  };
}
export type BillingService = ReturnType<typeof createBillingService>;
