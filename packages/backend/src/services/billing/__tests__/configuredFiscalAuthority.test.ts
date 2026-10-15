import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  createConfiguredFiscalAuthority,
  configuredFiscalAuthoritySchema,
} from '../configuredFiscalAuthority';
import { createVerifiedBillingTaxQuote } from '../tax-quote';

function fixture() {
  const now = new Date('2026-10-15T12:00:00Z');
  const owner = {
    merchantId: 'internal_fixture',
    oxyAppId: 'app_fixture',
    environment: 'development' as const,
  };
  const request = {
    storeId: 'payer_fixture',
    planId: 'plan_fixture',
    customerLocationEvidenceId: 'location_fixture',
  };
  const configuration = configuredFiscalAuthoritySchema.parse({
    keyId: 'fixture',
    quoteLifetimeSeconds: 300,
    declarations: [
      {
        owner,
        sellerLegalEntity: {
          legalName: 'Synthetic fixture only',
          taxIdentifier: 'SYNTHETIC-ID',
          registrationJurisdiction: 'SYNTHETIC',
        },
        product: {
          configurationApproved: true,
          planId: request.planId,
          currency: 'USD',
          grossMinorUnits: 2999,
          taxTreatment: 'inclusive',
          sellerId: 'seller_fixture',
          invoiceIssuerId: 'issuer_fixture',
          taxRemitterId: 'remitter_fixture',
          taxServiceRef: 'reviewed_fixture',
          allowedCountries: ['RO'],
          coverageEvidenceId: 'coverage_fixture',
        },
        rates: [
          {
            country: 'RO',
            rateNumerator: 1,
            rateDenominator: 5,
            rounding: 'half_up_minor_unit',
            evidenceId: 'SYNTHETIC_NOT_REAL_TAX',
            validFrom: '2026-10-15T00:00:00Z',
            validUntil: '2026-10-16T00:00:00Z',
          },
        ],
        locations: [
          {
            id: request.customerLocationEvidenceId,
            storeId: request.storeId,
            appId: owner.oxyAppId,
            country: 'RO',
            mode: 'test',
            environment: owner.environment,
            observedAt: now.toISOString(),
            expiresAt: new Date(+now + 120_000).toISOString(),
          },
        ],
      },
    ],
  });
  const { privateKey } = generateKeyPairSync('ed25519');
  return { now, owner, request, configuration, privateKey };
}
describe('reviewed fiscal declarations', () => {
  it('signs the existing owned authority contract with exact inclusive rounding and evidence expiry', async () => {
    const f = fixture();
    const calculator = createConfiguredFiscalAuthority(f.configuration, f.privateKey, () => f.now);
    const result = await createVerifiedBillingTaxQuote(
      calculator,
      f.owner,
      'merch_fixture',
      f.request,
      () => f.now,
    );
    expect(result.quote.netMinorUnits).toBe(2499);
    expect(result.quote.taxMinorUnits).toBe(500);
    expect(result.quote.expiresAt).toBe(new Date(+f.now + 120_000).toISOString());
    expect(result.signature.keyId).toBe('fixture');
    await expect(
      createVerifiedBillingTaxQuote(
        calculator,
        { ...f.owner, merchantId: 'foreign' },
        'merch_foreign',
        f.request,
        () => f.now,
      ),
    ).rejects.toThrow();
    await expect(
      createVerifiedBillingTaxQuote(
        calculator,
        f.owner,
        'merch_fixture',
        { ...f.request, storeId: 'foreign' },
        () => f.now,
      ),
    ).rejects.toThrow();
  });
  it('never supplies absent rates, country coverage, customer evidence, or signing authority', async () => {
    const f = fixture();
    expect(() =>
      configuredFiscalAuthoritySchema.parse({
        ...f.configuration,
        declarations: [{ ...f.configuration.declarations[0], rates: [] }],
      }),
    ).toThrow();
    const expired = createConfiguredFiscalAuthority(
      f.configuration,
      f.privateKey,
      () => new Date(+f.now + 86_400_000),
    );
    await expect(
      createVerifiedBillingTaxQuote(
        expired,
        f.owner,
        'merch_fixture',
        f.request,
        () => new Date(+f.now + 86_400_000),
      ),
    ).rejects.toThrow();
    const missing = {
      ...f.configuration,
      declarations: f.configuration.declarations.map((d) => ({ ...d, locations: [] })),
    };
    await expect(
      createVerifiedBillingTaxQuote(
        createConfiguredFiscalAuthority(missing, f.privateKey, () => f.now),
        f.owner,
        'merch_fixture',
        f.request,
        () => f.now,
      ),
    ).rejects.toThrow();
  });
});
