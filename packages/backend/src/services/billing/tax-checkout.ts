import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalBillingTaxQuote,
  type BillingTaxQuote,
  type CreateBillingCheckoutParams,
  type BillingFinalInvoiceAuthority,
} from '@peable.to/shared-types';
import {
  BillingError,
  billingReference,
  billingTaxQuoteSchema,
  type BillingOwner,
  type BillingDeployment,
} from './contracts';
import {
  billingTaxProductSchema,
  billingCustomerLocationSchema,
  verifyBillingTaxQuote,
  type BillingTaxQuoteCalculator,
} from './tax-quote';
import type { ProviderHostedSession } from './provider';

const offerSchema = z
  .object({
    providerPriceId: billingReference,
    planId: billingReference,
    offerId: billingReference,
    offerVersion: z.number().int().positive(),
    interval: z.literal('month'),
    intervalCount: z.literal(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    grossMinorUnits: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    taxTreatment: z.literal('inclusive'),
  })
  .strict();
export const billingTaxCheckoutSnapshotSchema = z
  .object({
    taxQuote: billingTaxQuoteSchema,
    quoteDigest: z.string().regex(/^[a-f0-9]{64}$/),
    offer: offerSchema,
  })
  .strict();
export type BillingTaxCheckoutSnapshot = z.infer<typeof billingTaxCheckoutSnapshotSchema>;
/** Registered in trusted boot composition only. A concrete adapter must prove the
 * provider charges exactly the snapshot gross/net/tax, disables tax recalculation,
 * applies the quote expiry, and deduplicates by the supplied durable remote key.
 * The ordinary Stripe checkout has no such capability and is never a fallback. */
export interface BillingTaxCheckoutAdapter {
  resolveOffer(owner: BillingOwner, providerPriceId: string): Promise<unknown>;
  createCheckout(
    input: {
      owner: BillingOwner;
      deployment: BillingDeployment;
      checkout: CreateBillingCheckoutParams;
      snapshot: BillingTaxCheckoutSnapshot;
    },
    idempotencyKey: string,
  ): Promise<ProviderHostedSession>;
}
export async function prepareBillingTaxCheckout(
  calculator: BillingTaxQuoteCalculator,
  adapter: BillingTaxCheckoutAdapter,
  owner: BillingOwner,
  merchantPublicId: string,
  input: CreateBillingCheckoutParams & { taxQuote: BillingTaxQuote },
  now: () => Date,
): Promise<BillingTaxCheckoutSnapshot> {
  const product = billingTaxProductSchema.parse(
    await calculator.resolveProduct(owner, input.planId),
  );
  const location = billingCustomerLocationSchema.parse(
    await calculator.readCustomerLocation(owner, input.taxQuote.quote.customerLocationEvidenceId),
  );
  const offer = offerSchema.parse(await adapter.resolveOffer(owner, input.providerPriceId));
  const clock = now();
  if (
    input.trialDays !== 0 ||
    location.id !== input.taxQuote.quote.customerLocationEvidenceId ||
    location.storeId !== input.storeId ||
    location.appId !== owner.oxyAppId ||
    location.environment !== owner.environment ||
    (location.mode === 'live') !== (owner.environment === 'production') ||
    Date.parse(location.observedAt) > clock.getTime() ||
    Date.parse(location.expiresAt) <= clock.getTime() ||
    Date.parse(location.expiresAt) <= Date.parse(location.observedAt) ||
    !product.allowedCountries.includes(location.country) ||
    product.planId !== input.planId ||
    offer.planId !== input.planId ||
    offer.providerPriceId !== input.providerPriceId ||
    offer.currency !== product.currency ||
    offer.grossMinorUnits !== product.grossMinorUnits ||
    product.taxTreatment !== 'inclusive'
  )
    throw new BillingError('identity_conflict');
  const taxQuote = verifyBillingTaxQuote(
    input.taxQuote,
    {
      source: {
        merchantId: merchantPublicId,
        appId: owner.oxyAppId,
        storeId: input.storeId,
        planId: input.planId,
        mode: location.mode,
        environment: owner.environment,
      },
      product,
      location,
    },
    calculator.verificationKeys,
    now(),
  );
  return {
    taxQuote,
    offer,
    quoteDigest: createHash('sha256').update(canonicalBillingTaxQuote(taxQuote)).digest('hex'),
  };
}
/** Historical linkage uses the persisted snapshot, never current product settings
 * or quote freshness at invoice-read time. Renewals need their own fresh fiscal
 * evidence; a changed invoice cannot silently reuse the checkout quote. */
export function verifyBillingInvoiceTaxCheckout(
  authority: BillingFinalInvoiceAuthority,
  snapshot: BillingTaxCheckoutSnapshot,
) {
  const { invoice } = authority;
  const quote = snapshot.taxQuote.quote;
  if (
    invoice.taxQuoteId !== quote.id ||
    invoice.currency !== quote.currency ||
    invoice.grossMinorUnits !== quote.grossMinorUnits ||
    invoice.netMinorUnits !== quote.netMinorUnits ||
    invoice.taxMinorUnits !== quote.taxMinorUnits ||
    invoice.taxTreatment !== quote.taxTreatment ||
    invoice.sellerId !== quote.sellerId ||
    invoice.invoiceIssuerId !== quote.invoiceIssuerId ||
    invoice.customerLocationEvidenceId !== quote.customerLocationEvidenceId ||
    invoice.taxRateEvidenceId !== quote.taxRateEvidenceId ||
    invoice.context.offerId !== snapshot.offer.offerId ||
    invoice.context.offerVersion !== snapshot.offer.offerVersion
  )
    throw new BillingError('invalid_provider_response', 502);
}
