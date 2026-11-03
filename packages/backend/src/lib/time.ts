/**
 * Every instant on the wire is integer Unix seconds (ADR 0014 D1).
 *
 * The one conversion, so no serializer rounds differently: floor, never round —
 * `created` must never claim a moment after the row existed.
 */
export function toUnix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** `toUnix` for a nullable column. */
export function toUnixOrNull(date: Date | null | undefined): number | null {
  return date ? toUnix(date) : null;
}

/** A Unix-seconds wire value back to a `Date`. */
export function fromUnix(seconds: number): Date {
  return new Date(seconds * 1000);
}
