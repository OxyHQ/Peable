import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { canonicalBillingAuthority, type BillingFinalInvoiceAuthority, type BillingPaidInvoice } from '@peable.to/shared-types';
import { billingReference, BillingError, type BillingOwner } from './contracts';

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime();
const environment = z.enum(['development', 'staging', 'production']);
const mode = z.enum(['test', 'live']);
export const finalInvoiceAuthoritySchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ invoiceId: billingReference, paymentIntentId: billingReference, customerId: billingReference,
    subscriptionId: billingReference, priceId: billingReference, planId: billingReference, merchantId: billingReference,
    appId: billingReference, mode, environment }).strict(),
  invoice: z.object({ platform: z.literal('peable'), currency: z.string().regex(/^[A-Z]{3}$/),
    grossMinorUnits: amount, netMinorUnits: amount, taxMinorUnits: amount, merchantFeeMinorUnits: amount,
    taxTreatment: z.enum(['inclusive', 'exclusive']), sellerId: billingReference, invoiceIssuerId: billingReference,
    taxQuoteId: billingReference, customerLocationEvidenceId: billingReference, taxRateEvidenceId: billingReference,
    context: z.object({ payerAccountId: billingReference, beneficiaryAccountId: billingReference,
      providerSubscriptionId: billingReference, offerId: billingReference, offerVersion: z.number().int().positive(),
      periodStart: timestamp, periodEnd: timestamp, mode, environment }).strict(),
    issuedAt: timestamp, expiresAt: timestamp,
    faircoinQuote: z.object({ id: billingReference, amountBaseUnits: z.string().regex(/^[1-9][0-9]*$/).max(80),
      quotedAt: timestamp, expiresAt: timestamp, roundingEvidenceId: billingReference }).strict().optional(),
  }).strict(),
  method: z.enum(['card', 'faircoin']),
  signature: z.object({ algorithm: z.literal('Ed25519'), keyId: billingReference, value: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict(),
}).strict();

export interface FinalInvoiceAuthorityReader {
  /** Trusted deployment adapter; never constructed from merchant request data. */
  read(input: { owner: BillingOwner; merchantPublicId: string; invoice: BillingPaidInvoice }): Promise<unknown>;
  /** Pinned issuer verification keys. No key is accepted from a response. */
  verificationKeys: Readonly<Record<string, string>>;
}

export function verifyFinalInvoiceAuthority(raw: unknown, expected: { owner: BillingOwner; merchantPublicId: string; invoice: BillingPaidInvoice }, keys: Readonly<Record<string, string>>, now: Date): BillingFinalInvoiceAuthority {
  const authority = finalInvoiceAuthoritySchema.parse(raw);
  const { source, invoice, signature } = authority;
  const paid = expected.invoice;
  const context = invoice.context;
  if (source.invoiceId !== paid.invoiceId || source.paymentIntentId !== paid.paymentIntentId || source.customerId !== paid.providerCustomerId
    || source.subscriptionId !== paid.providerSubscriptionId || source.priceId !== paid.providerPriceId || source.planId !== paid.planId
    || source.merchantId !== expected.merchantPublicId || source.appId !== expected.owner.oxyAppId || source.environment !== expected.owner.environment
    || (source.mode === 'live') !== paid.livemode || context.mode !== source.mode || context.environment !== source.environment
    || context.providerSubscriptionId !== source.subscriptionId || context.payerAccountId !== paid.storeId || context.beneficiaryAccountId !== paid.storeId
    || context.periodStart !== paid.periodStart || context.periodEnd !== paid.periodEnd || Date.parse(context.periodEnd) <= Date.parse(context.periodStart)
    || invoice.currency !== paid.currency || BigInt(invoice.grossMinorUnits) !== BigInt(paid.amountPaid)
    || paid.netAmount === null || paid.taxAmount === null || BigInt(invoice.netMinorUnits) !== BigInt(paid.netAmount) || BigInt(invoice.taxMinorUnits) !== BigInt(paid.taxAmount)
    || invoice.netMinorUnits + invoice.taxMinorUnits !== invoice.grossMinorUnits || !Number.isSafeInteger(invoice.netMinorUnits + invoice.taxMinorUnits)
    || Date.parse(invoice.issuedAt) > now.getTime() || Date.parse(invoice.expiresAt) <= now.getTime()
    || Date.parse(invoice.expiresAt) <= Date.parse(invoice.issuedAt) || Date.parse(paid.paidAt) > now.getTime()
    || Date.parse(paid.observedAt) > now.getTime() || now.getTime() - Date.parse(paid.observedAt) > 60_000) throw new BillingError('invalid_provider_response', 502);
  if (authority.method === 'faircoin' && (!invoice.faircoinQuote || Date.parse(invoice.faircoinQuote.quotedAt) > now.getTime()
    || Date.parse(invoice.faircoinQuote.expiresAt) > Date.parse(invoice.expiresAt) || Date.parse(invoice.faircoinQuote.expiresAt) <= now.getTime() || Date.parse(invoice.faircoinQuote.expiresAt) <= Date.parse(invoice.faircoinQuote.quotedAt))) throw new BillingError('invalid_provider_response', 502);
  const pinnedKey = keys[signature.keyId];
  if (!pinnedKey) throw new BillingError('invalid_provider_response', 502);
  try {
    const key = createPublicKey(pinnedKey);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonicalBillingAuthority(authority), 'utf8'), key, Buffer.from(signature.value, 'base64url'))) throw new Error('Signature differs');
  } catch { throw new BillingError('invalid_provider_response', 502); }
  return authority;
}
