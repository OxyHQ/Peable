import { findMerchantByAppEnvironment } from '../../db/merchants/merchantRepository';
import type { FaircoinRenewalExecutor } from './faircoin-renewal-consumer';
import { createPublicKey } from 'node:crypto';
import type { BillingTaxQuoteCalculator } from './tax-quote';
import type { FinalInvoiceAuthorityReader } from './invoice-authority';
import { z } from 'zod';
import { config } from '../../config';
import type { Database } from '../../db/postgres';
import { stripeBillingClient } from '../providers/stripe/client';
import { billingDeploymentSchema, billingOwnerSchema, billingReference, BillingError } from './contracts';
import { createBillingService } from './billingService';
import { createStripeBillingProvider, type StripeBillingClient } from './stripeBillingProvider';
import { createVerifiedBillingBindings } from './verifiedBindings';
import { createOwnedBillingRecurringReader, createOwnedBillingInvoiceResolver } from './recurringBillingReader';
import { STRIPE_API_VERSION } from '../providers/stripe/client';

const cohortConfiguration = z.object({
  deployment: billingDeploymentSchema,
  faircoinExecutorRef: billingReference.optional(),
  faircoinActors: z.array(z.object({ payerAccountId: billingReference, merchantId: billingReference, appId: billingReference,
    mode: z.enum(['live', 'test']), environment: z.enum(['development', 'staging', 'production']) }).strict()).min(1).max(20).optional(),
  observationsEnabled: z.boolean().default(false),
  taxQuoteAdapterRef: billingReference.optional(),
  finalInvoiceAuthorityAdapterRef: billingReference.optional(),
  portalConfigurationRef: z.string().regex(/^bpc_[A-Za-z0-9]+$/),
  cohorts: z.array(billingOwnerSchema.extend({ evidenceRef: billingReference }).strict()).min(1).max(20),
}).strict();
/** Only trusted deployment composition registers adapters. Configuration selects
 * an existing name; it cannot load arbitrary modules, URLs or provider secrets. */
