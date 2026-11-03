// The money vocabulary is the contract's (`@peable.to/contracts/vocabulary`,
// zod-free, so this package stays light at runtime): one definition of the
// currency set, its scales and the base-unit spelling.
export {
  BASE_UNIT_PATTERN,
  CURRENCY_CODES,
  CURRENCY_DECIMALS,
  type CurrencyCode,
  decimalsFor,
  FIAT_CURRENCY_CODES,
  type FiatCurrencyCode,
  isBaseUnitString,
  isCurrencyCode,
  SIGNED_BASE_UNIT_PATTERN,
  UNITS_PER_COIN,
} from '@peable.to/contracts/vocabulary';
