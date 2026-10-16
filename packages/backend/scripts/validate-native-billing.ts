import { readFile } from 'node:fs/promises';
import { PEABLE_BILLING_AUTHORITY_KEYS } from '@peable.to/shared-types';
import { faircoinBillingConfigurationSchema } from '../src/services/billing/faircoinBillingService';
import { configuredFiscalAuthoritySchema } from '../src/services/billing/configuredFiscalAuthority';

const [cohortFile, fiscalFile] = process.argv.slice(2);
if (!cohortFile || !fiscalFile)
  throw new Error(
    'Usage: bun scripts/validate-native-billing.ts <cohort.json> <reviewed-fiscal.json>',
  );
// Either the native rail alone, or the multi-rail `{ rails: [...] }` shape.
const parsedCohort = JSON.parse(await readFile(cohortFile, 'utf8'));
const entries: Record<string, unknown>[] = Array.isArray(parsedCohort.rails)
  ? parsedCohort.rails
  : [parsedCohort];
const native = entries.filter((entry) => entry.rail === 'faircoin');
if (native.length !== 1 || !native[0]) throw new Error('Expected one native FairCoin rail');
const { rail: _rail, ...raw } = native[0];
const cohort = faircoinBillingConfigurationSchema.parse(raw);
const fiscal = configuredFiscalAuthoritySchema.parse(
  JSON.parse(await readFile(fiscalFile, 'utf8')),
);
if (fiscal.keyId !== cohort.invoiceSigningKeyId)
  throw new Error('Tax quotes and invoices must be signed under the same pinned key id');
if (!Object.hasOwn(PEABLE_BILLING_AUTHORITY_KEYS, cohort.invoiceSigningKeyId))
  throw new Error('invoiceSigningKeyId must name a key pinned in PEABLE_BILLING_AUTHORITY_KEYS');
for (const owner of cohort.cohorts)
  for (const offer of owner.offers) {
    const matches = fiscal.declarations.filter(
      (d) =>
        d.owner.merchantId === owner.merchantId &&
        d.owner.oxyAppId === owner.oxyAppId &&
        d.owner.environment === owner.environment &&
        d.product.planId === offer.planId &&
        d.product.currency === offer.currency &&
        d.product.grossMinorUnits === offer.grossMinorUnits &&
        d.product.taxTreatment === offer.taxTreatment,
    );
    if (matches.length !== 1)
      throw new Error('Each offer requires one exact reviewed fiscal declaration');
  }
console.log(
  'Native cohort and fiscal declaration shapes and price bindings are valid. This does not verify legal correctness, merchant ownership, signing keys, Explorer availability or chain settlement.',
);
