import { z } from 'zod';
import { describe } from '../../common/objects';
import { MAX_UNIX_SECONDS, queryBoolean } from '../../common/params';
import { CATALOG_MAX_WHOLE_UNITS, maxBaseUnits } from '../../vocabulary/catalog';
import { type CurrencyCode, isBaseUnitString } from '../../vocabulary/money';

/**
 * Request pieces the catalog's bodies share — and that every other body naming
 * an amount, a currency or an inline price reuses (checkout line items,
 * invoice items), so one shape rule is written once and every caller refuses
 * the same mistake with the same `param`.
 */

/** A canonical base-unit integer string: `"1999"`, never `"19.99"` or `1999`. */
export const baseUnitAmountParam = z
  .string()
  .refine(isBaseUnitString, 'must be a non-negative integer string in the smallest currency unit')
  .describe('Base units of the currency, as an integer string (`"1999"` is 19.99 EUR).');

/** A positive count that fits a Postgres `integer`. */
export const countParam = z.number().int().min(1).max(2_147_483_647);

/** A future instant in a body (`redeem_by`, `expires_at`): positive Unix seconds. */
export const positiveUnixSecondsParam = z.number().int().positive().max(MAX_UNIX_SECONDS);

/**
 * A boolean filter in a query string. A typed caller passes `true` / `false`
 * (the SDK spells it for the URL); the URL carries `'true'` / `'false'`,
 * which the gateway reads the same.
 */
export const queryFlag = queryBoolean as unknown as z.ZodType<boolean, boolean>;

/** `ids[]=a&ids[]=b` or `ids=a`: one id is a list of one. */
export function queryIdList(max: number) {
  return describe(
    z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (typeof value === 'string' ? [value] : value))
      .pipe(z.array(z.string().min(1).max(255)).min(1).max(max)),
    {
      jsonSchema: {
        type: 'array',
        items: { type: 'string', maxLength: 255 },
        minItems: 1,
        maxItems: max,
      },
    },
  );
}

/** `""` on an update clears the field (Stripe's rule): the parsed value is `null`. */
export const clearing = <T extends z.ZodType>(schema: T) =>
  z
    .union([schema, z.literal('')])
    .transform((value): z.output<T> | null => (value === '' ? null : (value as z.output<T>)));

/** Report one broken rule at `path` (relative to the object being parsed). */
export type Issue = (path: (string | number)[], message: string) => void;

export function issuer(ctx: z.RefinementCtx): { issue: Issue; failed: () => boolean } {
  let failed = false;
  return {
    issue: (path, message) => {
      failed = true;
      ctx.addIssue({ code: 'custom', path, message });
    },
    failed: () => failed,
  };
}

/** Refuse an amount above the catalog's bound for `currency`. */
export function amountWithinBound(
  issue: Issue,
  amount: string | undefined,
  currency: CurrencyCode,
  path: (string | number)[],
): void {
  if (amount === undefined || !isBaseUnitString(amount)) return;
  if (BigInt(amount) > maxBaseUnits(currency)) {
    issue(
      path,
      `must be at most ${maxBaseUnits(currency)} (${CATALOG_MAX_WHOLE_UNITS} whole ${currency})`,
    );
  }
}

/** Add a bound issue for a coupon or promotion amount in `currency`. */
export function checkAmountBound(
  ctx: z.RefinementCtx,
  amount: string | undefined,
  currency: CurrencyCode | undefined,
  path: (string | number)[],
): void {
  if (currency !== undefined) amountWithinBound(issuer(ctx).issue, amount, currency, path);
}
