import { createHmac } from 'node:crypto';
import {
  type CreateTaxLocationEvidenceParams,
  type TaxLocationEvidenceType,
  taxLocationEvidenceItemsParam,
} from '@peable.to/contracts';
import type { StoredTaxEvidenceItem } from '../../db/schema/tax';
import { locationRuleFor, type TaxLocationRule } from './jurisdictions';

export interface EvaluatedEvidence {
  status: 'sufficient' | 'insufficient' | 'conflicting';
  rule: TaxLocationRule | 'none';
  country: string | null;
  state: string | null;
  items: StoredTaxEvidenceItem[];
}

/**
 * Judge evidence against the customer's jurisdiction's rule.
 *
 * The jurisdiction is the country most kinds of evidence agree on (the billing
 * address breaks a tie). Its rule then decides whether that is enough. Nothing
 * is inferred: an item names a country, or it is not evidence.
 */
export function evaluateEvidence(
  raw: CreateTaxLocationEvidenceParams['evidence'],
  ipHashSalt: string | undefined,
): EvaluatedEvidence {
  const parsed = taxLocationEvidenceItemsParam.parse(raw);
  const items: StoredTaxEvidenceItem[] = parsed.map((item) => {
    if (item.type === 'billing_address')
      return {
        type: item.type,
        country: item.address.country,
        state: item.address.state ?? null,
        postalCode: item.address.postal_code ?? null,
        city: item.address.city ?? null,
        line1: item.address.line1 ?? null,
        line2: item.address.line2 ?? null,
      };
    if (item.type === 'ip_address')
      return {
        type: item.type,
        country: item.country,
        state: item.state ?? null,
        // The address itself is never stored; without a salt not even its hash.
        ...(ipHashSalt
          ? { ipHash: createHmac('sha256', ipHashSalt).update(item.ip_address).digest('hex') }
          : {}),
      };
    return { type: item.type, country: item.country, state: null };
  });

  // Distinct evidence KINDS per country: two IP addresses are one kind.
  const kinds = new Map<string, Set<TaxLocationEvidenceType>>();
  for (const item of items) {
    const set = kinds.get(item.country) ?? new Set();
    set.add(item.type as TaxLocationEvidenceType);
    kinds.set(item.country, set);
  }
  const billing = items.find((item) => item.type === 'billing_address');
  const ranked = [...kinds.entries()].sort(
    (a, b) =>
      b[1].size - a[1].size ||
      Number(b[0] === billing?.country) - Number(a[0] === billing?.country),
  );
  const [top, second] = ranked;
  if (!top) return { status: 'insufficient', rule: 'none', country: null, state: null, items };
  const tied =
    second !== undefined &&
    second[1].size === top[1].size &&
    top[0] !== billing?.country &&
    second[0] !== billing?.country;
  const target = top[0];
  const rule = locationRuleFor(target);
  const address = billing?.country === target ? billing : undefined;
  const regionOf = () =>
    address?.state ??
    items.find((item) => item.country === target && item.state !== null)?.state ??
    null;

  switch (rule) {
    case 'eu_digital_two_items':
    case 'gb_digital_two_items': {
      // Two agreeing kinds are enough even beside a contradicting one; a
      // contradiction that is equally supported is not resolvable.
      if (top[1].size < 2)
        return {
          status: ranked.length > 1 ? 'conflicting' : 'insufficient',
          rule,
          country: null,
          state: null,
          items,
        };
      if (second && second[1].size >= 2)
        return { status: 'conflicting', rule, country: null, state: null, items };
      return { status: 'sufficient', rule, country: target, state: null, items };
    }
    case 'us_billing_address':
    case 'ca_billing_address': {
      if (!address?.state || !address.postalCode)
        return { status: 'insufficient', rule, country: null, state: null, items };
      return { status: 'sufficient', rule, country: target, state: address.state, items };
    }
    case 'default_one_item': {
      if (tied || (ranked.length > 1 && !billing))
        return { status: 'conflicting', rule, country: null, state: null, items };
      return { status: 'sufficient', rule, country: target, state: regionOf(), items };
    }
  }
}
