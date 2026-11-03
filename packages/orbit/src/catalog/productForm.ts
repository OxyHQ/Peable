import type {
  CreatePriceParams,
  CreateProductParams,
  CurrencyCode,
  DefaultPriceDataParams,
  Price,
  PriceTaxBehavior,
  Product,
  RecurringInterval,
  UpdateProductParams,
} from '@peable.to/shared-types';
import { formatAmount, ORBIT_CURRENCY_DECIMALS } from '../format/money';
import { labelFor, t } from '../i18n';

/**
 * What Orbit's product and price forms turn into gateway bodies (ADR 0018).
 * Pure, so the rules a person can get wrong are tested apart from the screen.
 * The gateway stays the judge of everything else (tax codes, bounds, which
 * price may be the default) and answers what it refuses with a `param`.
 */

export const ORBIT_CATALOG_CURRENCIES: readonly CurrencyCode[] = ['EUR', 'USD', 'FAIR'];
export const ORBIT_RECURRING_INTERVALS: readonly RecurringInterval[] = [
  'day',
  'week',
  'month',
  'year',
];
export const ORBIT_TAX_BEHAVIORS: readonly PriceTaxBehavior[] = [
  'unspecified',
  'inclusive',
  'exclusive',
];

/**
 * A typed decimal amount (`19.99`, `0.5`, `1`) in base units of `currency`
 * (`"1999"`), exactly — digits are moved, never multiplied as a float, so a
 * FAIR amount with eight decimals stays exact. `null` for anything that is not
 * a plain non-negative decimal, or that has more decimals than the currency.
 */
export function decimalToBaseUnits(text: string, currency: CurrencyCode): string | null {
  const decimals = ORBIT_CURRENCY_DECIMALS[currency];
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;
  const digits = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  return digits;
}

export interface ProductForm {
  name: string;
  description: string;
  unitLabel: string;
  statementDescriptor: string;
}

export const EMPTY_PRODUCT_FORM: ProductForm = {
  name: '',
  description: '',
  unitLabel: '',
  statementDescriptor: '',
};

/** A product's current values as the form edits them. */
export function productFormOf(product: Product): ProductForm {
  return {
    name: product.name,
    description: product.description ?? '',
    unitLabel: product.unit_label ?? '',
    statementDescriptor: product.statement_descriptor ?? '',
  };
}

export interface PriceForm {
  currency: CurrencyCode;
  /** Whole units, as typed: `19.99`. */
  amount: string;
  type: 'one_time' | 'recurring';
  interval: RecurringInterval;
  /** As typed; a positive integer. */
  intervalCount: string;
  taxBehavior: PriceTaxBehavior;
}

export const EMPTY_PRICE_FORM: PriceForm = {
  currency: 'EUR',
  amount: '',
  type: 'recurring',
  interval: 'month',
  intervalCount: '1',
  taxBehavior: 'unspecified',
};

export type PriceFormError = 'amount' | 'intervalCount';
export type ProductFormError = 'name' | PriceFormError;

export type FormResult<T, E> = { ok: true; body: T } | { ok: false; error: E };

/** The price a form describes, as `default_price_data` (no product). */
export function buildPriceData(
  form: PriceForm,
): FormResult<DefaultPriceDataParams, PriceFormError> {
  const unitAmount = decimalToBaseUnits(form.amount, form.currency);
  if (unitAmount === null) return { ok: false, error: 'amount' };
  const body: DefaultPriceDataParams = { currency: form.currency, unit_amount: unitAmount };
  if (form.type === 'recurring') {
    const count = form.intervalCount.trim();
    if (!/^[1-9]\d*$/.test(count)) return { ok: false, error: 'intervalCount' };
    body.recurring =
      count === '1'
        ? { interval: form.interval }
        : { interval: form.interval, interval_count: Number(count) };
  }
  if (form.taxBehavior !== 'unspecified') body.tax_behavior = form.taxBehavior;
  return { ok: true, body };
}

/** `POST /prices` for an existing product. */
export function buildCreatePriceBody(
  productId: string,
  form: PriceForm,
): FormResult<CreatePriceParams, PriceFormError> {
  const data = buildPriceData(form);
  if (!data.ok) return data;
  return { ok: true, body: { product: productId, ...data.body } };
}

/** `POST /products`, with a first price when `price` is given. */
export function buildCreateProductBody(
  form: ProductForm,
  price: PriceForm | null,
): FormResult<CreateProductParams, ProductFormError> {
  const name = form.name.trim();
  if (!name) return { ok: false, error: 'name' };
  const body: CreateProductParams = { name };
  const description = form.description.trim();
  if (description) body.description = description;
  const unitLabel = form.unitLabel.trim();
  if (unitLabel) body.unit_label = unitLabel;
  const descriptor = form.statementDescriptor.trim();
  if (descriptor) body.statement_descriptor = descriptor;
  if (price) {
    const data = buildPriceData(price);
    if (!data.ok) return data;
    body.default_price_data = data.body;
  }
  return { ok: true, body };
}

/**
 * `POST /products/:id` with only what changed: a field emptied in the form is
 * sent as `''`, which the gateway reads as "clear it".
 */
export function buildUpdateProductBody(
  form: ProductForm,
  product: Product,
): FormResult<UpdateProductParams, 'name'> {
  const name = form.name.trim();
  if (!name) return { ok: false, error: 'name' };
  const body: UpdateProductParams = {};
  if (name !== product.name) body.name = name;
  const optional = [
    ['description', form.description, product.description],
    ['unit_label', form.unitLabel, product.unit_label],
    ['statement_descriptor', form.statementDescriptor, product.statement_descriptor],
  ] as const;
  for (const [field, typed, stored] of optional) {
    const value = typed.trim();
    if (value !== (stored ?? '')) body[field] = value;
  }
  return { ok: true, body };
}

type PriceLabelSource = Pick<
  Price,
  'unit_amount' | 'currency' | 'recurring' | 'billing_scheme' | 'tiers_mode'
>;

/**
 * How a price reads in a list: `19.99 EUR / month`, `12.50 EUR every 3
 * months`, `1.00 FAIR`, or `Tiered (graduated) · EUR / month`.
 */
export function formatPriceLabel(price: PriceLabelSource): string {
  const tiers = price.tiers_mode ? ` (${labelFor('price.tiersMode', price.tiers_mode)})` : '';
  const amount =
    price.billing_scheme === 'tiered' || price.unit_amount === null
      ? `${t('product.price.tiered')}${tiers} · ${price.currency}`
      : formatAmount(price.unit_amount, price.currency);
  const recurring = price.recurring;
  if (!recurring) return amount;
  if (recurring.interval_count === 1) {
    return t('price.label.per', {
      amount,
      interval: labelFor('price.unit.one', recurring.interval),
    });
  }
  return t('price.label.every', {
    amount,
    count: recurring.interval_count,
    intervals: labelFor('price.unit.other', recurring.interval),
  });
}
