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
  observationsEnabled: z.boolean().default(false),
  taxQuoteAdapterRef: billingReference.optional(),
  finalInvoiceAuthorityAdapterRef: billingReference.optional(),
  portalConfigurationRef: z.string().regex(/^bpc_[A-Za-z0-9]+$/),
  cohorts: z.array(billingOwnerSchema.extend({ evidenceRef: billingReference }).strict()).min(1).max(20),
}).strict();
/** Only trusted deployment composition registers adapters. Configuration selects
 * an existing name; it cannot load arbitrary modules, URLs or provider secrets. */
export interface BillingRuntimeAdapters {
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
  if (!parsed.observationsEnabled) return { service };
  const environment = cohorts[0]?.environment;
  if (!environment || cohorts.some((cohort) => cohort.environment !== environment)) {
    throw new Error('Recurring observations require one deployment environment');
  }
  return {
    service,
    observations: {
      deployment: { ...parsed.deployment, environment, apiVersion: STRIPE_API_VERSION },
      reader: createOwnedBillingRecurringReader({ db, bindings: verifiedBindings, client }),
      bindOwnedInvoice: createOwnedBillingInvoiceResolver({ db, bindings: verifiedBindings, client }),
    },
    relay: { enabled: true, db, cohorts },
  };
}
