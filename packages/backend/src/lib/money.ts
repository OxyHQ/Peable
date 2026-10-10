// bigint <-> canonical base-unit-string helpers. The domain works in bigint
// base units (m⊜); the database stores the decimal string. No float ever touches a
// monetary value on either side of this boundary.
import { isBaseUnitString } from '@peable.to/shared-types';

/**
 * Parse a canonical base-unit integer string into a bigint. Throws (via the
 * `isBaseUnitString` guard) on anything that is not a non-negative integer
 * string — fractional inputs like "1.5", signs, and leading zeros are refused.
 */
export function toBaseUnits(s: string): bigint {
  if (!isBaseUnitString(s)) {
    throw new Error(`invalid base-unit amount: ${JSON.stringify(s)}`);
  }
  return BigInt(s);
}

/**
 * Serialize a non-negative bigint back to its canonical base-unit string.
 * Negative amounts are meaningless for a payment amount and are refused.
 */
export function fromBaseUnits(b: bigint): string {
  if (b < 0n) {
    throw new Error(`base-unit amount cannot be negative: ${b.toString()}`);
  }
  return b.toString();
}
