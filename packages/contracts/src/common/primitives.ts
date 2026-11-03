import { z } from 'zod';
import {
  BASE_UNIT_PATTERN,
  CURRENCY_CODES,
  FIAT_CURRENCY_CODES,
  type FiatCurrencyCode,
  NETWORK_TYPES,
  SIGNED_BASE_UNIT_PATTERN,
} from '../vocabulary/money';

/**
 * The house style's primitives (ADR 0014 D1), as RESPONSE schemas: what the
 * gateway emits. Request-side building blocks (coercing query integers,
 * `expand[]`, metadata patches) are in `params.ts`.
 */

/** Every instant on the wire: integer Unix seconds. */
export const unixSeconds = z.number().int().nonnegative().describe('Unix seconds.');

/** A base-unit amount: an integer string in the currency's smallest unit (a FAIR amount does not fit a JS number). */
export const amount = z
  .string()
  .regex(BASE_UNIT_PATTERN)
  .describe('Base units of `currency`, as an integer string (cents for EUR, m⊜ for FAIR).');

/** A signed base-unit amount (a customer balance, a balance transaction's net). */
export const signedAmount = z
  .string()
  .regex(SIGNED_BASE_UNIT_PATTERN)
  .describe('Signed base units of `currency`, as an integer string.');

/** An uppercase ISO 4217 code, or `FAIR`. */
export const currency = z.enum(CURRENCY_CODES).describe('Uppercase ISO 4217 code, or `FAIR`.');

/** A currency the card rail can denominate in. */
export const fiatCurrency = z.enum(
  FIAT_CURRENCY_CODES as [FiatCurrencyCode, ...FiatCurrencyCode[]],
);

/** The FairCoin network. */
export const network = z.enum(NETWORK_TYPES);

/** Whether the object exists in live mode (`false`: test mode). */
export const livemode = z.boolean().describe('`true` in live mode, `false` in test mode.');

/** The merchant's own key/value bag, as returned. */
export const metadata = z
  .record(z.string(), z.string())
  .describe('Your own key/value pairs: at most 50 keys, keys ≤ 40 characters, values ≤ 500.');

/** A nullable string — the shape of every optional text field on a response. */
export const nullableString = z.string().nullable();

/** A literal `object` discriminator. */
export const objectName = <T extends string>(name: T) => z.literal(name);
