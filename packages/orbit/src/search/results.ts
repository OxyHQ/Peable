/**
 * Orbit's global search results, as rows: what each hit is called, what is
 * said beside it, and where it opens. Pure, so the mapping is tested without
 * a renderer (`results.test.ts`); `SearchBox.tsx` only draws it.
 *
 * Where a hit opens follows the screens that exist: a payment opens itself; a
 * charge and a refund open their payment; a product opens itself and a price
 * its product. A customer has no detail screen yet, so its row has no link.
 */
import type { SearchableResource } from '@peable.to/shared-types';
import type { DashboardSearchGroup } from '../api/dashboard';
import { formatAmount } from '../format/money';
import { t } from '../i18n';
import { paymentStatusLabel } from '../payments/status';

/** An expo-router destination with one dynamic segment. */
export interface SearchHref {
  pathname: '/payments/[id]' | '/products/[id]';
  params: { id: string };
}

export interface SearchRow {
  /** The object's id — the row's key, unique within a group. */
  key: string;
  label: string;
  sublabel: string;
  /** `null` when Orbit has no screen for the object. */
  href: SearchHref | null;
}

/** A reference that may come expanded: its id either way. */
function idOf(reference: string | { id: string }): string {
  return typeof reference === 'string' ? reference : reference.id;
}

const join = (...parts: (string | null | undefined)[]) =>
  parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ');

const payment = (id: string): SearchHref => ({ pathname: '/payments/[id]', params: { id } });
const product = (id: string): SearchHref => ({ pathname: '/products/[id]', params: { id } });

/** The rows of one group, in the gateway's order (newest first). */
export function searchRows(group: DashboardSearchGroup): SearchRow[] {
  switch (group.resource) {
    case 'payment_intents':
      return group.data.map((intent) => ({
        key: intent.id,
        label: formatAmount(intent.amount, intent.currency),
        sublabel: join(
          paymentStatusLabel(intent.status),
          intent.receipt_email,
          intent.description,
          intent.id,
        ),
        href: payment(intent.id),
      }));
    case 'charges':
      return group.data.map((charge) => {
        const card = charge.payment_method_details?.card;
        return {
          key: charge.id,
          label: formatAmount(charge.amount, charge.currency),
          sublabel: join(
            charge.billing_details?.email,
            card?.last4 ? `${card.brand ?? ''} ···· ${card.last4}`.trim() : null,
            charge.id,
          ),
          href: payment(idOf(charge.payment_intent)),
        };
      });
    case 'refunds':
      return group.data.map((refund) => ({
        key: refund.id,
        label: formatAmount(refund.amount, refund.currency),
        sublabel: join(refund.status, refund.id),
        href: payment(idOf(refund.payment_intent)),
      }));
    case 'customers':
      return group.data.map((customer) => ({
        key: customer.id,
        label: customer.name ?? customer.email ?? customer.id,
        sublabel: join(customer.name ? customer.email : null, customer.phone, customer.id),
        href: null,
      }));
    case 'products':
      return group.data.map((item) => ({
        key: item.id,
        label: item.name,
        sublabel: join(t(item.active ? 'search.active' : 'search.archived'), item.id),
        href: product(item.id),
      }));
    case 'prices':
      return group.data.map((price) => {
        const amount =
          price.unit_amount === null ? null : formatAmount(price.unit_amount, price.currency);
        const name = price.nickname ?? price.lookup_key;
        return {
          key: price.id,
          label: name ?? amount ?? price.id,
          sublabel: join(
            name === null ? null : amount,
            price.nickname === null ? null : price.lookup_key,
            price.id,
          ),
          href: product(idOf(price.product)),
        };
      });
  }
}

/** The heading of a group. */
export function searchGroupTitle(resource: SearchableResource): string {
  return t(`search.group.${resource}`);
}

/** How long typing must pause before the box asks the gateway. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The query the box sends for what was typed, or `null` for nothing to send.
 * Bounded like the gateway's `q` (1000 characters): longer input is refused
 * there, so it is never sent.
 */
export function searchTerm(input: string): string | null {
  const term = input.trim();
  if (term.length === 0 || term.length > 1000) return null;
  return term;
}
