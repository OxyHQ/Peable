/**
 * AmountInput — a TextInput-backed FAIR amount field that auto-formats
 * thousands separators while typing and clamps to 8 decimal places.
 *
 * Uses `react-number-format`'s `numericFormatter` helper directly so the
 * formatter API works in React Native without the DOM-event coupling that
 * its `<NumericFormat customInput={TextInput} />` wrapper requires.
 *
 * `value` is the raw user-facing decimal string with no thousands
 * separators (e.g. "1.5"). The component shows it as "1.5" or "1,234.5"
 * depending on magnitude.
 */

import { forwardRef, useCallback, useMemo } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { numericFormatter } from 'react-number-format';

export interface AmountInputProps
  extends Omit<TextInputProps, 'value' | 'onChangeText' | 'keyboardType'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Max decimal places allowed (default: 8 for FAIR). */
  decimalScale?: number;
}

const THOUSAND_SEPARATOR = ',';
const DECIMAL_SEPARATOR = '.';

function sanitize(input: string, decimalScale: number): string {
  // Drop thousand separators that the user may have copy/pasted in
  let raw = input.replace(/,/g, '');
  // Drop everything except digits and the decimal separator
  raw = raw.replace(/[^\d.]/g, '');

  // Collapse multiple decimal points into one (keep the first)
  const firstDot = raw.indexOf(DECIMAL_SEPARATOR);
  if (firstDot !== -1) {
    raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, '');
  }

  const parts = raw.split(DECIMAL_SEPARATOR);
  // Strip leading zeros from the whole part but keep "0" if the user is
  // mid-typing a sub-1 amount like "0.5".
  if (parts[0] && parts[0].length > 1) {
    parts[0] = parts[0].replace(/^0+/, '') || '0';
  }
  // Clamp decimal precision
  if (parts[1] && parts[1].length > decimalScale) {
    parts[1] = parts[1].slice(0, decimalScale);
  }

  return parts.join(DECIMAL_SEPARATOR);
}

export const AmountInput = forwardRef<TextInput, AmountInputProps>(function AmountInput(
  { value, onValueChange, decimalScale = 8, ...rest },
  ref,
) {
  const display = useMemo(() => {
    if (!value) return '';
    return numericFormatter(value, {
      thousandSeparator: THOUSAND_SEPARATOR,
      decimalSeparator: DECIMAL_SEPARATOR,
      decimalScale,
      fixedDecimalScale: false,
      allowNegative: false,
      valueIsNumericString: true,
    });
  }, [value, decimalScale]);

  const handleChangeText = useCallback(
    (text: string) => {
      const cleaned = sanitize(text, decimalScale);
      if (cleaned !== value) onValueChange(cleaned);
    },
    [value, onValueChange, decimalScale],
  );

  return (
    <TextInput
      ref={ref}
      {...rest}
      value={display}
      onChangeText={handleChangeText}
      keyboardType="decimal-pad"
      inputMode="decimal"
    />
  );
});
