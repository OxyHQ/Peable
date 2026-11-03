/**
 * Peable Tax on the card rail (ADR 0012).
 *
 * The FairCoin rail already charges a signed Peable Tax quote; this is the same
 * contract for Stripe. Three pieces, each registered by trusted boot
 * composition when a Stripe rail entry names `taxQuoteAdapterRef: "peable_tax"`:
 *
 * - a `BillingTaxCheckoutAdapter` that opens a Stripe Checkout charging EXACTLY
 *   the frozen quote: the bound price as the one subscription line, the frozen
 *   tax as a manual Stripe tax rate on it, Stripe Tax OFF, the Checkout expiring
 *   with the quote — and the totals Stripe computed checked against the quote
 *   before anyone is handed the URL;
 * - a `FinalInvoiceAuthorityReader` that Peable signs itself (method `card`),
 *   so the frozen tax lines can sit inside the signature;
 * - the recorder in `stripeInvoiceTax.ts`, which commits a paid quoted
 *   invoice as a `tax_transaction`, reprices each renewal before it finalizes
 *   and reverses refunds (ADR 0013).
 *
 * Nothing here runs for a Stripe rail without that reference, so a deployment
 * that never opted in (Mercaria's I08 cohort) is untouched.
 */
import { createPublicKey, sign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalBillingAuthority,
  type BillingFinalInvoiceAuthority,
  type BillingTaxQuote,
} from '@peable.to/shared-types';
import type { Database } from '../../db/postgres';
import { invoiceTaxLines } from '../tax/billingTaxQuotes';
import { BillingError, billingReturnUrl, type BillingOwner } from './contracts';
import {
  billingTaxCheckoutSnapshotSchema,
  type billingTaxOfferSchema,
  type BillingTaxCheckoutAdapter,
} from './tax-checkout';
import type { FinalInvoiceAuthorityReader } from './invoice-authority';
import type { StripeBillingClient } from './stripeBillingProvider';
import { toUnix } from '../../lib/time';

export type StripeTaxOffer = z.infer<typeof billingTaxOfferSchema>;

/** Stripe refuses a Checkout Session that expires sooner than 30 minutes after
 * it is created; a quote with less left than this cannot be charged. */
const MIN_CHECKOUT_LIFETIME_MS = 31 * 60_000;

/** Receipt labels for the tax types Peable Tax's provider reports. */
const TAX_LABELS: Readonly<Record<string, string>> = {
  vat: 'VAT',
  gst: 'GST',
  hst: 'HST',
  pst: 'PST',
  qst: 'QST',
  rst: 'RST',
  jct: 'JCT',
  igst: 'IGST',
  sales_tax: 'Sales tax',
};

/**
 * The percentage a manual Stripe tax rate must carry so that Stripe's own
 * arithmetic lands exactly on the frozen tax amount.
 *
 * Stripe computes a rate's tax from the line amount: `amount × p` when
 * exclusive, `amount × p / (1 + p)` when inclusive, then rounds. A percentage
 * is accepted only if that exact value is within 0.4 minor units of the frozen
 * tax, so no rounding mode — half-up, half-even — can produce a different
 * cent. The coarsest such percentage wins (`20`, not `20.0013`). `null` means
 * no percentage of at most four decimals reproduces the amount, and the sale
 * must not be charged.
 */
export function exactTaxRatePercentage(
  quote: Pick<
    BillingTaxQuote['quote'],
    'gross_minor_units' | 'net_minor_units' | 'tax_minor_units' | 'tax_treatment'
  >,
): number | null {
  const tax = BigInt(quote.tax_minor_units);
  const exclusive = quote.tax_treatment === 'exclusive';
  const base = BigInt(exclusive ? quote.net_minor_units : quote.gross_minor_units);
  const denominator = exclusive ? base : base - tax;
  if (tax <= 0n || denominator <= 0n) return null;
  for (let decimals = 0; decimals <= 4; decimals++) {
    const unit = 10n ** BigInt(decimals);
    // percentage = k / unit, so the fraction is k / scale.
    const scale = 100n * unit;
    const nearest = (2n * tax * scale + denominator) / (2n * denominator);
    for (const k of [nearest - 1n, nearest, nearest + 1n]) {
      if (k <= 0n || k > scale) continue;
      const span = exclusive ? scale : scale + k;
      const difference = base * k - tax * span;
      if ((difference < 0n ? -difference : difference) * 10n <= 4n * span)
        return Number(k) / Number(unit);
    }
  }
  return null;
}

/**
 * The manual Stripe tax rate that carries a frozen quote's tax: a percentage
 * Stripe's own arithmetic turns into exactly that amount
 * (`exactTaxRatePercentage`). `undefined` for a zero-tax quote, which carries
 * no rate. Shared by the checkout and by a renewal's repricing.
 */
