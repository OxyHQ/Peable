import { readFile } from 'node:fs/promises';
import { faircoinBillingConfigurationSchema } from '../src/services/billing/faircoinBillingService';
import { configuredFiscalAuthoritySchema } from '../src/services/billing/configuredFiscalAuthority';

const [cohortFile, fiscalFile] = process.argv.slice(2);
if (!cohortFile || !fiscalFile)
  throw new Error(
    'Usage: bun scripts/validate-native-billing.ts <cohort.json> <reviewed-fiscal.json>',
  );
const { rail, ...raw } = JSON.parse(await readFile(cohortFile, 'utf8'));
if (rail !== 'faircoin') throw new Error('Expected native FairCoin rail');
const cohort = faircoinBillingConfigurationSchema.parse(raw);
const fiscal = configuredFiscalAuthoritySchema.parse(
  JSON.parse(await readFile(fiscalFile, 'utf8')),
);
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
