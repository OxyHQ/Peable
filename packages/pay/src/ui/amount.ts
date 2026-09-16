/**
 * What the payer typed, turned into money — or into a refusal that says why.
 *
 * Every other module here works in base units (`bigint`). A text field works in
 * FAIR decimal strings. This is the one place the two meet, and it is a module
 * of its own because the interesting cases are all invisible: `parseFairToUnits`
 * TRUNCATES past eight decimals, so `"0.000000001"` parses successfully to `0n`.
 * A UI that only checked for `null` would take that as a valid amount, quote a
 * fee for it, and offer to send nothing while showing the payer the number they
 * typed.
 */

import { UNITS_PER_COIN, formatFair, parseFairToUnits } from '@fairco.in/core';

/**
 * The four answers a typed amount can have. `too-small` is separate from
 * `invalid` on purpose: the text parsed, so telling the payer it is malformed
 * would be a lie about input they can see is well-formed.
 */
export type AmountEntry =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'too-small' }
  | { readonly kind: 'ok'; readonly amountSat: bigint };

/**
 * Amounts offered as one tap. Whole FAIR, because a preset exists to save
 * typing and nobody wants `0.37` offered to them.
 */
export const DEFAULT_PRESETS_SAT: readonly bigint[] = [
  1n * UNITS_PER_COIN,
  5n * UNITS_PER_COIN,
  10n * UNITS_PER_COIN,
];

/**
 * Parse a FAIR decimal string into base units.
 *
 * Whitespace-only counts as empty rather than invalid — a payer who has typed
 * nothing has not made a mistake, and an error under an untouched field is
 * noise that trains people to ignore the field's real errors.
 */
export function parseAmountInput(text: string): AmountEntry {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };

  const amountSat = parseFairToUnits(trimmed);
  if (amountSat === null) return { kind: 'invalid' };
  if (amountSat <= 0n) return { kind: 'too-small' };
  return { kind: 'ok', amountSat };
}

/** A number whose every comma sits in a valid thousands position. */
const FULLY_GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * Keystrokes this field accepts at all.
 *
 * Filtering on the way IN rather than validating on the way out, because a
 * numeric keyboard is a request and not a guarantee: a hardware keyboard, a
 * paste, or an IME can all put letters in a `keyboardType="decimal-pad"` field.
 * `parseFairToUnits` returns `null` for every one of them.
 *
 * A comma is the case worth spelling out, because the two readings differ by a
 * factor of a thousand. It is dropped as a thousands separator ONLY when EVERY
 * comma in the string sits in a valid grouping position — which is exactly the
 * shape `formatFair` emits, so its own output pastes back in unchanged.
 * Anything else, `1,5` included, reads the comma as a decimal point. Blanket
 * stripping would turn a European `1,5` into `15`: a ten-fold overpayment,
 * assembled silently out of a keystroke the payer did make.
 */
export function sanitizeAmountInput(text: string): string {
  const withoutSpaces = text.replace(/\s/g, '');
  const commasResolved = !withoutSpaces.includes(',')
    ? withoutSpaces
    : FULLY_GROUPED.test(withoutSpaces)
      ? withoutSpaces.replace(/,/g, '')
      : withoutSpaces.replace(/,/g, '.');
  const digitsAndDots = commasResolved.replace(/[^0-9.]/g, '');

  // Only the FIRST decimal point survives. `"1.2.3"` has no correct reading, and
  // keeping the later dots would make the field parse as `invalid` while looking
  // like a normal number.
  const firstDot = digitsAndDots.indexOf('.');
  if (firstDot === -1) return digitsAndDots;
  return (
    digitsAndDots.slice(0, firstDot + 1) +
    digitsAndDots.slice(firstDot + 1).replace(/\./g, '')
  );
}

/**
 * The text a preset puts in the field.
 *
 * `formatFair` and not `formatUnits`, so one FAIR reads `1` rather than
 * `1.00000000` — and then the thousands separators come straight back out,
 * because this string is round-tripped through {@link parseAmountInput} and
 * `parseFairToUnits` returns `null` for a comma. A preset that made its own
 * field invalid is the kind of thing nobody notices until a preset goes above
 * 999.
 */
export function amountInputFor(amountSat: bigint): string {
  return formatFair(amountSat).replace(/,/g, '');
}

/** The message under the field for a non-`ok` entry, or `null` while it is fine. */
export function amountEntryMessage(entry: AmountEntry): string | null {
  switch (entry.kind) {
    case 'empty':
    case 'ok':
      return null;
    case 'invalid':
      return "That doesn't look like an amount";
    case 'too-small':
      return 'Enter an amount above zero';
  }
}