export async function createFrozenTaxRate(
  input: {
    db: Database;
    client: StripeBillingClient;
    owner: BillingOwner;
    livemode: boolean;
    quote: BillingTaxQuote['quote'];
  },
  key: string,
): Promise<string | undefined> {
  const { db, client, owner, quote } = input;
  if (quote.tax_minor_units <= 0) return undefined;
  if (!client.createTaxRate) throw new BillingError('not_found', 404);
  const percentage = exactTaxRatePercentage(quote);
  if (percentage === null) throw new BillingError('invalid_provider_response', 502);
  const lines = (await invoiceTaxLines(db, owner.merchantId, quote.tax_rate_evidence_id)) ?? [];
  const types = new Set(lines.map((line) => line.tax_type));
  const [only] = types;
  const inclusive = quote.tax_treatment === 'inclusive';
  return z
    .object({
      id: z.string().regex(/^txr_[A-Za-z0-9]+$/),
      livemode: z.literal(input.livemode),
      active: z.literal(true),
      inclusive: z.literal(inclusive),
      percentage: z.literal(percentage),
    })
    .parse(
      await client.createTaxRate(
        {
          display_name: (types.size === 1 && only && TAX_LABELS[only]) || 'Tax',
          inclusive,
          percentage,
          country: quote.country,
          metadata: {
            peable_tax_quote: quote.id,
            peable_tax_calculation: quote.tax_rate_evidence_id,
          },
        },
        key,
      ),
    ).id;
}

/** Opens a Stripe Checkout that charges the frozen quote and nothing else. */
export function createStripePeableTaxCheckout(options: {
  db: Database;
  client: StripeBillingClient;
  offers: (owner: BillingOwner) => readonly StripeTaxOffer[];
  now?: () => Date;
}): BillingTaxCheckoutAdapter {
  const { db, client } = options;
  const now = options.now ?? (() => new Date());
  async function createSession(
    {
      owner,
      deployment,
      checkout,
      snapshot,
    }: Parameters<BillingTaxCheckoutAdapter['createCheckout']>[0],
    key: string,
    embedded: boolean,
  ) {
    if (!client.createTaxRate || !client.expireCheckout) throw new BillingError('not_found', 404);
    const quote = snapshot.taxQuote.quote;
    const expiresAt = quote.expires_at;
    if (expiresAt * 1000 - now().getTime() < MIN_CHECKOUT_LIFETIME_MS)
      throw new BillingError('result_expired');
    const taxRate = await createFrozenTaxRate(
      { db, client, owner, livemode: deployment.livemode, quote },
      `${key}:tax_rate`,
    );
    const successUrl = new URL(checkout.return_url);
    successUrl.searchParams.set('billing', 'complete');
    const cancelUrl = new URL(checkout.return_url);
    cancelUrl.searchParams.set('billing', 'cancelled');
    const raw = await client.createCheckout(
      {
        mode: 'subscription',
        // The signed quote's currency must survive hosted checkout unchanged.
        adaptive_pricing: { enabled: false },
        customer: checkout.provider_customer_id,
        line_items: [
          {
            price: checkout.provider_price_id,
            quantity: 1,
            ...(taxRate ? { tax_rates: [taxRate] } : {}),
          },
        ],
        // Peable Tax priced this sale; Stripe must not price it again.
        automatic_tax: { enabled: false },
        // A renewal is repriced from what Stripe holds about the payer (ADR
        // 0013): the billing address is collected and kept on the customer.
        billing_address_collection: 'required',
        customer_update: { address: 'auto' },
        expires_at: expiresAt,
        subscription_data: { metadata: { peable_tax_quote: quote.id } },
        ...(embedded
          ? { ui_mode: 'elements' as const, return_url: checkout.return_url }
          : { success_url: successUrl.toString(), cancel_url: cancelUrl.toString() }),
      },
      key,
    );
    const id = z
      .object({
        id: z
          .string()
          .regex(/^cs_(test|live)_[A-Za-z0-9]+$/)
          .max(128),
      })
      .parse(raw).id;
    const session = z
      .object({
        customer: z.literal(checkout.provider_customer_id),
        mode: z.literal('subscription'),
        livemode: z.literal(deployment.livemode),
        url: embedded ? z.null() : billingReturnUrl,
        ...(embedded ? { ui_mode: z.enum(['custom', 'elements']) } : {}),
        expires_at: z.literal(expiresAt),
        currency: z.literal(quote.currency.toLowerCase()),
        amount_total: z.literal(quote.gross_minor_units),
        total_details: z.object({ amount_tax: z.literal(quote.tax_minor_units) }),
        automatic_tax: z.object({ enabled: z.literal(false) }),
      })
      .safeParse(raw);
    if (!session.success || id.startsWith('cs_live_') !== deployment.livemode) {
      // Stripe would charge something other than the quote: end it unpaid.
      await client.expireCheckout(id).catch(() => undefined);
      throw new BillingError('invalid_provider_response', 502);
    }
    const common = {
      providerObjectRef: id,
      providerCustomerId: session.data.customer,
      livemode: session.data.livemode,
      expiresAt,
    };
    if (embedded) return { ...common, presentation: 'embedded' as const };
    return { ...common, url: billingReturnUrl.parse(session.data.url) };
  }
  return {
    async resolveOffer(owner, providerPriceId) {
      const matches = options
        .offers(owner)
        .filter((offer) => offer.providerPriceId === providerPriceId);
      const offer = matches.length === 1 ? matches[0] : undefined;
      if (!offer) throw new BillingError('not_found', 404);
      // The bound Stripe price must charge exactly the listed price the quote
      // was made from; the quote's tax rides on it as a rate.
      const price = z
        .object({
          id: z.literal(providerPriceId),
          livemode: z.literal(client.livemode),
          active: z.literal(true),
          currency: z.literal(offer.currency.toLowerCase()),
          unit_amount: z.literal(offer.grossMinorUnits),
          recurring: z.object({
            interval: z.literal(offer.interval),
            interval_count: z.literal(1),
          }),
        })
        .safeParse(await client.retrievePrice(providerPriceId));
      if (!price.success) throw new BillingError('identity_conflict');
      return offer;
    },
    async createCheckout(input, key) {
      const result = await createSession(input, key, false);
      if (!('url' in result)) throw new BillingError('invalid_provider_response', 502);
      return result;
    },
    async createEmbeddedCheckout(input, key) {
      const result = await createSession(input, key, true);
      if (!('presentation' in result)) throw new BillingError('invalid_provider_response', 502);
      return result;
    },
  };
}

