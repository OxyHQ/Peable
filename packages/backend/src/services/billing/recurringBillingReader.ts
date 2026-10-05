import {z} from 'zod';
import type {Database} from '../../db/postgres';
import {recurringMirrors} from '../../db/schema';
import {mirrorIdentity} from '../../db/recurring/recurringMirrorRepository';
import {requireBillingBinding} from '../../db/billing/billingRepository';
import type {VerifiedBillingBindings} from './verifiedBindings';
import type {RecurringReader,RecurringReadRequest} from '../recurring/contracts';
import {normalizeBillingSubscription,type StripeBillingClient} from './stripeBillingProvider';
/** Read-only approved composition. Uses existing owner-bound reads; no timer,
 * imports from event metadata, mandates, catalogue creation or new credentials. */
export function createOwnedBillingRecurringReader(options:{db:Database;bindings:VerifiedBillingBindings;client:StripeBillingClient}):RecurringReader{
 return {async readSnapshot(request:RecurringReadRequest){
  if(request.signal.aborted)throw new Error('Observation aborted');
  const [mirror]=await options.db.select().from(recurringMirrors).where(mirrorIdentity(request.deployment,request.kind,request.objectRef,request.providerAccountId));
  if(!mirror)throw new Error('Unknown owned recurring object');
  const billingDeployment={provider:request.deployment.provider,platformAccountId:request.deployment.platformAccountId,livemode:request.deployment.livemode};
  const owner={merchantId:mirror.merchantId,oxyAppId:mirror.oxyAppId,environment:mirror.environment as 'development'|'staging'|'production'};
  const identity={schemaVersion:1,provider:request.deployment.provider,platformAccountId:request.deployment.platformAccountId,providerAccountId:request.providerAccountId,livemode:request.deployment.livemode,apiVersion:request.deployment.apiVersion,objectRef:request.objectRef};
  if(request.kind==='subscription'){
   const binding=await requireBillingBinding(options.db,billingDeployment,owner,'subscription',request.objectRef);
   if(!binding.customerBindingId||!binding.priceBindingId)throw new Error('Subscription mapping differs');
   // Gateway bindings reverify customer/price/store separately through retrieveInvoiceState.
   const sub=normalizeBillingSubscription(await options.client.retrieveSubscription(request.objectRef));
   if(sub.providerSubscriptionId!==request.objectRef||sub.livemode!==request.deployment.livemode)throw new Error('Subscription identity differs');
   const customer=await requireBillingBinding(options.db,billingDeployment,owner,'customer',sub.providerCustomerId);const price=await requireBillingBinding(options.db,billingDeployment,owner,'price',sub.providerPriceId);
   if(customer.id!==binding.customerBindingId||price.id!==binding.priceBindingId||customer.externalSubjectRef!==binding.externalSubjectRef||price.planRef!==binding.planRef)throw new Error('Subscription ownership differs');
   return {...identity,kind:'subscription',status:sub.status,cancelAtPeriodEnd:sub.cancelAtPeriodEnd,periods:[{itemRef:'owned_subscription',start:sub.currentPeriodStart,end:sub.currentPeriodEnd}],hasMorePeriods:false};
  }
  if(!options.client.retrieveInvoice)throw new Error('Invoice reader unavailable');
  const root=z.object({id:z.literal(request.objectRef),parent:z.object({subscription_details:z.object({subscription:z.string().min(1)})})}).parse(await options.client.retrieveInvoice(request.objectRef));
  const value=await options.bindings.retrieveInvoiceState(owner,root.parent.subscription_details.subscription,request.objectRef,false,request.signal);
  if(request.signal.aborted)throw new Error('Observation aborted');
  return {...identity,kind:'invoice',subscriptionRef:value.providerSubscriptionId,status:'paid',currency:value.currency,amountDue:value.amountPaid,amountPaid:value.amountPaid,amountRemaining:'0',amountRefunded:value.amountRefunded,paymentIntentRef:value.paymentIntentId,chargeRef:value.chargeId,periods:[{itemRef:value.lineId,start:value.periodStart,end:value.periodEnd}],hasMorePeriods:false};
 }};
}

/** An invoice can be discovered only by its provider parent and an EXISTING
 * subscription mirror established by owned checkout/import. Verified bindings
 * then prove customer/price/merchant/cohort/mode before creating the invoice mirror.
 * Metadata, event amounts and caller-supplied owner never participate. */
export function createOwnedBillingInvoiceResolver(options:{db:Database;bindings:VerifiedBillingBindings;client:StripeBillingClient}){
 return async(request:RecurringReadRequest)=>{
  if(request.signal.aborted)throw new Error('Invoice discovery aborted');
  if(request.kind!=='invoice'||request.providerAccountId!==null||!options.client.retrieveInvoice)throw new Error('Invoice discovery scope unavailable');
  const root=z.object({id:z.literal(request.objectRef),livemode:z.literal(request.deployment.livemode),parent:z.object({subscription_details:z.object({subscription:z.string().min(1)})})}).parse(await options.client.retrieveInvoice(request.objectRef));
  const [parent]=await options.db.select().from(recurringMirrors).where(mirrorIdentity(request.deployment,'subscription',root.parent.subscription_details.subscription,null));
  if(!parent||parent.environment!==request.deployment.environment)throw new Error('Unknown invoice parent');
  await options.bindings.retrieveInvoiceState({merchantId:parent.merchantId,oxyAppId:parent.oxyAppId,environment:parent.environment as 'development'|'staging'|'production'},root.parent.subscription_details.subscription,request.objectRef,true,request.signal);
 };
}
