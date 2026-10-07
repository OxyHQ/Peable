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
  portalConfigurationRef: z.string().regex(/^bpc_[A-Za-z0-9]+$/),
  cohorts: z.array(billingOwnerSchema.extend({ evidenceRef: billingReference }).strict()).min(1).max(20),
}).strict();
/** Boot opt-in. No JSON means no client construction or provider call. */
export async function configureBillingRuntime(db: Database, raw = config.billingCohortConfig, injectedClient?: StripeBillingClient) {
  if (raw === undefined) return undefined;
  let parsed: z.infer<typeof cohortConfiguration>;
  try { parsed = cohortConfiguration.parse(JSON.parse(raw)); } catch { throw new Error('Invalid PEABLE_BILLING_COHORT configuration'); }
  if (!injectedClient && (!config.stripe.secretKey || config.stripe.keyMode === 'unknown')) throw new Error('Recurring billing requires the configured platform Stripe key');
  const client = injectedClient ?? stripeBillingClient();
  const cohorts = parsed.cohorts.map((owner) => ({ ...owner, ...parsed.deployment }));
  if (cohorts.some((owner) => (owner.environment === 'production') !== parsed.deployment.livemode)) throw new BillingError('identity_conflict');
  const provider = createStripeBillingProvider(parsed.deployment, client, { portalConfigurationRef: parsed.portalConfigurationRef });
  // An invalid account or unsafe Portal setting is a boot failure before listening.
  await provider.verifyDeployment(); await provider.verifyPortalConfiguration();
  const verifiedBindings = createVerifiedBillingBindings({ db, client, deployment: parsed.deployment, cohorts });
  const service = createBillingService({ db, provider, cohorts, verifiedBindings });
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