/** The signed final invoice of a quoted card sale. Peable is the signer, so the
 * frozen tax lines can be inside the signature. */
export function createPeableCardInvoiceAuthority(options: {
  db: Database;
  signingKey: KeyObject;
  keyId: string;
  now?: () => Date;
}): FinalInvoiceAuthorityReader {
  const { db, signingKey, keyId } = options;
  const now = options.now ?? (() => new Date());
  return {
    signsTaxLines: true,
    verificationKeys: {
      [keyId]: createPublicKey(signingKey).export({ type: 'spki', format: 'pem' }).toString(),
    },
    async read({ owner, merchantPublicId, invoice: paid, taxCheckoutSnapshot, include }) {
      // Peable signs only what Peable Tax priced.
      if (!taxCheckoutSnapshot) throw new BillingError('not_found', 404);
      const snapshot = billingTaxCheckoutSnapshotSchema.parse(taxCheckoutSnapshot);
      const tax = snapshot.taxQuote.quote;
      const lines = include?.taxLines
        ? await invoiceTaxLines(db, owner.merchantId, tax.tax_rate_evidence_id)
        : undefined;
      if (lines === null) throw new BillingError('not_found', 404);
      const mode = paid.livemode ? ('live' as const) : ('test' as const);
      const issuedAt = now();
      const authority: BillingFinalInvoiceAuthority = {
        schema_version: 2,
        method: 'card',
        source: {
          invoice_id: paid.invoice_id,
          payment_intent_id: paid.payment_intent_id,
          customer_id: paid.provider_customer_id,
          subscription_id: paid.provider_subscription_id,
          price_id: paid.provider_price_id,
          plan_id: paid.plan_id,
          merchant_id: merchantPublicId,
          app_id: owner.oxyAppId,
          mode,
          environment: owner.environment,
        },
        invoice: {
          platform: 'peable',
          currency: tax.currency,
          gross_minor_units: tax.gross_minor_units,
          net_minor_units: tax.net_minor_units,
          tax_minor_units: tax.tax_minor_units,
          merchant_fee_minor_units: 0,
          tax_treatment: tax.tax_treatment,
          seller_id: tax.seller_id,
          invoice_issuer_id: tax.invoice_issuer_id,
          tax_quote_id: tax.id,
          customer_location_evidence_id: tax.customer_location_evidence_id,
          tax_rate_evidence_id: tax.tax_rate_evidence_id,
          context: {
            payer_account_id: paid.store_id,
            beneficiary_account_id: paid.store_id,
            provider_subscription_id: paid.provider_subscription_id,
            offer_id: snapshot.offer.offerId,
            offer_version: snapshot.offer.offerVersion,
            period_start: paid.period_start,
            period_end: paid.period_end,
            mode,
            environment: owner.environment,
          },
          issued_at: toUnix(issuedAt),
          expires_at: toUnix(issuedAt) + 60,
          ...(lines ? { tax_lines: lines } : {}),
        },
        signature: { algorithm: 'Ed25519', key_id: keyId, value: '' },
      };
      authority.signature.value = sign(
        null,
        Buffer.from(canonicalBillingAuthority(authority)),
        signingKey,
      ).toString('base64url');
      return authority;
    },
  };
}
