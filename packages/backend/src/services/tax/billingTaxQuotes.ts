import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  canonicalBillingTaxQuote,
  type BillingInvoiceTaxLine,
  type BillingTaxQuote,
} from '@peable.to/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { merchants } from '../../db/schema/merchants';
import { taxCalculations, taxLocationEvidence, taxSettings } from '../../db/schema/tax';
import { BillingError, type BillingOwner } from '../billing/contracts';
import type { BillingTaxQuoteCalculator } from '../billing/tax-quote';
import { TaxError, type TaxService } from './taxService';

/** What a rail sells: the price it charges for a plan and how tax relates to it. */
export interface TaxableOffer {
  planId: string;
  providerPriceId: string;
  currency: string;
  /** The listed price: tax included when inclusive, added on top when exclusive. */
  grossMinorUnits: number;
  taxTreatment: 'inclusive' | 'exclusive';
}

/** The signed quote's service reference: Peable Tax issued it. */
export const PEABLE_TAX_SERVICE_REF = 'peable_tax';
/** A quote is a short commitment; its calculation may live longer. */
const QUOTE_LIFETIME_MS = 15 * 60_000;

/**
 * Peable Tax behind the billing rails' signed-quote seam. A rail supplies its
 * offers; every amount comes from a frozen Peable Tax calculation, and the
 * quote is signed with the pinned billing key so a consumer verifies it the
 * way it verifies the invoice it later becomes.
 *
 * The quote's evidence fields name Peable Tax objects: `taxRateEvidenceId` is
 * the calculation (`taxcalc_…`), `coverageEvidenceId` the registration that
 * covered the sale (`taxreg_…`) or `not_registered` / `nontaxable`, and
 * `customerLocationEvidenceId` the evidence (`taxloc_…`).
 */
