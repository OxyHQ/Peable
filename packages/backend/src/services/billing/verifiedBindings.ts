import { z } from 'zod';
import {readOwnedPaidInvoice} from './paidInvoice';
import type { Database } from '../../db/postgres';
import { bindBillingObject, findBillingCheckoutOperation, requireBillingBinding, requireBillingBindingById } from '../../db/billing/billingRepository';
import { bindRecurringObject } from '../../db/recurring/recurringMirrorRepository';
import { BillingError, billingOwnerSchema, billingReference, type BillingDeployment, type BillingOwner } from './contracts';
import type { BillingCohort } from './billingService';
import { normalizeBillingSubscription, type StripeBillingClient } from './stripeBillingProvider';
import { STRIPE_API_VERSION } from '../providers/stripe/client';

/** Internal composition/import only: no HTTP route accepts these inputs. Cohort
 * and evidence are operator-approved inputs, not claims discovered in metadata. */
export function createVerifiedBillingBindings(options: { db: Database; client: StripeBillingClient; deployment: BillingDeployment; cohorts: readonly BillingCohort[] }) {
  const { db, client, deployment } = options;
  const cohorts = options.cohorts.map((value) => ({ ...value }));
  async function authorize(owner: BillingOwner) {
    billingOwnerSchema.parse(owner);
    if (client.scope !== 'platform' || client.apiVersion !== STRIPE_API_VERSION || client.livemode !== deployment.livemode
      || !cohorts.some((value) => value.merchantId === owner.merchantId && value.oxyAppId === owner.oxyAppId && value.environment === owner.environment
        && value.provider === deployment.provider && value.platformAccountId === deployment.platformAccountId && value.livemode === deployment.livemode && value.evidenceRef.length > 0)) throw new BillingError('not_found', 404);
    const account = z.object({ id: z.string() }).parse(await client.account());
    if (account.id !== deployment.platformAccountId || (owner.environment === 'production') !== deployment.livemode) throw new BillingError('identity_conflict');
  }
  async function persistSubscription(owner: BillingOwner, subRef: string, customerRef: string, priceRef: string, evidence: string) {
    const snapshot = normalizeBillingSubscription(await client.retrieveSubscription(subRef));
    if (snapshot.providerSubscriptionId !== subRef || snapshot.providerCustomerId !== customerRef || snapshot.providerPriceId !== priceRef || snapshot.livemode !== deployment.livemode) throw new BillingError('identity_conflict');
    return db.transaction(async (tx) => {
      const customer = await requireBillingBinding(tx, deployment, owner, 'customer', customerRef);
      const price = await requireBillingBinding(tx, deployment, owner, 'price', priceRef);
      if (!customer.externalSubjectRef || !price.planRef) throw new BillingError('identity_conflict');
      const binding = await bindBillingObject(tx, deployment, owner, { kind: 'subscription', providerRef: subRef, externalSubjectRef: customer.externalSubjectRef,
        planRef: price.planRef, customerBindingId: customer.id, priceBindingId: price.id, bindingEvidenceRef: evidence });
      await bindRecurringObject(tx, { ...deployment, environment: owner.environment, apiVersion: STRIPE_API_VERSION }, {
        merchantId: owner.merchantId, providerAccountId: null, kind: 'subscription', objectRef: subRef, bindingEvidenceRef: evidence });
      return binding;
    });
  }
  async function retrieveCheckout(owner:BillingOwner,checkoutRef:string){
    await authorize(owner);z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/).max(128).parse(checkoutRef);
    const operation=await findBillingCheckoutOperation(db,deployment,checkoutRef);
    if(!operation||operation.merchantId!==owner.merchantId||operation.oxyAppId!==owner.oxyAppId||operation.environment!==owner.environment||!operation.customerBindingId||!operation.priceBindingId)throw new BillingError('not_found',404);
    const customer=await requireBillingBindingById(db,deployment,owner,'customer',operation.customerBindingId);
    const price=await requireBillingBindingById(db,deployment,owner,'price',operation.priceBindingId);
    const value=z.object({id:z.literal(checkoutRef),customer:z.literal(customer.providerRef),mode:z.literal('subscription'),livemode:z.literal(deployment.livemode),status:z.enum(['open','complete','expired']),subscription:z.string().regex(/^sub_[A-Za-z0-9]+$/).nullable()}).parse(await client.retrieveCheckout(checkoutRef));
    if(!customer.externalSubjectRef||!price.planRef||(value.status==='complete')!==(value.subscription!==null))throw new BillingError('identity_conflict');
    const binding=value.subscription?await persistSubscription(owner,value.subscription,customer.providerRef,price.providerRef,operation.id):null;
    const snapshot=binding?normalizeBillingSubscription(await client.retrieveSubscription(binding.providerRef)):null;
    if(snapshot&&(snapshot.providerSubscriptionId!==binding?.providerRef||snapshot.providerCustomerId!==customer.providerRef||snapshot.providerPriceId!==price.providerRef||snapshot.livemode!==deployment.livemode))throw new BillingError('identity_conflict');
    return {id:checkoutRef,status:value.status,storeId:customer.externalSubjectRef,planId:price.planRef,providerCustomerId:customer.providerRef,providerPriceId:price.providerRef,subscription:snapshot?{...snapshot,storeId:customer.externalSubjectRef,planId:price.planRef}:null};
  }
  return {
    retrieveCheckout,
    async retrievePaidInvoice(owner:BillingOwner,subscriptionRef:string,invoiceRef:string){
      await authorize(owner);z.string().regex(/^in_[A-Za-z0-9]+$/).max(128).parse(invoiceRef);
      const subscription=await requireBillingBinding(db,deployment,owner,'subscription',subscriptionRef);
      if(!subscription.customerBindingId||!subscription.priceBindingId||!subscription.externalSubjectRef||!subscription.planRef)throw new BillingError('identity_conflict');
      const customer=await requireBillingBindingById(db,deployment,owner,'customer',subscription.customerBindingId);
      const price=await requireBillingBindingById(db,deployment,owner,'price',subscription.priceBindingId);
      if(customer.externalSubjectRef!==subscription.externalSubjectRef||price.planRef!==subscription.planRef)throw new BillingError('identity_conflict');
      return readOwnedPaidInvoice(client,{invoiceId:invoiceRef,subscriptionId:subscriptionRef,customerId:customer.providerRef,priceId:price.providerRef,storeId:subscription.externalSubjectRef,planId:subscription.planRef,livemode:deployment.livemode});
    },
    async importCustomer(owner: BillingOwner, input: { providerCustomerId: string; storeId: string; evidenceRef: string }) {
      await authorize(owner); const evidence = billingReference.parse(input.evidenceRef);
      const value = z.object({ id: z.string().regex(/^cus_[A-Za-z0-9]+$/), livemode: z.boolean(), deleted: z.literal(false).optional() }).parse(await client.retrieveCustomer(input.providerCustomerId));
      if (value.id !== input.providerCustomerId || value.livemode !== deployment.livemode) throw new BillingError('identity_conflict');
      return bindBillingObject(db, deployment, owner, { kind: 'customer', providerRef: value.id, externalSubjectRef: input.storeId, bindingEvidenceRef: evidence });
    },
    async importPrice(owner: BillingOwner, input: { providerPriceId: string; planId: string; evidenceRef: string }) {
      await authorize(owner); const evidence = billingReference.parse(input.evidenceRef);
      const value = z.object({ id: z.string().regex(/^price_[A-Za-z0-9]+$/), livemode: z.boolean(), active: z.literal(true),
        recurring: z.object({ interval: z.enum(['month', 'year']), interval_count: z.literal(1) }) }).parse(await client.retrievePrice(input.providerPriceId));
      if (value.id !== input.providerPriceId || value.livemode !== deployment.livemode) throw new BillingError('identity_conflict');
      return bindBillingObject(db, deployment, owner, { kind: 'price', providerRef: value.id, planRef: input.planId, bindingEvidenceRef: evidence });
    },
    async importSubscription(owner: BillingOwner, input: { providerSubscriptionId: string; providerCustomerId: string; providerPriceId: string; evidenceRef: string }) {
      await authorize(owner);
      return persistSubscription(owner, input.providerSubscriptionId, input.providerCustomerId, input.providerPriceId, billingReference.parse(input.evidenceRef));
    },
    /** Provider read verifies exact checkout correlation to a locally authorized operation.
     * The caller's subscription ID alone, customer metadata and store metadata confer nothing. */
    async resolveCompletedSubscription(owner: BillingOwner, subscriptionRef: string) {
      await authorize(owner); z.string().regex(/^sub_[A-Za-z0-9]+$/).max(128).parse(subscriptionRef);
      const candidates = z.object({ has_more: z.literal(false), data: z.array(z.object({ id: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/) })).length(1) }).safeParse(await client.listCheckoutsForSubscription(subscriptionRef));
      if (!candidates.success || !candidates.data.data[0]) throw new BillingError('not_found', 404);
      const checkoutRef = candidates.data.data[0].id;
      const operation = await findBillingCheckoutOperation(db, deployment, checkoutRef);
      if (!operation || operation.merchantId !== owner.merchantId || operation.oxyAppId !== owner.oxyAppId || operation.environment !== owner.environment
        || !operation.customerBindingId || !operation.priceBindingId) throw new BillingError('not_found', 404);
      const customer = await requireBillingBindingById(db, deployment, owner, 'customer', operation.customerBindingId);
      const price = await requireBillingBindingById(db, deployment, owner, 'price', operation.priceBindingId);
      const checkout = z.object({ id: z.literal(checkoutRef), customer: z.literal(customer.providerRef), mode: z.literal('subscription'),
        subscription: z.literal(subscriptionRef), status: z.literal('complete'), livemode: z.literal(deployment.livemode) }).safeParse(await client.retrieveCheckout(checkoutRef));
      if (!checkout.success) throw new BillingError('identity_conflict');
      return persistSubscription(owner, subscriptionRef, customer.providerRef, price.providerRef, operation.id);
    },
  };
}
export type VerifiedBillingBindings = ReturnType<typeof createVerifiedBillingBindings>;
