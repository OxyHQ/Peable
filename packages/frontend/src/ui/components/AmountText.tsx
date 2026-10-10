/**
 * AmountText — renders a FAIR amount (in smallest units / bigint) with thousands
 * separators and trimmed trailing zeros.
 *
 * By default it is a single `<Text>` (use `suffix`/`prefix` for a text unit like
 * " FAIR"). Pass `symbol` to render the FairCoin logo glyph inline after the
 * number (the on-screen replacement for the "⊜" character) — in that mode it
 * renders a row (number + icon), so give it a numeric `symbolSize`.
 */

import { Text, View, type TextProps } from 'react-native';
import { NumericFormat } from 'react-number-format';
import { UNITS_PER_COIN } from '@fairco.in/core';
import { FairCoinSymbol } from './FairCoinSymbol';

export interface AmountTextProps extends Omit<TextProps, 'children'> {
  /** Amount in smallest units (m⊜). */
  value: bigint;
  /** Whether to keep trailing decimal zeros (default: false → trimmed). */
  fixedDecimalScale?: boolean;
  /** Number of decimal places to display (default: 8). */
  decimalScale?: number;
  /** Suffix appended after the amount, e.g. " FAIR". */
  suffix?: string;
  /** Prefix prepended before the amount. */
  prefix?: string;
  /** Render the FairCoin logo glyph after the number instead of a text unit. */
  symbol?: boolean;
  /** Icon size (px) when `symbol` is set. Defaults to 16. */
  symbolSize?: number;
  /** Icon tint when `symbol` is set. Defaults to the FairCoin brand green. */
  symbolColor?: string;
}

/**
 * Convert a bigint smallest-unit (m⊜) amount to a full-precision FAIR
 * decimal string. Uses string arithmetic to avoid the precision loss of
 * `Number(bigint)` for very large amounts.
 */
function unitsToDecimalString(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / UNITS_PER_COIN;
  const frac = abs % UNITS_PER_COIN;
  const fracStr = frac.toString().padStart(8, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

export function AmountText({
  value,
  fixedDecimalScale = false,
  decimalScale = 8,
  suffix,
  prefix,
  symbol = false,
  symbolSize = 16,
  symbolColor,
  style,
  ...rest
}: AmountTextProps) {
  let decimalString = unitsToDecimalString(value);
  if (!fixedDecimalScale) {
    // `unitsToDecimalString` always emits 8 fraction digits; strip trailing
    // zeros (and a bare trailing dot) so read-only amounts render compactly
    // (`0` not `0.00000000`, `1.5` not `1.50000000`). Only zeros AFTER the
    // decimal point are removed — the whole part is never touched.
    decimalString = decimalString.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  // In symbol mode, drop Android's extra font padding so the number's box bottom
  // sits at the glyph baseline — then flex-end lands the icon on that baseline.
  const textStyle = symbol ? [style, { includeFontPadding: false }] : style;
  const numberText = (
    <NumericFormat
      value={decimalString}
      displayType="text"
      thousandSeparator=","
      decimalSeparator="."
      decimalScale={decimalScale}
      fixedDecimalScale={fixedDecimalScale}
      prefix={prefix}
      suffix={suffix}
      valueIsNumericString
      renderText={(formatted) => (
        <Text {...rest} style={textStyle}>
          {formatted}
        </Text>
      )}
    />
  );

  if (!symbol) return numberText;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
      {numberText}
      <View style={{ marginLeft: symbolSize * 0.25, marginBottom: symbolSize * 0.28 }}>
        <FairCoinSymbol size={symbolSize} color={symbolColor} />
      </View>
    </View>
  );
}
