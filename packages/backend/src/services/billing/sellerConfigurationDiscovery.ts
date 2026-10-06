import {z} from 'zod';
import type {StripeBillingClient} from './stripeBillingProvider';
import {STRIPE_API_VERSION} from '../providers/stripe/client';
import type {BillingCohort} from './billingService';
/** Read-only operator discovery, not a tax quote, legal registration verification,
 * merchant-of-record appointment or seller authorization. No legal names/addresses
 * or registration numbers are returned/persisted. No route or boot invocation. */
export async function discoverSellerConfiguration(client:StripeBillingClient,cohort:BillingCohort){
 if(!cohort.evidenceRef||client.scope!=='platform'||client.apiVersion!==STRIPE_API_VERSION||client.livemode!==cohort.livemode||(cohort.environment==='production')!==cohort.livemode)throw new Error('Discovery scope differs');
 const account=z.object({id:z.literal(cohort.platformAccountId)});
 account.parse(await client.account());
 if(!client.retrieveTaxSettings||!client.listTaxRegistrations)return {status:'unconfigured' as const,seller:'unverified' as const,invoiceIssuer:'unverified' as const};
 const settings=z.object({object:z.literal('tax.settings'),livemode:z.literal(cohort.livemode),status:z.enum(['active','pending']),defaults:z.object({provider:z.string().min(1),tax_behavior:z.enum(['inclusive','exclusive','inferred_by_currency']).nullable(),tax_code:z.string().nullable()})}).parse(await client.retrieveTaxSettings());
 const registrations:Array<{id:string;country:string;status:string;activeFrom:number;expiresAt:number|null}>=[];let cursor:string|undefined;
 for(let n=0;n<20;n++){
  const page=z.object({has_more:z.boolean(),data:z.array(z.object({id:z.string().min(1),object:z.literal('tax.registration'),livemode:z.literal(cohort.livemode),country:z.string().regex(/^[A-Z]{2}$/),status:z.enum(['active','expired','scheduled']),active_from:z.number().int().nonnegative(),expires_at:z.number().int().nonnegative().nullable()})).max(100)}).parse(await client.listTaxRegistrations(cursor));
  for(const v of page.data){if(registrations.some(r=>r.id===v.id))throw new Error('Discovery pagination differs');registrations.push({id:v.id,country:v.country,status:v.status,activeFrom:v.active_from,expiresAt:v.expires_at});}
  if(!page.has_more){account.parse(await client.account());return {status:'observed' as const,scope:{merchantId:cohort.merchantId,appId:cohort.oxyAppId,environment:cohort.environment,livemode:cohort.livemode,platformAccountId:cohort.platformAccountId},providerTaxSettings:{status:settings.status,defaults:settings.defaults},providerTaxRegistrations:registrations,seller:'unverified' as const,invoiceIssuer:'unverified' as const,taxRemitter:'unverified' as const,observedAt:new Date().toISOString()};}
  const last=page.data.at(-1);if(!last||last.id===cursor)throw new Error('Discovery pagination differs');cursor=last.id;
 }throw new Error('Discovery pagination incomplete');
}

/** Exact owned invoice configuration only. Provider `self` identifies its account
 * scope, not a contracting legal seller or tax remitter. No names/addresses copied. */
export async function discoverOwnedInvoiceConfiguration(options:{client:StripeBillingClient;bindings:import('./verifiedBindings').VerifiedBillingBindings;owner:import('./contracts').BillingOwner;subscriptionId:string;invoiceId:string}){
 const paid=await options.bindings.retrieveInvoiceState(options.owner,options.subscriptionId,options.invoiceId);
 if(!options.client.retrieveInvoice)throw new Error('Invoice configuration unconfigured');
 const account=z.string().regex(/^acct_[A-Za-z0-9]+$/);
 const role=z.discriminatedUnion('type',[z.object({type:z.literal('self')}),z.object({type:z.literal('account'),account})]);
 const schema=z.object({id:z.literal(paid.invoiceId),customer:z.literal(paid.providerCustomerId),livemode:z.literal(paid.livemode),issuer:role,on_behalf_of:account.nullable(),automatic_tax:z.object({enabled:z.boolean(),status:z.string().nullable(),provider:z.string().nullable(),liability:role.nullable()})});
 const observed=schema.parse(await options.client.retrieveInvoice(options.invoiceId));
 if(JSON.stringify(observed)!==JSON.stringify(schema.parse(await options.client.retrieveInvoice(options.invoiceId))))throw new Error('Invoice configuration changed');
 return {status:'observed' as const,source:{invoiceId:paid.invoiceId,paymentIntentId:paid.paymentIntentId,customerId:paid.providerCustomerId,subscriptionId:paid.providerSubscriptionId,priceId:paid.providerPriceId,merchantId:options.owner.merchantId,appId:options.owner.oxyAppId,environment:options.owner.environment,livemode:paid.livemode},providerInvoiceIssuer:observed.issuer,providerOnBehalfOf:observed.on_behalf_of,providerAutomaticTax:observed.automatic_tax,legalSeller:'unverified' as const,legalInvoiceIssuer:'unverified' as const,taxRemitter:'unverified' as const,observedAt:new Date().toISOString()};
}