export interface BillingRuntimeAdapters {
  faircoinExecutors?: Readonly<Record<string, FaircoinRenewalExecutor>>;
  taxQuoteCalculators?: Readonly<Record<string, BillingTaxQuoteCalculator>>;
  finalInvoiceAuthorities?: Readonly<Record<string, FinalInvoiceAuthorityReader>>;
}
function pinnedKeys(keys: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const copy = z.record(billingReference, z.string().min(1)).parse(keys);
  if (Object.keys(copy).length < 1 || Object.keys(copy).length > 20) throw new Error('Fiscal adapter requires pinned verification keys');
  for (const value of Object.values(copy)) {
    if (!value.startsWith('-----BEGIN PUBLIC KEY-----') || createPublicKey(value).asymmetricKeyType !== 'ed25519') throw new Error('Fiscal adapter requires public Ed25519 keys');
  }
  return Object.freeze(copy);
}
/** Boot opt-in. No JSON means no client construction or provider call. */
export async function configureBillingRuntime(db: Database, raw = config.billingCohortConfig, injectedClient?: StripeBillingClient, adapters: BillingRuntimeAdapters = {}) {
  if (raw === undefined) return undefined;
  let parsed: z.infer<typeof cohortConfiguration>;
  try { parsed = cohortConfiguration.parse(JSON.parse(raw)); } catch { throw new Error('Invalid PEABLE_BILLING_COHORT configuration'); }
  if (!!parsed.faircoinExecutorRef !== !!parsed.faircoinActors) throw new Error('Renewal executor requires explicit actor scope');
  const executor = parsed.faircoinExecutorRef && Object.prototype.hasOwnProperty.call(adapters.faircoinExecutors ?? {}, parsed.faircoinExecutorRef) ? adapters.faircoinExecutors?.[parsed.faircoinExecutorRef] : undefined;
  if (parsed.faircoinExecutorRef && !executor) throw new Error('Configured renewal executor is unavailable');
  for (const actor of parsed.faircoinActors ?? []) {
    const merchant = await findMerchantByAppEnvironment(db, actor.appId, actor.environment);
    if (!merchant || merchant.publicId !== actor.merchantId || !parsed.cohorts.some(cohort => cohort.merchantId === merchant.id
      && cohort.oxyAppId === actor.appId && (parsed.deployment.livemode ? 'live' : 'test') === actor.mode
      && cohort.environment === actor.environment)) throw new Error('Renewal actor is outside configured cohorts');
  }
  const renewals = executor && parsed.faircoinActors ? { db, executor, actors: structuredClone(parsed.faircoinActors) } : undefined;
  const selectedTax = parsed.taxQuoteAdapterRef && Object.prototype.hasOwnProperty.call(adapters.taxQuoteCalculators ?? {}, parsed.taxQuoteAdapterRef) ? adapters.taxQuoteCalculators?.[parsed.taxQuoteAdapterRef] : undefined;
  const selectedInvoice = parsed.finalInvoiceAuthorityAdapterRef && Object.prototype.hasOwnProperty.call(adapters.finalInvoiceAuthorities ?? {}, parsed.finalInvoiceAuthorityAdapterRef) ? adapters.finalInvoiceAuthorities?.[parsed.finalInvoiceAuthorityAdapterRef] : undefined;
  if (parsed.taxQuoteAdapterRef && !selectedTax || parsed.finalInvoiceAuthorityAdapterRef && !selectedInvoice) throw new Error('Configured fiscal adapter is unavailable');
  const taxQuoteCalculator = selectedTax ? { ...selectedTax,
    resolveProduct: (owner: Parameters<BillingTaxQuoteCalculator['resolveProduct']>[0], plan: string) => selectedTax.resolveProduct(owner, plan),
    readCustomerLocation: (owner: Parameters<BillingTaxQuoteCalculator['readCustomerLocation']>[0], evidence: string) => selectedTax.readCustomerLocation(owner, evidence),
    calculate: (input: Parameters<BillingTaxQuoteCalculator['calculate']>[0]) => selectedTax.calculate(input),
    verificationKeys: pinnedKeys(selectedTax.verificationKeys),
  } : undefined;
  const finalInvoiceAuthority = selectedInvoice ? { read: (input: Parameters<FinalInvoiceAuthorityReader['read']>[0]) => selectedInvoice.read(input), verificationKeys: pinnedKeys(selectedInvoice.verificationKeys) } : undefined;
  if (!injectedClient && (!config.stripe.secretKey || config.stripe.keyMode === 'unknown')) throw new Error('Recurring billing requires the configured platform Stripe key');
  const client = injectedClient ?? stripeBillingClient();
  const cohorts = parsed.cohorts.map((owner) => ({ ...owner, ...parsed.deployment }));
  if (cohorts.some((owner) => (owner.environment === 'production') !== parsed.deployment.livemode)) throw new BillingError('identity_conflict');
  const provider = createStripeBillingProvider(parsed.deployment, client, { portalConfigurationRef: parsed.portalConfigurationRef });
  // An invalid account or unsafe Portal setting is a boot failure before listening.
  await provider.verifyDeployment(); await provider.verifyPortalConfiguration();
  const verifiedBindings = createVerifiedBillingBindings({ db, client, deployment: parsed.deployment, cohorts });
  const service = createBillingService({ db, provider, cohorts, verifiedBindings, taxQuoteCalculator, finalInvoiceAuthority });
  // No recurring queue access until the reviewed cohort explicitly opts in.
  if (!parsed.observationsEnabled) return { service, renewals };
  const environment = cohorts[0]?.environment;
  if (!environment || cohorts.some((cohort) => cohort.environment !== environment)) {
    throw new Error('Recurring observations require one deployment environment');
  }
  return {
    service, renewals,
    observations: {
      deployment: { ...parsed.deployment, environment, apiVersion: STRIPE_API_VERSION },
      reader: createOwnedBillingRecurringReader({ db, bindings: verifiedBindings, client }),
      bindOwnedInvoice: createOwnedBillingInvoiceResolver({ db, bindings: verifiedBindings, client }),
    },
    relay: { enabled: true, db, cohorts },
  };
}
