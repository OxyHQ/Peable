import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalBillingTaxQuote,
  type BillingTaxQuote,
  type CreateBillingTaxQuoteParams,
} from '@peable.to/shared-types';
import { billingReference, BillingError, type BillingOwner } from './contracts';

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime();
const mode = z.enum(['test', 'live']);
const environment = z.enum(['development', 'staging', 'production']);
const country = z.string().regex(/^[A-Z]{2}$/);
export const billingTaxQuoteRequestSchema = z
  .object({
    storeId: billingReference,
    planId: billingReference,
    customerLocationEvidenceId: billingReference,
  })
  .strict();
const productSchema = z
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
    allowedCountries: z
      .array(country)
      .min(1)
      .max(250)
      .refine((values) => new Set(values).size === values.length, 'Duplicate countries'),
    coverageEvidenceId: billingReference,
  })
  .strict();
const locationSchema = z
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
export const billingTaxQuoteSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z
      .object({
        merchantId: billingReference,
        appId: billingReference,
        storeId: billingReference,
        planId: billingReference,
        mode,
        environment,
      })
      .strict(),
    quote: z
      .object({
        id: billingReference,
        currency: z.string().regex(/^[A-Z]{3}$/),
        grossMinorUnits: amount,
        netMinorUnits: amount,
        taxMinorUnits: amount,
        taxTreatment: z.enum(['inclusive', 'exclusive']),
        sellerId: billingReference,
        invoiceIssuerId: billingReference,
        taxRemitterId: billingReference,
        taxServiceRef: billingReference,
        country,
        coverageEvidenceId: billingReference,
        taxRateEvidenceId: billingReference,
        customerLocationEvidenceId: billingReference,
        quotedAt: timestamp,
        expiresAt: timestamp,
      })
      .strict(),
    signature: z
      .object({
        algorithm: z.literal('Ed25519'),
        keyId: billingReference,
        value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
      })
      .strict(),
  })
  .strict();
export type BillingTaxProductConfiguration = z.infer<typeof productSchema>;
export type BillingVerifiedCustomerLocation = z.infer<typeof locationSchema>;
export interface BillingTaxQuoteCalculator {
  /** Operator-reviewed product, issuer/remitter and explicit country coverage. */
  resolveProduct(owner: BillingOwner, planId: string): Promise<unknown>;
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
  const product = productSchema.parse(await calculator.resolveProduct(owner, request.planId));
  const location = locationSchema.parse(
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
    !product.allowedCountries.includes(location.country) ||
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
  const quote = authority.quote;
  const completion = now();
  if (
    JSON.stringify(authority.source) !==
      JSON.stringify(billingTaxQuoteSchema.shape.source.parse(source)) ||
    quote.currency !== product.currency ||
    quote.grossMinorUnits !== product.grossMinorUnits ||
    quote.taxTreatment !== product.taxTreatment ||
    quote.sellerId !== product.sellerId ||
    quote.invoiceIssuerId !== product.invoiceIssuerId ||
    quote.taxRemitterId !== product.taxRemitterId ||
    quote.taxServiceRef !== product.taxServiceRef ||
    quote.country !== location.country ||
    quote.coverageEvidenceId !== product.coverageEvidenceId ||
    quote.customerLocationEvidenceId !== location.id ||
    !Number.isSafeInteger(quote.netMinorUnits + quote.taxMinorUnits) ||
    quote.netMinorUnits + quote.taxMinorUnits !== quote.grossMinorUnits ||
    Date.parse(quote.quotedAt) > completion.getTime() ||
    Date.parse(quote.expiresAt) <= completion.getTime() ||
    Date.parse(quote.expiresAt) > Date.parse(location.expiresAt) ||
    Date.parse(quote.expiresAt) <= Date.parse(quote.quotedAt)
  )
    throw new BillingError('invalid_provider_response', 502);
  const pinned = calculator.verificationKeys[authority.signature.keyId];
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
