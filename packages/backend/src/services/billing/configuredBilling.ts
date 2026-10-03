import { z } from 'zod';
import { config } from '../../config';
import type { Database } from '../../db/postgres';
import { stripeBillingClient } from '../providers/stripe/client';
import { billingDeploymentSchema, billingOwnerSchema, billingReference, BillingError } from './contracts';
import { createBillingService } from './billingService';
import { createStripeBillingProvider, type StripeBillingClient } from './stripeBillingProvider';
import { createVerifiedBillingBindings } from './verifiedBindings';

const cohortConfiguration = z.object({
  deployment: billingDeploymentSchema,
  portalConfigurationRef: z.string().regex(/^bpc_[A-Za-z0-9]+$/),
  cohorts: z.array(billingOwnerSchema.extend({ evidenceRef: billingReference }).strict()).min(1).max(20),
}).strict();
/** Boot opt-in. No JSON means no client construction or provider call. */
export async function configureBilling(db: Database, raw = config.billingCohortConfig, injectedClient?: StripeBillingClient) {
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
  return createBillingService({ db, provider, cohorts, verifiedBindings });
}
