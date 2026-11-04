/**
 * `automatic_tax` on a Checkout Session — Peable Tax (ADR 0011), with the
 * address the payer gave as the location evidence.
 *
 * Fails CLOSED: a sale Peable Tax cannot price is `failed`, and a failed
 * session cannot be confirmed — never priced at zero tax. A sale where the
 * merchant is not registered is priced at zero and recorded as such by the
 * calculation (`collection: not_registered`), which is Peable Tax's own rule.
 * Location evidence is the billing address only: never language, currency or
 * timezone (ADR 0011).
 */
import type { Address, CurrencyCode } from '@peable.to/shared-types';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { TaxError, type TaxService } from '../tax/taxService';
import type { AutomaticTaxStatus } from '../../db/schema/valueSets';
import type { LineTaxes } from './totals';

export interface TaxableLine {
  readonly key: string;
  /** The line's amount after its discount. */
  readonly amount: bigint;
  readonly quantity: number;
  readonly taxCode: string | null;
  readonly taxBehavior: 'inclusive' | 'exclusive' | 'unspecified';
}

export type CheckoutTaxResult =
  | { readonly status: null; readonly taxes: LineTaxes; readonly calculationId: null }
  | {
      readonly status: Exclude<AutomaticTaxStatus, 'complete'>;
      readonly taxes: LineTaxes;
      readonly calculationId: null;
      readonly reason?: string;
    }
  | { readonly status: 'complete'; readonly taxes: LineTaxes; readonly calculationId: string };

const NONE: LineTaxes = new Map();

/** Whether an address locates the payer for Peable Tax at all. */
export function locatesPayer(address: Address | null | undefined): boolean {
  return Boolean(address?.country);
}

/**
 * Price the order's tax. `enabled: false` is no tax at all; no address is
 * `requires_location_inputs`; anything Peable Tax refuses is `failed`.
 */
export async function checkoutTax(
  tax: TaxService | undefined,
  merchant: MerchantRow,
  input: {
    readonly enabled: boolean;
    readonly sessionPublicId: string;
    readonly currency: CurrencyCode;
    readonly address: Address | null | undefined;
    readonly lines: readonly TaxableLine[];
  },
): Promise<CheckoutTaxResult> {
  if (!input.enabled) return { status: null, taxes: NONE, calculationId: null };
  const address = input.address;
  if (!address || !locatesPayer(address)) {
    return { status: 'requires_location_inputs', taxes: NONE, calculationId: null };
  }
  if (!tax) return { status: 'failed', taxes: NONE, calculationId: null, reason: 'no_tax_service' };
  const priced = input.lines.filter((line) => line.quantity > 0);
  if (priced.length === 0) return { status: null, taxes: NONE, calculationId: null };
  try {
    const evidence = await tax.recordEvidence(merchant, {
      customer_ref: input.sessionPublicId,
      evidence: [
        {
          type: 'billing_address',
          address: {
            country: address.country,
            ...(address.state ? { state: address.state } : {}),
            ...(address.postal_code ? { postal_code: address.postal_code } : {}),
            ...(address.city ? { city: address.city } : {}),
            ...(address.line1 ? { line1: address.line1 } : {}),
            ...(address.line2 ? { line2: address.line2 } : {}),
          },
        },
      ],
    });
    const calculation = await tax.calculate(
      merchant,
      {
        currency: input.currency,
        customer_location_evidence_id: evidence.id,
        line_items: priced.map((line) => ({
          reference: line.key,
          amount: line.amount.toString(),
          quantity: line.quantity,
          ...(line.taxCode ? { tax_code: line.taxCode } : {}),
          ...(line.taxBehavior !== 'unspecified' ? { tax_behavior: line.taxBehavior } : {}),
        })),
      },
      { requireActive: true },
    );
    const taxes = new Map(
      calculation.line_items.map((line) => [
        line.reference,
        { amountTax: BigInt(line.amount_tax), inclusive: line.tax_behavior === 'inclusive' },
      ]),
    );
    return { status: 'complete', taxes, calculationId: calculation.id };
  } catch (error) {
    if (error instanceof TaxError) {
      return { status: 'failed', taxes: NONE, calculationId: null, reason: error.code };
    }
    throw error;
  }
}
