import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalBillingTaxQuote, type BillingTaxQuote } from '@peable.to/shared-types';
import { billingOwnerSchema, BillingError } from './contracts';
import {
  billingTaxProductSchema,
  billingCustomerLocationSchema,
  type BillingTaxQuoteCalculator,
} from './tax-quote';

/** Deployment-owned business declarations, never browser data or guessed tax.
 * Every jurisdiction/rate and location must have a reviewed evidence reference. */
export const configuredFiscalAuthoritySchema = z
  .object({
    keyId: z.string().min(1),
    quoteLifetimeSeconds: z.number().int().min(30).max(900),
    declarations: z
      .array(
        z
          .object({
            owner: billingOwnerSchema,
            sellerLegalEntity: z
              .object({
                legalName: z.string().min(1),
                taxIdentifier: z.string().min(1),
                registrationJurisdiction: z.string().min(1),
              })
              .strict()
              .refine(
                (value) => value.taxIdentifier !== value.legalName,
                'A legal name is not a tax identifier',
              ),
            product: billingTaxProductSchema,
            rates: z
              .array(
                z
                  .object({
                    country: z.string().regex(/^[A-Z]{2}$/),
                    rateNumerator: z.number().int().nonnegative().safe(),
                    rateDenominator: z.number().int().positive().safe(),
                    rounding: z.literal('half_up_minor_unit'),
                    evidenceId: z.string().min(1),
                    validFrom: z.string().datetime(),
                    validUntil: z.string().datetime(),
                  })
                  .strict(),
              )
              .min(1),
            locations: z.array(billingCustomerLocationSchema),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function createConfiguredFiscalAuthority(
  raw: z.input<typeof configuredFiscalAuthoritySchema>,
  signingKey: string | KeyObject,
  now: () => Date = () => new Date(),
): BillingTaxQuoteCalculator {
  const configuration = configuredFiscalAuthoritySchema.parse(raw);
  const key = typeof signingKey === 'string' ? createPrivateKey(signingKey) : signingKey;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519')
    throw new Error('Fiscal authority signing key must be Ed25519');
  const ownerMatches = (
    left: z.infer<typeof billingOwnerSchema>,
    right: z.infer<typeof billingOwnerSchema>,
  ) =>
    left.merchantId === right.merchantId &&
    left.oxyAppId === right.oxyAppId &&
    left.environment === right.environment;
  function declaration(owner: z.infer<typeof billingOwnerSchema>, planId: string) {
    const matches = configuration.declarations.filter(
      (value) => ownerMatches(value.owner, owner) && value.product.planId === planId,
    );
    if (matches.length !== 1 || !matches[0]) throw new BillingError('not_found', 404);
    return matches[0];
  }
  return {
    verificationKeys: {
      [configuration.keyId]: createPublicKey(key)
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    },
    async resolveProduct(owner, planId) {
      return structuredClone(declaration(owner, planId).product);
    },
    async readCustomerLocation(owner, evidenceId) {
      const matches = configuration.declarations
        .filter((value) => ownerMatches(value.owner, owner))
        .flatMap((value) => value.locations)
        .filter((value) => value.id === evidenceId);
      const unique = [...new Map(matches.map((value) => [JSON.stringify(value), value])).values()];
      if (unique.length !== 1) throw new BillingError('not_found', 404);
      return structuredClone(unique[0]);
    },
    async calculate({ source, product, location }) {
      const matches = configuration.declarations.filter(
        (value) =>
          value.product.planId === source.planId &&
          value.owner.oxyAppId === source.appId &&
          value.owner.environment === source.environment &&
          value.product.sellerId === product.sellerId &&
          value.locations.some(
            (candidate) => candidate.id === location.id && candidate.storeId === source.storeId,
          ),
      );
      if (matches.length !== 1 || !matches[0] || product.taxTreatment !== 'inclusive')
        throw new BillingError('not_found', 404);
      const current = now();
      const rates = matches[0].rates.filter(
        (rate) =>
          rate.country === location.country &&
          Date.parse(rate.validFrom) <= +current &&
          Date.parse(rate.validUntil) > +current,
      );
      if (rates.length !== 1 || !rates[0]) throw new BillingError('not_found', 404);
      const rate = rates[0];
      // Reviewed inclusive rate and rounding; zero is valid only if explicitly
      // declared with its own jurisdiction evidence, never as a missing-data default.
      const divisor = BigInt(rate.rateDenominator) + BigInt(rate.rateNumerator);
      const numerator = BigInt(product.grossMinorUnits) * BigInt(rate.rateDenominator);
      const netMinorUnits = Number((2n * numerator + divisor) / (2n * divisor));
      const expiresAt = new Date(
        Math.min(
          +current + configuration.quoteLifetimeSeconds * 1000,
          Date.parse(rate.validUntil),
          Date.parse(location.expiresAt),
        ),
      ).toISOString();
      if (Date.parse(expiresAt) <= +current) throw new BillingError('not_found', 404);
      const quote = {
        currency: product.currency,
        grossMinorUnits: product.grossMinorUnits,
        netMinorUnits,
        taxMinorUnits: product.grossMinorUnits - netMinorUnits,
        taxTreatment: 'inclusive' as const,
        sellerId: product.sellerId,
        invoiceIssuerId: product.invoiceIssuerId,
        taxRemitterId: product.taxRemitterId,
        taxServiceRef: product.taxServiceRef,
        country: location.country,
        coverageEvidenceId: product.coverageEvidenceId,
        taxRateEvidenceId: rate.evidenceId,
        customerLocationEvidenceId: location.id,
        quotedAt: current.toISOString(),
        expiresAt,
      };
      const result: BillingTaxQuote = {
        schemaVersion: 1,
        source,
        quote: {
          id: `tax_${createHash('sha256').update(JSON.stringify({ source, quote })).digest('hex')}`,
          ...quote,
        },
        signature: { algorithm: 'Ed25519', keyId: configuration.keyId, value: '' },
      };
      result.signature.value = sign(
        null,
        Buffer.from(canonicalBillingTaxQuote(result)),
        key,
      ).toString('base64url');
      return result;
    },
  };
}
