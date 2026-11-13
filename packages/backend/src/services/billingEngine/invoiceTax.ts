/**
 * Peable Tax on an invoice — computed BEFORE it finalizes, for every line
 * (ADR 0018 §2, ADR 0011).
 *
 * Peable decides whether a sale is taxed; the provider only says how much.
 * With `automatic_tax.enabled`:
 *
 *  - The customer's location is established from what Orbit holds about them
 *    — the billing address, the saved card's issuing country — recorded as
 *    fresh Peable Tax evidence at the moment of finalization (evidence lives a
 *    day; an invoice is its own sale). Not enough of it is
 *    `requires_location_inputs`, and the invoice does NOT finalize.
 *  - Charge lines are calculated by Peable Tax as one frozen calculation. A
 *    customer no registration covers is `not_registered`: zero tax, recorded.
 *    A covered sale the provider cannot price FAILS CLOSED — the invoice stays
 *    a draft and is retried; it is never finalized at zero.
 *  - A proration CREDIT is not recalculated: it gives back a share of the
 *    line it credits, and its tax is that line's tax scaled to the same share
 *    (negative). When the invoice is paid, the share is committed as a
 *    reversal of the credited invoice's tax transaction (ADR 0013's rule:
 *    reversals netted into the same report rows, never deletions).
 *
 * Without automatic tax an invoice carries no tax at all (Stripe's default).
 */
import type { InvoiceTaxAmount, TaxCalculation } from '@peable.to/shared-types';
import type { CustomerRow } from '../../db/customers/customerRepository';
import { findPaymentMethodById } from '../../db/customers/paymentMethodRepository';
import { findLinesByIds, type InvoiceLineRow } from '../../db/billingEngine/invoiceRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { DatabaseOrTransaction } from '../../db/postgres';
import { TaxError, type InvoiceTaxPolicy } from '../tax/taxService';
import { BillingEngineError } from './errors';
import { type Catalog, type DraftLine, productOfPrice, priceOf } from './drafting';
import { billingEngineRuntime } from './runtime';

export interface InvoiceTax {
  /** `null` when the invoice is not taxed (automatic tax off). */
  readonly calculation: TaxCalculation | null;
  /** Per line, in line order. */
  readonly taxAmounts: InvoiceTaxAmount[][];
  readonly exclusive: bigint[];
  readonly inclusive: bigint[];
}

const UNTAXED = (count: number): InvoiceTax => ({
  calculation: null,
  taxAmounts: Array.from({ length: count }, () => []),
  exclusive: Array.from({ length: count }, () => 0n),
  inclusive: Array.from({ length: count }, () => 0n),
});

/** What failed, with the `automatic_tax.status` it leaves the draft in. */
export class InvoiceTaxError extends BillingEngineError {
  constructor(
    readonly taxStatus: 'requires_location_inputs' | 'failed',
    code:
      | 'customer_location_insufficient'
      | 'tax_calculation_unavailable'
      | 'tax_settings_not_active',
    message: string,
  ) {
    super(code, message, undefined, code === 'tax_calculation_unavailable' ? 503 : 400);
    this.name = 'InvoiceTaxError';
  }
}

/** Round `value × part / whole` half away from zero. */
function share(value: bigint, part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  const negative = value < 0n !== part < 0n;
  const v = value < 0n ? -value : value;
  const p = part < 0n ? -part : part;
  const w = whole < 0n ? -whole : whole;
  const rounded = (2n * v * p + w) / (2n * w);
  return negative ? -rounded : rounded;
}

export function capturedLocationEvidence(
  customer: CustomerRow,
  cardCountry: string | undefined,
): Record<string, unknown>[] {
  const evidence: Record<string, unknown>[] = [];
  const address = customer.address;
  if (address?.country) {
    evidence.push({
      type: 'billing_address',
      address: {
        country: address.country,
        ...(address.state ? { state: address.state } : {}),
        ...(address.postal_code ? { postal_code: address.postal_code } : {}),
        ...(address.city ? { city: address.city } : {}),
        ...(address.line1 ? { line1: address.line1 } : {}),
        ...(address.line2 ? { line2: address.line2 } : {}),
      },
    });
  }
  if (cardCountry) evidence.push({ type: 'payment_method_country', country: cardCountry });
  return evidence;
}
async function locationEvidence(db: DatabaseOrTransaction, customer: CustomerRow) {
  const method = customer.defaultPaymentMethodId
    ? await findPaymentMethodById(db, customer.defaultPaymentMethodId)
    : null;
  return capturedLocationEvidence(customer, method?.card.country ?? undefined);
}

export interface CapturedInvoiceTax {
  readonly policy: InvoiceTaxPolicy | null;
  readonly credited: readonly InvoiceLineRow[];
  readonly location: readonly Record<string, unknown>[];
}

function fromTaxError(error: TaxError): InvoiceTaxError {
  switch (error.code) {
    case 'customer_location_insufficient':
    case 'customer_location_conflicting':
    case 'customer_location_expired':
    case 'customer_location_invalid':
      return new InvoiceTaxError(
        'requires_location_inputs',
        'customer_location_insufficient',
        "the customer's location could not be established for tax; add a billing address to the customer",
      );
    case 'tax_settings_not_active':
      return new InvoiceTaxError(
        'failed',
        'tax_settings_not_active',
        'automatic tax needs tax settings approved by the owner',
      );
    default:
      return new InvoiceTaxError(
        'failed',
        'tax_calculation_unavailable',
        'tax could not be calculated right now; the invoice stays a draft and is retried',
      );
  }
}