export function createPeableTaxQuoteCalculator(options: {
  db: DatabaseOrTransaction;
  tax: TaxService;
  offers: (owner: BillingOwner) => readonly TaxableOffer[];
  signingKey: KeyObject;
  keyId: string;
  now?: () => Date;
}): BillingTaxQuoteCalculator {
  const { db, tax, signingKey, keyId } = options;
  const now = options.now ?? (() => new Date());
  if (signingKey.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Peable Tax quotes are signed with an Ed25519 private key');
  async function merchantOf(owner: BillingOwner) {
    const merchant = await findMerchantById(db, owner.merchantId);
    if (
      !merchant ||
      merchant.oxyAppId !== owner.oxyAppId ||
      merchant.environment !== owner.environment
    )
      throw new BillingError('not_found', 404);
    return merchant;
  }
  function offerFor(owner: BillingOwner, planId: string, providerPriceId?: string) {
    const matches = options
      .offers(owner)
      .filter(
        (offer) =>
          offer.planId === planId &&
          (providerPriceId === undefined || offer.providerPriceId === providerPriceId),
      );
    if (matches.length !== 1 || !matches[0]) throw new BillingError('not_found', 404);
    return matches[0];
  }
  return {
    verificationKeys: {
      [keyId]: createPublicKey(signingKey).export({ type: 'spki', format: 'pem' }).toString(),
    },
    async resolveProduct(owner, planId, providerPriceId) {
      const merchant = await merchantOf(owner);
      const [settings] = await db
        .select({ status: taxSettings.status })
        .from(taxSettings)
        .where(eq(taxSettings.merchantId, merchant.id));
      // The commercial gate: no approved tax settings, no sale.
      if (settings?.status !== 'active') throw new BillingError('not_found', 404);
      const offer = offerFor(owner, planId, providerPriceId);
      return {
        configurationApproved: true,
        planId,
        currency: offer.currency,
        grossMinorUnits: offer.grossMinorUnits,
        taxTreatment: offer.taxTreatment,
        sellerId: merchant.publicId,
        invoiceIssuerId: merchant.publicId,
        taxRemitterId: merchant.publicId,
        taxServiceRef: PEABLE_TAX_SERVICE_REF,
      };
    },
    async readCustomerLocation(owner, evidenceId) {
      const merchant = await merchantOf(owner);
      const [row] = await db
        .select()
        .from(taxLocationEvidence)
        .where(
          and(
            eq(taxLocationEvidence.merchantId, merchant.id),
            eq(taxLocationEvidence.publicId, evidenceId),
          ),
        );
      if (row?.status !== 'sufficient' || !row.country) throw new BillingError('not_found', 404);
      return {
        id: row.publicId,
        storeId: row.customerRef,
        appId: owner.oxyAppId,
        mode: owner.environment === 'production' ? 'live' : 'test',
        environment: owner.environment,
        country: row.country,
        observedAt: row.observedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      };
    },
    async calculate({ source, product, location }) {
      const merchant = await merchantOf({
        merchantId: (await merchantIdFor(db, source.merchantId)) ?? '',
        oxyAppId: source.appId,
        environment: source.environment,
      });
      let calculation: Awaited<ReturnType<TaxService['calculate']>>;
      try {
        calculation = await tax.calculate(
          merchant,
          {
            currency: product.currency,
            customerLocationEvidenceId: location.id,
            lineItems: [
              {
                reference: product.planId,
                amount: product.grossMinorUnits,
                taxBehavior: product.taxTreatment,
              },
            ],
          },
          { requireActive: true },
        );
      } catch (error) {
        if (error instanceof TaxError)
          throw new BillingError(
            error.status === 503 ? 'provider_unavailable' : 'not_found',
            error.status === 503 ? 503 : 404,
          );
        throw error;
      }
      const at = now();
      const expiresAt = new Date(
        Math.min(
          +at + QUOTE_LIFETIME_MS,
          Date.parse(calculation.expiresAt),
          Date.parse(location.expiresAt),
        ),
      );
      const quote = {
        currency: calculation.currency,
        grossMinorUnits: calculation.amountTotal,
        netMinorUnits: calculation.amountNet,
        taxMinorUnits: calculation.amountTotal - calculation.amountNet,
        taxTreatment: product.taxTreatment,
        sellerId: product.sellerId,
        invoiceIssuerId: product.invoiceIssuerId,
        taxRemitterId: product.taxRemitterId,
        taxServiceRef: product.taxServiceRef,
        country: calculation.country,
        coverageEvidenceId: calculation.registrationId ?? calculation.collection,
        taxRateEvidenceId: calculation.id,
        customerLocationEvidenceId: location.id,
        quotedAt: at.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      const result: BillingTaxQuote = {
        schemaVersion: 1,
        source,
        quote: {
          id: `tax_${createHash('sha256').update(JSON.stringify({ source, quote })).digest('hex')}`,
          ...quote,
        },
        signature: { algorithm: 'Ed25519', keyId, value: '' },
      };
      result.signature.value = sign(
        null,
        Buffer.from(canonicalBillingTaxQuote(result)),
        signingKey,
      ).toString('base64url');
      return result;
    },
  };
}

async function merchantIdFor(db: DatabaseOrTransaction, publicId: string) {
  const [row] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.publicId, publicId));
  return row?.id;
}

/** The frozen tax lines of a calculation, as they appear on a signed invoice. */
export async function invoiceTaxLines(
  db: DatabaseOrTransaction,
  merchantId: string,
  calculationPublicId: string,
): Promise<BillingInvoiceTaxLine[] | null> {
  const [row] = await db
    .select({ result: taxCalculations.result })
    .from(taxCalculations)
    .where(
      and(
        eq(taxCalculations.merchantId, merchantId),
        eq(taxCalculations.publicId, calculationPublicId),
      ),
    );
  if (!row) return null;
  return row.result.lineItems.flatMap((line) =>
    line.breakdown.map((entry) => ({
      calculationId: calculationPublicId,
      country: entry.country,
      state: entry.state,
      taxType: entry.taxType,
      ratePercentage: entry.ratePercentage,
      taxableMinorUnits: entry.taxableAmount,
      taxMinorUnits: entry.amount,
      inclusive: entry.inclusive,
      taxabilityReason: entry.taxabilityReason,
    })),
  );
}
