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

export const billingTaxOfferSchema = z
  .object({
    providerPriceId: billingReference,
    planId: billingReference,
    offerId: billingReference,
    offerVersion: z.number().int().positive(),
    interval: z.enum(['month', 'year']),
    intervalCount: z.literal(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    grossMinorUnits: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    taxTreatment: z.enum(['inclusive', 'exclusive']),
  })
  .strict();
export const billingTaxCheckoutSnapshotSchema = z
  .object({
    taxQuote: billingTaxQuoteSchema,
    quoteDigest: z.string().regex(/^[a-f0-9]{64}$/),
    offer: billingTaxOfferSchema,
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
    await calculator.resolveProduct(owner, input.plan_id, input.provider_price_id),
  );
  const location = billingCustomerLocationSchema.parse(
    await calculator.readCustomerLocation(owner, input.tax_quote.quote.customer_location_evidence_id),
  );
  const offer = billingTaxOfferSchema.parse(
    await adapter.resolveOffer(owner, input.provider_price_id),
  );
  const clock = now();
  if (
    input.trial_days !== 0 ||
    location.id !== input.tax_quote.quote.customer_location_evidence_id ||
    location.storeId !== input.store_id ||
    location.appId !== owner.oxyAppId ||
    location.environment !== owner.environment ||
    (location.mode === 'live') !== (owner.environment === 'production') ||
    Date.parse(location.observedAt) > clock.getTime() ||
    Date.parse(location.expiresAt) <= clock.getTime() ||
    Date.parse(location.expiresAt) <= Date.parse(location.observedAt) ||
    (product.allowedCountries !== undefined &&
      !product.allowedCountries.includes(location.country)) ||
    product.planId !== input.plan_id ||
    offer.planId !== input.plan_id ||
    offer.providerPriceId !== input.provider_price_id ||
    offer.currency !== product.currency ||
    offer.grossMinorUnits !== product.grossMinorUnits ||
    offer.taxTreatment !== product.taxTreatment
  )
    throw new BillingError('identity_conflict');
  const taxQuote = verifyBillingTaxQuote(
    input.tax_quote,
    {
      source: {
        merchant_id: merchantPublicId,
        app_id: owner.oxyAppId,
        store_id: input.store_id,
        plan_id: input.plan_id,
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
    invoice.tax_quote_id !== quote.id ||
    invoice.currency !== quote.currency ||
    invoice.gross_minor_units !== quote.grossMinorUnits ||
    invoice.net_minor_units !== quote.netMinorUnits ||
    invoice.tax_minor_units !== quote.taxMinorUnits ||
    invoice.tax_treatment !== quote.taxTreatment ||
    invoice.seller_id !== quote.sellerId ||
    invoice.invoice_issuer_id !== quote.invoiceIssuerId ||
    invoice.customer_location_evidence_id !== quote.customerLocationEvidenceId ||
    invoice.tax_rate_evidence_id !== quote.taxRateEvidenceId ||
    invoice.context.offer_id !== snapshot.offer.offerId ||
    invoice.context.offer_version !== snapshot.offer.offerVersion
  )
    throw new BillingError('invalid_provider_response', 502);
}
