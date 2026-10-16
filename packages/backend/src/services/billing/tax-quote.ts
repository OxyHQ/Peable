import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalBillingTaxQuote,
  type BillingTaxQuote,
  type CreateBillingTaxQuoteParams,
} from '@peable.to/shared-types';
import {
  billingRailId,
  billingReference,
  billingTaxQuoteSchema,
  BillingError,
  type BillingOwner,
} from './contracts';

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime();
const mode = z.enum(['test', 'live']);
const environment = z.enum(['development', 'staging', 'production']);
const country = z.string().regex(/^[A-Z]{2}$/);
export const billingTaxQuoteRequestSchema = z
  .object({
    rail: billingRailId.optional(),
    storeId: billingReference,
    planId: billingReference,
    providerPriceId: billingReference.optional(),
    customerLocationEvidenceId: billingReference,
  })
  .strict();
export const billingTaxProductSchema = z
  .object({
    configurationApproved: z.literal(true),
    planId: billingReference,
    currency: z.string().regex(/^[A-Z]{3}$/),
    grossMinorUnits: amount,
    taxTreatment: z.enum(['inclusive', 'exclusive']),
    sellerId: billingReference,
    invoiceIssuerId: billingReference,
    taxRemitterId: billingReference,
    taxServiceRef: billingReference,
    /** Absent: every country (a jurisdiction without a registration is quoted
     * at zero tax, recorded as not registered). */
    allowedCountries: z
      .array(country)
      .min(1)
      .max(250)
      .refine((values) => new Set(values).size === values.length, 'Duplicate countries')
      .optional(),
    /** Absent: coverage is decided per sale, by the registration that covers it. */
    coverageEvidenceId: billingReference.optional(),
  })
  .strict();
export const billingCustomerLocationSchema = z
  .object({
    id: billingReference,
    storeId: billingReference,
    appId: billingReference,
    mode,
    environment,
    country,
    observedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict();
export type BillingTaxProductConfiguration = z.infer<typeof billingTaxProductSchema>;
export type BillingVerifiedCustomerLocation = z.infer<typeof billingCustomerLocationSchema>;
export interface BillingTaxQuoteCalculator {
  /** The product as sold: its price, tax treatment and seller. `providerPriceId`
   * selects one offer when a plan is sold at several prices. */
  resolveProduct(owner: BillingOwner, planId: string, providerPriceId?: string): Promise<unknown>;
  /** Trusted location evidence lookup, never country from the request itself. */
  readCustomerLocation(owner: BillingOwner, evidenceId: string): Promise<unknown>;
  /** Provider-neutral calculator seam; no supplier selected by this interface. */
  calculate(input: {
    source: BillingTaxQuote['source'];
    product: BillingTaxProductConfiguration;
    location: BillingVerifiedCustomerLocation;
  }): Promise<unknown>;
  verificationKeys: Readonly<Record<string, string>>;
}

/** Fiscal calculation stays behind Peable. Missing/unsupported jurisdiction,
 * issuer/remitter or evidence fails before invoking a supplier. */
export async function createVerifiedBillingTaxQuote(
  calculator: BillingTaxQuoteCalculator,
  owner: BillingOwner,
  merchantPublicId: string,
  raw: CreateBillingTaxQuoteParams,
  now: () => Date = () => new Date(),
): Promise<BillingTaxQuote> {
  const request = billingTaxQuoteRequestSchema.parse(raw);
  const product = billingTaxProductSchema.parse(
    await calculator.resolveProduct(owner, request.planId, request.providerPriceId),
  );
  const location = billingCustomerLocationSchema.parse(
    await calculator.readCustomerLocation(owner, request.customerLocationEvidenceId),
  );
  const clock = now();
  if (
    product.planId !== request.planId ||
    location.id !== request.customerLocationEvidenceId ||
    location.storeId !== request.storeId ||
    location.appId !== owner.oxyAppId ||
    location.environment !== owner.environment ||
    (location.mode === 'live') !== (owner.environment === 'production') ||
    (product.allowedCountries !== undefined &&
      !product.allowedCountries.includes(location.country)) ||
    Date.parse(location.observedAt) > clock.getTime() ||
    Date.parse(location.expiresAt) <= clock.getTime() ||
    Date.parse(location.expiresAt) <= Date.parse(location.observedAt)
  )
    throw new BillingError('not_found', 404);
  const source = {
    merchantId: merchantPublicId,
    appId: owner.oxyAppId,
    storeId: request.storeId,
    planId: request.planId,
    mode: location.mode,
    environment: owner.environment,
  };
  const authority = billingTaxQuoteSchema.parse(
    await calculator.calculate(structuredClone({ source, product, location })),
  );
  return verifyBillingTaxQuote(
    authority,
    { source, product, location },
    calculator.verificationKeys,
    now(),
  );
}

/** Revalidate a supplied signed quote against current trusted product and location;
 * this does not ask a supplier to mint a replacement quote. */
export function verifyBillingTaxQuote(
  raw: unknown,
  expected: {
    source: BillingTaxQuote['source'];
    product: BillingTaxProductConfiguration;
    location: BillingVerifiedCustomerLocation;
  },
  keys: Readonly<Record<string, string>>,
  completion: Date,
): BillingTaxQuote {
  const authority = billingTaxQuoteSchema.parse(raw);
  const { source, product, location } = expected;
  const quote = authority.quote;

  if (
    JSON.stringify(authority.source) !==
      JSON.stringify(billingTaxQuoteSchema.shape.source.parse(source)) ||
    quote.currency !== product.currency ||
    // The product's price is what the payer pays when tax is included, and
    // what tax is added to when it is not.
    (product.taxTreatment === 'inclusive'
      ? quote.grossMinorUnits !== product.grossMinorUnits
      : quote.netMinorUnits !== product.grossMinorUnits) ||
    quote.taxTreatment !== product.taxTreatment ||
    quote.sellerId !== product.sellerId ||
    quote.invoiceIssuerId !== product.invoiceIssuerId ||
    quote.taxRemitterId !== product.taxRemitterId ||
    quote.taxServiceRef !== product.taxServiceRef ||
    quote.country !== location.country ||
    (product.coverageEvidenceId !== undefined &&
      quote.coverageEvidenceId !== product.coverageEvidenceId) ||
    quote.customerLocationEvidenceId !== location.id ||
    !Number.isSafeInteger(quote.netMinorUnits + quote.taxMinorUnits) ||
    quote.netMinorUnits + quote.taxMinorUnits !== quote.grossMinorUnits ||
    Date.parse(quote.quotedAt) > completion.getTime() ||
    Date.parse(quote.expiresAt) <= completion.getTime() ||
    Date.parse(quote.expiresAt) > Date.parse(location.expiresAt) ||
    Date.parse(quote.expiresAt) <= Date.parse(quote.quotedAt)
  )
    throw new BillingError('invalid_provider_response', 502);
  const pinned = Object.hasOwn(keys, authority.signature.keyId)
    ? keys[authority.signature.keyId]
    : undefined;
  if (!pinned) throw new BillingError('invalid_provider_response', 502);
  try {
    const key = createPublicKey(pinned);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(
        null,
        Buffer.from(canonicalBillingTaxQuote(authority)),
        key,
        Buffer.from(authority.signature.value, 'base64url'),
      )
    )
      throw new Error('Signature differs');
  } catch {
    throw new BillingError('invalid_provider_response', 502);
  }
  return authority;
}
