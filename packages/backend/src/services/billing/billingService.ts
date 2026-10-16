import {
  prepareBillingTaxCheckout,
  verifyBillingInvoiceTaxCheckout,
  type BillingTaxCheckoutAdapter,
  type BillingTaxCheckoutSnapshot,
} from './tax-checkout';
import { createVerifiedBillingTaxQuote, type BillingTaxQuoteCalculator } from './tax-quote';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { verifyFinalInvoiceAuthority, type FinalInvoiceAuthorityReader } from './invoice-authority';
import { createHash, randomUUID } from 'node:crypto';
import type {
  BillingCustomer,
  BillingHostedSession,
  BillingCheckoutSession,
  BillingRailList,
  BillingSubscription,
  RetrieveBillingCheckoutOperationParams,
  BillingCheckoutOperationRecovery,
  CreateBillingTaxQuoteParams,
  CreateBillingCheckoutParams,
  CreateBillingPortalParams,
  EnsureBillingCustomerParams,
} from '@peable.to/shared-types';
import { z } from 'zod';
import type { Database, Transaction } from '../../db/postgres';
import {
  findBillingCustomerForStore,
  findOwnedBillingCheckoutOperationByKey,
  completeRecoveredBillingCheckout,
  findBillingTaxCheckoutSnapshot,
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
  checkoutOperationRequestSchema,
  billingHostedSessionSchema,
  billingCheckoutSessionSchema,
  parseBillingResult,
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

/** Optional parts of a signed final invoice a caller asks for. */
export interface BillingInvoiceAuthorityInclude {
  taxLines?: boolean;
}
/** Trusted deployment composition, never a request field. No cohort means no access. */
export interface BillingCohort extends BillingOwner, BillingDeployment {
  evidenceRef: string;
  requireTaxQuote?: boolean;
}
/** Capability supplied by trusted deployment composition. A provider without
 * exact operation-key discovery leaves recovery indeterminate, never recreates. */
export interface BillingCheckoutOperationReader {
  read(input: {
    taxQuoteId: string | null;
    remoteIdempotencyKey: string;
    requestDigest: string;
    providerCustomerId: string;
    providerPriceId: string;
    livemode: boolean;
  }): Promise<unknown>;
}
export interface BillingServiceOptions {
  db: Database;
  provider: BillingProvider;
  cohorts: readonly BillingCohort[];
  now?: () => Date;
  finalInvoiceAuthority?: FinalInvoiceAuthorityReader;
  taxQuoteCalculator?: BillingTaxQuoteCalculator;
  checkoutOperationReader?: BillingCheckoutOperationReader;
  taxCheckoutAdapter?: BillingTaxCheckoutAdapter;
  verifiedBindings?: Pick<
    VerifiedBillingBindings,
    | 'resolveCompletedSubscription'
    | 'retrieveCheckout'
    | 'retrievePaidInvoice'
    | 'retrieveInvoiceState'
    | 'verifyInitialInvoice'
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
    requireTaxQuote: cohort.requireTaxQuote === true,
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
    checkoutBindings?: {
      customerBindingId: string;
      priceBindingId: string;
      taxCheckoutSnapshot?: BillingTaxCheckoutSnapshot;
    },
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
      if (
        !input.taxQuote &&
        cohorts.some(
          (cohort) =>
            cohort.merchantId === owner.merchantId &&
            cohort.oxyAppId === owner.oxyAppId &&
            cohort.environment === owner.environment &&
            cohort.requireTaxQuote,
        )
      )
        throw new BillingError('not_found', 404);
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
      let snapshot: BillingTaxCheckoutSnapshot | undefined;
      if (input.taxQuote) {
        if (
          !options.taxQuoteCalculator ||
          !options.taxCheckoutAdapter ||
          !options.finalInvoiceAuthority
        )
          throw new BillingError('not_found', 404);
        const merchant = await findMerchantById(db, owner.merchantId);
        if (
          !merchant ||
          merchant.oxyAppId !== owner.oxyAppId ||
          merchant.environment !== owner.environment
        )
          throw new BillingError('not_found', 404);
        snapshot = await prepareBillingTaxCheckout(
          options.taxQuoteCalculator,
          options.taxCheckoutAdapter,
          owner,
          merchant.publicId,
          { ...input, taxQuote: input.taxQuote },
          now,
        );
      }
      const taxCheckoutAdapter = options.taxCheckoutAdapter;
      const immutableSnapshot = snapshot === undefined ? undefined : structuredClone(snapshot);
      return perform(
        owner,
        'checkout',
        idempotencyKey,
        input,
        async (key) => {
          // Recheck expiry after deployment verification and durable claim, before effects.
          if (
            immutableSnapshot &&
            Date.parse(immutableSnapshot.taxQuote.quote.expiresAt) <= now().getTime()
          )
            throw new BillingError('result_expired');
          if (immutableSnapshot && !taxCheckoutAdapter) throw new BillingError('not_found', 404);
          const value =
            immutableSnapshot && taxCheckoutAdapter
              ? await taxCheckoutAdapter.createCheckout(
                  {
                    owner: { ...owner },
                    deployment: { ...deployment },
                    checkout: structuredClone(input),
                    snapshot: structuredClone(immutableSnapshot),
                  },
                  key,
                )
              : await provider.createCheckoutSession(input, key);
          if (
            value.livemode !== deployment.livemode ||
            value.providerObjectRef.startsWith('cs_live_') !== deployment.livemode ||
            value.providerCustomerId !== customer.providerRef ||
            (immutableSnapshot !== undefined &&
              Date.parse(value.expiresAt) > Date.parse(immutableSnapshot.taxQuote.quote.expiresAt))
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
        {
          customerBindingId: customer.id,
          priceBindingId: price.id,
          ...(immutableSnapshot ? { taxCheckoutSnapshot: immutableSnapshot } : {}),
        },
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
    async retrieveCheckoutOperation(
      owner: BillingOwner,
      params: RetrieveBillingCheckoutOperationParams,
    ): Promise<BillingCheckoutOperationRecovery> {
      authorize(owner);
      const input = checkoutOperationRequestSchema.parse(params);
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
        throw new BillingError('not_found', 404);
      const merchant = await findMerchantById(db, owner.merchantId);
      if (
        !merchant ||
        merchant.oxyAppId !== owner.oxyAppId ||
        merchant.environment !== owner.environment
      )
        throw new BillingError('not_found', 404);
      const source = {
        ...input,
        taxQuoteId: null as string | null,
        merchantId: merchant.publicId,
        appId: owner.oxyAppId,
        mode: deployment.livemode ? ('live' as const) : ('test' as const),
        environment: owner.environment,
      };
      let operation = await findOwnedBillingCheckoutOperationByKey(
        db,
        deployment,
        owner,
        input.idempotencyKey,
      );
      if (!operation) return { state: 'not_found', source };
      if (operation.customerBindingId !== customer.id || operation.priceBindingId !== price.id)
        throw new BillingError('not_found', 404);
      source.taxQuoteId = operation.taxQuoteRef;
      if (operation.state !== 'succeeded' && options.checkoutOperationReader) {
        const expected = {
          taxQuoteId: operation.taxQuoteRef,
          remoteIdempotencyKey: operation.remoteIdempotencyKey,
          requestDigest: operation.requestDigest,
          providerCustomerId: customer.providerRef,
          providerPriceId: price.providerRef,
          livemode: deployment.livemode,
        };
        const recovered = z
          .discriminatedUnion('state', [
            z.object({ state: z.enum(['not_found', 'indeterminate']) }).strict(),
            z
              .object({
                state: z.literal('succeeded'),
                taxQuoteId: z.literal(expected.taxQuoteId),
                remoteIdempotencyKey: z.literal(expected.remoteIdempotencyKey),
                requestDigest: z.literal(expected.requestDigest),
                providerCustomerId: z.literal(expected.providerCustomerId),
                providerPriceId: z.literal(expected.providerPriceId),
                livemode: z.literal(expected.livemode),
                checkout: billingCheckoutSessionSchema,
              })
              .strict(),
          ])
          .parse(await options.checkoutOperationReader.read(structuredClone(expected)));
        if (recovered.state !== 'succeeded') return { state: 'indeterminate', source };
        if (recovered.checkout.id.startsWith('cs_live_') !== deployment.livemode)
          throw new BillingError('identity_conflict');
        if (
          operation.taxCheckoutSnapshot &&
          Date.parse(recovered.checkout.expiresAt) >
            Date.parse(operation.taxCheckoutSnapshot.taxQuote.quote.expiresAt)
        )
          throw new BillingError('identity_conflict');
        await completeRecoveredBillingCheckout(db, operation, recovered.checkout, now());
        operation = await findOwnedBillingCheckoutOperationByKey(
          db,
          deployment,
          owner,
          input.idempotencyKey,
        );
        if (
          !operation ||
          operation.customerBindingId !== customer.id ||
          operation.priceBindingId !== price.id
        )
          throw new BillingError('reconciliation_required');
      }
      if (operation.state !== 'succeeded') return { state: operation.state, source };
      const result = billingCheckoutSessionSchema.parse({
        id: operation.providerObjectRef,
        ...parseBillingResult('checkout', operation.result),
      });
      if (result.id !== operation.providerObjectRef) throw new BillingError('identity_conflict');
      return {
        state: 'succeeded',
        source,
        checkout: {
          id: result.id,
          expiresAt: result.expiresAt,
          ...(Date.parse(result.expiresAt) > now().getTime() ? { url: result.url } : {}),
        },
      };
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
      include?: BillingInvoiceAuthorityInclude,
    ) {
      authorize(owner);
      // A relayed card authority is signed by its reader adapter and Peable
      // cannot add lines under someone else's signature; only a reader that is
      // Peable's own signer (Peable Tax on the card rail) can include them.
      if (include?.taxLines && !options.finalInvoiceAuthority?.signsTaxLines)
        throw new BillingError('not_found', 404);
      if (!options.finalInvoiceAuthority || !options.verifiedBindings)
        throw new BillingError('not_found', 404);
      const binding = await ownedSubscription(owner, subscriptionRef);
      const taxCheckoutSnapshot = await findBillingTaxCheckoutSnapshot(
        db,
        deployment,
        owner,
        binding.bindingEvidenceRef,
      );
      if (taxCheckoutSnapshot)
        await options.verifiedBindings.verifyInitialInvoice(owner, subscriptionRef, invoiceRef);
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
      const expected = {
        owner,
        merchantPublicId: merchant.publicId,
        invoice,
        ...(taxCheckoutSnapshot ? { taxCheckoutSnapshot } : {}),
      };
      const raw = await options.finalInvoiceAuthority.read(
        structuredClone(
          include?.taxLines ? { ...expected, include: { taxLines: true as const } } : expected,
        ),
      );
      const authority = verifyFinalInvoiceAuthority(
        raw,
        expected,
        options.finalInvoiceAuthority.verificationKeys,
        now(),
      );
      if (taxCheckoutSnapshot) verifyBillingInvoiceTaxCheckout(authority, taxCheckoutSnapshot);
      // Lines are present exactly when asked for.
      if ((authority.invoice.taxLines !== undefined) !== (include?.taxLines === true))
        throw new BillingError('invalid_provider_response', 502);
      return authority;
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
export type BillingService = ReturnType<typeof createBillingService> & {
  /** Native FAIR is explicitly renewed by the payer; existing card providers may omit this. */
  renew?: (
    owner: BillingOwner,
    subscriptionRef: string,
    input: CreateBillingCheckoutParams,
    idempotencyKey: string,
  ) => Promise<BillingCheckoutSession>;
  /** The rails the merchant's payers can choose from (the multi-rail router). */
  listRails?: (owner: BillingOwner) => Promise<BillingRailList>;
};
