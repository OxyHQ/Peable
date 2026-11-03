import { View } from 'react-native';
import type { CurrencyCode, PriceTaxBehavior, RecurringInterval } from '@peable.to/shared-types';
import { ORBIT_CURRENCY_DECIMALS } from '../format/money';
import { t } from '../i18n';
import { Choice } from '../ui/Choice';
import { FormField } from '../ui/FormField';
import {
  ORBIT_CATALOG_CURRENCIES,
  ORBIT_RECURRING_INTERVALS,
  ORBIT_TAX_BEHAVIORS,
  type PriceForm,
  type PriceFormError,
} from './productForm';

const CURRENCY_OPTIONS = ORBIT_CATALOG_CURRENCIES.map((code) => ({ value: code, label: code }));
const TYPE_OPTIONS = [
  { value: 'recurring', label: t('price.type.recurring') },
  { value: 'one_time', label: t('price.type.one_time') },
];
const INTERVAL_OPTIONS = ORBIT_RECURRING_INTERVALS.map((interval) => ({
  value: interval,
  label: t(`price.interval.${interval}`),
}));
const TAX_OPTIONS = ORBIT_TAX_BEHAVIORS.map((behavior) => ({
  value: behavior,
  label: t(`price.tax.${behavior}`),
}));

/** The fields of one per-unit price — a product's first price, or another one. */
export function PriceFields({
  form,
  onChange,
  invalid,
  disabled,
}: {
  form: PriceForm;
  onChange: (form: PriceForm) => void;
  invalid: PriceFormError | null;
  disabled?: boolean;
}) {
  const set =
    <K extends keyof PriceForm>(field: K) =>
    (value: PriceForm[K]) =>
      onChange({ ...form, [field]: value });
  return (
    <View className="gap-4">
      <View className="flex-row flex-wrap gap-4">
        <View className="w-40">
          <Choice
            label={t('price.field.currency')}
            value={form.currency}
            options={CURRENCY_OPTIONS}
            onChange={(value) => set('currency')(value as CurrencyCode)}
            disabled={disabled}
          />
        </View>
        <View className="flex-1 min-w-48">
          <FormField
            label={t('price.field.amount')}
            value={form.amount}
            onChange={set('amount')}
            placeholder="19.99"
            keyboardType="decimal-pad"
            invalid={invalid === 'amount'}
            hint={
              invalid === 'amount'
                ? t('price.invalidAmount')
                : t('price.field.amountHelp', {
                    currency: form.currency,
                    decimals: ORBIT_CURRENCY_DECIMALS[form.currency],
                  })
            }
            disabled={disabled}
          />
        </View>
      </View>
      <View className="flex-row flex-wrap gap-4">
        <View className="w-40">
          <Choice
            label={t('price.field.type')}
            value={form.type}
            options={TYPE_OPTIONS}
            onChange={(value) => set('type')(value as PriceForm['type'])}
            disabled={disabled}
          />
        </View>
        {form.type === 'recurring' ? (
          <>
            <View className="w-40">
              <Choice
                label={t('price.field.interval')}
                value={form.interval}
                options={INTERVAL_OPTIONS}
                onChange={(value) => set('interval')(value as RecurringInterval)}
                disabled={disabled}
              />
            </View>
            <View className="w-48">
              <FormField
                label={t('price.field.intervalCount')}
                value={form.intervalCount}
                onChange={set('intervalCount')}
                keyboardType="number-pad"
                invalid={invalid === 'intervalCount'}
                hint={
                  invalid === 'intervalCount'
                    ? t('price.invalidIntervalCount')
                    : t('price.field.intervalCountHelp')
                }
                disabled={disabled}
              />
            </View>
          </>
        ) : null}
        <View className="w-48">
          <Choice
            label={t('price.field.taxBehavior')}
            value={form.taxBehavior}
            options={TAX_OPTIONS}
            onChange={(value) => set('taxBehavior')(value as PriceTaxBehavior)}
            disabled={disabled}
          />
        </View>
      </View>
    </View>
  );
}