/**
 * Tax every line of a draft (`nets` are the lines' amounts after discount).
 *
 * @throws {InvoiceTaxError} — the draft must not finalize.
 */
export async function taxInvoiceLines(
  db: DatabaseOrTransaction,
  input: {
    readonly merchant: MerchantRow;
    readonly customer: CustomerRow;
    readonly automaticTax: boolean;
    readonly currency: string;
    readonly lines: readonly DraftLine[];
    readonly nets: readonly bigint[];
    readonly catalog: Catalog;
    readonly captured?: CapturedInvoiceTax;
  },
): Promise<InvoiceTax> {
  const { lines, nets } = input;
  if (!input.automaticTax) return UNTAXED(lines.length);
  const result = UNTAXED(lines.length);

  // Credits: the credited line's own tax, scaled to the share given back.
  const credited = input.captured
    ? input.captured.credited
    : await findLinesByIds(
        db,
        lines.map((line) => line.creditsLineId).filter((id): id is string => id !== null),
      );
  const creditedById = new Map(credited.map((line: InvoiceLineRow) => [line.id, line]));

  const charged: number[] = [];
  lines.forEach((line, index) => {
    const net = nets[index] ?? 0n;
    if (line.creditsLineId !== null || net < 0n) {
      const original = line.creditsLineId ? creditedById.get(line.creditsLineId) : undefined;
      if (!original) return;
      const originalNet = BigInt(original.amount) - BigInt(original.discountAmount);
      const taxes = original.taxAmounts.map((tax) => ({
        amount: share(BigInt(tax.amount), net, originalNet).toString(),
        inclusive: tax.inclusive,
        tax_calculation: null,
        taxability_reason: tax.taxability_reason,
      }));
      result.taxAmounts[index] = taxes.filter((tax) => tax.amount !== '0');
      for (const tax of taxes) {
        if (tax.inclusive)
          result.inclusive[index] = (result.inclusive[index] ?? 0n) + BigInt(tax.amount);
        else result.exclusive[index] = (result.exclusive[index] ?? 0n) + BigInt(tax.amount);
      }
      return;
    }
    charged.push(index);
  });

  if (!charged.some((index) => (nets[index] ?? 0n) > 0n)) return result;

  const tax = billingEngineRuntime().tax;
  if (!tax || (input.captured && !input.captured.policy)) {
    throw new InvoiceTaxError(
      'failed',
      'tax_calculation_unavailable',
      'Peable Tax is not available on this deployment',
    );
  }
  const evidence = input.captured
    ? input.captured.location
    : await locationEvidence(db, input.customer);
  if (evidence.length === 0) {
    throw new InvoiceTaxError(
      'requires_location_inputs',
      'customer_location_insufficient',
      'the customer has no billing address or card country to establish their location for tax',
    );
  }
  let calculation: TaxCalculation;
  try {
    const recorded = await tax.recordEvidence(input.merchant, {
      customer_ref: input.customer.publicId,
      evidence,
    });
    calculation = await tax.calculate(
      input.merchant,
      {
        currency: input.currency,
        customer_location_evidence_id: recorded.id,
        line_items: charged.map((index) => {
          const line = lines[index] as DraftLine;
          const price = line.priceId ? priceOf(input.catalog, line.priceId) : null;
          const product = productOfPrice(input.catalog, line.priceId);
          return {
            reference: line.publicId,
            amount: (nets[index] ?? 0n).toString(),
            ...(line.quantity && line.quantity > 0
              ? { quantity: Math.min(line.quantity, 1_000_000) }
              : {}),
            ...(product?.taxCode ? { tax_code: product.taxCode } : {}),
            ...(price && price.taxBehavior !== 'unspecified'
              ? { tax_behavior: price.taxBehavior }
              : {}),
          };
        }),
      },
      {
        requireActive: true,
        ...(input.captured?.policy ? { invoicePolicy: input.captured.policy } : {}),
      },
    );
  } catch (error) {
    if (error instanceof TaxError) throw fromTaxError(error);
    throw error;
  }
  for (const index of charged) {
    const line = lines[index] as DraftLine;
    const answer = calculation.line_items.find((item) => item.reference === line.publicId);
    if (!answer) {
      throw new InvoiceTaxError(
        'failed',
        'tax_calculation_unavailable',
        'the tax calculation missed a line',
      );
    }
    const inclusive = answer.tax_behavior === 'inclusive';
    result.taxAmounts[index] = [
      {
        amount: answer.amount_tax,
        inclusive,
        tax_calculation: calculation.id,
        taxability_reason: answer.breakdown[0]?.taxability_reason ?? null,
      },
    ];
    if (inclusive) result.inclusive[index] = BigInt(answer.amount_tax);
    else result.exclusive[index] = BigInt(answer.amount_tax);
  }
  return { ...result, calculation };
}
