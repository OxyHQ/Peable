/** Opt-in invoice approval snapshots. Never hash generated tax evidence, clock
 * ticks or numbering counters: those are outputs, not the reviewed inputs. */
import { createHash } from 'node:crypto';
import type { DatabaseOrTransaction } from '../../db/postgres';
import {
  findInvoiceById,
  findLinesByIds,
  listLines,
} from '../../db/billingEngine/invoiceRepository';
import { readFinalizationSettings } from '../../db/billingEngine/settingsRepository';
import { findCustomerById } from '../../db/customers/customerRepository';
import { findPaymentMethodById } from '../../db/customers/paymentMethodRepository';
import { findMerchantById } from '../../db/merchants/merchantRepository';
import { findCouponById } from '../../db/catalog/couponRepository';
import { draftLineOf, loadCatalog } from './drafting';
import { capturedLocationEvidence } from './invoiceTax';
import { billingEngineRuntime, engineNow } from './runtime';
import { BillingEngineError, missing } from './errors';

/** Exact integer amounts and decimals stay strings; no floating-point money. */
export function canonicalFinalizationInput(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFinalizationInput).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalFinalizationInput(item)}`)
      .join(',')}}`;
  }
  throw new Error('unsupported invoice finalization input');
}

export function finalizationConflict(): BillingEngineError {
  return new BillingEngineError(
    'invoice_finalization_conflict',
    'the reviewed invoice inputs changed; retrieve and review the draft again',
    'expected_finalization_revision',
    409,
  );
}

/** Caller supplies a consistent transaction, shared with rendering or commit. */
export async function captureFinalizationInput(db: DatabaseOrTransaction, invoiceId: string) {
  const invoice = await findInvoiceById(db, invoiceId);
  if (!invoice) throw missing('invoice');
  const merchant = await findMerchantById(db, invoice.merchantId);
  const customer = await findCustomerById(db, invoice.customerId);
  if (!merchant || !customer) throw new Error('invoice has no merchant or customer');
  const lines = (await listLines(db, invoice.id)).map(draftLineOf);
  const catalog = await loadCatalog(
    db,
    lines.map((line) => line.priceId),
  );
  const coupon = invoice.discountCouponId
    ? await findCouponById(db, invoice.discountCouponId)
    : null;
  const credited = await findLinesByIds(
    db,
    lines.flatMap((line) => (line.creditsLineId ? [line.creditsLineId] : [])),
  );
  const customerMethod = customer.defaultPaymentMethodId
    ? await findPaymentMethodById(db, customer.defaultPaymentMethodId)
    : null;
  const invoiceMethod = invoice.defaultPaymentMethodId
    ? await findPaymentMethodById(db, invoice.defaultPaymentMethodId)
    : null;
  const location = capturedLocationEvidence(customer, customerMethod?.card.country ?? undefined);
  const runtimeTax = billingEngineRuntime().tax;
  const policy =
    invoice.automaticTax && runtimeTax
      ? await runtimeTax.captureInvoicePolicy(
          merchant,
          lines.map((line) => line.publicId),
          db,
        )
      : null;
  const settings = await readFinalizationSettings(db, merchant);
  const frozenClock = invoice.testClockId ? await engineNow(db, invoice.testClockId) : null;
  // Failure annotations are not financial input and must not invalidate their own retry.
  const {
    automaticTaxStatus: _taxStatus,
    lastFinalizationError: _error,
    nextActionAt: _next,
    taxCalculationId: _calculation,
    taxedLinesDigest: _taxDigest,
    ...invoiceInput
  } = invoice;
  const policyInput = policy
    ? {
        merchantId: policy.merchantId,
        settings: policy.settings,
        products: policy.products,
        provider: policy.provider,
        registrations: policy.registrations.map((row) => ({
          ...row,
          effective:
            row.approvedAt !== null &&
            row.activeFrom !== null &&
            row.activeFrom <= policy.evaluatedAt &&
            (row.expiresAt === null || row.expiresAt > policy.evaluatedAt),
        })),
      }
    : null;
  const byId = <T extends { id: string }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const revision = createHash('sha256')
    .update('peable-invoice-finalization/v1\n')
    .update(
      canonicalFinalizationInput({
        invoice: invoiceInput,
        merchant,
        customer,
        customerMethod,
        invoiceMethod,
        lines,
        coupon,
        prices: byId([...catalog.prices.values()]),
        products: byId([...catalog.products.values()]),
        credited: byId(credited),
        location,
        settings,
        frozenClock,
        taxPolicy: policyInput,
      }),
    )
    .digest('hex');
  return {
    invoice,
    merchant,
    customer,
    lines,
    catalog,
    coupon,
    tax: { policy, credited, location },
    revision,
  };
}

export type FinalizationInput = Awaited<ReturnType<typeof captureFinalizationInput>>;
