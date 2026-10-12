/**
 * `value`, or a thrown error saying it was missing.
 *
 * Tests use this where they would write `value!`. A non-null assertion only
 * silences the compiler: a row that is unexpectedly absent then fails later as
 * an unrelated `TypeError`, or gets passed along as `undefined` and fails
 * nowhere. This fails at the point the assumption breaks.
 */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present, got ${value}`);
  }
  return value;
}
