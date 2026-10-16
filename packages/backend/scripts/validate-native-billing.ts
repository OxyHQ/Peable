import { readFile } from 'node:fs/promises';
import { PEABLE_BILLING_AUTHORITY_KEYS } from '@peable.to/shared-types';
import { faircoinBillingConfigurationSchema } from '../src/services/billing/faircoinBillingService';
import { PEABLE_TAX_SERVICE_REF } from '../src/services/tax/billingTaxQuotes';

const [cohortFile] = process.argv.slice(2);
if (!cohortFile) throw new Error('Usage: bun scripts/validate-native-billing.ts <cohort.json>');
// Either the native rail alone, or the multi-rail `{ rails: [...] }` shape.
const parsedCohort = JSON.parse(await readFile(cohortFile, 'utf8'));
const entries: Record<string, unknown>[] = Array.isArray(parsedCohort.rails)
  ? parsedCohort.rails
  : [parsedCohort];
const native = entries.filter((entry) => entry.rail === 'faircoin');
if (native.length !== 1 || !native[0]) throw new Error('Expected one native FairCoin rail');
const { rail: _rail, ...raw } = native[0];
const cohort = faircoinBillingConfigurationSchema.parse(raw);
if (cohort.taxQuoteAdapterRef !== PEABLE_TAX_SERVICE_REF)
  throw new Error(
    `taxQuoteAdapterRef must be "${PEABLE_TAX_SERVICE_REF}": quotes come from Peable Tax`,
  );
if (!Object.hasOwn(PEABLE_BILLING_AUTHORITY_KEYS, cohort.invoiceSigningKeyId))
  throw new Error('invoiceSigningKeyId must name a key pinned in PEABLE_BILLING_AUTHORITY_KEYS');
for (const owner of cohort.cohorts) {
  const plans = owner.offers.map((offer) => `${offer.planId}:${offer.providerPriceId}`);
  if (new Set(plans).size !== plans.length) throw new Error('Each plan/price is offered once');
}
console.log(
  'Native cohort shape is valid. Tax readiness is per merchant: its owner must approve Peable Tax settings (GET /v1/tax/settings shows status). This does not verify merchant ownership, the signing key mount, Explorer availability or chain settlement.',
);
