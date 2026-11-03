/**
 * Instants on the wire are integer Unix SECONDS (ADR 0014 D1). Every conversion
 * to a `Date` goes through here, so no screen multiplies by 1000 twice or not
 * at all.
 */
export function fromUnixSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

/** A readable local date and time, or an em dash for a missing instant. */
export function formatInstant(seconds: number | null | undefined, locale?: string): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
  return fromUnixSeconds(seconds).toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * "in 5 min" / "3 h ago" relative to `now` (Unix seconds), coarse on purpose:
 * it is a hint beside the exact time, never a replacement for it.
 */
export function formatRelative(seconds: number, now: number): string {
  const delta = seconds - now;
  const magnitude = Math.abs(delta);
  const [value, unit] =
    magnitude < 60
      ? [Math.round(magnitude), 's']
      : magnitude < 3600
        ? [Math.round(magnitude / 60), 'min']
        : magnitude < 86_400
          ? [Math.round(magnitude / 3600), 'h']
          : [Math.round(magnitude / 86_400), 'd'];
  if (value === 0) return 'now';
  return delta >= 0 ? `in ${value} ${unit}` : `${value} ${unit} ago`;
}

/** `YYYY-MM-DD` (UTC) of a Unix-seconds instant — the format date fields take. */
export function utcDay(seconds: number): string {
  return fromUnixSeconds(seconds).toISOString().slice(0, 10);
}

/** The current instant in Unix seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
