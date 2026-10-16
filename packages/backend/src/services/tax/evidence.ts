import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { TaxLocationEvidenceType } from '@peable.to/shared-types';
import type { StoredTaxEvidenceItem } from '../../db/schema/tax';
import { locationRuleFor, type TaxLocationRule } from './jurisdictions';

const country = z.string().regex(/^[A-Z]{2}$/);
const subdivision = z
  .string()
  .regex(/^[A-Z0-9]{1,3}$/)
  .nullish();
const shortText = z.string().trim().min(1).max(200).nullish();
export const taxAddressSchema = z
  .object({
    country,
    state: subdivision,
    postalCode: z.string().trim().min(1).max(20).nullish(),
    city: shortText,
    line1: shortText,
    line2: shortText,
  })
  .strict();

/** The accepted evidence kinds. Strict: an item claiming a language, currency,
 * locale or timezone is not a smaller kind of evidence, it is refused. */
const evidenceItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('billing_address'), address: taxAddressSchema }).strict(),
  z
    .object({
      type: z.literal('ip_address'),
      ipAddress: z.string().refine((value) => isIP(value) !== 0, 'Not an IP address'),
      country,
      state: subdivision,
    })
    .strict(),
  z
    .object({
      type: z.enum(['payment_method_country', 'bank_country', 'sim_country', 'landline_country']),
      country,
    })
    .strict(),
]);
export const createTaxLocationEvidenceSchema = z
  .object({
    customerRef: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    evidence: z.array(evidenceItemSchema).min(1).max(6),
  })
  .strict();

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
  raw: z.input<typeof createTaxLocationEvidenceSchema>['evidence'],
  ipHashSalt: string | undefined,
): EvaluatedEvidence {
  const parsed = z.array(evidenceItemSchema).min(1).max(6).parse(raw);
  const items: StoredTaxEvidenceItem[] = parsed.map((item) => {
    if (item.type === 'billing_address')
      return {
        type: item.type,
        country: item.address.country,
        state: item.address.state ?? null,
        postalCode: item.address.postalCode ?? null,
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
          ? { ipHash: createHmac('sha256', ipHashSalt).update(item.ipAddress).digest('hex') }
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
