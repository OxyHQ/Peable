// The catalog keys of the billing pages' closed values (an invoice's status, a
// price's interval), shared by the hosted invoice page and the portal.
import type { PublicInvoice } from '@peable.to/shared-types';
import type { MessageKey } from '../i18n';

export const INVOICE_STATUS_LABEL: Record<PublicInvoice['status'], MessageKey> = {
  draft: 'invoiceStatusDraft',
  open: 'invoiceStatusOpen',
  paid: 'invoiceStatusPaid',
  void: 'invoiceStatusVoid',
  uncollectible: 'invoiceStatusUncollectible',
};

const INTERVAL_LABEL: Readonly<Record<string, MessageKey>> = {
  day: 'intervalDay',
  week: 'intervalWeek',
  month: 'intervalMonth',
  year: 'intervalYear',
};

/** A recurring interval's catalog key, or `null` for one the catalog does not name. */
export function intervalLabel(interval: string): MessageKey | null {
  return INTERVAL_LABEL[interval] ?? null;
}
