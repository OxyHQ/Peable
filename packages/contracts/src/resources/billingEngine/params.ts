import { z } from 'zod';
import { idParam } from '../../common/params';
import { resolveObject, type Ref } from '../../common/objects';
import { CURRENCY_CODES, isBaseUnitString } from '../../vocabulary/money';

/**
 * Request (and response) pieces the billing engine's resources share (ADR
 * 0018). Internal to this group: not re-exported from its `index.ts`, so no
 * name here can collide with another group's at the package root.
 */

/** A quantity: a whole number of units, 0 to a billion. */
export const quantityParam = z.number().int().min(0).max(1_000_000_000);

/** Non-empty bounded text. */
export const shortText = (max: number) => z.string().min(1).max(max);

/** `send_invoice` only: days from finalization to the due date. */
export const daysUntilDueParam = z.number().int().min(0).max(365);

/** A currency a request names. */
export const currencyParam = z.enum(CURRENCY_CODES);

/** A canonical base-unit integer string: `"1999"`, never `"19.99"` or `1999`. */
export const amountParam = z
  .string()
  .refine(isBaseUnitString, 'must be a non-negative integer string in the smallest currency unit');

/** A signed base-unit integer string (a balance adjustment). */
export const signedAmountParam = z
  .string()
  .regex(
    /^(0|-?[1-9][0-9]{0,30})$/,
    'must be an integer string in the smallest currency unit, optionally negative',
  );

/** One entry of `discounts[]`: a coupon or a promotion code. */
export const discountParams = z
  .object({ coupon: idParam.optional(), promotion_code: idParam.optional() })
  .strict();
export type DiscountParams = z.input<typeof discountParams>;

/** `discounts[]`, at most twenty. */
export const discountsParam = z.array(discountParams).max(20);

/** `automatic_tax[enabled]`: compute Peable Tax (ADR 0011) before the invoice finalizes. */
export const automaticTaxParam = z.object({ enabled: z.boolean() }).strict();

/** An http(s) URL a request names (a return URL, a policy link). */
export const httpUrlParam = z
  .string()
  .regex(/^https?:\/\//)
  .max(2048);

/** A request with no parameters at all. */
export const emptyBody = z.object({}).strict();

/**
 * An object another resource defines, always EMBEDDED (never an id): a
 * subscription item's `price`. Validated against that resource's registered
 * schema, and typed as it once {@link Ref} resolves.
 */
export function embedded<K extends string>(type: K, description?: string): z.ZodType<Ref<K>> {
  const schema = z.lazy(() => resolveObject(type));
  return (description === undefined
    ? schema
    : schema.describe(description)) as unknown as z.ZodType<Ref<K>>;
}
